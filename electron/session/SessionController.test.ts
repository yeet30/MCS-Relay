import { describe, expect, it, vi } from 'vitest';
import type { EventName, Events } from '../../shared/ipc';
import { DEFAULT_JAVA_FLAGS } from '../../shared/types';
import type { LockView, SessionPhase, SyncReport, UserInfo } from '../../shared/types';
import { AppError } from '../errors';
import { SessionController } from './SessionController';
import type { SessionDeps } from './SessionController';

const ME: UserInfo = { name: 'Alice', email: 'alice@example.com', picture: '' };
const FREE: LockView = { state: 'free', lock: null };

function report(patch: Partial<SyncReport> = {}): SyncReport {
    return {
        serverId: 's1', status: 'in-sync', firstSyncOnThisPc: false, baseRevision: 3, remoteRevision: 3,
        remoteAuthor: null, remoteCreatedAt: null,
        plan: { download: [], upload: [], deleteLocal: [], deleteRemote: [], conflicts: [] },
        downloadBytes: 0, uploadBytes: 0, allowedChoices: [], pendingChoice: null,
        cleanup: { mine: 0, others: [] }, lock: FREE, checkedAt: '', ...patch,
    };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function setup(overrides: { report?: SyncReport; journal?: boolean } = {}) {
    const phases: SessionPhase[] = [];
    const events: Array<[EventName, unknown]> = [];
    let holding = false;
    let journal = overrides.journal ?? false;
    let javaRunning = false;
    const lock = {
        inspect: vi.fn(async (): Promise<LockView> => FREE),
        claim: vi.fn(async () => {
            holding = true;
        }),
        update: vi.fn(async () => undefined),
        release: vi.fn(async () => {
            holding = false;
        }),
        releaseIfMine: vi.fn(async () => {
            holding = false;
        }),
        isHolding: vi.fn(() => holding),
    };
    const sync = {
        preflight: vi.fn(async () => overrides.report ?? report()),
        resolve: vi.fn(async () => report()),
        download: vi.fn(async () => undefined),
        uploadSession: vi.fn(async () => {
            journal = false;
            return { uploaded: 1, deleted: 0, revision: 4 };
        }),
        loadRules: vi.fn(async () => () => false),
        hasJournal: vi.fn(() => journal),
        serversWithJournal: vi.fn(() => (journal ? ['s1'] : [])),
        discardJournal: vi.fn(() => {
            journal = false;
        }),
        baseRevision: vi.fn(() => 3),
        cleanupMyPlaceholders: vi.fn(async () => 0),
    };
    const changes = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), clear: vi.fn() };
    const minecraft = {
        start: vi.fn<(opts: { signal?: AbortSignal }) => Promise<void>>(async () => {
            javaRunning = true;
        }),
        stopAndWait: vi.fn(async () => {
            javaRunning = false;
        }),
        isRunning: vi.fn(() => javaRunning),
        send: vi.fn(),
    };
    const playit = { start: vi.fn(async () => 'abc.joinmc.link'), stop: vi.fn(async () => undefined) };
    const settings = {
        get: vi.fn(() => ({ selectedServerId: 's1', playitggPath: 'C:/playit.exe', usePlayitgg: true, launchServer: true, joinedServerIds: [] })),
        set: vi.fn(),
        getServer: vi.fn(() => ({ localPath: 'C:/servers/s1', javaFlags: { ...DEFAULT_JAVA_FLAGS } })),
    };
    const deps: SessionDeps = {
        lock: lock as unknown as SessionDeps['lock'],
        sync: sync as unknown as SessionDeps['sync'],
        changes: changes as unknown as SessionDeps['changes'],
        minecraft: minecraft as unknown as SessionDeps['minecraft'],
        playit: playit as unknown as SessionDeps['playit'],
        settings: settings as unknown as SessionDeps['settings'],
        events: {
            emit<E extends EventName>(event: E, payload: Events[E]) {
                events.push([event, payload]);
                if (event === 'session:state') {
                    const phase = (payload as Events['session:state']).phase;
                    if (phases[phases.length - 1] !== phase) phases.push(phase);
                }
            },
        },
        me: async () => ME,
        sleep: vi.fn(async () => undefined),
        lockPollMs: 1_000_000,
    };
    const session = new SessionController(deps);
    return {
        session, lock, sync, changes, minecraft, playit, settings, phases, events,
        setJava: (running: boolean) => {
            javaRunning = running;
        },
    };
}

describe('SessionController: a normal session', () => {
    it('goes through every phase and writes each one into the lock', async () => {
        const t = setup();
        await t.session.start('s1');
        expect(t.phases).toEqual(['checking', 'claiming', 'downloading', 'launching', 'running']);
        expect(t.lock.claim).toHaveBeenCalledWith('s1', 3);
        expect(t.lock.update.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
            { phase: 'downloading' }, { phase: 'launching' },
            { phase: 'running', startedAt: expect.any(String), address: 'abc.joinmc.link' },
        ]);
        expect(t.session.getState()).toMatchObject({ phase: 'running', javaRunning: true, address: 'abc.joinmc.link' });
        expect(t.changes.start).toHaveBeenCalledWith('C:/servers/s1', expect.any(Function));

        await t.session.stop();
        expect(t.phases.slice(5)).toEqual(['stopping', 'uploading', 'releasing', 'idle']);
        expect(t.minecraft.stopAndWait).toHaveBeenCalledTimes(1);
        expect(t.sync.uploadSession).toHaveBeenCalledTimes(1);
        expect(t.lock.releaseIfMine).toHaveBeenCalledWith('s1');
        expect(t.session.isBusy()).toBe(false);
    });

    it('stop is idempotent', async () => {
        const t = setup();
        await t.session.start('s1');
        await Promise.all([t.session.stop(), t.session.stop()]);
        await t.session.stop();
        expect(t.sync.uploadSession).toHaveBeenCalledTimes(1);
    });

    it('does not start playit or Java when the settings say so', async () => {
        const t = setup();
        t.settings.get.mockReturnValue({ selectedServerId: 's1', playitggPath: '', usePlayitgg: true, launchServer: false, joinedServerIds: [] });
        await t.session.start('s1');
        expect(t.playit.start).not.toHaveBeenCalled();
        expect(t.minecraft.start).not.toHaveBeenCalled();
        expect(t.session.getState().phase).toBe('running');
    });
});

describe('SessionController: refusing to start', () => {
    it('needs a choice when both sides changed, and stays idle', async () => {
        const t = setup({ report: report({ status: 'diverged' }) });
        await expect(t.session.start('s1')).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(t.lock.claim).not.toHaveBeenCalled();
        expect(t.session.getState().phase).toBe('idle');
    });

    it("refuses while someone else's upload is unfinished", async () => {
        const t = setup({ report: report({ status: 'unfinished-upload' }) });
        await expect(t.session.start('s1')).rejects.toMatchObject({ code: 'UNFINISHED_UPLOAD' });
    });

    it('a failed download releases the lock and never starts Java', async () => {
        const t = setup();
        t.sync.download.mockRejectedValueOnce(new AppError('DOWNLOAD_INCOMPLETE', '2 files could not be downloaded.'));
        await expect(t.session.start('s1')).rejects.toMatchObject({ code: 'DOWNLOAD_INCOMPLETE' });
        expect(t.minecraft.start).not.toHaveBeenCalled();
        expect(t.lock.releaseIfMine).toHaveBeenCalledWith('s1');
        expect(t.session.getState()).toMatchObject({ phase: 'failed', error: { code: 'DOWNLOAD_INCOMPLETE' } });
        t.session.dismiss();
        expect(t.session.getState().phase).toBe('idle');
    });

    it('waits for its own crashed session to expire instead of blaming someone else', async () => {
        const t = setup();
        t.lock.claim.mockRejectedValueOnce(new AppError('LOCK_HELD', 'Alice is playing.'));
        t.lock.inspect.mockResolvedValueOnce({
            state: 'held', ageSeconds: 30,
            lock: { format: 2, sessionId: 'old', host: { name: 'Alice', email: ME.email }, phase: 'running', leaseSeconds: 45, baseRevision: 3, startedAt: null, address: null, players: [] },
        });
        await t.session.start('s1');
        expect(t.lock.claim).toHaveBeenCalledTimes(2);
        expect(t.session.getState().phase).toBe('running');
    });

    it('stop while starting cancels the start without an error', async () => {
        const t = setup();
        const java = deferred();
        t.minecraft.start.mockImplementationOnce(async (opts: { signal?: AbortSignal }) => {
            opts.signal?.addEventListener('abort', () => java.reject(new Error('aborted')));
            await java.promise;
        });
        const starting = t.session.start('s1');
        await vi.waitFor(() => expect(t.session.getState().phase).toBe('launching'));
        await t.session.stop();
        await starting;
        expect(t.session.getState().phase).toBe('idle');
        expect(t.sync.uploadSession).not.toHaveBeenCalled();
        expect(t.lock.releaseIfMine).toHaveBeenCalled();
    });
});

describe('SessionController: things going wrong while hosting', () => {
    it('a Java crash stops the session and uploads the world', async () => {
        const t = setup();
        await t.session.start('s1');
        t.setJava(false);
        t.session.onMinecraftExit(1, false);
        await vi.waitFor(() => expect(t.session.getState().phase).toBe('idle'));
        expect(t.sync.uploadSession).toHaveBeenCalledTimes(1);
    });

    it('losing the lock stops Java and uploads nothing', async () => {
        const t = setup();
        await t.session.start('s1');
        t.session.onLockLost('s1', 'Another member took over the server.');
        await vi.waitFor(() => expect(t.session.getState().phase).toBe('failed'));
        expect(t.session.getState().error?.code).toBe('LOCK_LOST');
        expect(t.minecraft.stopAndWait).toHaveBeenCalled();
        expect(t.sync.uploadSession).not.toHaveBeenCalled();
    });

    it('a failed upload keeps the lock and can be retried', async () => {
        const t = setup();
        await t.session.start('s1');
        t.sync.uploadSession.mockRejectedValueOnce(new AppError('UPLOAD_INCOMPLETE', '3 files could not be uploaded.'));
        await t.session.stop();
        expect(t.session.getState()).toMatchObject({ phase: 'upload-pending', error: { code: 'UPLOAD_INCOMPLETE' } });
        expect(t.lock.releaseIfMine).not.toHaveBeenCalled();
        expect(t.session.isBusy()).toBe(true);
        await t.session.retryUpload();
        expect(t.session.getState().phase).toBe('idle');
        expect(t.lock.releaseIfMine).toHaveBeenCalledTimes(1);
    });

    it('a Java process that cannot be stopped is never uploaded under', async () => {
        const t = setup();
        await t.session.start('s1');
        t.minecraft.stopAndWait.mockRejectedValueOnce(new AppError('JAVA', 'The Minecraft server could not be stopped.'));
        await t.session.stop();
        expect(t.sync.uploadSession).not.toHaveBeenCalled();
        expect(t.session.getState().phase).toBe('upload-pending');
        await expect(t.session.retryUpload()).rejects.toMatchObject({ code: 'JAVA' });
        t.setJava(false);
        await t.session.retryUpload();
        expect(t.sync.uploadSession).toHaveBeenCalledTimes(1);
    });

    it('commands go to Java and are echoed in the console', async () => {
        const t = setup();
        await t.session.start('s1');
        t.session.command('say hi');
        expect(t.minecraft.send).toHaveBeenCalledWith('say hi');
        expect(t.session.consoleLines().at(-1)).toBe('> say hi');
    });
});

describe('SessionController: startup and quit', () => {
    it('finishes an unfinished upload at startup, then cleans up placeholders', async () => {
        const t = setup({ journal: true });
        await t.session.resumeUnfinishedUploads();
        expect(t.lock.claim).toHaveBeenCalledWith('s1', 3, { phase: 'uploading', allowStaleFromMe: true });
        expect(t.sync.uploadSession).toHaveBeenCalledTimes(1);
        expect(t.session.getState().phase).toBe('idle');
        expect(t.sync.cleanupMyPlaceholders).toHaveBeenCalled();
    });

    it('an unfinished upload the cloud has moved past is dropped so the user can choose', async () => {
        const t = setup({ journal: true });
        t.sync.uploadSession.mockRejectedValueOnce(new AppError('CONFLICT', 'The cloud changed since this PC last synced.'));
        await t.session.resumeUnfinishedUploads();
        expect(t.sync.discardJournal).toHaveBeenCalledWith('s1');
        expect(t.session.getState().phase).toBe('failed');
    });

    it('starting a server with an unfinished upload finishes it first', async () => {
        const t = setup({ journal: true });
        await t.session.start('s1');
        expect(t.sync.uploadSession).toHaveBeenCalledTimes(1);
        expect(t.session.getState().phase).toBe('running');
    });

    it('shutdown stops a running session and waits for the upload', async () => {
        const t = setup();
        await t.session.start('s1');
        const upload = deferred<{ uploaded: number; deleted: number; revision: number }>();
        t.sync.uploadSession.mockReturnValueOnce(upload.promise);
        const done = t.session.shutdown();
        await vi.waitFor(() => expect(t.session.getState().phase).toBe('uploading'));
        upload.resolve({ uploaded: 1, deleted: 0, revision: 4 });
        await done;
        expect(t.session.getState().phase).toBe('idle');
    });
});
