// The one place that knows what phase a hosting session is in (Part 2, Figure 3).
// Every decision is taken from this.state.phase, never from a UI flag (F8).
import type { EventName, Events } from '../../shared/ipc';
import type {
    AppErrorInfo, ConflictChoice, LockPhase, LockView, SessionPhase, SessionState, StepMessage, SyncReport, UserInfo,
} from '../../shared/types';
import { AppError, toAppError } from '../errors';
import type { LockService } from '../lock/LockService';
import type { MinecraftProcess } from '../processes/MinecraftProcess';
import type { PlayitProcess } from '../processes/PlayitProcess';
import type { SettingsService } from '../settings/SettingsService';
import type { ChangeTracker } from '../sync/changeTracker';
import type { SyncEngine } from '../sync/SyncEngine';

export interface EventSink {
    emit<E extends EventName>(event: E, payload: Events[E]): void;
}

export interface SessionDeps {
    lock: Pick<LockService, 'inspect' | 'claim' | 'update' | 'release' | 'releaseIfMine' | 'isHolding'>;
    sync: Pick<SyncEngine,
        'preflight' | 'resolve' | 'download' | 'uploadSession' | 'loadRules' | 'hasJournal' | 'serversWithJournal'
        | 'discardJournal' | 'baseRevision' | 'cleanupMyPlaceholders'>;
    changes: Pick<ChangeTracker, 'start' | 'stop' | 'clear'>;
    minecraft: Pick<MinecraftProcess, 'start' | 'stopAndWait' | 'isRunning' | 'send'>;
    playit: Pick<PlayitProcess, 'start' | 'stop'>;
    settings: Pick<SettingsService, 'get' | 'set' | 'getServer'>;
    events: EventSink;
    me: () => Promise<UserInfo>;
    now?: () => number;
    lockPollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    timeouts?: { playitMs?: number; minecraftMs?: number; stopMs?: number };
}

const MAX_STEPS = 50;
const MAX_CONSOLE = 1000;
const LOCK_PHASES = new Set<SessionPhase>(['downloading', 'launching', 'running', 'stopping', 'uploading']);
const IDLE_PHASES = new Set<SessionPhase>(['idle', 'failed']);
const STARTING_PHASES = new Set<SessionPhase>(['checking', 'claiming', 'downloading', 'launching']);

const IDLE: SessionState = {
    phase: 'idle', serverId: null, startedAt: null, address: null, players: [], javaRunning: false, error: null,
};

function isCode(err: unknown, code: AppErrorInfo['code']): boolean {
    return err instanceof AppError && err.code === code;
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
    private cancelled = false;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly d: SessionDeps) {
        this.now = d.now ?? Date.now;
        this.sleep = d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    /* ------------------------------------------------------------------ queries */

    getState(): SessionState {
        return { ...this.state, players: [...this.state.players] };
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

    async preflight(serverId: string): Promise<SyncReport> {
        const report = await this.d.sync.preflight(serverId);
        if (serverId === this.selected || serverId === this.state.serverId) this.report = report;
        this.d.events.emit('sync:report', report);
        this.d.events.emit('lock:update', { serverId, view: report.lock });
        return report;
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
        this.setState({ ...IDLE, phase: 'checking', serverId });
        if (this.d.sync.hasJournal(serverId) && !(await this.finishUnfinishedUpload(serverId))) {
            // Either the lock is not free yet (state back to idle) or the upload failed again (upload-pending).
            const info = this.state.error ?? { code: 'UNFINISHED_UPLOAD' as const, message: 'Your last upload of this server has not finished yet. Try again in a minute.' };
            if (this.state.phase === 'checking') this.setState({ ...IDLE });
            throw new AppError(info.code, info.message, info.detail);
        }
        this.lockLost = false;
        this.cancelled = false;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        this.setState({ ...IDLE, phase: 'checking', serverId });
        this.step('Checking the server', 'loading', 'major');

        let report: SyncReport;
        try {
            report = await this.preflight(serverId);
            this.checkReport(report);
        } catch (err) {
            this.step(toAppError(err).message, 'error', 'major');
            this.setState({ ...IDLE });
            this.schedulePoll();
            throw err;
        }

        try {
            this.setState({ phase: 'claiming' });
            await this.claim(serverId, report);
            this.step('The server is yours for this session', 'done', 'minor');

            await this.enter('downloading');
            await this.d.sync.download(serverId, report, signal);
            this.throwIfLost();

            await this.enter('launching');
            const settings = this.d.settings.get();
            const server = this.d.settings.getServer(serverId);
            let address: string | null = null;
            if (settings.usePlayitgg && settings.playitggPath) {
                this.step('Starting playit.gg', 'loading', 'minor');
                address = await this.d.playit.start(settings.playitggPath, this.d.timeouts?.playitMs ?? 60_000, signal);
                this.setState({ address });
                this.step(`playit.gg is ready: ${address}`, 'done', 'minor');
            }
            if (settings.launchServer) {
                this.step('Starting the Minecraft server', 'loading', 'major');
                this.onMinecraftOutput([`[System] Starting the Minecraft server (${new Date(this.now()).toLocaleTimeString()})`]);
                await this.d.minecraft.start({
                    serverPath: server.localPath ?? '', javaFlags: server.javaFlags,
                    readyTimeoutMs: this.d.timeouts?.minecraftMs ?? 180_000, signal,
                });
                this.setState({ javaRunning: true });
                this.step('The Minecraft server is ready', 'done', 'major');
            }
            this.throwIfLost();

            const startedAt = new Date(this.now()).toISOString();
            this.setState({ phase: 'running', startedAt });
            await this.d.lock.update(serverId, { phase: 'running', startedAt, address });
            this.d.changes.clear();
            if (server.localPath) await this.d.changes.start(server.localPath, await this.d.sync.loadRules(serverId));
            this.step('Hosting', 'done', 'major');
        } catch (err) {
            const info = this.lockLost ? this.lostInfo() : toAppError(err);
            this.abort?.abort();
            await this.stopProcesses();
            await this.d.changes.stop();
            await this.d.lock.releaseIfMine(serverId);
            if (this.cancelled) {
                this.step('The start was cancelled', 'done', 'major');
                this.setState({ ...IDLE });
                void this.refreshAfterSession(serverId);
                return;
            }
            console.warn('[session] start failed:', info.detail ?? info.message);
            this.step(info.message, 'error', 'major');
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
            this.step(`Waiting ${waitSeconds} s for this PC's previous session to expire`, 'loading', 'minor');
            await this.sleep(waitSeconds * 1000);
            this.abort?.signal.throwIfAborted();
        }
        await this.d.lock.claim(serverId, baseRevision);
    }

    /* ------------------------------------------------------------------ stop and upload */

    /** running: stop and upload. While starting: cancel the start. Otherwise waits for what is in progress. */
    stop(): Promise<void> {
        if (STARTING_PHASES.has(this.state.phase) && this.abort) {
            this.cancelled = true;
            this.abort.abort();
            return this.current ?? Promise.resolve();
        }
        if (this.state.phase !== 'running') return this.current ?? Promise.resolve();
        const run = this.runStop();
        this.current = run.catch(() => undefined);
        return run;
    }

    private async runStop(): Promise<void> {
        const serverId = this.state.serverId!;
        await this.enter('stopping');
        this.step('Stopping the server', 'loading', 'major');
        await this.d.changes.stop();
        try {
            await this.d.minecraft.stopAndWait(this.d.timeouts?.stopMs ?? 60_000);
        } catch (err) {
            // Java is still writing the world: uploading now could save a half-written region file.
            const info = toAppError(err);
            this.step(info.message, 'error', 'major');
            await this.d.playit.stop();
            this.setState({ phase: 'upload-pending', javaRunning: this.d.minecraft.isRunning(), error: info });
            return;
        }
        this.setState({ javaRunning: false, players: [] });
        await this.d.playit.stop();
        this.setState({ address: null });
        this.step('The server has stopped', 'done', 'major');
        if (this.lockLost) return;
        await this.upload(serverId);
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
        this.lockLost = false;
        this.abort = new AbortController();
        this.setState({ javaRunning: false, error: null });
        if (!this.d.lock.isHolding(serverId)) {
            try {
                await this.d.lock.claim(serverId, this.d.sync.baseRevision(serverId), { phase: 'uploading', allowStaleFromMe: true });
            } catch (err) {
                const info = toAppError(err);
                this.setState({ phase: 'upload-pending', error: info });
                throw err;
            }
        }
        await this.upload(serverId);
    }

    /** uploading -> releasing -> idle; on failure upload-pending, still holding the lock. */
    private async upload(serverId: string): Promise<void> {
        await this.enter('uploading');
        try {
            await this.d.sync.uploadSession(serverId, this.abort?.signal);
        } catch (err) {
            if (this.lockLost) return;
            const info = toAppError(err);
            if (info.code === 'CONFLICT') {
                // Someone committed while we were not holding the lock: keep the files, let the user choose.
                this.d.sync.discardJournal(serverId);
                await this.d.lock.releaseIfMine(serverId);
                this.step(info.message, 'error', 'major');
                this.setState({ ...IDLE, phase: 'failed', serverId, error: info });
                void this.refreshAfterSession(serverId);
                return;
            }
            this.step(info.message, 'error', 'major');
            this.setState({ phase: 'upload-pending', error: info });
            return;
        }
        this.setState({ phase: 'releasing' });
        await this.d.lock.releaseIfMine(serverId);
        this.setState({ ...IDLE, serverId: null });
        this.step('Session finished', 'done', 'major');
        void this.refreshAfterSession(serverId);
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
        this.consoleLog.push(...lines);
        if (this.consoleLog.length > MAX_CONSOLE) this.consoleLog.splice(0, this.consoleLog.length - MAX_CONSOLE);
        this.d.events.emit('console:output', lines);
    }

    onMinecraftExit(code: number | null, expected: boolean): void {
        this.setState({ javaRunning: false, players: [] });
        this.onMinecraftOutput([`[System] The server stopped (exit code ${code ?? 'unknown'})`]);
        this.onMinecraftOutput([]);
        if (this.state.phase === 'running' && !expected) {
            this.step(`The Minecraft server stopped unexpectedly (exit code ${code ?? 'unknown'}); saving the world`, 'error', 'major');
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
                await this.finishUnfinishedUpload(serverId);
            }
        })();
        this.current = run.catch(() => undefined);
        await run;
        void this.d.sync.cleanupMyPlaceholders()
            .catch((err: unknown) => console.warn('[session] placeholder cleanup failed:', toAppError(err).detail));
    }

    /** true when there is no unfinished upload left for this server. */
    private async finishUnfinishedUpload(serverId: string): Promise<boolean> {
        if (!this.d.settings.getServer(serverId).localPath) return false;
        this.step('Finishing your last upload', 'loading', 'major');
        this.setState({ error: null });
        try {
            await this.d.lock.claim(serverId, this.d.sync.baseRevision(serverId), { phase: 'uploading', allowStaleFromMe: true });
        } catch (err) {
            const info = toAppError(err);
            console.warn(`[session] cannot resume the upload of ${serverId} yet:`, info.message);
            this.step(`Your last upload will be finished when the server is free (${info.message})`, 'error', 'minor');
            return false;
        }
        this.lockLost = false;
        this.abort = new AbortController();
        this.setState({ ...IDLE, phase: 'uploading', serverId });
        await this.upload(serverId);
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

    private async stopProcesses(): Promise<void> {
        try {
            await this.d.minecraft.stopAndWait(this.d.timeouts?.stopMs ?? 60_000);
        } catch (err) {
            console.error('[session] the Minecraft server could not be stopped:', err);
        }
        await this.d.playit.stop();
        this.setState({ javaRunning: this.d.minecraft.isRunning(), address: null, players: [] });
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

    step(message: string, status: StepMessage['status'] = 'loading', importance: StepMessage['importance'] = 'minor'): void {
        const entry: StepMessage = { message, status, importance, at: new Date(this.now()).toISOString() };
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
        this.selected = null;
    }
}
