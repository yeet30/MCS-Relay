// The app's own updates: checks GitHub Releases for a newer MCS-Relay, downloads it in the background, and installs
// it the next time the app quits (or at once, when the user asks and nothing is in progress). Development builds
// have no updater and never check.
import type { UpdateState } from '../../shared/types';

/** The part of electron-updater's autoUpdater used here (tests pass a fake). */
export interface UpdaterLike {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    on(event: string, listener: (payload: unknown) => void): unknown;
    checkForUpdates(): Promise<unknown>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdatesDeps {
    /** null in development: nothing is checked. */
    updater: UpdaterLike | null;
    current: string;
    emit: (state: UpdateState) => void;
    firstCheckMs?: number;
    checkEveryMs?: number;
}

const FIRST_CHECK_MS = 15_000;                  // after the window is up, so starting the app is not slowed down
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;      // the app often stays open in the tray for days

function versionOf(info: unknown): string | null {
    const version = (info as { version?: unknown } | null)?.version;
    return typeof version === 'string' ? version : null;
}

function percentOf(progress: unknown): number {
    const percent = (progress as { percent?: unknown } | null)?.percent;
    return typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0;
}

/** electron-updater's messages can carry a whole HTTP answer: the first line is enough to show. */
function messageOf(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    return text.split(/\r?\n/)[0].slice(0, 200) || 'The update check failed.';
}

export class Updates {
    private state: UpdateState;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly d: UpdatesDeps) {
        this.state = { current: d.current, status: d.updater ? 'idle' : 'unavailable', version: null, percent: 0, error: null };
        const updater = d.updater;
        if (!updater) return;
        updater.autoDownload = true;
        updater.autoInstallOnAppQuit = true;
        updater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
        updater.on('update-not-available', () => this.set({ status: 'up-to-date' }));
        updater.on('update-available', (info) => this.set({ status: 'downloading', version: versionOf(info), percent: 0 }));
        updater.on('download-progress', (progress) => {
            if (this.state.status === 'downloading') this.set({ percent: percentOf(progress) });
        });
        updater.on('update-downloaded', (info) => this.set({ status: 'ready', version: versionOf(info) ?? this.state.version, percent: 100 }));
        updater.on('error', (err) => this.set({ status: 'error', error: messageOf(err) }));
    }

    get(): UpdateState {
        return { ...this.state };
    }

    /** Checks a little after startup, then every few hours. */
    start(): void {
        if (!this.d.updater || this.timer) return;
        const loop = (delay: number): void => {
            this.timer = setTimeout(() => {
                void this.check().finally(() => loop(this.d.checkEveryMs ?? CHECK_EVERY_MS));
            }, delay);
        };
        loop(this.d.firstCheckMs ?? FIRST_CHECK_MS);
    }

    /** Checks now, unless a check or download is running or an update is already waiting. */
    async check(): Promise<UpdateState> {
        const updater = this.d.updater;
        const status = this.state.status;
        if (!updater || status === 'checking' || status === 'downloading' || status === 'ready') return this.get();
        try {
            await updater.checkForUpdates();
        } catch (err) {
            this.set({ status: 'error', error: messageOf(err) });
        }
        return this.get();
    }

    /** Quits and installs the downloaded update at once (the app starts again afterwards). false when none is ready. */
    install(): boolean {
        if (!this.d.updater || this.state.status !== 'ready') return false;
        this.d.updater.quitAndInstall(true, true);
        return true;
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private set(patch: Partial<UpdateState>): void {
        this.state = { ...this.state, ...patch };
        this.d.emit(this.get());
    }
}
