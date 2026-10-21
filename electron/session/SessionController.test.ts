import { describe, expect, it, vi } from 'vitest';
import type { EventName, Events } from '../../shared/ipc';
import { DEFAULT_JAVA_FLAGS } from '../../shared/types';
import type { LockView, SessionPhase, SessionProgress, SyncReport, UserInfo } from '../../shared/types';
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
    const notes: Array<{ title: string; body: string; outcome: 'done' | 'failed' }> = [];
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
        unfinishedRepair: vi.fn(() => false),
        commitPartial: vi.fn(async () => {
            journal = false;
            return { revision: 4, sent: 2, planned: 5 } as { revision: number; sent: number; planned: number | null } | null;
        }),
    };
    const changes = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), clear: vi.fn(), all: vi.fn(() => []) };
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
        get: vi.fn(() => ({
            selectedServerId: 's1', playitggPath: 'C:/playit.exe', usePlayitgg: true, launchServer: true, joinedServerIds: [] as string[],
            eulaAccepted: true, notifications: true, notificationSound: true,
        })),
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
        notify: (n) => void notes.push(n),
        serverName: () => 'Survival',
    };
    const session = new SessionController(deps);
    return {
        session, lock, sync, changes, minecraft, playit, settings, phases, events, notes,
        setJava: (running: boolean) => {
            javaRunning = running;
        },
        setJournal: (exists: boolean) => {
            journal = exists;
        },
    };
}

/** A sync step that only ends when the run is cancelled. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
    return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
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
        t.settings.get.mockReturnValue({
            selectedServerId: 's1', playitggPath: '', usePlayitgg: true, launchServer: false, joinedServerIds: [],
            eulaAccepted: false, notifications: true, notificationSound: true,
        });
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

describe('SessionController: progress', () => {
    function progressEvents(events: Array<[string, unknown]>): SessionProgress[] {
        return events.filter(([name]) => name === 'session:progress').map(([, payload]) => payload as SessionProgress);
    }

    it('a start and a stop each fill the bar from 0 to 100 % and close every log line', async () => {
        const t = setup();
        await t.session.start('s1');
        const start = progressEvents(t.events);
        expect(start[0]).toMatchObject({ title: 'Starting the server', active: true, fraction: 0 });
        expect(start.at(-1)).toMatchObject({ title: 'Starting the server', active: false, outcome: 'done', fraction: 1 });

        await t.session.stop();
        const stop = progressEvents(t.events).filter((p) => p.title === 'Stopping and uploading');
        expect(stop.at(-1)).toMatchObject({ outcome: 'done', fraction: 1 });
        const fractions = stop.map((p) => p.fraction);
        expect(fractions).toEqual([...fractions].sort((a, b) => a - b));          // never backwards
        expect(t.session.steps().filter((s) => s.status === 'loading')).toEqual([]);
    });

    it('a failed upload marks its stage as failed, and the retry says what it does', async () => {
        const t = setup();
        await t.session.start('s1');
        t.sync.uploadSession.mockRejectedValueOnce(new AppError('UPLOAD_INCOMPLETE', '3 files could not be uploaded.'));
        await t.session.stop();
        expect(t.session.getProgress()).toMatchObject({ outcome: 'failed', active: false });
        expect(t.session.steps().some((s) => s.status === 'error' && s.message === '3 files could not be uploaded.')).toBe(true);

        await t.session.retryUpload();
        expect(t.session.getProgress()).toMatchObject({ title: 'Retrying the failed uploads', outcome: 'done' });
        expect(t.session.steps().some((s) => s.message.startsWith('Retrying'))).toBe(true);
    });
});

describe('SessionController: EULA, notifications and syncing without playing', () => {
    it('does not start the Minecraft server before the EULA is accepted', async () => {
        const t = setup();
        t.settings.get.mockReturnValue({ ...t.settings.get(), eulaAccepted: false });
        await expect(t.session.start('s1')).rejects.toThrow(/EULA/);
        expect(t.lock.claim).not.toHaveBeenCalled();
        expect(t.minecraft.start).not.toHaveBeenCalled();
    });

    it('tells the user when the server is running and when it is saved', async () => {
        const t = setup();
        await t.session.start('s1');
        await t.session.stop();
        expect(t.notes.map((n) => [n.outcome, n.title])).toEqual([
            ['done', 'Survival is running'],
            ['done', 'Survival is saved to the cloud'],
        ]);
        expect(t.notes[0].body).toMatch(/Friends can join at abc\.joinmc\.link\. Started in \d+ s\./);
    });

    it('log lines record when they finished, so the UI can show how long each took', async () => {
        const t = setup();
        await t.session.start('s1');
        const finished = t.session.steps().filter((s) => s.status === 'done' && s.endedAt);
        expect(finished.length).toBeGreaterThan(3);
    });

    it('downloads the latest version under the lock without starting anything', async () => {
        const t = setup({ report: report({ status: 'cloud-newer' }) });
        await t.session.syncNow('s1', 'down');
        expect(t.phases).toEqual(['checking', 'claiming', 'downloading', 'releasing', 'idle']);
        expect(t.sync.download).toHaveBeenCalledTimes(1);
        expect(t.minecraft.start).not.toHaveBeenCalled();
        expect(t.lock.releaseIfMine).toHaveBeenCalledWith('s1');
        expect(t.notes.at(-1)?.title).toBe('Survival is up to date');
    });

    it('uploads this PC\'s changes under the lock, and refuses when there is nothing to upload', async () => {
        const t = setup({ report: report({ status: 'local-changes' }) });
        await t.session.syncNow('s1', 'up');
        expect(t.lock.claim).toHaveBeenCalledWith('s1', 3, { phase: 'uploading' });
        expect(t.sync.uploadSession).toHaveBeenCalledTimes(1);
        expect(t.session.getState().phase).toBe('idle');

        const idle = setup();
        await expect(idle.session.syncNow('s1', 'up')).rejects.toThrow(/nothing to upload/);
        expect(idle.lock.claim).not.toHaveBeenCalled();
    });

    it('"Upload my changes" that only had to finish a stopped upload ends without an error', async () => {
        const t = setup({ journal: true });
        await t.session.syncNow('s1', 'up');
        expect(t.sync.uploadSession).toHaveBeenCalledTimes(1);
        expect(t.session.getState().phase).toBe('idle');
        expect(t.session.getProgress().outcome).toBe('done');
    });
});

describe('SessionController: cancel and continue', () => {
    it('cancelling a download goes back to idle, frees the server and keeps what already arrived', async () => {
        const t = setup({ report: report({ status: 'cloud-newer' }) });
        t.sync.download.mockImplementationOnce(((_: string, __: SyncReport, signal?: AbortSignal) => untilAborted(signal)) as never);
        const starting = t.session.start('s1');
        await vi.waitFor(() => expect(t.session.getState().phase).toBe('downloading'));
        await t.session.cancel();
        await starting;
        expect(t.session.getState().phase).toBe('idle');
        expect(t.lock.releaseIfMine).toHaveBeenCalledWith('s1');
        expect(t.minecraft.start).not.toHaveBeenCalled();
        const progress = t.session.getProgress();
        expect(progress).toMatchObject({ outcome: 'cancelled', kind: 'start', serverId: 's1' });
        expect(progress.message).toMatch(/already arrived are kept/);
        expect(t.notes.some((n) => n.outcome === 'failed')).toBe(false);
    });

    it('pausing an upload keeps the server reserved, and Continue picks it up', async () => {
        const t = setup();
        await t.session.start('s1');
        t.sync.uploadSession.mockImplementationOnce(((_: string, signal?: AbortSignal) => {
            t.setJournal(true);                                     // the first files reached Drive
            return untilAborted(signal);
        }) as never);
        const stopping = t.session.stop();
        await vi.waitFor(() => expect(t.session.getState().phase).toBe('uploading'));
        await t.session.cancel();
        await stopping;
        expect(t.session.getState()).toMatchObject({ phase: 'upload-pending', error: null });
        expect(t.lock.releaseIfMine).not.toHaveBeenCalled();
        expect(t.session.getProgress()).toMatchObject({ outcome: 'cancelled', kind: 'stop', message: expect.stringMatching(/paused/) });
        expect(t.notes.some((n) => n.outcome === 'failed')).toBe(false);

        await t.session.retryUpload();
        expect(t.session.getProgress()).toMatchObject({ title: 'Continuing the upload', outcome: 'done' });
        expect(t.session.getState().phase).toBe('idle');
        expect(t.lock.releaseIfMine).toHaveBeenCalledTimes(1);
    });

    it('an upload cancelled before anything was sent frees the server', async () => {
        const t = setup();
        await t.session.start('s1');
        t.sync.uploadSession.mockImplementationOnce(((_: string, signal?: AbortSignal) => untilAborted(signal)) as never);
        const stopping = t.session.stop();
        await vi.waitFor(() => expect(t.session.getState().phase).toBe('uploading'));
        await t.session.cancel();
        await stopping;
        expect(t.session.getState().phase).toBe('idle');
        expect(t.lock.releaseIfMine).toHaveBeenCalledWith('s1');
        expect(t.session.getProgress().message).toMatch(/stay on this PC/);
    });

    it('there is nothing to cancel while idle or while the server runs', async () => {
        const t = setup();
        await expect(t.session.cancel()).rejects.toThrow(/nothing to cancel/);
        await t.session.start('s1');
        await expect(t.session.cancel()).rejects.toThrow(/nothing to cancel/);
        expect(t.session.getState().phase).toBe('running');
    });
});

describe('SessionController: repairing another member\'s unfinished upload', () => {
    const bobStale: LockView = {
        state: 'stale', ageSeconds: 600,
        lock: { format: 2, sessionId: 'bob', host: { name: 'Bob', email: 'bob@example.com' }, phase: 'uploading', leaseSeconds: 45, baseRevision: 3, startedAt: null, address: null, players: [] },
    };

    it('takes the server over, uploads in repair mode and frees it', async () => {
        const t = setup({ report: report({ status: 'unfinished-upload', lock: bobStale }) });
        await t.session.repair('s1');
        expect(t.lock.claim).toHaveBeenCalledWith('s1', 3, { phase: 'uploading', takeOverUnfinished: true });
        expect(t.sync.uploadSession).toHaveBeenCalledWith('s1', expect.any(AbortSignal), expect.anything(), { repair: true });
        expect(t.session.getState().phase).toBe('idle');
        expect(t.lock.releaseIfMine).toHaveBeenCalledWith('s1');
        expect(t.notes.at(-1)?.title).toBe('Survival is repaired');
        expect(t.session.getProgress()).toMatchObject({ outcome: 'done', kind: 'repair' });
    });

    it('refuses without an unfinished upload, or from a PC that is not at the last saved version', async () => {
        const fine = setup();
        await expect(fine.session.repair('s1')).rejects.toThrow(/no unfinished upload/);
        const behind = setup({ report: report({ status: 'unfinished-upload', lock: bobStale, baseRevision: 2 }) });
        await expect(behind.session.repair('s1')).rejects.toThrow(/Only a PC that has revision 3/);
        for (const t of [fine, behind]) {
            expect(t.lock.claim).not.toHaveBeenCalled();
            expect(t.session.getState().phase).toBe('idle');
        }
    });
});

describe('SessionController: cancelling an upload for good', () => {
    async function uploadingSession() {
        const t = setup();
        await t.session.start('s1');
        t.sync.uploadSession.mockImplementationOnce(((_: string, signal?: AbortSignal) => {
            t.setJournal(true);
            return untilAborted(signal);
        }) as never);
        const stopping = t.session.stop();
        await vi.waitFor(() => expect(t.session.getState().phase).toBe('uploading'));
        return { t, stopping };
    }

    it('saves what was sent as an incomplete revision and frees the server', async () => {
        const { t, stopping } = await uploadingSession();
        await t.session.abandonUpload();
        await stopping;
        expect(t.sync.commitPartial).toHaveBeenCalledWith('s1', expect.anything());
        expect(t.session.getState().phase).toBe('idle');
        expect(t.lock.releaseIfMine).toHaveBeenCalledWith('s1');
        expect(t.notes.at(-1)).toMatchObject({ outcome: 'done', body: expect.stringContaining('incomplete') });
    });

    it('works on a paused upload too', async () => {
        const { t, stopping } = await uploadingSession();
        await t.session.cancel();
        await stopping;
        expect(t.session.getState().phase).toBe('upload-pending');
        await t.session.abandonUpload();
        expect(t.sync.commitPartial).toHaveBeenCalledTimes(1);
        expect(t.session.getState().phase).toBe('idle');
    });

    it('keeps the upload waiting when saving fails, and never cancels a repair', async () => {
        const { t, stopping } = await uploadingSession();
        t.sync.commitPartial.mockRejectedValueOnce(new AppError('CONFLICT', 'The cloud changed meanwhile.'));
        await t.session.abandonUpload();
        await stopping;
        expect(t.session.getState()).toMatchObject({ phase: 'upload-pending', error: { code: 'CONFLICT' } });
        t.sync.unfinishedRepair.mockReturnValue(true);
        await expect(t.session.abandonUpload()).rejects.toThrow(/repair/);
    });
});
