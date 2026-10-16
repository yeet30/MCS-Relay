// Decides what to move between this PC and the cloud, and moves it.
// preflight() only reads. download() and uploadSession() run while the session holds the lock.
// The manifest is written LAST in an upload: that single write is the commit (Part 2, section 7).
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { APP_PROPS } from '../../shared/types';
import type {
    BaseEntry, ConflictChoice, LockView, Manifest, ManifestEntry, PendingCleanup, Snapshot,
    StepMessage, SyncPlan, SyncReport, SyncRules, SyncStatus, UserInfo,
} from '../../shared/types';
import { BUILTIN_IGNORES, DEFAULT_SHARED_IGNORES, ancestorsOf, baseName, compileRules, normalizeRule, parentOf } from '../../shared/paths';
import { DriveError } from '../drive/types';
import type { DriveApi, DriveFileMeta } from '../drive/types';
import { AppError, toAppError } from '../errors';
import type { LockService } from '../lock/LockService';
import type { SettingsService } from '../settings/SettingsService';
import type { AppData } from '../store/appData';
import type { JobOutcome, TransferEngine, TransferJob, TransferResult } from '../transfer/TransferEngine';
import type { LauncherFiles } from './launcherFiles';
import { baseToSnapshot, manifestToSnapshot, readManifest, readRules, writeManifest, writeRules } from './manifest';
import { allowedChoices, deriveStatus, emptyPlan, planMirrorRemote, planSync, planUpload, sumBytes } from './planner';
import { scanLocal } from './scanner';

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

const FREE_LOCK: LockView = { state: 'free', lock: null };
const META_CONCURRENCY = 8;

function isNotFound(err: unknown): boolean {
    return err instanceof DriveError && err.status === 404;
}

function sorted(paths: Iterable<string>): string[] {
    return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

    constructor(private readonly d: SyncEngineDeps) {}

    /* ------------------------------------------------------------------ reading */

    /** Read-only on Drive and on disk: what would happen if this PC started a session now. */
    async preflight(serverId: string, signal?: AbortSignal): Promise<SyncReport> {
        const checkedAt = this.iso();
        const report: SyncReport = {
            serverId, status: 'error', firstSyncOnThisPc: this.d.appData.readBase(serverId) === null,
            baseRevision: null, remoteRevision: null, remoteAuthor: null, remoteCreatedAt: null,
            plan: emptyPlan(), downloadBytes: 0, uploadBytes: 0, allowedChoices: [],
            pendingChoice: this.choices.get(serverId) ?? null, cleanup: { mine: 0, others: [] },
            lock: FREE_LOCK, checkedAt,
        };
        try {
            report.lock = await this.d.lock.inspect(serverId);
            const a = await this.analyze(serverId, false, signal, report.lock);
            report.status = a.status;
            report.baseRevision = a.baseRevision;
            report.remoteRevision = a.remote?.revision ?? null;
            report.remoteAuthor = a.remote ? a.remote.author : null;
            report.remoteCreatedAt = a.remote?.createdAt ?? null;
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

    async download(serverId: string, _report: SyncReport, signal?: AbortSignal): Promise<void> {
        const lock = await this.d.lock.inspect(serverId);
        // Plan again: the cloud may have changed since the preflight the user looked at.
        const a = await this.analyze(serverId, true, signal, lock);
        const choice = this.choices.get(serverId) ?? null;
        if (!a.remote) {
            if (this.d.appData.readBase(serverId) === null) {
                this.d.appData.writeBase(serverId, { format: 2, serverId, revision: 0, files: {}, folders: {} });
            }
            this.d.step('This server has no files in the cloud yet; your folder will be uploaded after the session', 'done', 'minor');
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
        let result: TransferResult = { done: [], failed: [] };
        if (jobs.length > 0) {
            this.d.step(`Downloading ${download.length} files from the cloud`, 'loading', 'major');
            result = await this.d.transfers.run('Downloading', jobs, signal);
            if (result.failed.length > 0) {
                throw new AppError(
                    'DOWNLOAD_INCOMPLETE',
                    `${result.failed.length} of ${jobs.length} files could not be downloaded, so the server was not started.`,
                    result.failed.slice(0, 5).map((f) => `${f.job.path}: ${f.error.message}`).join('\n'),
                );
            }
            this.d.step(`Downloaded ${download.length} files`, 'done', 'major');
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

    async uploadSession(serverId: string, signal?: AbortSignal): Promise<{ uploaded: number; deleted: number; revision: number }> {
        const root = await this.requireRoot(serverId);
        const isIgnored = await this.loadRules(serverId, true);
        let journal = this.d.appData.readJournal(serverId);
        let remote = await readManifest(this.d.launcher, serverId);
        const me = await this.d.me();

        if (journal && this.recoverCommitted(serverId, journal.baseRevision, remote, me)) {
            journal = null;
        }
        const base = this.d.appData.readBase(serverId);
        const baseRevision = base?.revision ?? 0;
        const local = await scanLocal(root, baseToSnapshot(base), isIgnored, signal);
        // Without a cloud manifest everything is new, whatever the base says.
        const planBase = remote ? baseToSnapshot(base) : new Map();
        const { upload, deleteRemote } = planUpload(planBase, local);

        if (upload.length === 0 && deleteRemote.length === 0) {
            if (journal) this.d.appData.deleteJournal(serverId);
            this.d.step('Nothing changed, so nothing was uploaded', 'done', 'major');
            return { uploaded: 0, deleted: 0, revision: remote?.revision ?? baseRevision };
        }
        if (remote && remote.revision !== baseRevision) {
            throw new AppError('CONFLICT', 'The cloud changed since this PC last synced, so the upload was stopped to protect the other copy.');
        }
        const resuming = journal !== null;
        this.d.appData.writeJournal(serverId, { format: 1, serverId, startedAt: this.iso(), baseRevision, sessionId: this.d.lock.sessionId });

        const remoteFiles: Record<string, ManifestEntry> = remote?.files ?? {};
        // A file someone trashed by hand on the Drive website would still accept new content, but nobody
        // else could download it any more: such paths are created again instead of updated.
        const gone = await this.missingTargets(serverId, upload.filter((p) => remoteFiles[p]), remoteFiles, remote?.folders ?? {});
        const isNew = (p: string): boolean => !remoteFiles[p] || gone.has(p);
        const folders = await this.ensureFolders(serverId, upload.filter(isNew), remote?.folders ?? {});
        const reused: Array<Extract<JobOutcome, { kind: 'upload' }>> = [];
        const jobs: TransferJob[] = [];
        // A resumed upload finds the files the interrupted attempt already created, so it does not create them twice.
        const earlier = resuming ? await this.filesFromEarlierAttempt(serverId, upload.filter(isNew), folders) : new Map<string, DriveFileMeta>();
        for (const p of upload) {
            const l = local.get(p)!;
            const existing = isNew(p) ? undefined : remoteFiles[p];
            const earlierFile = earlier.get(p);
            if (resuming && existing && (await this.alreadyUploaded(existing.driveId, l.md5))) {
                reused.push({ kind: 'upload', path: p, driveId: existing.driveId, md5: l.md5, size: l.size });
                continue;
            }
            if (earlierFile && earlierFile.md5Checksum === l.md5) {
                reused.push({ kind: 'upload', path: p, driveId: earlierFile.id, md5: l.md5, size: l.size });
                continue;
            }
            jobs.push(this.uploadJob(serverId, root, p, l.size, l.md5, existing?.driveId ?? earlierFile?.id, folders));
        }
        const deletions = deleteRemote.filter((p) => remoteFiles[p]);
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

        this.d.step(`Uploading ${upload.length - reused.length} files${deletions.length ? ` and removing ${deletions.length}` : ''}`, 'loading', 'major');
        let result = jobs.length > 0 ? await this.d.transfers.run('Uploading', jobs, signal) : { done: [], failed: [] };
        result = await this.recreateMissing(serverId, root, result, folders, signal);
        if (result.failed.length > 0) {
            throw new AppError(
                'UPLOAD_INCOMPLETE',
                `${result.failed.length} files could not be uploaded. Your session is kept on this PC; press Retry.`,
                result.failed.slice(0, 5).map((f) => `${f.job.path}: ${f.error.message}`).join('\n'),
            );
        }

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
        this.d.step(`Uploaded the session (revision ${next.revision})`, 'done', 'major');
        void this.cleanupMyPlaceholders().catch((err: unknown) => console.warn('[sync] placeholder cleanup failed:', toAppError(err).detail));
        return { uploaded: upload.length, deleted: deletions.length, revision: next.revision };
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
            appProperties: driveId ? undefined : { [APP_PROPS.server]: serverId, [APP_PROPS.path]: p },
        };
    }

    /** A file someone trashed by hand in the Drive website cannot be updated in place: create it again. */
    private async recreateMissing(
        serverId: string, root: string, result: TransferResult, folders: Record<string, string>, signal?: AbortSignal,
    ): Promise<TransferResult> {
        const missing = result.failed.filter((f) => f.job.kind === 'upload' && f.job.driveId && f.error.code === 'NOT_FOUND');
        if (missing.length === 0) return result;
        const dirs = missing.map((f) => f.job.path);
        const ensured = await this.ensureFolders(serverId, dirs, folders);
        Object.assign(folders, ensured);
        const retry = missing.map((f) => {
            const job = f.job as Extract<TransferJob, { kind: 'upload' }>;
            return this.uploadJob(serverId, root, job.path, job.size, job.md5, undefined, folders);
        });
        const second = await this.d.transfers.run('Uploading', retry, signal);
        return {
            done: [...result.done, ...second.done],
            failed: [...result.failed.filter((f) => !missing.includes(f)), ...second.failed],
        };
    }

    /** Paths whose Drive file was trashed or deleted outside the app. One listing per folder; only files
     *  missing from their folder's listing cost an extra request. */
    private async missingTargets(serverId: string, paths: string[], files: Record<string, ManifestEntry>, folders: Record<string, string>): Promise<Set<string>> {
        const gone = new Set<string>();
        const byParent = new Map<string, string[]>();
        for (const p of paths) {
            const dir = parentOf(p);
            const parentId = dir ? folders[dir] : serverId;
            if (parentId) byParent.set(parentId, [...(byParent.get(parentId) ?? []), p]);
        }
        for (const [parentId, group] of byParent) {
            let present: Set<string>;
            try {
                present = new Set((await this.d.drive.listChildren(parentId)).map((c) => c.id));
            } catch (err) {
                if (!isNotFound(err)) throw err;
                present = new Set();
            }
            for (const p of group) {
                if (present.has(files[p].driveId)) continue;
                // Not in its folder: moved elsewhere (still usable) or really gone.
                if (!(await this.fileAlive(files[p].driveId))) gone.add(p);
            }
        }
        if (gone.size > 0) console.warn(`[sync] ${gone.size} files were removed outside the app and will be uploaded again`);
        return gone;
    }

    private async fileAlive(id: string): Promise<boolean> {
        try {
            return !(await this.d.drive.getMeta(id)).trashed;
        } catch (err) {
            if (isNotFound(err)) return false;
            throw err;
        }
    }

    /** My files, tagged with this server and path, that sit where an earlier, uncommitted attempt put them. */
    private async filesFromEarlierAttempt(serverId: string, newPaths: string[], folders: Record<string, string>): Promise<Map<string, DriveFileMeta>> {
        const found = new Map<string, DriveFileMeta>();
        const byParent = new Map<string, string[]>();
        for (const p of newPaths) {
            const dir = parentOf(p);
            const parentId = dir ? folders[dir] : serverId;
            if (parentId) byParent.set(parentId, [...(byParent.get(parentId) ?? []), p]);
        }
        for (const [parentId, paths] of byParent) {
            const wanted = new Set(paths);
            for (const child of await this.d.drive.listChildren(parentId)) {
                const p = child.appProperties?.[APP_PROPS.path];
                if (!p || !wanted.has(p) || found.has(p) || !child.ownedByMe) continue;
                if (child.appProperties?.[APP_PROPS.server] !== serverId || child.appProperties?.[APP_PROPS.tombstone]) continue;
                found.set(p, child);
            }
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

    /** Folder ids for the parents of new files, creating missing folders parents-first. */
    private async ensureFolders(serverId: string, newFiles: string[], known: Record<string, string>): Promise<Record<string, string>> {
        const folders = { ...known };
        const needed = new Set<string>();
        for (const p of newFiles) {
            const dir = parentOf(p);
            if (dir) for (const ancestor of ancestorsOf(dir)) needed.add(ancestor);
        }
        const ordered = [...needed].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
        for (const dir of ordered) {
            if (folders[dir] && (await this.fileAlive(folders[dir]))) continue;
            const parentDir = parentOf(dir);
            const parentId = parentDir ? folders[parentDir] : serverId;
            const name = baseName(dir);
            const existing = await this.d.drive.listChildren(parentId, { name, foldersOnly: true });
            folders[dir] = existing[0]?.id ?? (await this.d.drive.createFolder(name, parentId)).id;
        }
        return folders;
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
            for (const file of files) {
                if (referenced.has(file.id)) continue;          // an upload that has not committed yet still points at it
                try {
                    await this.d.drive.deleteForever(file.id);
                    deleted += 1;
                } catch (err) {
                    if (!isNotFound(err)) console.warn(`[sync] could not delete placeholder ${file.name}:`, toAppError(err).detail);
                }
            }
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
        await eachLimited(Object.values(m.files), META_CONCURRENCY, async (entry) => {
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
            return { mine, others: [...others].map(([ownerEmail, count]) => ({ ownerEmail, count })) };
        } catch (err) {
            console.warn('[sync] could not count placeholders:', toAppError(err).detail);
            return { mine: 0, others: [] };
        }
    }

    /* ------------------------------------------------------------------ helpers */

    private async analyze(serverId: string, createRules: boolean, signal: AbortSignal | undefined, lock: LockView): Promise<Analysis> {
        const root = await this.requireRoot(serverId);
        const me = await this.d.me();
        const base = this.d.appData.readBase(serverId);
        const remote = await readManifest(this.d.launcher, serverId);
        const isIgnored = await this.loadRules(serverId, createRules);
        const baseSnap = baseToSnapshot(base);
        const local = await scanLocal(root, baseSnap, isIgnored, signal);
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
        // Someone else's upload stopped half way: their app must finish it before anyone plays.
        // My own unfinished upload is resumed by the session instead (it has the journal).
        if (lock.state === 'stale' && lock.lock.phase === 'uploading' && lock.lock.host.email.toLowerCase() !== me.email.toLowerCase()) {
            status = 'unfinished-upload';
        }
        return { root, me, remote, baseRevision: base?.revision ?? null, local, remoteSnap, plan, status, lock };
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
