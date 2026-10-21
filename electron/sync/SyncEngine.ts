// Decides what to move between this PC and the cloud, and moves it.
// preflight() only reads. download() and uploadSession() run while the session holds the lock.
// The manifest is written LAST in an upload: that single write is the commit.
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { APP_PROPS } from '../../shared/types';
import type {
    BaseEntry, ConflictChoice, LockView, Manifest, ManifestEntry, PendingCleanup, ProgressStageKey, Snapshot,
    StepMessage, SyncPlan, SyncReport, SyncRules, SyncStatus, UserInfo,
} from '../../shared/types';
import { BUILTIN_IGNORES, DEFAULT_SHARED_IGNORES, ancestorsOf, baseName, compileRules, normalizeRule, parentOf } from '../../shared/paths';
import { DriveError, FOLDER_MIME } from '../drive/types';
import type { DriveApi, DriveFileMeta } from '../drive/types';
import { AppError, toAppError } from '../errors';
import type { LockService } from '../lock/LockService';
import type { SettingsService } from '../settings/SettingsService';
import type { AppData, JournalEntry, UploadJournal } from '../store/appData';
import type { JobOutcome, RunHooks, TransferEngine, TransferJob, TransferResult } from '../transfer/TransferEngine';
import type { LauncherFiles } from './launcherFiles';
import { baseToSnapshot, manifestToSnapshot, readManifest, readRules, writeManifest, writeRules } from './manifest';
import { allowedChoices, deriveStatus, emptyPlan, planMirrorRemote, planSync, planUpload, sumBytes } from './planner';
import { NO_PROGRESS } from './progressSink';
import type { ProgressSink } from './progressSink';
import { scanLocal } from './scanner';
import { creationTags, pathHash } from './tags';

export interface SyncEngineDeps {
    drive: DriveApi;
    launcher: LauncherFiles;
    lock: Pick<LockService, 'inspect' | 'sessionId'>;
    transfers: Pick<TransferEngine, 'run'>;
    appData: AppData;
    settings: Pick<SettingsService, 'getServer'>;
    me: () => Promise<UserInfo>;
    step: (message: string, status?: StepMessage['status'], importance?: StepMessage['importance']) => void;
    now?: () => number;
    platform?: NodeJS.Platform;
}

interface Analysis {
    root: string;
    me: UserInfo;
    remote: Manifest | null;
    baseRevision: number | null;
    local: Snapshot;
    remoteSnap: Snapshot;
    plan: SyncPlan;
    status: SyncStatus;
    lock: LockView;
}

/** What journal.log says an interrupted upload already did. */
interface JournalMemory {
    /** A journal from before the log existed: nothing is known, everything has to be looked up on Drive. */
    legacy: boolean;
    folders: Record<string, string>;
    done: Map<string, { id: string; md5: string; size: number }>;
    started: Set<string>;
    gone: Set<string>;
}

/** A repair's look at the cloud: manifest files whose Drive file no longer holds what the manifest says. */
interface CloudCheck {
    /** Different content, but the file is still there: overwritten in place. */
    changed: Set<string>;
    /** Trashed, deleted, or emptied into a placeholder: created again. */
    gone: Set<string>;
}

type UploadOutcome = Extract<JobOutcome, { kind: 'upload' }>;
type Log = (entry: JournalEntry) => void;

const FREE_LOCK: LockView = { state: 'free', lock: null };
/** Parallel metadata requests (lookups, listings, trash): enough to hide round trips, few enough for Google's limits. */
const LOOKUP_CONCURRENCY = 8;

function isNotFound(err: unknown): boolean {
    return err instanceof DriveError && err.status === 404;
}

function sorted(paths: Iterable<string>): string[] {
    return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function count(n: number): string {
    return n.toLocaleString('en-US');
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${count(n)} ${n === 1 ? one : many}`;
}

/** Runs `task` over `items` with at most `limit` running at once. */
async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) await task(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const WINDOWS_BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** Why a cloud path cannot be written on Windows, or null when it can. */
export function windowsPathProblem(relPath: string): string | null {
    for (const segment of relPath.split('/')) {
        if (WINDOWS_RESERVED.test(segment)) return `"${segment}" is a reserved name on Windows`;
        if (WINDOWS_BAD_CHARS.test(segment)) return `"${segment}" contains a character Windows does not allow`;
        if (/[. ]$/.test(segment)) return `"${segment}" ends with a dot or a space`;
    }
    return null;
}

export class SyncEngine {
    private readonly choices = new Map<string, ConflictChoice>();
    private cleaning: Promise<number> | null = null;
    /** The last scan per server folder: preflight and the download that follows it do not hash the world twice. */
    private readonly lastScan = new Map<string, Snapshot>();

    constructor(private readonly d: SyncEngineDeps) {}

    /* ------------------------------------------------------------------ reading */

    /** Read-only on Drive and on disk: what would happen if this PC started a session now.
     *  With `progress`, hashing the folder is reported as the "check" stage. */
    async preflight(serverId: string, signal?: AbortSignal, progress?: ProgressSink): Promise<SyncReport> {
        const checkedAt = this.iso();
        const report: SyncReport = {
            serverId, status: 'error', firstSyncOnThisPc: this.d.appData.readBase(serverId) === null,
            baseRevision: null, remoteRevision: null, remoteAuthor: null, remoteCreatedAt: null,
            plan: emptyPlan(), downloadBytes: 0, uploadBytes: 0, allowedChoices: [],
            pendingChoice: this.choices.get(serverId) ?? null, cleanup: { mine: 0, others: [] },
            lock: FREE_LOCK, checkedAt, unfinishedHere: this.hasJournal(serverId),
        };
        try {
            report.lock = await this.d.lock.inspect(serverId);
            const a = await this.analyze(serverId, false, signal, report.lock, progress, 'check');
            report.status = a.status;
            report.baseRevision = a.baseRevision;
            report.remoteRevision = a.remote?.revision ?? null;
            report.remoteAuthor = a.remote ? a.remote.author : null;
            report.remoteCreatedAt = a.remote?.createdAt ?? null;
            report.remoteIncomplete = a.remote?.incomplete ?? null;
            report.plan = a.plan;
            report.downloadBytes = sumBytes([...a.plan.download, ...a.plan.conflicts], a.remoteSnap);
            report.uploadBytes = sumBytes(a.plan.upload, a.local);
            report.allowedChoices = a.status === 'diverged' ? allowedChoices(a.plan) : [];
            if (a.status !== 'diverged') this.choices.delete(serverId);
            report.pendingChoice = this.choices.get(serverId) ?? null;
            report.cleanup = await this.pendingCleanup(serverId, a.me);
        } catch (err) {
            if (err instanceof AppError && err.code === 'NO_LOCAL_PATH') {
                report.status = 'no-local-path';
            } else {
                const info = toAppError(err);
                console.warn('[sync] preflight failed:', info.detail ?? info.message);
                report.status = 'error';
                report.error = info.message;
            }
        }
        return report;
    }

    pendingChoice(serverId: string): ConflictChoice | null {
        return this.choices.get(serverId) ?? null;
    }

    hasJournal(serverId: string): boolean {
        return this.d.appData.readJournal(serverId) !== null;
    }

    serversWithJournal(): string[] {
        return this.d.appData.serversWithJournal();
    }

    /** Forgets an unfinished upload that can no longer be committed (the cloud moved on). The files stay
     *  on disk, so the next preflight shows them as local changes or as a conflict to choose from. */
    discardJournal(serverId: string): void {
        this.d.appData.deleteJournal(serverId);
    }

    baseRevision(serverId: string): number {
        return this.d.appData.readBase(serverId)?.revision ?? 0;
    }

    /** The unfinished upload of this PC is a repair (resuming it checks the cloud again). */
    unfinishedRepair(serverId: string): boolean {
        return this.d.appData.readJournal(serverId)?.repair === true;
    }

    /* ------------------------------------------------------------------ rules */

    async getRules(serverId: string): Promise<SyncRules> {
        return { format: 1, ignore: await this.sharedRules(serverId, false), builtin: [...BUILTIN_IGNORES] };
    }

    async setRules(serverId: string, ignore: string[]): Promise<SyncRules> {
        const rules = [...new Set(ignore.map(normalizeRule).filter((r): r is string => r !== null))];
        await writeRules(this.d.launcher, serverId, rules);
        return this.getRules(serverId);
    }

    /** Builtin rules plus the shared ones. With `create`, a missing sync-rules.json is written (under the lock). */
    async loadRules(serverId: string, create = false): Promise<(rel: string) => boolean> {
        return compileRules([...BUILTIN_IGNORES, ...(await this.sharedRules(serverId, create))]);
    }

    private async sharedRules(serverId: string, create: boolean): Promise<string[]> {
        const existing = await readRules(this.d.launcher, serverId);
        if (existing) return existing;
        const defaults = [...new Set([...DEFAULT_SHARED_IGNORES, ...this.d.appData.legacyBlacklist()])];
        if (create) await writeRules(this.d.launcher, serverId, defaults);
        return defaults;
    }

    /* ------------------------------------------------------------------ conflicts */

    async resolve(serverId: string, choice: ConflictChoice): Promise<SyncReport> {
        const lock = await this.d.lock.inspect(serverId);
        const a = await this.analyze(serverId, false, undefined, lock);
        if (a.status !== 'diverged') {
            throw new AppError('INVALID', 'There is nothing to choose any more: your copy and the cloud no longer conflict.');
        }
        if (!allowedChoices(a.plan).includes(choice)) {
            throw new AppError('INVALID', 'Combining is only possible when no file was changed on both sides.');
        }
        if (choice === 'keep-local') {
            this.adoptRemoteAsBase(serverId, a.remote, a.local);
            this.choices.delete(serverId);
        } else if (choice === 'keep-cloud') {
            const copied = await this.backupLocalDifferences(serverId, a);
            this.d.step(`Saved ${copied} of your changed files in the backups folder`, 'done', 'minor');
            this.choices.set(serverId, choice);
        } else {
            this.choices.set(serverId, choice);
        }
        return this.preflight(serverId);
    }

    /** keep-local: the cloud's state becomes the base, so every local difference becomes an upload. */
    private adoptRemoteAsBase(serverId: string, remote: Manifest | null, local: Snapshot): void {
        if (!remote) return;
        const files: Record<string, BaseEntry> = {};
        for (const [p, e] of Object.entries(remote.files)) {
            const l = local.get(p);
            files[p] = { ...e, mtimeMs: l && l.md5 === e.md5 ? l.mtimeMs ?? -1 : -1 };
        }
        this.d.appData.writeBase(serverId, { format: 2, serverId, revision: remote.revision, files, folders: { ...remote.folders } });
    }

    /** keep-cloud: copies every local file that differs from the cloud (or exists only here) into a backup folder. */
    private async backupLocalDifferences(serverId: string, a: Analysis): Promise<number> {
        const differing = sorted([...a.local.keys()].filter((p) => a.remoteSnap.get(p)?.md5 !== a.local.get(p)?.md5));
        if (differing.length === 0) return 0;
        const dir = this.d.appData.backupDir(serverId, 'keep-cloud');
        for (const rel of differing) {
            const target = this.abs(dir, rel);
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(this.abs(a.root, rel), target);
        }
        console.log(`[sync] backed up ${differing.length} files to ${dir}`);
        return differing.length;
    }

    /* ------------------------------------------------------------------ download (under the lock) */

    async download(serverId: string, _report: SyncReport, signal?: AbortSignal, progress: ProgressSink = NO_PROGRESS): Promise<void> {
        const lock = await this.d.lock.inspect(serverId);
        // Plan again: the cloud may have changed since the preflight the user looked at.
        progress.enter('scan', 'Checking your files');
        const a = await this.analyze(serverId, true, signal, lock, progress, 'scan');
        progress.complete('scan', `Checked ${plural(a.local.size, 'file')}`);
        const choice = this.choices.get(serverId) ?? null;
        if (!a.remote) {
            if (this.d.appData.readBase(serverId) === null) {
                this.d.appData.writeBase(serverId, { format: 2, serverId, revision: 0, files: {}, folders: {} });
            }
            progress.complete('download', 'Nothing in the cloud yet: your folder is uploaded after the session');
            return;
        }
        let download: string[];
        let deleteLocal: string[];
        if (choice === 'keep-cloud') {
            ({ download, deleteLocal } = planMirrorRemote(a.local, a.remoteSnap));
        } else {
            if (a.plan.conflicts.length > 0 || (a.status === 'diverged' && choice !== 'combine')) {
                throw new AppError('CONFLICT', 'Your copy and the cloud both changed. Choose which version to keep before starting.');
            }
            download = a.plan.download;
            deleteLocal = a.plan.deleteLocal;
        }
        this.checkWindowsNames(download, a.remoteSnap);

        const jobs: TransferJob[] = [
            ...download.map((p): TransferJob => {
                const e = a.remote!.files[p];
                return { kind: 'download', path: p, driveId: e.driveId, size: e.size, md5: e.md5, dest: this.abs(a.root, p) };
            }),
            ...deleteLocal.map((p): TransferJob => ({ kind: 'delete-local', path: p, target: this.abs(a.root, p) })),
        ];
        progress.setTotal('download', jobs.length);
        let result: TransferResult = { done: [], failed: [] };
        if (jobs.length > 0) {
            progress.enter('download', `Downloading ${plural(download.length, 'file')}`);
            result = await this.d.transfers.run('Downloading files', jobs, signal);
            progress.settle('download', result.done.length);
            if (result.failed.length > 0) {
                throw new AppError(
                    'DOWNLOAD_INCOMPLETE',
                    `${result.failed.length} of ${jobs.length} files could not be downloaded, so the server was not started.`,
                    result.failed.slice(0, 5).map((f) => `${f.job.path}: ${f.error.message}`).join('\n'),
                );
            }
            progress.complete('download', `Downloaded ${plural(download.length, 'file')}`);
        } else {
            progress.complete('download', 'Nothing to download');
        }

        const downloaded = new Map<string, Extract<JobOutcome, { kind: 'download' }>>();
        for (const o of result.done) if (o.kind === 'download') downloaded.set(o.path, o);
        const files: Record<string, BaseEntry> = {};
        for (const [p, e] of Object.entries(a.remote.files)) {
            const dl = downloaded.get(p);
            const l = a.local.get(p);
            // -1 forces a re-hash: a local change kept for "combine", or a local delete still to be uploaded.
            const mtimeMs = dl ? dl.mtimeMs : l && l.md5 === e.md5 ? l.mtimeMs ?? -1 : -1;
            files[p] = { size: e.size, md5: e.md5, driveId: e.driveId, mtimeMs };
        }
        this.d.appData.writeBase(serverId, { format: 2, serverId, revision: a.remote.revision, files, folders: { ...a.remote.folders } });
        this.choices.delete(serverId);
    }

    private checkWindowsNames(paths: string[], snap: Snapshot): void {
        if ((this.d.platform ?? process.platform) !== 'win32') return;
        for (const p of paths) {
            const problem = windowsPathProblem(p);
            if (problem) {
                throw new AppError('INVALID', `The cloud has a file this PC cannot store: ${p} (${problem}). Rename it on the PC that created it.`);
            }
        }
        const seen = new Map<string, string>();
        for (const p of snap.keys()) {
            const key = p.toLowerCase();
            const other = seen.get(key);
            if (other !== undefined) {
                throw new AppError('INVALID', `The cloud has two files whose names differ only in capital letters ("${other}" and "${p}"), which Windows cannot store side by side.`);
            }
            seen.set(key, p);
        }
    }

    /* ------------------------------------------------------------------ upload (under the lock) */

    /** With `repair`, this PC's copy is also put back wherever the cloud no longer matches the last manifest
     *  (another member's upload stopped half way). Needs this PC to be at the cloud's revision. */
    async uploadSession(
        serverId: string, signal?: AbortSignal, progress: ProgressSink = NO_PROGRESS, opts: { repair?: boolean } = {},
    ): Promise<{ uploaded: number; deleted: number; revision: number }> {
        const root = await this.requireRoot(serverId);
        const isIgnored = await this.loadRules(serverId, true);
        let journal = this.d.appData.readJournal(serverId);
        let remote = await readManifest(this.d.launcher, serverId);
        const me = await this.d.me();
        const repair = opts.repair === true || journal?.repair === true;

        if (journal && this.recoverCommitted(serverId, journal.baseRevision, remote, me)) {
            journal = null;
        }
        const base = this.d.appData.readBase(serverId);
        const baseRevision = base?.revision ?? 0;
        progress.enter('scan', 'Checking your files');
        const local = await this.scan(serverId, root, baseToSnapshot(base), isIgnored, signal, progress, 'scan');
        progress.complete('scan', `Checked ${plural(local.size, 'file')}`);
        // Without a cloud manifest everything is new, whatever the base says.
        const planBase = remote ? baseToSnapshot(base) : new Map();
        const planned = planUpload(planBase, local);
        let upload = planned.upload;
        const deleteRemote = planned.deleteRemote;
        if (remote && remote.revision !== baseRevision) {
            throw new AppError('CONFLICT', repair
                ? `This PC no longer has the cloud's last saved version (revision ${remote.revision}), so it cannot repair the server.`
                : 'The cloud changed since this PC last synced, so the upload was stopped to protect the other copy.');
        }
        let broken: CloudCheck | null = null;
        if (repair && remote) {
            broken = await this.checkCloud(serverId, remote, signal, progress);
            const restore = [...broken.changed, ...broken.gone].filter((p) => local.has(p));
            upload = sorted(new Set([...upload, ...restore]));
        }

        if (upload.length === 0 && deleteRemote.length === 0) {
            if (journal) this.d.appData.deleteJournal(serverId);
            for (const key of ['folders', 'files', 'commit', 'cleanup'] as const) progress.skip(key);
            this.d.step(repair ? 'The cloud matches this PC, so nothing needed repairing' : 'Nothing changed, so nothing was uploaded', 'done', 'major');
            return { uploaded: 0, deleted: 0, revision: remote?.revision ?? baseRevision };
        }
        const memory = this.journalMemory(serverId, journal);
        this.d.appData.writeJournal(serverId, {
            format: 1, serverId, startedAt: journal?.startedAt ?? this.iso(), baseRevision, sessionId: this.d.lock.sessionId, logged: true,
            planned: upload.length + deleteRemote.length,
            ...(repair ? { repair: true } : {}),
        });
        const log: Log = (entry) => this.d.appData.appendJournalLog(serverId, [entry]);

        const remoteFiles: Record<string, ManifestEntry> = remote?.files ?? {};
        // A file someone trashed by hand on the Drive website would still accept new content, but nobody
        // else could download it any more: such paths are created again instead of updated.
        const gone = broken
            ? broken.gone
            : await this.missingTargets(serverId, upload.filter((p) => remoteFiles[p]), remoteFiles, remote?.folders ?? {});
        const isNew = (p: string): boolean => !remoteFiles[p] || gone.has(p);
        const newPaths = upload.filter(isNew);
        const manifestFolders = remote?.folders ?? {};
        const folders = await this.ensureFolders(
            serverId, newPaths, { ...manifestFolders, ...memory.folders }, new Set(Object.keys(manifestFolders)), signal, progress, log,
        );

        // Only a create that may have reached Drive without being logged has to be looked for on Drive.
        const uncertain = newPaths.filter((p) => memory.legacy || (memory.started.has(p) && !memory.done.has(p)));
        const earlier = uncertain.length > 0 ? await this.findOwnFiles(serverId, uncertain, progress) : new Map<string, DriveFileMeta[]>();

        const reused: UploadOutcome[] = [];
        const jobs: TransferJob[] = [];
        let uploads = 0;
        for (const p of upload) {
            const l = local.get(p)!;
            const logged = memory.done.get(p);
            if (logged && logged.md5 === l.md5) {
                reused.push({ kind: 'upload', path: p, driveId: logged.id, md5: l.md5, size: l.size });
                continue;
            }
            const existing = isNew(p) ? undefined : remoteFiles[p];
            const unsure = memory.legacy || (memory.started.has(p) && !logged);
            if (existing && unsure && (await this.alreadyUploaded(existing.driveId, l.md5))) {
                reused.push({ kind: 'upload', path: p, driveId: existing.driveId, md5: l.md5, size: l.size });
                continue;
            }
            const candidates = earlier.get(p) ?? [];
            const same = candidates.find((c) => c.md5Checksum === l.md5);
            if (same) {
                reused.push({ kind: 'upload', path: p, driveId: same.id, md5: l.md5, size: l.size });
                continue;
            }
            const earlierId = candidates.length > 0 ? candidates[candidates.length - 1].id : undefined;
            jobs.push(this.uploadJob(serverId, root, p, l.size, l.md5, existing?.driveId ?? logged?.id ?? earlierId, folders));
            uploads += 1;
        }
        const deletions = deleteRemote.filter((p) => remoteFiles[p] && !memory.gone.has(p));
        if (deletions.length > 0) {
            let pendingFolderId: string | null = null;
            try {
                pendingFolderId = await this.d.launcher.ensureSubfolder(serverId, 'pending-delete');
            } catch (err) {
                console.warn('[sync] could not prepare .launcher/pending-delete; placeholders stay where they are:', toAppError(err).detail);
            }
            for (const p of deletions) {
                jobs.push({ kind: 'delete-remote', path: p, driveId: remoteFiles[p].driveId, serverId, pendingFolderId });
            }
        }
        if (reused.length > 0) console.log(`[sync] ${reused.length} files were already uploaded by the interrupted attempt`);

        const hooks = this.journalHooks(log);
        const what = [uploads > 0 ? `Uploading ${plural(uploads, 'file')}` : '', deletions.length > 0 ? `removing ${plural(deletions.length, 'file')}` : '']
            .filter(Boolean).join(' and ');
        progress.setTotal('files', jobs.length);
        progress.enter('files', what ? what.charAt(0).toUpperCase() + what.slice(1) : 'Everything was already uploaded');
        let result: TransferResult = { done: [], failed: [] };
        if (jobs.length > 0) {
            result = await this.d.transfers.run('Uploading files', jobs, signal, hooks);
            progress.settle('files', result.done.length);
        }
        result = await this.recreateMissing(serverId, root, result, folders, signal, progress, hooks, log);
        if (result.failed.length > 0) {
            throw new AppError(
                'UPLOAD_INCOMPLETE',
                `${plural(result.failed.length, 'file')} could not be uploaded. Your session is kept on this PC; press Retry to send just those again.`,
                result.failed.slice(0, 5).map((f) => `${f.job.path}: ${f.error.message}`).join('\n'),
            );
        }
        const doneText = [uploads > 0 ? `Uploaded ${plural(uploads, 'file')}` : '', deletions.length > 0 ? `removed ${plural(deletions.length, 'file')}` : '']
            .filter(Boolean).join(' and ');
        progress.complete('files', doneText ? doneText.charAt(0).toUpperCase() + doneText.slice(1) : 'Everything was already uploaded');

        progress.enter('commit', 'Saving the new version to the cloud');
        signal?.throwIfAborted();
        const latest = await readManifest(this.d.launcher, serverId);
        if ((latest?.revision ?? 0) !== (remote?.revision ?? 0)) {
            throw new AppError('CONFLICT', 'The cloud changed during your upload, so it was not committed.');
        }
        const files: Record<string, ManifestEntry> = { ...remoteFiles };
        for (const o of [...result.done, ...reused]) {
            if (o.kind === 'upload') files[o.path] = { size: o.size, md5: o.md5, driveId: o.driveId };
        }
        for (const p of deleteRemote) delete files[p];
        const parentRevision = remote?.revision ?? baseRevision;
        const next: Manifest = {
            format: 2, revision: parentRevision + 1, parentRevision,
            author: { name: me.name, email: me.email }, createdAt: this.iso(), files, folders,
        };
        signal?.throwIfAborted();                                     // the lock may have been lost meanwhile
        await writeManifest(this.d.launcher, serverId, next);         // the commit
        remote = next;
        this.writeBaseFrom(serverId, next, local);
        this.d.appData.deleteJournal(serverId);
        progress.complete('commit', `Saved revision ${next.revision}`);

        progress.enter('cleanup', 'Looking for leftovers on Google Drive');
        let swept = 0;
        try {
            swept = await this.sweepLeftovers(serverId, next);
        } catch (err) {
            console.warn('[sync] could not look for leftovers:', toAppError(err).detail);
        }
        progress.complete('cleanup', swept > 0 ? `Moved ${plural(swept, 'leftover file')} to the trash` : 'No leftovers on Google Drive');
        void this.cleanupMyPlaceholders().catch((err: unknown) => console.warn('[sync] placeholder cleanup failed:', toAppError(err).detail));
        return { uploaded: upload.length, deleted: deletions.length, revision: next.revision };
    }

    /** The user cancelled the upload for good. What reached Google Drive (journal.log says what; a few lookups
     *  settle the files that were in flight) becomes the next revision, marked incomplete, so the cloud is
     *  consistent again and the server can be freed. Changes that were not sent stay local changes for the next
     *  upload. null when nothing of the world had been sent: the cloud is left as it was. */
    async commitPartial(
        serverId: string, progress: ProgressSink = NO_PROGRESS,
    ): Promise<{ revision: number; sent: number; planned: number | null } | null> {
        const journal = this.d.appData.readJournal(serverId);
        if (!journal) return null;
        if (journal.repair) throw new AppError('INVALID', 'A repair cannot be cancelled half way. Pause it and continue it later.');
        if (!journal.logged) {
            throw new AppError('INVALID', 'This upload was started by an older version of the app, so what it sent is not known. Continue it instead.');
        }
        const planned = journal.planned ?? null;
        const remote = await readManifest(this.d.launcher, serverId);
        const me = await this.d.me();
        if (this.recoverCommitted(serverId, journal.baseRevision, remote, me)) {
            return { revision: remote!.revision, sent: planned ?? 0, planned };        // it had all landed after all
        }
        const remoteRevision = remote?.revision ?? 0;
        if (remoteRevision !== journal.baseRevision) {
            throw new AppError('CONFLICT', 'The cloud changed since this upload started, so what it sent cannot be saved.');
        }
        progress.enter('commit', 'Looking at what reached Google Drive');
        const memory = this.journalMemory(serverId, journal);
        const remoteFiles: Record<string, ManifestEntry> = remote?.files ?? {};
        const files: Record<string, ManifestEntry> = { ...remoteFiles };
        let sent = 0;
        for (const [p, e] of memory.done) {
            files[p] = { size: e.size, md5: e.md5, driveId: e.id };
            sent += 1;
        }
        for (const p of memory.gone) {
            delete files[p];
            sent += 1;
        }
        // In flight when the upload stopped: Drive has either the new content (the answer got lost) or the old.
        const unsure = [...memory.started].filter((p) => !memory.done.has(p) && !memory.gone.has(p));
        await eachLimited(unsure.filter((p) => remoteFiles[p]), LOOKUP_CONCURRENCY, async (p) => {
            let meta: DriveFileMeta | null = null;
            try {
                meta = await this.d.drive.getMeta(remoteFiles[p].driveId);
            } catch (err) {
                if (!isNotFound(err)) throw err;
            }
            if (!meta || meta.trashed || meta.appProperties?.[APP_PROPS.tombstone] === '1') {
                delete files[p];                                        // a deletion that landed
                sent += 1;
            } else if (meta.md5Checksum && meta.md5Checksum.toLowerCase() !== remoteFiles[p].md5.toLowerCase()) {
                files[p] = { size: meta.size ?? 0, md5: meta.md5Checksum.toLowerCase(), driveId: meta.id };
                sent += 1;
            }
        });
        const created = unsure.filter((p) => !remoteFiles[p]);
        if (created.length > 0) {
            for (const [p, candidates] of await this.ownTaggedFiles(serverId, created)) {
                const newest = [...candidates].reverse().find((c) => c.md5Checksum);
                if (!newest?.md5Checksum) continue;
                files[p] = { size: newest.size ?? 0, md5: newest.md5Checksum.toLowerCase(), driveId: newest.id };
                sent += 1;
            }
        }
        if (sent === 0) {
            // Nothing of the world had changed in the cloud yet (folders it made are harmless and reused later).
            this.d.appData.deleteJournal(serverId);
            progress.complete('commit', 'Nothing had been sent, so the cloud stays as it was');
            return null;
        }

        // This PC's copy decides what is still to send later; read it before the commit, which cannot fail half way.
        const root = await this.requireRoot(serverId);
        const isIgnored = await this.loadRules(serverId);
        const local = await this.scan(serverId, root, baseToSnapshot(this.d.appData.readBase(serverId)), isIgnored, undefined);
        const complete = planned !== null && sent >= planned;
        const next: Manifest = {
            format: 2, revision: remoteRevision + 1, parentRevision: remoteRevision,
            author: { name: me.name, email: me.email }, createdAt: this.iso(), files,
            folders: { ...(remote?.folders ?? {}), ...memory.folders },
        };
        if (!complete) next.incomplete = { by: { name: me.name, email: me.email }, at: this.iso(), sent, planned };
        const latest = await readManifest(this.d.launcher, serverId);
        if ((latest?.revision ?? 0) !== remoteRevision) {
            throw new AppError('CONFLICT', 'The cloud changed meanwhile, so what was sent was not saved.');
        }
        await writeManifest(this.d.launcher, serverId, next);           // the commit
        this.writeBaseFrom(serverId, next, local);
        this.d.appData.deleteJournal(serverId);
        progress.complete('commit', complete
            ? `Saved revision ${next.revision}`
            : `Saved revision ${next.revision} as incomplete (${count(sent)} of ${planned === null ? '?' : count(planned)} changes)`);

        progress.enter('cleanup', 'Looking for leftovers on Google Drive');
        let swept = 0;
        try {
            swept = await this.sweepLeftovers(serverId, next);
        } catch (err) {
            console.warn('[sync] could not look for leftovers:', toAppError(err).detail);
        }
        progress.complete('cleanup', swept > 0 ? `Moved ${plural(swept, 'leftover file')} to the trash` : 'No leftovers on Google Drive');
        console.log(`[sync] cancelled upload of ${serverId} saved as revision ${next.revision}: ${sent} of ${planned ?? '?'} changes`);
        return { revision: next.revision, sent, planned };
    }

    /** A journal plus a cloud revision one above it, written by me, means my commit landed but the
     *  app stopped before saving the base. Finish that instead of reporting a conflict. */
    private recoverCommitted(serverId: string, journalBase: number, remote: Manifest | null, me: UserInfo): boolean {
        if (!remote || remote.parentRevision !== journalBase || remote.author.email !== me.email) return false;
        const base = this.d.appData.readBase(serverId);
        if (base && base.revision === remote.revision) {
            this.d.appData.deleteJournal(serverId);
            return true;
        }
        this.adoptRemoteAsBase(serverId, remote, new Map());
        this.d.appData.deleteJournal(serverId);
        console.log(`[sync] finished an upload whose commit (revision ${remote.revision}) had already landed`);
        return true;
    }

    private journalMemory(serverId: string, journal: UploadJournal | null): JournalMemory {
        const memory: JournalMemory = { legacy: false, folders: {}, done: new Map(), started: new Set(), gone: new Set() };
        if (!journal) return memory;
        if (!journal.logged) {
            memory.legacy = true;
            return memory;
        }
        for (const e of this.d.appData.readJournalLog(serverId)) {
            if (e.t === 'folder') memory.folders[e.p] = e.id;
            else if (e.t === 'start') memory.started.add(e.p);
            else if (e.t === 'done') memory.done.set(e.p, { id: e.id, md5: e.md5, size: e.size });
            else memory.gone.add(e.p);
        }
        return memory;
    }

    /** Writes each job to journal.log as it starts and as it ends. */
    private journalHooks(log: Log): RunHooks {
        return {
            onStart: (job) => {
                if (job.kind === 'upload' || job.kind === 'delete-remote') log({ t: 'start', p: job.path });
            },
            onDone: (o) => {
                if (o.kind === 'upload') log({ t: 'done', p: o.path, id: o.driveId, md5: o.md5, size: o.size });
                else if (o.kind === 'delete-remote') log({ t: 'gone', p: o.path });
            },
        };
    }

    private writeBaseFrom(serverId: string, m: Manifest, local: Snapshot): void {
        const files: Record<string, BaseEntry> = {};
        for (const [p, e] of Object.entries(m.files)) {
            const l = local.get(p);
            files[p] = { ...e, mtimeMs: l && l.md5 === e.md5 ? l.mtimeMs ?? -1 : -1 };
        }
        this.d.appData.writeBase(serverId, { format: 2, serverId, revision: m.revision, files, folders: { ...m.folders } });
    }

    private uploadJob(
        serverId: string, root: string, p: string, size: number, md5: string, driveId: string | undefined, folders: Record<string, string>,
    ): TransferJob {
        const dir = parentOf(p);
        return {
            kind: 'upload', path: p, name: baseName(p), size, md5, source: this.abs(root, p), driveId,
            parentId: driveId ? undefined : dir ? folders[dir] : serverId,
            appProperties: driveId ? undefined : creationTags(serverId, p),
        };
    }

    /** A file someone trashed by hand in the Drive website cannot be updated in place: create it again. */
    private async recreateMissing(
        serverId: string, root: string, result: TransferResult, folders: Record<string, string>, signal: AbortSignal | undefined,
        progress: ProgressSink, hooks: RunHooks, log: Log,
    ): Promise<TransferResult> {
        const missing = result.failed.filter((f) => f.job.kind === 'upload' && f.job.driveId && f.error.code === 'NOT_FOUND');
        if (missing.length === 0) return result;
        const paths = missing.map((f) => f.job.path);
        const ensured = await this.ensureFolders(serverId, paths, folders, new Set(Object.keys(folders)), signal, progress, log);
        Object.assign(folders, ensured);
        const retry = missing.map((f) => {
            const job = f.job as Extract<TransferJob, { kind: 'upload' }>;
            return this.uploadJob(serverId, root, job.path, job.size, job.md5, undefined, folders);
        });
        progress.enter('files', `Uploading ${plural(retry.length, 'file')} again that were removed on the Drive website`);
        const second = await this.d.transfers.run('Uploading files', retry, signal, hooks);
        progress.settle('files', second.done.length);
        return {
            done: [...result.done, ...second.done],
            failed: [...result.failed.filter((f) => !missing.includes(f)), ...second.failed],
        };
    }

    /** Paths whose Drive file was trashed or deleted outside the app. One listing per folder (in parallel);
     *  only files missing from their folder's listing cost an extra request. */
    private async missingTargets(serverId: string, paths: string[], files: Record<string, ManifestEntry>, folders: Record<string, string>): Promise<Set<string>> {
        const gone = new Set<string>();
        const byParent = new Map<string, string[]>();
        for (const p of paths) {
            const dir = parentOf(p);
            const parentId = dir ? folders[dir] : serverId;
            if (parentId) byParent.set(parentId, [...(byParent.get(parentId) ?? []), p]);
        }
        const notListed: string[] = [];
        await eachLimited([...byParent], LOOKUP_CONCURRENCY, async ([parentId, group]) => {
            let present: Set<string>;
            try {
                present = new Set((await this.d.drive.listChildren(parentId)).map((c) => c.id));
            } catch (err) {
                if (!isNotFound(err)) throw err;
                present = new Set();
            }
            for (const p of group) if (!present.has(files[p].driveId)) notListed.push(p);
        });
        // Not in its folder: moved elsewhere (still usable) or really gone.
        await eachLimited(notListed, LOOKUP_CONCURRENCY, async (p) => {
            if (!(await this.fileAlive(files[p].driveId))) gone.add(p);
        });
        if (gone.size > 0) console.warn(`[sync] ${gone.size} files were removed outside the app and will be uploaded again`);
        return gone;
    }

    /** For a repair: every file of the manifest, checked against what Google Drive really holds. One listing
     *  per folder (in parallel); only files missing from their folder's listing cost an extra request. */
    private async checkCloud(serverId: string, remote: Manifest, signal: AbortSignal | undefined, progress: ProgressSink): Promise<CloudCheck> {
        const paths = Object.keys(remote.files);
        const check: CloudCheck = { changed: new Set(), gone: new Set() };
        progress.setTotal('verify', paths.length);
        progress.enter('verify', `Checking ${plural(paths.length, 'file')} on Google Drive`);
        let checked = 0;
        const judge = (p: string, meta: DriveFileMeta | null): void => {
            if (!meta || meta.trashed || meta.appProperties?.[APP_PROPS.tombstone] === '1') check.gone.add(p);
            else if (meta.md5Checksum?.toLowerCase() !== remote.files[p].md5.toLowerCase()) check.changed.add(p);
            checked += 1;
            progress.report('verify', checked, paths.length, `Checking files on Google Drive (${count(checked)} of ${count(paths.length)})`);
        };
        const byParent = new Map<string, string[]>();
        for (const p of paths) {
            const dir = parentOf(p);
            const parentId = (dir ? remote.folders[dir] : serverId) ?? '';
            byParent.set(parentId, [...(byParent.get(parentId) ?? []), p]);
        }
        const notListed: string[] = [];
        await eachLimited([...byParent], LOOKUP_CONCURRENCY, async ([parentId, group]) => {
            signal?.throwIfAborted();
            const present = new Map<string, DriveFileMeta>();
            try {
                if (parentId) for (const child of await this.d.drive.listChildren(parentId)) present.set(child.id, child);
            } catch (err) {
                if (!isNotFound(err)) throw err;
            }
            for (const p of group) {
                const meta = present.get(remote.files[p].driveId);
                if (meta) judge(p, meta);
                else notListed.push(p);
            }
        });
        // Not in its folder: moved elsewhere (into pending-delete as a placeholder, for example) or really gone.
        await eachLimited(notListed, LOOKUP_CONCURRENCY, async (p) => {
            signal?.throwIfAborted();
            let meta: DriveFileMeta | null = null;
            try {
                meta = await this.d.drive.getMeta(remote.files[p].driveId);
            } catch (err) {
                if (!isNotFound(err)) throw err;
            }
            judge(p, meta);
        });
        const broken = check.changed.size + check.gone.size;
        progress.complete('verify', broken > 0
            ? `${plural(broken, 'file')} on Google Drive no longer match revision ${remote.revision}`
            : `Every file on Google Drive matches revision ${remote.revision}`);
        if (broken > 0) console.log(`[sync] repair of ${serverId}: ${check.changed.size} changed, ${check.gone.size} gone`);
        return check;
    }

    private async fileAlive(id: string): Promise<boolean> {
        try {
            return !(await this.d.drive.getMeta(id)).trashed;
        } catch (err) {
            if (isNotFound(err)) return false;
            throw err;
        }
    }

    /** Files of mine, tagged with this server, that an interrupted attempt may have created for `paths`.
     *  One search over the whole server instead of one listing per folder; also finds files in a folder that
     *  exists twice. Newest last. */
    private async findOwnFiles(serverId: string, paths: string[], progress: ProgressSink): Promise<Map<string, DriveFileMeta[]>> {
        progress.enter('files', 'Checking what the interrupted upload already sent');
        return this.ownTaggedFiles(serverId, paths);
    }

    private async ownTaggedFiles(serverId: string, paths: string[]): Promise<Map<string, DriveFileMeta[]>> {
        const byHash = new Map(paths.map((p) => [pathHash(p), p]));
        const wanted = new Set(paths);
        const found = new Map<string, DriveFileMeta[]>();
        for (const item of await this.d.drive.listMyTagged(serverId)) {
            const props = item.appProperties ?? {};
            if (item.mimeType === FOLDER_MIME || props[APP_PROPS.tombstone] === '1') continue;
            const hash = props[APP_PROPS.pathHash];
            const p = hash !== undefined ? byHash.get(hash) : props[APP_PROPS.path];
            if (p === undefined || !wanted.has(p)) continue;
            found.set(p, [...(found.get(p) ?? []), item]);
        }
        return found;
    }

    private async alreadyUploaded(driveId: string, md5: string): Promise<boolean> {
        try {
            const meta = await this.d.drive.getMeta(driveId);
            return !meta.trashed && meta.md5Checksum === md5;
        } catch {
            return false;
        }
    }

    /** Folder ids for the parents of new files. Missing folders are created level by level (parents before
     *  children), each level in parallel lanes. Ids in `verify` come from the manifest and may be stale. */
    private async ensureFolders(
        serverId: string, newFiles: string[], known: Record<string, string>, verify: Set<string>,
        signal: AbortSignal | undefined, progress: ProgressSink, log: Log,
    ): Promise<Record<string, string>> {
        const folders = { ...known };
        const needed = new Set<string>();
        for (const p of newFiles) {
            const dir = parentOf(p);
            if (dir) for (const ancestor of ancestorsOf(dir)) needed.add(ancestor);
        }
        if (needed.size === 0) {
            progress.complete('folders', 'No new folders needed');
            return folders;
        }
        progress.enter('folders', 'Looking up folders on Google Drive');
        const stale = [...needed].filter((dir) => folders[dir] !== undefined && verify.has(dir));
        await eachLimited(stale, LOOKUP_CONCURRENCY, async (dir) => {
            if (!(await this.fileAlive(folders[dir]))) delete folders[dir];
        });

        const missing = [...needed].filter((dir) => folders[dir] === undefined);
        progress.setTotal('folders', missing.length);
        const byDepth = new Map<number, string[]>();
        for (const dir of missing) {
            const depth = dir.split('/').length;
            byDepth.set(depth, [...(byDepth.get(depth) ?? []), dir]);
        }
        const createdNow = new Set<string>();
        let created = 0;
        for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
            const level = sorted(byDepth.get(depth)!);
            // A parent that existed before may already hold a folder of that name (another member's, or one an
            // interrupted attempt made without logging it): list each such parent once.
            const parentsToList = [...new Set(level.map(parentOf))].filter((dir) => !createdNow.has(dir));
            const existing = new Map<string, Map<string, string>>();
            await eachLimited(parentsToList, LOOKUP_CONCURRENCY, async (dir) => {
                const names = new Map<string, string>();
                for (const child of await this.d.drive.listChildren(dir ? folders[dir] : serverId, { foldersOnly: true })) {
                    if (!names.has(child.name)) names.set(child.name, child.id);           // oldest wins
                }
                existing.set(dir, names);
            });
            const jobs: TransferJob[] = [];
            let found = 0;
            for (const dir of level) {
                const parentDir = parentOf(dir);
                const id = existing.get(parentDir)?.get(baseName(dir));
                if (id) {
                    folders[dir] = id;
                    log({ t: 'folder', p: dir, id });
                    found += 1;
                    continue;
                }
                jobs.push({
                    kind: 'create-folder', path: dir, name: baseName(dir), parentId: parentDir ? folders[parentDir] : serverId,
                    serverId, appProperties: creationTags(serverId, dir),
                });
            }
            progress.settle('folders', found);
            if (jobs.length === 0) continue;
            progress.enter('folders', `Creating ${plural(missing.length, 'folder')} on Google Drive`);
            const result = await this.d.transfers.run('Creating folders', jobs, signal, {
                onDone: (o) => {
                    if (o.kind !== 'create-folder') return;
                    folders[o.path] = o.driveId;
                    log({ t: 'folder', p: o.path, id: o.driveId });
                },
            });
            progress.settle('folders', result.done.length);
            if (result.failed.length > 0) {
                throw new AppError(
                    'UPLOAD_INCOMPLETE',
                    `${plural(result.failed.length, 'folder')} could not be created on Google Drive. Press Retry to try again.`,
                    result.failed.slice(0, 5).map((f) => `${f.job.path}: ${f.error.message}`).join('\n'),
                );
            }
            for (const job of jobs) createdNow.add(job.path);
            created += jobs.length;
        }
        progress.complete('folders', created > 0 ? `Created ${plural(created, 'folder')} on Google Drive` : 'All folders already exist');
        return folders;
    }

    /** After a commit: files of mine tagged with this server that the new manifest does not use are leftovers
     *  of interrupted attempts (or of the duplicate folders older versions could make). They go to the trash,
     *  so 30 days remain to undo a mistake. Placeholders and folders are left alone. */
    private async sweepLeftovers(serverId: string, manifest: Manifest): Promise<number> {
        const used = new Set(Object.values(manifest.files).map((f) => f.driveId));
        const leftovers = (await this.d.drive.listMyTagged(serverId)).filter((item) =>
            item.mimeType !== FOLDER_MIME && !used.has(item.id) && item.appProperties?.[APP_PROPS.tombstone] !== '1');
        let trashed = 0;
        await eachLimited(leftovers, LOOKUP_CONCURRENCY, async (item) => {
            try {
                await this.d.drive.trash(item.id);
                trashed += 1;
            } catch (err) {
                if (!isNotFound(err)) console.warn(`[sync] could not trash leftover ${item.name}:`, toAppError(err).detail);
            }
        });
        if (trashed > 0) console.log(`[sync] moved ${trashed} leftover files of ${serverId} to the trash`);
        return trashed;
    }

    /* ------------------------------------------------------------------ placeholders */

    /** Deletes, for good, my placeholders that no manifest references any more. Needs no lock. */
    cleanupMyPlaceholders(): Promise<number> {
        if (!this.cleaning) {
            this.cleaning = this.cleanupNow().finally(() => {
                this.cleaning = null;
            });
        }
        return this.cleaning;
    }

    private async cleanupNow(): Promise<number> {
        const mine = await this.d.drive.listTombstones({ mineOnly: true });
        if (mine.length === 0) return 0;
        const byServer = new Map<string, typeof mine>();
        for (const file of mine) {
            const server = file.appProperties?.[APP_PROPS.server] ?? '';
            byServer.set(server, [...(byServer.get(server) ?? []), file]);
        }
        let deleted = 0;
        for (const [serverId, files] of byServer) {
            let referenced = new Set<string>();
            if (serverId) {
                try {
                    const m = await readManifest(this.d.launcher, serverId);
                    if (m) referenced = new Set(Object.values(m.files).map((f) => f.driveId));
                } catch (err) {
                    if (!(err instanceof DriveError) || (err.status !== 404 && err.status !== 403)) {
                        console.warn(`[sync] skipped placeholder cleanup for ${serverId}:`, toAppError(err).detail);
                        continue;
                    }
                }
            }
            // An upload that has not committed yet still points at a referenced placeholder.
            await eachLimited(files.filter((file) => !referenced.has(file.id)), LOOKUP_CONCURRENCY, async (file) => {
                try {
                    await this.d.drive.deleteForever(file.id);
                    deleted += 1;
                } catch (err) {
                    if (!isNotFound(err)) console.warn(`[sync] could not delete placeholder ${file.name}:`, toAppError(err).detail);
                }
            });
        }
        if (deleted > 0) this.d.step(`Deleted ${deleted} of your old files that other members removed`, 'done', 'minor');
        return deleted;
    }

    /** Before an owner trashes a whole server: hand every file someone else owns back to its owner for deletion. */
    async markForeignFilesDeleted(serverId: string): Promise<number> {
        const m = await readManifest(this.d.launcher, serverId);
        if (!m) return 0;
        const me = await this.d.me();
        const deletedAt = this.iso();
        let marked = 0;
        await eachLimited(Object.values(m.files), LOOKUP_CONCURRENCY, async (entry) => {
            try {
                const meta = await this.d.drive.getMeta(entry.driveId);
                if (meta.ownedByMe || meta.trashed || !meta.capabilities?.canModifyContent) return;
                await this.d.drive.markDeleted(entry.driveId, {
                    [APP_PROPS.tombstone]: '1', [APP_PROPS.server]: serverId,
                    [APP_PROPS.deletedBy]: me.email, [APP_PROPS.deletedAt]: deletedAt,
                });
                marked += 1;
            } catch (err) {
                if (!isNotFound(err)) console.warn('[sync] could not hand a file back to its owner:', toAppError(err).detail);
            }
        });
        console.log(`[sync] marked ${marked} files of other members for deletion before deleting ${serverId}`);
        return marked;
    }

    private async pendingCleanup(serverId: string, me: UserInfo): Promise<PendingCleanup> {
        try {
            const all = await this.d.drive.listTombstones({ mineOnly: false, serverId });
            const others = new Map<string, number>();
            let mine = 0;
            for (const file of all) {
                const owner = file.owners?.[0]?.emailAddress ?? 'unknown';
                if (file.ownedByMe || owner === me.email) mine += 1;
                else others.set(owner, (others.get(owner) ?? 0) + 1);
            }
            return { mine, others: [...others].map(([ownerEmail, n]) => ({ ownerEmail, count: n })) };
        } catch (err) {
            console.warn('[sync] could not count placeholders:', toAppError(err).detail);
            return { mine: 0, others: [] };
        }
    }

    /* ------------------------------------------------------------------ helpers */

    private async analyze(
        serverId: string, createRules: boolean, signal: AbortSignal | undefined, lock: LockView,
        progress: ProgressSink = NO_PROGRESS, stage: ProgressStageKey = 'scan',
    ): Promise<Analysis> {
        const root = await this.requireRoot(serverId);
        const me = await this.d.me();
        const base = this.d.appData.readBase(serverId);
        const remote = await readManifest(this.d.launcher, serverId);
        const isIgnored = await this.loadRules(serverId, createRules);
        const baseSnap = baseToSnapshot(base);
        // Nothing in the cloud yet: everything will be uploaded, so only the sizes matter now. Hashing a big world
        // takes a while and happens at the upload anyway.
        const local = await this.scan(serverId, root, baseSnap, isIgnored, signal, progress, stage, remote !== null);
        const remoteSnap = manifestToSnapshot(remote);

        let plan: SyncPlan;
        let status: SyncStatus;
        if (!remote) {
            plan = { ...emptyPlan(), upload: sorted(local.keys()) };
            status = 'new-server';
        } else {
            plan = planSync(baseSnap, local, remoteSnap);
            status = deriveStatus(plan);
        }
        // Someone else's upload stopped half way: their app must finish it before anyone plays. My own is
        // resumed by the session instead, when this PC has its journal (otherwise it ran on another PC).
        // A lock this PC left behind is its own business either way: with a journal Start finishes it, without one
        // nothing had been sent yet.
        if (lock.state === 'stale' && lock.lock.phase === 'uploading' && !lock.leftByThisPc
            && (lock.lock.host.email.toLowerCase() !== me.email.toLowerCase() || this.d.appData.readJournal(serverId) === null)) {
            status = 'unfinished-upload';
        }
        return { root, me, remote, baseRevision: base?.revision ?? null, local, remoteSnap, plan, status, lock };
    }

    /** Hashes only files whose size or modification time changed since the base or the last scan. */
    private async scan(
        serverId: string, root: string, base: Snapshot, isIgnored: (rel: string) => boolean, signal: AbortSignal | undefined,
        progress: ProgressSink = NO_PROGRESS, stage: ProgressStageKey = 'scan', hash = true,
    ): Promise<Snapshot> {
        const key = `${serverId}|${root}`;
        const last = this.lastScan.get(key);
        const known = last ? new Map([...base, ...last]) : base;
        const local = await scanLocal(root, known, isIgnored, signal, (done, total) => {
            progress.report(stage, done, total, `Checking your files (${count(done)} of ${count(total)})`);
        }, { hash });
        if (hash) this.lastScan.set(key, local);                    // a sizes-only scan has no md5s to reuse
        return local;
    }

    private async requireRoot(serverId: string): Promise<string> {
        const localPath = this.d.settings.getServer(serverId).localPath;
        if (!localPath) throw new AppError('NO_LOCAL_PATH', 'Choose a folder on this PC for this server first.');
        try {
            if ((await stat(localPath)).isDirectory()) return localPath;
        } catch {
            // fall through
        }
        throw new AppError('NO_LOCAL_PATH', `The server folder ${localPath} does not exist any more. Choose it again.`);
    }

    private abs(root: string, rel: string): string {
        return path.join(root, ...rel.split('/'));
    }

    private iso(): string {
        return new Date((this.d.now ?? Date.now)()).toISOString();
    }
}
