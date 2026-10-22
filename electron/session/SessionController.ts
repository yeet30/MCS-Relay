// The one place that knows what phase a hosting session is in.
// Every decision is taken from this.state.phase, never from a UI flag.
import type { EventName, Events } from '../../shared/ipc';
import type {
    AppErrorInfo, ConflictChoice, LockPhase, LockView, PlayitTunnel, RunKind, SessionPhase, SessionProgress, SessionState,
    StepMessage, SyncReport, TransferSnapshot, UserInfo,
} from '../../shared/types';
import { formatDuration } from '../../shared/duration';
import { ancestorsOf, parentOf } from '../../shared/paths';
import { AppError, toAppError } from '../errors';
import type { LockService } from '../lock/LockService';
import type { MinecraftProcess } from '../processes/MinecraftProcess';
import type { PlayitProcess } from '../processes/PlayitProcess';
import type { SettingsService } from '../settings/SettingsService';
import type { ChangeTracker } from '../sync/changeTracker';
import type { SyncEngine } from '../sync/SyncEngine';
import { NO_PROGRESS } from '../sync/progressSink';
import type { ProgressSink } from '../sync/progressSink';
import { OrchestrationProgress } from './progress';
import type { RunInfo, StagePlan } from './progress';

export interface EventSink {
    emit<E extends EventName>(event: E, payload: Events[E]): void;
}

export interface SessionDeps {
    lock: Pick<LockService, 'inspect' | 'claim' | 'update' | 'release' | 'releaseIfMine' | 'isHolding'>;
    sync: Pick<SyncEngine,
        'preflight' | 'resolve' | 'download' | 'uploadSession' | 'loadRules' | 'hasJournal' | 'serversWithJournal'
        | 'discardJournal' | 'baseRevision' | 'cleanupMyPlaceholders' | 'unfinishedRepair' | 'commitPartial'>;
    changes: Pick<ChangeTracker, 'start' | 'stop' | 'clear' | 'all'>;
    minecraft: Pick<MinecraftProcess, 'start' | 'stopAndWait' | 'isRunning' | 'send'>;
    playit: Pick<PlayitProcess, 'start' | 'stop'>;
    settings: Pick<SettingsService, 'get' | 'set' | 'getServer'>;
    events: EventSink;
    me: () => Promise<UserInfo>;
    now?: () => number;
    lockPollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    timeouts?: { playitMs?: number; minecraftMs?: number; stopMs?: number };
    /** Tells the user (notification, chime) that a start or stop finished. */
    notify?: (n: { title: string; body: string; outcome: 'done' | 'failed' }) => void;
    serverName?: (serverId: string) => string | null;
}

const MAX_STEPS = 100;
const MAX_CONSOLE = 1000;
const LOCK_PHASES = new Set<SessionPhase>(['downloading', 'launching', 'running', 'stopping', 'uploading']);
const IDLE_PHASES = new Set<SessionPhase>(['idle', 'failed']);
const STARTING_PHASES = new Set<SessionPhase>(['checking', 'claiming', 'downloading', 'launching']);
/** A start or a download is cancelled (back to idle); an upload is paused (Continue resumes it). */
const CANCELLABLE_PHASES = new Set<SessionPhase>([...STARTING_PHASES, 'uploading']);
const JAVA_NOTE = 'This takes a minute or two, longer with mods or a big world. The server console further down this page shows what the server is doing; the button at the bottom right takes you there.';
const FIRST_UPLOAD_NOTE = 'First upload of this server: every folder and file has to be created on Google Drive, so this takes much longer than later uploads.';
const REPAIR_NOTE = 'Every file of the last saved version is checked on Google Drive first, so a repair takes a while even when little is broken.';
const CHECK_EMIT_MS = 200;
const KEPT_DOWNLOADS = 'Files that already arrived are kept, so the next run downloads only the rest.';

type UploadKind = Extract<RunKind, 'stop' | 'retry' | 'resume' | 'up' | 'repair'>;

const IDLE: SessionState = {
    phase: 'idle', serverId: null, startedAt: null, address: null, tunnels: [], players: [], javaRunning: false, error: null,
};

const uploadFailed = (name: string): string => `The upload of ${name} did not finish`;
/** The notification for a run that failed, by what the run was doing. */
const FAILED_TITLES: Record<RunKind, (name: string) => string> = {
    start: (name) => `${name} could not start`,
    stop: uploadFailed,
    retry: uploadFailed,
    resume: uploadFailed,
    up: uploadFailed,
    down: (name) => `${name} could not be downloaded`,
    repair: (name) => `The repair of ${name} did not finish`,
};

/** The tunnel shown first: the one this PC chose earlier, else the Minecraft Java one, else the first. */
export function primaryTunnel(tunnels: PlayitTunnel[], preferred: string | null): PlayitTunnel | null {
    return tunnels.find((t) => t.address === preferred)
        ?? tunnels.find((t) => t.type === 'minecraft-java')
        ?? tunnels[0]
        ?? null;
}

function isCode(err: unknown, code: AppErrorInfo['code']): boolean {
    return err instanceof AppError && err.code === code;
}

/** Files a start will download according to the last check (an estimate until the download plans again). */
function downloadCount(report: SyncReport): number {
    const plan = report.plan;
    const mirror = report.pendingChoice === 'keep-cloud' ? plan.conflicts.length + plan.upload.length : 0;
    return plan.download.length + plan.deleteLocal.length + mirror;
}

/** A repair only makes sense for an unfinished upload, and only from a PC that has the last saved version:
 *  that copy is what the cloud is put back to. */
function checkRepairable(report: SyncReport): void {
    if (report.status !== 'unfinished-upload') {
        throw new AppError('INVALID', 'There is no unfinished upload to repair: the server can be used normally.');
    }
    const holder = report.lock.lock?.host.name ?? 'the other member';
    if (report.remoteRevision === null) {
        throw new AppError('INVALID', `The cloud has no saved version yet, so there is nothing to repair. Ask ${holder} to open MCS-Relay to finish the first upload.`);
    }
    if (report.baseRevision !== report.remoteRevision) {
        throw new AppError('INVALID', report.baseRevision === null
            ? `This PC has never synced this server, so it does not have revision ${report.remoteRevision} to repair the cloud with.`
            : `This PC has revision ${report.baseRevision}, but the last saved version is revision ${report.remoteRevision}. Only a PC that has revision ${report.remoteRevision} can repair it.`);
    }
}

export class SessionController {
    private state: SessionState = { ...IDLE };
    private report: SyncReport | null = null;
    private stepLog: StepMessage[] = [];
    private consoleLog: string[] = [];
    private selected: string | null = null;
    private abort: AbortController | null = null;
    /** The start / stop / upload that is running now; shutdown() waits for it. */
    private current: Promise<void> | null = null;
    private lockLost = false;
    /** startedAt of the last run whose failure was announced (its final snapshot can be emitted more than once). */
    private announcedFailure: string | null = null;
    private cancelled = false;
    /** The cancel is for good: what was sent is saved as an incomplete version instead of pausing. */
    private abandoning = false;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private nextStepId = 1;
    private lastTransfer: TransferSnapshot | null = null;
    private readonly progress: OrchestrationProgress;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly d: SessionDeps) {
        this.now = d.now ?? Date.now;
        this.sleep = d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.progress = new OrchestrationProgress({
            emit: (progress) => {
                this.d.events.emit('session:progress', progress);
                this.announceIfFailed(progress);
            },
            log: {
                open: (message, importance) => this.openTask(message, importance),
                update: (id, message, status) => this.updateTask(id, message, status),
            },
            now: this.now,
        });
    }

    /* ------------------------------------------------------------------ queries */

    getState(): SessionState {
        return { ...this.state, players: [...this.state.players], tunnels: [...this.state.tunnels] };
    }

    lastReport(): SyncReport | null {
        return this.report;
    }

    steps(): StepMessage[] {
        return [...this.stepLog];
    }

    consoleLines(): string[] {
        return [...this.consoleLog];
    }

    getProgress(): SessionProgress {
        return this.progress.snapshot();
    }

    /** Every transfer snapshot (wired by main.ts): moves the bar of the stage that is transferring. */
    onTransfer(snapshot: TransferSnapshot): void {
        this.lastTransfer = snapshot;
        this.progress.applyTransfer(snapshot);
    }

    isBusy(): boolean {
        return !IDLE_PHASES.has(this.state.phase);
    }

    /* ------------------------------------------------------------------ selection and preflight */

    async select(serverId: string | null): Promise<void> {
        this.selected = serverId;
        this.d.settings.set({ selectedServerId: serverId });
        this.stopPolling();
        if (this.report && this.report.serverId !== serverId) this.report = null;
        if (!serverId) return;
        if (!this.isBusy()) {
            try {
                await this.preflight(serverId);
            } catch (err) {
                console.warn('[session] preflight after select failed:', toAppError(err).detail);
            }
        }
        this.schedulePoll();
    }

    async preflight(serverId: string, progress?: ProgressSink, signal?: AbortSignal): Promise<SyncReport> {
        const report = await this.d.sync.preflight(serverId, signal, progress ?? this.checkProgress(serverId));
        if (serverId === this.selected || serverId === this.state.serverId) this.report = report;
        this.d.events.emit('sync:report', report);
        this.d.events.emit('lock:update', { serverId, view: report.lock });
        return report;
    }

    /** Outside a run a check has no progress bar: how far it got goes to the status card (sync:checking). */
    private checkProgress(serverId: string): ProgressSink {
        let last = 0;
        return {
            ...NO_PROGRESS,
            report: (_key, done, total) => {
                const now = this.now();
                if (done > 0 && done < total && now - last < CHECK_EMIT_MS) return;
                last = now;
                this.d.events.emit('sync:checking', { serverId, done, total });
            },
        };
    }

    async resolve(serverId: string, choice: ConflictChoice): Promise<SyncReport> {
        if (this.isBusy()) throw new AppError('BUSY', 'Wait until the current session has finished.');
        const report = await this.d.sync.resolve(serverId, choice);
        this.report = report;
        this.d.events.emit('sync:report', report);
        return report;
    }

    /* ------------------------------------------------------------------ start */

    start(serverId: string): Promise<void> {
        if (this.isBusy()) return Promise.reject(new AppError('BUSY', 'A session is already in progress.'));
        const run = this.runStart(serverId);
        this.current = run.catch(() => undefined);
        return run;
    }

    private async runStart(serverId: string): Promise<void> {
        this.stopPolling();
        this.cancelled = false;
        this.abandoning = false;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        this.setState({ ...IDLE, phase: 'checking', serverId });
        if (this.d.sync.hasJournal(serverId) && !(await this.finishUnfinishedUpload(serverId))) {
            // The lock is not free yet (state back to idle), or the upload failed again or was paused (upload-pending).
            if (this.cancelled) return this.endCancelledCheck(serverId);
            const info = this.state.error ?? { code: 'UNFINISHED_UPLOAD' as const, message: 'Your last upload of this server has not finished yet. Try again in a minute.' };
            if (this.state.phase === 'checking') this.setState({ ...IDLE });
            throw new AppError(info.code, info.message, info.detail);
        }
        if (this.cancelled) return this.endCancelledCheck(serverId);
        this.lockLost = false;
        this.setState({ ...IDLE, phase: 'checking', serverId });
        const settings = this.d.settings.get();
        const usePlayit = settings.usePlayitgg && Boolean(settings.playitggPath);
        const known = this.report?.serverId === serverId ? this.report : null;
        this.progress.begin('Starting the server', [
            { key: 'check', label: 'Checking the server', total: 1 },
            { key: 'claim', label: 'Reserving the server', total: 1 },
            { key: 'scan', label: 'Checking your files', total: 1 },
            { key: 'download', label: 'Downloading files', total: known ? downloadCount(known) : 0 },
            { key: 'playit', label: 'Starting playit.gg', total: usePlayit ? 1 : 0 },
            { key: 'java', label: 'Starting the Minecraft server', total: settings.launchServer ? 1 : 0 },
            { key: 'watch', label: 'Watching the folder for changes', total: 1 },
        ], { kind: 'start', serverId });
        if (!usePlayit) this.progress.skip('playit');
        if (!settings.launchServer) this.progress.skip('java');

        let report: SyncReport;
        try {
            this.progress.enter('check', 'Checking the server');
            if (settings.launchServer && !settings.eulaAccepted) {
                throw new AppError('INVALID', 'Accept the Minecraft EULA before starting the server.');
            }
            report = await this.preflight(serverId, this.progress, signal);
            signal.throwIfAborted();
            this.checkReport(report);
            this.progress.setTotal('download', downloadCount(report));
            this.progress.complete('check', 'Checked the server');
        } catch (err) {
            if (this.cancelled) {
                this.progress.finish('cancelled', 'The start was cancelled');
                return this.endCancelledCheck(serverId);
            }
            this.progress.finish('failed', toAppError(err).message);
            this.setState({ ...IDLE });
            this.schedulePoll();
            throw err;
        }

        try {
            this.setState({ phase: 'claiming' });
            this.progress.enter('claim', 'Reserving the server');
            await this.claim(serverId, report);
            this.progress.complete('claim', 'The server is reserved for you');
            signal.throwIfAborted();

            await this.enter('downloading');
            await this.d.sync.download(serverId, report, signal, this.progress);
            this.throwIfLost();

            await this.enter('launching');
            const server = this.d.settings.getServer(serverId);
            let address: string | null = null;
            if (usePlayit) {
                this.progress.enter('playit', 'Starting playit.gg');
                const tunnels = await this.d.playit.start(
                    settings.playitggPath, this.d.timeouts?.playitMs ?? 60_000, signal, (next) => void this.tunnelsChanged(serverId, next),
                );
                address = primaryTunnel(tunnels, settings.playitPrimary)?.address ?? null;
                this.setState({ address, tunnels });
                const more = tunnels.length > 1 ? ` (and ${tunnels.length - 1} more)` : '';
                this.progress.complete('playit', `playit.gg is ready: ${address}${more}`);
            }
            if (settings.launchServer) {
                this.progress.enter('java', 'Waiting for the Minecraft server to finish loading');
                this.progress.setNote(JAVA_NOTE);
                this.onMinecraftOutput([`[System] Starting the Minecraft server (${new Date(this.now()).toLocaleTimeString()})`]);
                await this.d.minecraft.start({
                    serverPath: server.localPath ?? '', javaFlags: server.javaFlags,
                    readyTimeoutMs: this.d.timeouts?.minecraftMs ?? 180_000, signal, acceptEula: settings.eulaAccepted,
                });
                this.setState({ javaRunning: true });
                this.progress.setNote(null);
                this.progress.complete('java', 'The Minecraft server is ready');
            }
            this.throwIfLost();

            this.progress.enter('watch', 'Watching the folder for changes');
            const startedAt = new Date(this.now()).toISOString();
            this.setState({ phase: 'running', startedAt });
            await this.d.lock.update(serverId, { phase: 'running', startedAt, address: this.state.address, tunnels: this.state.tunnels });
            this.d.changes.clear();
            if (server.localPath) await this.d.changes.start(server.localPath, await this.d.sync.loadRules(serverId));
            this.progress.complete('watch', 'Hosting');
            this.progress.finish('done');
            this.announce(serverId, 'done', `${this.nameOf(serverId)} is running`,
                `${this.state.address ? `Friends can join at ${this.state.address}. ` : ''}Started in ${this.elapsed()}.`);
        } catch (err) {
            const info = this.lockLost ? this.lostInfo() : toAppError(err);
            const downloading = this.state.phase === 'downloading';
            this.abort?.abort();
            this.progress.finish(
                this.cancelled ? 'cancelled' : 'failed',
                this.cancelled ? `The start was cancelled.${downloading ? ` ${KEPT_DOWNLOADS}` : ''}` : info.message,
            );
            await this.stopProcesses();
            await this.d.changes.stop();
            await this.d.lock.releaseIfMine(serverId);
            if (this.cancelled) {
                this.setState({ ...IDLE });
                void this.refreshAfterSession(serverId);
                return;
            }
            console.warn('[session] start failed:', info.detail ?? info.message);
            this.setState({ ...IDLE, phase: 'failed', serverId, error: info });
            throw new AppError(info.code, info.message, info.detail);
        }
    }

    private checkReport(report: SyncReport): void {
        switch (report.status) {
            case 'unfinished-upload':
                throw new AppError('UNFINISHED_UPLOAD', `${report.lock.lock?.host.name ?? 'Another member'}'s last upload did not finish. Their app finishes it the next time it opens.`);
            case 'no-local-path':
                throw new AppError('NO_LOCAL_PATH', 'Choose a folder on this PC for this server first.');
            case 'error':
                throw new AppError('UNKNOWN', report.error ?? 'The server could not be checked.');
            case 'diverged':
                if (!report.pendingChoice) throw new AppError('CONFLICT', 'Your copy and the cloud both changed. Choose which version to keep first.');
                return;
            default:
                return;
        }
    }

    /** Claims the lock. A lock left by this PC's previous run (the app crashed or was killed) is still
     *  "held" until its lease runs out, so we wait for that instead of telling the user someone else plays. */
    private async claim(serverId: string, report: SyncReport): Promise<void> {
        const baseRevision = report.baseRevision ?? 0;
        try {
            await this.d.lock.claim(serverId, baseRevision);
            return;
        } catch (err) {
            if (!isCode(err, 'LOCK_HELD')) throw err;
            const view = await this.d.lock.inspect(serverId);
            const me = await this.d.me();
            if (view.state !== 'held' || view.lock.host.email.toLowerCase() !== me.email.toLowerCase()) throw err;
            const waitSeconds = Math.max(1, Math.ceil(view.lock.leaseSeconds - view.ageSeconds) + 2);
            this.progress.enter('claim', `Waiting ${waitSeconds} s for this PC's previous session to expire`);
            await this.wait(waitSeconds * 1000);
            this.abort?.signal.throwIfAborted();
        }
        await this.d.lock.claim(serverId, baseRevision);
    }

    /* ------------------------------------------------------------------ stop and upload */

    /** running: stop and upload. While starting: cancel the start. Otherwise waits for what is in progress. */
    stop(): Promise<void> {
        if (STARTING_PHASES.has(this.state.phase) && this.abort) return this.cancel();
        if (this.state.phase !== 'running') return this.current ?? Promise.resolve();
        const run = this.runStop();
        this.current = run.catch(() => undefined);
        return run;
    }

    /** While this PC hosts: which playit.gg tunnel is shown first, here and to the other members (through the lock).
     *  Remembered on this PC for the next sessions. */
    async setPrimaryTunnel(address: string): Promise<void> {
        const tunnel = this.state.tunnels.find((t) => t.address === address);
        if (!tunnel) throw new AppError('INVALID', 'That playit.gg tunnel is not running any more.');
        this.d.settings.set({ playitPrimary: tunnel.address });
        if (this.state.address === tunnel.address) return;
        this.setState({ address: tunnel.address });
        const serverId = this.state.serverId;
        if (serverId && this.state.phase === 'running') await this.d.lock.update(serverId, { address: tunnel.address });
    }

    /** playit.gg listed other tunnels while it runs (one was added or removed on playit.gg). */
    private async tunnelsChanged(serverId: string, tunnels: PlayitTunnel[]): Promise<void> {
        const { phase } = this.state;
        if (this.state.serverId !== serverId || (phase !== 'launching' && phase !== 'running')) return;
        const address = primaryTunnel(tunnels, this.d.settings.get().playitPrimary)?.address ?? null;
        this.setState({ address, tunnels });
        if (phase !== 'running') return;
        try {
            await this.d.lock.update(serverId, { address, tunnels });
        } catch (err) {
            console.warn('[session] could not write the new playit.gg tunnels into the lock:', toAppError(err).message);
        }
    }

    /** Cancels what is running; resolves when it has stopped. A start or a download goes back to idle (files that
     *  already arrived stay). An upload pauses: the server stays reserved and Continue picks it up where it
     *  stopped, from the journal. Stopping the Minecraft server and releasing the server cannot be cancelled. */
    cancel(): Promise<void> {
        // While Java saves the world nothing is interrupted: the request is kept, and no upload starts afterwards.
        if (this.state.phase === 'stopping' && this.progress.snapshot().kind === 'stop') {
            if (!this.cancelled) console.log('[session] stop asked while the Minecraft server saves the world: no upload will start');
            this.cancelled = true;
            return this.current ?? Promise.resolve();
        }
        if (!CANCELLABLE_PHASES.has(this.state.phase) || !this.abort) {
            return Promise.reject(new AppError('INVALID', 'There is nothing to cancel right now.'));
        }
        if (!this.cancelled) {
            this.cancelled = true;
            console.log(`[session] cancelled by the user while ${this.state.phase}`);
            this.abort.abort();
        }
        return this.current ?? Promise.resolve();
    }

    /** A run cancelled before it reserved the server: back to idle, nothing to undo. */
    private endCancelledCheck(serverId: string): void {
        if (this.state.phase === 'checking' || this.state.phase === 'claiming') this.setState({ ...IDLE });
        void this.refreshAfterSession(serverId);
    }

    private async runStop(): Promise<void> {
        const serverId = this.state.serverId!;
        this.cancelled = false;
        this.abandoning = false;
        const javaRunning = this.state.javaRunning || this.d.minecraft.isRunning();
        const playitRunning = this.state.address !== null;
        this.progress.begin('Stopping and uploading', this.uploadPlan({
            stopJava: javaRunning, stopPlayit: playitRunning, ...this.estimateUpload(serverId),
        }), { note: this.uploadNote(serverId), kind: 'stop', serverId });
        await this.enter('stopping');
        await this.d.changes.stop();
        if (javaRunning) this.progress.enter('stop-java', 'Stopping the Minecraft server (it saves the world first)');
        try {
            await this.d.minecraft.stopAndWait(this.d.timeouts?.stopMs ?? 60_000);
        } catch (err) {
            // Java is still writing the world: uploading now could save a half-written region file.
            const info = toAppError(err);
            this.progress.finish('failed', info.message);
            await this.d.playit.stop();
            this.setState({ phase: 'upload-pending', javaRunning: this.d.minecraft.isRunning(), error: info });
            return;
        }
        this.setState({ javaRunning: false, players: [] });
        if (javaRunning) this.progress.complete('stop-java', 'The Minecraft server has stopped');
        if (playitRunning) this.progress.enter('stop-playit', 'Stopping playit.gg');
        await this.d.playit.stop();
        this.setState({ address: null, tunnels: [] });
        if (playitRunning) this.progress.complete('stop-playit', 'playit.gg has stopped');
        if (this.lockLost) return;
        if (this.cancelled) {
            // Pause or Cancel was pressed while the Minecraft server saved the world: nothing has been sent.
            if (this.abandoning) {
                this.progress.finish('cancelled', 'The upload was cancelled before it started');
                await this.finishPartial(serverId);
            } else {
                await this.enter('uploading');                // the lock keeps the server reserved for it
                this.progress.finish('cancelled', 'Upload paused before it started. The server stays reserved for you until you continue.');
                this.setState({ phase: 'upload-pending', error: null });
            }
            return;
        }
        await this.upload(serverId, 'stop');
    }

    private uploadNote(serverId: string): string | null {
        const report = this.report?.serverId === serverId ? this.report : null;
        const first = report ? report.status === 'new-server' : this.d.sync.baseRevision(serverId) === 0;
        return first ? FIRST_UPLOAD_NOTE : null;
    }

    /** The stages of an upload. Folder and file counts are estimates until the scan has run. */
    private uploadPlan(o: {
        check?: boolean; claim?: boolean; stopJava?: boolean; stopPlayit?: boolean; verify?: number; files: number; folders: number;
    }): StagePlan[] {
        const plan: StagePlan[] = [];
        if (o.check) plan.push({ key: 'check', label: 'Checking the server', total: 1 });
        if (o.claim) plan.push({ key: 'claim', label: 'Reserving the server', total: 1 });
        if (o.stopJava) plan.push({ key: 'stop-java', label: 'Stopping the Minecraft server', total: 1 });
        if (o.stopPlayit) plan.push({ key: 'stop-playit', label: 'Stopping playit.gg', total: 1 });
        plan.push(
            { key: 'scan', label: 'Checking your files', total: 1 },
        );
        if (o.verify !== undefined) plan.push({ key: 'verify', label: 'Checking every file on Google Drive', total: o.verify });
        plan.push(
            { key: 'folders', label: 'Creating folders on Google Drive', total: o.folders },
            { key: 'files', label: 'Uploading files', total: o.files },
            { key: 'commit', label: 'Saving the new version', total: 1 },
            { key: 'cleanup', label: 'Cleaning up on Google Drive', total: 1 },
            { key: 'release', label: 'Releasing the server', total: 1 },
        );
        return plan;
    }

    /** Before the scan: the files the last check planned to upload plus everything that changed during the
     *  session; for a new server, every folder of those files has to be created. */
    private estimateUpload(serverId: string): { files: number; folders: number } {
        const report = this.report?.serverId === serverId ? this.report : null;
        const paths = new Set<string>([...(report?.plan.upload ?? []), ...(report?.plan.deleteRemote ?? [])]);
        for (const [p] of this.d.changes.all()) paths.add(p);
        let folders = 0;
        if (report?.status === 'new-server') {
            const dirs = new Set<string>();
            for (const p of paths) {
                const dir = parentOf(p);
                if (dir) for (const ancestor of ancestorsOf(dir)) dirs.add(ancestor);
            }
            folders = dirs.size;
        }
        return { files: paths.size, folders };
    }

    retryUpload(): Promise<void> {
        if (this.state.phase !== 'upload-pending' || !this.state.serverId) {
            return Promise.reject(new AppError('INVALID', 'There is no upload waiting to be retried.'));
        }
        if (this.d.minecraft.isRunning()) {
            return Promise.reject(new AppError('JAVA', 'The Minecraft server is still running. Close it before uploading.'));
        }
        const run = this.runRetry(this.state.serverId);
        this.current = run.catch(() => undefined);
        return run;
    }

    private async runRetry(serverId: string): Promise<void> {
        // A paused upload has no error: it continues instead of retrying something that failed.
        const paused = this.state.error === null;
        this.lockLost = false;
        this.cancelled = false;
        this.abandoning = false;
        this.abort = new AbortController();
        this.setState({ javaRunning: false, error: null });
        const holding = this.d.lock.isHolding(serverId);
        const failed = paused ? 0 : this.lastTransfer?.filesFailed ?? 0;
        const repair = this.d.sync.unfinishedRepair(serverId);
        this.progress.begin(
            paused ? (repair ? 'Continuing the repair' : 'Continuing the upload') : 'Retrying the failed uploads',
            this.uploadPlan({ claim: !holding, verify: repair ? 0 : undefined, files: failed, folders: 0 }),
            { note: repair ? REPAIR_NOTE : this.uploadNote(serverId), kind: repair ? 'repair' : 'retry', serverId },
        );
        this.step(
            paused ? 'Continuing where it stopped'
                : failed > 0 ? `Retrying the ${failed === 1 ? 'file' : `${failed} files`} that failed to upload` : 'Retrying the upload',
            'done', 'major',
        );
        if (!holding) {
            this.setState({ phase: 'claiming' });
            try {
                this.progress.enter('claim', 'Reserving the server again');
                await this.d.lock.claim(serverId, this.d.sync.baseRevision(serverId), { phase: 'uploading', allowStaleFromMe: true });
                this.progress.complete('claim', 'The server is reserved for you');
            } catch (err) {
                const info = toAppError(err);
                this.progress.finish('failed', info.message);
                this.setState({ phase: 'upload-pending', error: info });
                throw err;
            }
        }
        await this.upload(serverId, 'retry');
    }

    /** uploading -> releasing -> idle; on failure upload-pending, still holding the lock. A cancel pauses the
     *  same way, without an error (Continue resumes from the journal). */
    private async upload(serverId: string, kind: UploadKind): Promise<void> {
        await this.enter('uploading');
        const repair = kind === 'repair' || this.d.sync.unfinishedRepair(serverId);
        try {
            await this.d.sync.uploadSession(serverId, this.abort?.signal, this.progress, { repair: kind === 'repair' });
        } catch (err) {
            if (this.lockLost) return;
            if (this.cancelled && this.abandoning) {
                this.progress.finish('cancelled', 'The upload was cancelled');
                await this.finishPartial(serverId);
                return;
            }
            if (this.cancelled) {
                await this.pauseUpload(serverId, repair);
                return;
            }
            const info = toAppError(err);
            this.progress.finish('failed', info.message);
            if (info.code === 'CONFLICT') {
                // Someone committed while we were not holding the lock: keep the files, let the user choose.
                this.d.sync.discardJournal(serverId);
                await this.d.lock.releaseIfMine(serverId);
                this.setState({ ...IDLE, phase: 'failed', serverId, error: info });
                void this.refreshAfterSession(serverId);
                return;
            }
            this.setState({ phase: 'upload-pending', error: info });
            return;
        }
        this.setState({ phase: 'releasing' });
        this.progress.enter('release', 'Releasing the server');
        await this.d.lock.releaseIfMine(serverId);
        this.progress.complete('release', 'The server is free for the others');
        this.progress.finish('done');
        this.setState({ ...IDLE, serverId: null });
        if (repair) {
            this.announce(serverId, 'done', `${this.nameOf(serverId)} is repaired`, `Repaired in ${this.elapsed()}. Everyone can use the server again.`);
        } else {
            this.announce(serverId, 'done', `${this.nameOf(serverId)} is saved to the cloud`,
                `${kind === 'retry' ? 'The retried upload finished' : 'Uploaded'} in ${this.elapsed()}. The server is free for the others.`);
        }
        void this.refreshAfterSession(serverId);
    }

    /** Cancels the upload for good, during it or while it is paused: what reached Google Drive becomes the next
     *  revision, marked incomplete (everyone is warned before they play it), the server is freed, and the rest of
     *  this PC's changes stay for its next upload. Not for repairs, which can only pause. */
    abandonUpload(): Promise<void> {
        const serverId = this.state.serverId;
        if (!serverId) return Promise.reject(new AppError('INVALID', 'There is no upload to cancel.'));
        if (this.d.sync.unfinishedRepair(serverId)) {
            return Promise.reject(new AppError('INVALID', 'A repair cannot be cancelled half way. Pause it and continue it later.'));
        }
        const phase = this.state.phase;
        const kind = this.progress.snapshot().kind;
        const uploading = kind === 'stop' || kind === 'retry' || kind === 'resume' || kind === 'up';
        const startedPause = phase === 'stopping' && kind === 'stop';
        if (uploading && (phase === 'uploading' || phase === 'claiming' || startedPause) && this.abort && (!this.cancelled || startedPause)) {
            this.abandoning = true;
            return this.cancel();
        }
        if (phase === 'upload-pending' && !this.d.minecraft.isRunning()) {
            const run = this.runAbandon(serverId);
            this.current = run.catch(() => undefined);
            return run;
        }
        return Promise.reject(new AppError('INVALID', 'The upload cannot be cancelled at this moment.'));
    }

    /** From a paused (or failed) upload: reserve the server again if needed, then save what was sent. */
    private async runAbandon(serverId: string): Promise<void> {
        this.lockLost = false;
        this.cancelled = false;
        this.abandoning = false;
        this.abort = new AbortController();
        this.setState({ error: null, javaRunning: false });
        if (!this.d.lock.isHolding(serverId)) {
            this.setState({ phase: 'claiming' });
            try {
                await this.d.lock.claim(serverId, this.d.sync.baseRevision(serverId), { phase: 'uploading', allowStaleFromMe: true });
            } catch (err) {
                const info = toAppError(err);
                this.setState({ phase: 'upload-pending', error: info });
                throw err;
            }
        }
        await this.finishPartial(serverId);
    }

    /** Saves what the cancelled upload sent and frees the server. On failure the upload waits again
     *  (upload-pending), so it can still be continued or cancelled once more. */
    private async finishPartial(serverId: string): Promise<void> {
        this.setState({ phase: 'releasing' });
        this.progress.begin('Cancelling the upload', [
            { key: 'commit', label: 'Saving what was sent', total: 1 },
            { key: 'cleanup', label: 'Cleaning up on Google Drive', total: 1 },
            { key: 'release', label: 'Releasing the server', total: 1 },
        ], { kind: 'up', serverId });
        let saved: Awaited<ReturnType<SessionDeps['sync']['commitPartial']>>;
        try {
            saved = await this.d.sync.commitPartial(serverId, this.progress);
        } catch (err) {
            const info = toAppError(err);
            this.progress.finish('failed', info.message);
            this.setState({ phase: 'upload-pending', error: info });
            return;
        }
        if (!saved) {
            this.progress.skip('cleanup');
            this.step('Nothing had reached Google Drive yet, so the cloud did not change', 'done', 'major');
        }
        this.progress.enter('release', 'Releasing the server');
        await this.d.lock.releaseIfMine(serverId);
        this.progress.complete('release', 'The server is free for the others');
        this.progress.finish('done');
        this.setState({ ...IDLE });
        const incomplete = saved !== null && (saved.planned === null || saved.sent < saved.planned);
        this.announce(serverId, 'done', `The upload of ${this.nameOf(serverId)} was cancelled`, !saved
            ? 'Nothing had been sent, so the cloud did not change. Your changes stay on this PC.'
            : incomplete
                ? `Revision ${saved.revision} is saved as incomplete. The rest of your changes stay on this PC for your next upload.`
                : `Everything had already been sent: revision ${saved.revision} is complete.`);
        void this.refreshAfterSession(serverId);
    }

    /** The user paused the upload. With a journal, files may already be on Google Drive: the server stays
     *  reserved until Continue finishes it. Without one nothing was sent yet, so the server is simply freed. */
    private async pauseUpload(serverId: string, repair: boolean): Promise<void> {
        if (!this.d.sync.hasJournal(serverId)) {
            this.progress.finish('cancelled', repair
                ? 'The repair was cancelled before it changed anything'
                : 'The upload was cancelled before anything was sent. Your changes stay on this PC.');
            await this.d.lock.releaseIfMine(serverId);
            this.setState({ ...IDLE });
            void this.refreshAfterSession(serverId);
            return;
        }
        this.progress.finish('cancelled', `${repair ? 'Repair' : 'Upload'} paused. The server stays reserved for you until you continue.`);
        this.setState({ phase: 'upload-pending', error: null });
    }

    /* ------------------------------------------------------------------ sync without playing */

    /** Downloads the latest version, or uploads this PC's changes, under the lock and without starting anything. */
    syncNow(serverId: string, direction: 'down' | 'up'): Promise<void> {
        if (this.isBusy()) return Promise.reject(new AppError('BUSY', 'A session is already in progress.'));
        const run = direction === 'down' ? this.runSyncDown(serverId) : this.runSyncUp(serverId);
        this.current = run.catch(() => undefined);
        return run;
    }

    /** Starts a sync-only run: finishes an unfinished upload first, then checks the server. When the check says
     *  no, the state goes back to idle and the error is thrown; null when the user cancelled. */
    private async checkForSync(serverId: string, title: string, plan: StagePlan[], run: RunInfo): Promise<SyncReport | null> {
        this.stopPolling();
        this.cancelled = false;
        this.abandoning = false;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        this.setState({ ...IDLE, phase: 'checking', serverId });
        if (this.d.sync.hasJournal(serverId) && !(await this.finishUnfinishedUpload(serverId))) {
            if (this.cancelled) {
                this.endCancelledCheck(serverId);
                return null;
            }
            const info = this.state.error ?? { code: 'UNFINISHED_UPLOAD' as const, message: 'Your last upload of this server has not finished yet. Try again in a minute.' };
            if (this.state.phase === 'checking') this.setState({ ...IDLE });
            throw new AppError(info.code, info.message, info.detail);
        }
        if (this.cancelled) {
            this.endCancelledCheck(serverId);
            return null;
        }
        this.lockLost = false;
        this.setState({ ...IDLE, phase: 'checking', serverId });
        this.progress.begin(title, plan, run);
        try {
            this.progress.enter('check', 'Checking the server');
            const report = await this.preflight(serverId, this.progress, signal);
            signal.throwIfAborted();
            this.checkReport(report);
            this.progress.complete('check', 'Checked the server');
            return report;
        } catch (err) {
            if (this.cancelled) {
                this.progress.finish('cancelled', 'Cancelled before anything changed');
                this.endCancelledCheck(serverId);
                return null;
            }
            this.progress.finish('failed', toAppError(err).message);
            this.setState({ ...IDLE });
            this.schedulePoll();
            throw err;
        }
    }

    private async runSyncDown(serverId: string): Promise<void> {
        const known = this.report?.serverId === serverId ? this.report : null;
        const report = await this.checkForSync(serverId, 'Downloading the latest version', [
            { key: 'check', label: 'Checking the server', total: 1 },
            { key: 'claim', label: 'Reserving the server', total: 1 },
            { key: 'scan', label: 'Checking your files', total: 1 },
            { key: 'download', label: 'Downloading files', total: known ? downloadCount(known) : 0 },
            { key: 'release', label: 'Releasing the server', total: 1 },
        ], { kind: 'down', serverId });
        if (!report) return;
        try {
            this.progress.setTotal('download', downloadCount(report));
            this.setState({ phase: 'claiming' });
            this.progress.enter('claim', 'Reserving the server');
            await this.claim(serverId, report);
            this.progress.complete('claim', 'The server is reserved for you');
            this.abort?.signal.throwIfAborted();
            await this.enter('downloading');
            await this.d.sync.download(serverId, report, this.abort?.signal, this.progress);
            this.throwIfLost();
            this.setState({ phase: 'releasing' });
            this.progress.enter('release', 'Releasing the server');
            await this.d.lock.releaseIfMine(serverId);
            this.progress.complete('release', 'The server is free for the others');
            this.progress.finish('done');
            this.setState({ ...IDLE });
            this.announce(serverId, 'done', `${this.nameOf(serverId)} is up to date`, `Downloaded the latest version in ${this.elapsed()}.`);
            void this.refreshAfterSession(serverId);
        } catch (err) {
            if (this.cancelled && !this.lockLost) {
                this.progress.finish('cancelled', `The download was cancelled. ${KEPT_DOWNLOADS}`);
                await this.d.lock.releaseIfMine(serverId);
                this.setState({ ...IDLE });
                void this.refreshAfterSession(serverId);
                return;
            }
            const info = this.lockLost ? this.lostInfo() : toAppError(err);
            this.progress.finish('failed', info.message);
            await this.d.lock.releaseIfMine(serverId);
            this.setState({ ...IDLE, phase: 'failed', serverId, error: info });
            throw new AppError(info.code, info.message, info.detail);
        }
    }

    private async runSyncUp(serverId: string): Promise<void> {
        const hadUnfinished = this.d.sync.hasJournal(serverId);
        const report = await this.checkForSync(serverId, 'Uploading your changes',
            this.uploadPlan({ check: true, claim: true, ...this.estimateUpload(serverId) }), { note: this.uploadNote(serverId), kind: 'up', serverId });
        if (!report) return;
        if (hadUnfinished && report.status === 'in-sync') {
            // Finishing the upload that had stopped was all there was to send.
            this.progress.finish('done');
            this.setState({ ...IDLE });
            this.schedulePoll();
            return;
        }
        const refuse = (message: string): never => {
            this.progress.finish('failed', message);
            this.setState({ ...IDLE });
            this.schedulePoll();
            throw new AppError('INVALID', message);
        };
        if (report.status === 'in-sync') refuse('Nothing changed on this PC, so there is nothing to upload.');
        if (report.status === 'cloud-newer') refuse('The cloud is newer than your copy. Download the latest version first.');
        if (report.status === 'diverged') refuse('Your copy and the cloud both changed. Download the latest version (or choose which version to keep) first.');
        try {
            this.setState({ phase: 'claiming' });
            this.progress.enter('claim', 'Reserving the server');
            await this.d.lock.claim(serverId, report.baseRevision ?? 0, { phase: 'uploading' });
            this.progress.complete('claim', 'The server is reserved for you');
            this.abort?.signal.throwIfAborted();
        } catch (err) {
            await this.d.lock.releaseIfMine(serverId);
            if (this.cancelled) {
                this.progress.finish('cancelled', 'The upload was cancelled before anything was sent');
                this.endCancelledCheck(serverId);
                return;
            }
            const info = toAppError(err);
            this.progress.finish('failed', info.message);
            this.setState({ ...IDLE, phase: 'failed', serverId, error: info });
            throw new AppError(info.code, info.message, info.detail);
        }
        await this.upload(serverId, 'up');
    }

    /* ------------------------------------------------------------------ repair */

    /** The owner's way out when another member's upload stopped half way and their app cannot finish it: takes
     *  the server over, checks every file of the last saved version on Google Drive, puts this PC's copy back
     *  wherever the cloud differs, and saves that as a new version. Needs this PC to be at that version. */
    repair(serverId: string): Promise<void> {
        if (this.isBusy()) return Promise.reject(new AppError('BUSY', 'A session is already in progress.'));
        const run = this.runRepair(serverId);
        this.current = run.catch(() => undefined);
        return run;
    }

    private async runRepair(serverId: string): Promise<void> {
        this.stopPolling();
        this.cancelled = false;
        this.abandoning = false;
        this.lockLost = false;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        this.setState({ ...IDLE, phase: 'checking', serverId });
        this.progress.begin('Repairing the server from this PC',
            this.uploadPlan({ check: true, claim: true, verify: 0, files: 0, folders: 0 }), { note: REPAIR_NOTE, kind: 'repair', serverId });
        let report: SyncReport;
        try {
            this.progress.enter('check', 'Checking the server');
            if (this.d.sync.hasJournal(serverId)) {
                throw new AppError('INVALID', 'This PC has an unfinished upload of its own for this server. Press Start to finish it first.');
            }
            report = await this.preflight(serverId, this.progress, signal);
            signal.throwIfAborted();
            checkRepairable(report);
            this.progress.complete('check', 'Checked the server');
        } catch (err) {
            if (this.cancelled) {
                this.progress.finish('cancelled', 'The repair was cancelled before it changed anything');
                return this.endCancelledCheck(serverId);
            }
            this.progress.finish('failed', toAppError(err).message);
            this.setState({ ...IDLE });
            this.schedulePoll();
            throw err;
        }
        const holder = report.lock.lock?.host.name ?? 'the other member';
        try {
            this.setState({ phase: 'claiming' });
            this.progress.enter('claim', `Taking the server over from ${holder}`);
            await this.d.lock.claim(serverId, report.baseRevision ?? 0, { phase: 'uploading', takeOverUnfinished: true });
            this.progress.complete('claim', `Took the server over from ${holder}`);
            signal.throwIfAborted();
        } catch (err) {
            await this.d.lock.releaseIfMine(serverId);
            if (this.cancelled) {
                this.progress.finish('cancelled', 'The repair was cancelled before it changed anything');
                return this.endCancelledCheck(serverId);
            }
            const info = toAppError(err);
            this.progress.finish('failed', info.message);
            this.setState({ ...IDLE, phase: 'failed', serverId, error: info });
            throw new AppError(info.code, info.message, info.detail);
        }
        console.log(`[session] ${serverId}: repairing the unfinished upload of ${report.lock.lock?.host.email ?? 'someone'}`);
        await this.upload(serverId, 'repair');
    }

    private nameOf(serverId: string): string {
        return this.d.serverName?.(serverId) ?? 'The server';
    }

    /** How long the current (or last) run took, as text. */
    private elapsed(): string {
        const started = this.progress.snapshot().startedAt;
        return formatDuration(started ? this.now() - Date.parse(started) : 0);
    }

    /** Every run that ends in failure is announced once (failure chime, notification), whatever failed in it. */
    private announceIfFailed(progress: SessionProgress): void {
        if (progress.active || progress.outcome !== 'failed' || !progress.serverId || !progress.kind) return;
        if (progress.startedAt === this.announcedFailure) return;   // the same run, emitted again
        this.announcedFailure = progress.startedAt;
        this.announce(progress.serverId, 'failed', FAILED_TITLES[progress.kind](this.nameOf(progress.serverId)), progress.message);
    }

    private announce(serverId: string, outcome: 'done' | 'failed', title: string, body: string): void {
        try {
            this.d.notify?.({ title, body, outcome });
        } catch (err) {
            console.warn(`[session] could not notify about ${serverId}:`, err);
        }
    }

    private async refreshAfterSession(serverId: string): Promise<void> {
        try {
            if (this.selected === serverId) await this.preflight(serverId);
        } catch (err) {
            console.warn('[session] preflight after the session failed:', toAppError(err).detail);
        }
        this.schedulePoll();
    }

    dismiss(): void {
        if (this.state.phase !== 'failed') return;
        const serverId = this.state.serverId;
        this.setState({ ...IDLE });
        if (serverId) void this.refreshAfterSession(serverId);
    }

    /* ------------------------------------------------------------------ while running */

    command(text: string): void {
        if (this.state.phase !== 'running' || !this.d.minecraft.isRunning()) {
            throw new AppError('INVALID', 'The Minecraft server is not running.');
        }
        this.d.minecraft.send(text);
        this.onMinecraftOutput([`> ${text}`]);
    }

    onMinecraftOutput(lines: string[]): void {
        if (lines.length === 0) return;
        this.consoleLog.push(...lines);
        if (this.consoleLog.length > MAX_CONSOLE) this.consoleLog.splice(0, this.consoleLog.length - MAX_CONSOLE);
        this.d.events.emit('console:output', lines);
    }

    onMinecraftExit(code: number | null, expected: boolean): void {
        this.setState({ javaRunning: false, players: [] });
        this.onMinecraftOutput([`[System] The server stopped (exit code ${code ?? 'unknown'})`]);
        if (this.state.phase === 'running' && !expected) {
            this.step(`The Minecraft server stopped unexpectedly (exit code ${code ?? 'unknown'}); saving the world`, 'error', 'major');
            if (this.state.serverId) {
                this.announce(this.state.serverId, 'failed', `${this.nameOf(this.state.serverId)} stopped unexpectedly`,
                    `The Minecraft server exited (code ${code ?? 'unknown'}). The world is being saved and uploaded.`);
            }
            void this.stop().catch((err: unknown) => console.error('[session] stop after a crash failed:', err));
        }
    }

    onPlayers(players: string[]): void {
        this.setState({ players: [...players] });
        const serverId = this.state.serverId;
        if (serverId && this.state.phase === 'running' && this.d.lock.isHolding(serverId)) {
            // Display only; a failed write is retried by the next renewal.
            void this.d.lock.update(serverId, { players }).catch((err: unknown) => console.warn('[session] players not written to the lock:', toAppError(err).detail));
        }
    }

    /** Another PC took the lock: stop everything and do NOT upload, or we would overwrite their session. */
    onLockLost(serverId: string, reason: string): void {
        if (serverId !== this.state.serverId || !this.isBusy()) return;
        console.error(`[session] lock lost for ${serverId}: ${reason}`);
        this.lockLost = true;
        this.abort?.abort();
        const info = this.lostInfo(reason);
        // During a run, its failure is announced with it; while the server just runs, say it here.
        if (!this.progress.isActive()) this.announce(serverId, 'failed', `${this.nameOf(serverId)} was taken over`, info.message);
        this.progress.finish('failed', info.message);
        this.step(info.message, 'error', 'major');
        void (async () => {
            await this.d.changes.stop();
            await this.stopProcesses();
            this.setState({ ...IDLE, phase: 'failed', serverId, error: info });
        })();
    }

    private lostInfo(reason = 'Another member took over the server.'): AppErrorInfo {
        return {
            code: 'LOCK_LOST',
            message: `${reason} Your changes were not uploaded; they are still in your server folder.`,
        };
    }

    private throwIfLost(): void {
        if (this.lockLost) throw new AppError('LOCK_LOST', this.lostInfo().message);
    }

    /* ------------------------------------------------------------------ startup and quit */

    /** At startup: finishes every upload a previous run could not finish, then cleans up my placeholders. */
    async resumeUnfinishedUploads(): Promise<void> {
        const run = (async () => {
            for (const serverId of this.d.sync.serversWithJournal()) {
                if (this.isBusy()) break;
                this.cancelled = false;
                this.abandoning = false;
                this.abort = new AbortController();
                await this.finishUnfinishedUpload(serverId);
            }
        })();
        this.current = run.catch(() => undefined);
        await run;
        void this.d.sync.cleanupMyPlaceholders()
            .catch((err: unknown) => console.warn('[session] placeholder cleanup failed:', toAppError(err).detail));
    }

    /** true when there is no unfinished upload left for this server. The caller prepares this.abort. */
    private async finishUnfinishedUpload(serverId: string): Promise<boolean> {
        if (!this.d.settings.getServer(serverId).localPath) return false;
        this.setState({ error: null });
        const repair = this.d.sync.unfinishedRepair(serverId);
        this.progress.begin(repair ? 'Finishing your repair' : 'Finishing your last upload',
            this.uploadPlan({ claim: true, verify: repair ? 0 : undefined, files: 0, folders: 0 }),
            { note: repair ? REPAIR_NOTE : this.uploadNote(serverId), kind: repair ? 'repair' : 'resume', serverId });
        // A phase of its own while reserving, so the run shows (and can be paused) from its first second.
        this.setState({ phase: 'claiming', serverId });
        try {
            this.progress.enter('claim', 'Reserving the server');
            await this.d.lock.claim(serverId, this.d.sync.baseRevision(serverId), { phase: 'uploading', allowStaleFromMe: true });
            this.progress.complete('claim', 'The server is reserved for you');
        } catch (err) {
            const info = toAppError(err);
            console.warn(`[session] cannot resume the upload of ${serverId} yet:`, info.message);
            this.progress.finish('failed', `Your last upload will be finished when the server is free (${info.message})`);
            this.setState({ ...IDLE });
            return false;
        }
        this.lockLost = false;
        this.setState({ ...IDLE, phase: 'uploading', serverId });
        await this.upload(serverId, 'resume');
        return !this.d.sync.hasJournal(serverId);
    }

    /** For quit and logout: lets a running session stop and upload, waits for whatever is in progress. */
    async shutdown(): Promise<void> {
        this.stopPolling();
        if (this.state.phase === 'running') await this.stop();
        else if (STARTING_PHASES.has(this.state.phase)) await this.stop();
        while (this.current) {
            const waiting = this.current;
            await waiting;
            if (this.current === waiting) break;
        }
        // upload-pending: the journal and the stale "uploading" lock make the next start finish it.
    }

    /* ------------------------------------------------------------------ helpers */

    /** sleep() that ends early when the run is cancelled. */
    private async wait(ms: number): Promise<void> {
        const signal = this.abort?.signal;
        if (!signal) return this.sleep(ms);
        let onAbort = (): void => undefined;
        const aborted = new Promise<void>((resolve) => {
            onAbort = () => resolve();
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            await Promise.race([this.sleep(ms), aborted]);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    private async stopProcesses(): Promise<void> {
        try {
            await this.d.minecraft.stopAndWait(this.d.timeouts?.stopMs ?? 60_000);
        } catch (err) {
            console.error('[session] the Minecraft server could not be stopped:', err);
        }
        await this.d.playit.stop();
        this.setState({ javaRunning: this.d.minecraft.isRunning(), address: null, tunnels: [], players: [] });
    }

    /** Sets the phase and writes it into the lock while we hold it. */
    private async enter(phase: SessionPhase): Promise<void> {
        this.setState({ phase });
        const serverId = this.state.serverId;
        if (serverId && LOCK_PHASES.has(phase) && this.d.lock.isHolding(serverId)) {
            try {
                await this.d.lock.update(serverId, { phase: phase as LockPhase });
            } catch (err) {
                if (isCode(err, 'LOCK_LOST')) throw err;
                console.warn(`[session] could not write phase ${phase} to the lock; the next renewal will:`, toAppError(err).detail);
            }
        }
    }

    private setState(patch: Partial<SessionState>): void {
        this.state = { ...this.state, ...patch };
        this.d.events.emit('session:state', this.getState());
    }

    /** A one-off line in the progress log (a finished fact or an error); stages log themselves. */
    step(message: string, status: StepMessage['status'] = 'done', importance: StepMessage['importance'] = 'minor'): void {
        this.pushStep({ id: this.nextStepId++, message, status, importance, at: new Date(this.now()).toISOString() });
    }

    private openTask(message: string, importance: StepMessage['importance']): number {
        const id = this.nextStepId++;
        this.pushStep({ id, message, status: 'loading', importance, at: new Date(this.now()).toISOString() });
        return id;
    }

    /** The same log line with a new text or status: the UI replaces it in place. */
    private updateTask(id: number, message: string, status: StepMessage['status']): void {
        const index = this.stepLog.findIndex((s) => s.id === id);
        if (index === -1) return;
        const before = this.stepLog[index];
        if (before.message === message && before.status === status) return;
        const entry: StepMessage = { ...before, message, status };
        if (before.status === 'loading' && status !== 'loading') entry.endedAt = new Date(this.now()).toISOString();
        this.stepLog[index] = entry;
        this.d.events.emit('session:step', entry);
    }

    private pushStep(entry: StepMessage): void {
        this.stepLog.push(entry);
        if (this.stepLog.length > MAX_STEPS) this.stepLog.splice(0, this.stepLog.length - MAX_STEPS);
        this.d.events.emit('session:step', entry);
    }

    /* ------------------------------------------------------------------ lock polling while idle */

    private schedulePoll(): void {
        this.stopPolling();
        if (!this.selected) return;
        this.pollTimer = setTimeout(() => void this.poll(), this.d.lockPollMs ?? 20_000);
    }

    private stopPolling(): void {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;
    }

    private async poll(): Promise<void> {
        this.pollTimer = null;
        const serverId = this.selected;
        if (!serverId || this.isBusy()) return;
        try {
            const view = await this.d.lock.inspect(serverId);
            if (this.selected !== serverId || this.isBusy()) return;
            const before: LockView | undefined = this.report?.serverId === serverId ? this.report.lock : undefined;
            const changed = !before || before.state !== view.state || before.lock?.sessionId !== view.lock?.sessionId
                || before.lock?.phase !== view.lock?.phase;
            if (changed && view.state === 'free') {
                await this.preflight(serverId);               // someone finished: the cloud has probably moved on
            } else {
                if (this.report?.serverId === serverId) this.report = { ...this.report, lock: view };
                this.d.events.emit('lock:update', { serverId, view });
            }
        } catch (err) {
            console.warn('[session] lock poll failed:', toAppError(err).detail);
        }
        if (this.selected === serverId && !this.isBusy()) this.schedulePoll();
    }

    /** Stops the idle poll timer (for tests and logout). */
    dispose(): void {
        this.stopPolling();
        this.progress.dispose();
        this.selected = null;
    }
}
