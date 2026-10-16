import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockContent, LockPhase, UserInfo } from '../../shared/types';
import { FakeDriveStore } from '../../test/fakes/FakeDrive';
import type { FakeNode } from '../../test/fakes/FakeDrive';
import { DriveError, FOLDER_MIME } from '../drive/types';
import type { DriveApi } from '../drive/types';
import { AppError } from '../errors';
import { LauncherFiles } from '../sync/launcherFiles';
import { LockService, parseLock, serializeLock } from './LockService';
import type { LockServiceDeps } from './LockService';

const ALICE: UserInfo = { name: 'Alice', email: 'alice@example.com', picture: '' };
const BOB: UserInfo = { name: 'Bob', email: 'bob@example.com', picture: '' };
const CAROL: UserInfo = { name: 'Carol', email: 'carol@example.com', picture: '' };

const RENEW_MS = 15_000;
const WRITE_OPS = new Set(['createFolder', 'createFile', 'updateContent', 'trash', 'deleteForever', 'rename', 'markDeleted']);
const LOST = 'Another member took over the server.';

interface Member {
    user: UserInfo;
    drive: DriveApi;
    lock: LockService;
    lost: Array<[serverId: string, reason: string]>;
    sleeps: number[];
}

function lockOf(user: UserInfo, sessionId: string, phase: LockPhase, extra: Partial<LockContent> = {}): LockContent {
    return {
        format: 2, sessionId, host: { name: user.name, email: user.email }, phase, leaseSeconds: 45,
        baseRevision: 0, startedAt: null, address: null, players: [], ...extra,
    };
}

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/** A DriveApi that behaves like `base` except for the given operations. */
function intercept(base: DriveApi, overrides: Partial<DriveApi>): DriveApi {
    return Object.assign(Object.create(base) as DriveApi, overrides);
}

/** Resolves for everyone once `parties` callers have arrived. */
function barrier(parties: number): () => Promise<void> {
    let arrived = 0;
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return () => {
        arrived += 1;
        if (arrived >= parties) open();
        return opened;
    };
}

/** Lets pending promise chains finish (setImmediate is not faked). */
async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
}

class Harness {
    readonly store = new FakeDriveStore();
    readonly serverId: string;
    private readonly services: LockService[] = [];

    constructor() {
        this.serverId = this.store.createRoot('Server-1', ALICE.email);
    }

    member(user: UserInfo, overrides: Partial<LockServiceDeps> = {}): Member {
        const drive = overrides.drive ?? this.store.as(user.email);
        const lost: Member['lost'] = [];
        const sleeps: number[] = [];
        const lock = new LockService({
            drive,
            launcher: new LauncherFiles(drive),
            me: async () => user,
            onLost: (serverId, reason) => lost.push([serverId, reason]),
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            ...overrides,
        });
        this.services.push(lock);
        return { user, drive, lock, lost, sleeps };
    }

    /** Puts a lock.json into .launcher directly, as another member's app would have written it. */
    seedLock(content: LockContent | string, ownerEmail = ALICE.email): string {
        const folder = this.store.findPath(this.serverId, '.launcher')
            ?? this.store.addNode({ name: '.launcher', mimeType: FOLDER_MIME, parentId: this.serverId, ownerEmail });
        const text = typeof content === 'string' ? content : serializeLock(content);
        return this.store.addNode({
            name: 'lock.json', mimeType: 'application/json', parentId: folder.id, ownerEmail, content: encode(text),
        }).id;
    }

    lockNode(): FakeNode {
        const node = this.store.findPath(this.serverId, '.launcher/lock.json');
        if (!node) throw new Error('lock.json does not exist');
        return node;
    }

    lockContent(): LockContent {
        return parseLock(this.store.text(this.lockNode().id));
    }

    callsBy(email: string, op?: string): unknown[] {
        return this.store.calls.filter((c) => c.user === email && (op === undefined || c.op === op));
    }

    writesBy(email: string): unknown[] {
        return this.store.calls.filter((c) => c.user === email && WRITE_OPS.has(c.op));
    }

    disposeAll(): void {
        for (const service of this.services) service.dispose();
    }
}

let h: Harness;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h = new Harness();
});

afterEach(() => {
    h.disposeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('parseLock / serializeLock', () => {
    it('round-trips a lock', () => {
        const lock = lockOf(ALICE, 's1', 'running', { baseRevision: 4, startedAt: '2026-10-15T12:00:00.000Z', address: 'a.joinmc.link', players: ['Steve'] });
        expect(parseLock(serializeLock(lock))).toEqual(lock);
    });

    it('fills in missing optional fields', () => {
        const text = JSON.stringify({ format: 2, sessionId: '', host: { name: 'A', email: 'a@x' }, phase: 'free', leaseSeconds: 45, baseRevision: 0 });
        expect(parseLock(text)).toMatchObject({ startedAt: null, address: null, players: [] });
    });

    it.each([
        ['not JSON', '{nope'],
        ['an old format', JSON.stringify({ format: 1, status: 'online' })],
        ['an unknown phase', serializeLock(lockOf(ALICE, 's', 'running')).replace('"running"', '"dancing"')],
        ['no host', JSON.stringify({ ...lockOf(ALICE, 's', 'running'), host: null })],
        ['a bad lease', JSON.stringify({ ...lockOf(ALICE, 's', 'running'), leaseSeconds: -1 })],
    ])('rejects %s with INVALID', (_label, text) => {
        let caught: unknown = null;
        try {
            parseLock(text);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AppError);
        expect(caught).toMatchObject({ code: 'INVALID' });
    });
});

describe('inspect', () => {
    it('is free when .launcher does not exist, and writes nothing', async () => {
        const bob = h.member(BOB);
        expect(await bob.lock.inspect(h.serverId)).toEqual({ state: 'free', lock: null });
        expect(h.writesBy(BOB.email)).toEqual([]);
        expect(h.store.findPath(h.serverId, '.launcher')).toBeUndefined();
    });

    it('is free when lock.json is missing from an existing .launcher folder', async () => {
        h.store.addNode({ name: '.launcher', mimeType: FOLDER_MIME, parentId: h.serverId, ownerEmail: ALICE.email });
        const bob = h.member(BOB);
        expect(await bob.lock.inspect(h.serverId)).toEqual({ state: 'free', lock: null });
        expect(h.writesBy(BOB.email)).toEqual([]);
    });

    it('reports a free lock together with its last host', async () => {
        h.seedLock(lockOf(ALICE, 'old', 'free'));
        const view = await h.member(BOB).lock.inspect(h.serverId);
        expect(view.state).toBe('free');
        expect(view.lock?.host.name).toBe('Alice');
        expect(h.writesBy(BOB.email)).toEqual([]);
    });

    it('never writes, whether the lock is held, stale, unreadable or mine', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const id = h.seedLock(lockOf(ALICE, 'alice-session', 'running'));
        const bob = h.member(BOB);
        const before = { ...h.store.node(id) };

        expect((await bob.lock.inspect(h.serverId)).state).toBe('held');
        h.store.advance(46_000);
        expect((await bob.lock.inspect(h.serverId)).state).toBe('stale');
        expect(h.store.node(id).modifiedTime).toBe(before.modifiedTime);
        expect(h.store.node(id).content).toEqual(before.content);

        h.store.node(id).content = encode('garbage');
        expect(await bob.lock.inspect(h.serverId)).toEqual({ state: 'free', lock: null });
        expect(h.writesBy(BOB.email)).toEqual([]);

        const carol = h.member(CAROL);
        await carol.lock.claim(h.serverId, 0);
        const writes = h.writesBy(CAROL.email).length;
        expect((await carol.lock.inspect(h.serverId)).state).toBe('mine');
        expect(h.writesBy(CAROL.email)).toHaveLength(writes);
    });

    it("measures age with Google's clock, not the PC's", async () => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2001, 0, 1));
        h.seedLock(lockOf(ALICE, 'alice-session', 'running'));
        h.store.advance(20_000);
        const view = await h.member(BOB).lock.inspect(h.serverId);
        expect(view.state).toBe('held');
        expect(view.state !== 'free' && view.ageSeconds).toBeCloseTo(20, 1);
    });

    it('pairs the content with its own modifiedTime when the lock changes between the two reads', async () => {
        h.seedLock(lockOf(ALICE, 'alice-session', 'running'));
        h.store.advance(60_000);                                 // Alice's PC died a minute ago
        const node = h.lockNode();
        const base = h.store.as(BOB.email);
        let changed = false;
        const drive = intercept(base, {
            readText: async (fileId) => {
                if (!changed) {
                    // Carol's claim lands between Bob's getMeta and readText.
                    changed = true;
                    node.content = encode(serializeLock(lockOf(CAROL, 'carol-session', 'claiming')));
                    node.modifiedTime = h.store.tick();
                }
                return base.readText(fileId);
            },
        });
        const view = await h.member(BOB, { drive }).lock.inspect(h.serverId);
        expect(view.state).toBe('held');                        // not "stale" with Carol's fresh content
        expect(view.lock?.host.email).toBe(CAROL.email);
        expect(h.callsBy(BOB.email, 'getMeta')).toHaveLength(2);
    });

    it('finds lock.json again after the cached file was trashed', async () => {
        const oldId = h.seedLock(lockOf(ALICE, 'alice-session', 'running'));
        const bob = h.member(BOB);
        expect((await bob.lock.inspect(h.serverId)).lock?.host.email).toBe(ALICE.email);
        await h.store.as(ALICE.email).trash(oldId);
        h.seedLock(lockOf(CAROL, 'carol-session', 'downloading'), CAROL.email);
        const view = await bob.lock.inspect(h.serverId);
        expect(view.state).toBe('held');
        expect(view.lock?.host.email).toBe(CAROL.email);
    });

    it('fails when the server folder itself is gone', async () => {
        h.store.node(h.serverId).trashed = true;
        await expect(h.member(BOB).lock.inspect(h.serverId)).rejects.toMatchObject({ status: 404 });
    });
});

describe('claim', () => {
    it('claims a free server and creates .launcher/lock.json', async () => {
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 7);

        expect(h.store.findPath(h.serverId, '.launcher')?.mimeType).toBe(FOLDER_MIME);
        expect(h.lockContent()).toEqual(lockOf(ALICE, alice.lock.sessionId, 'claiming', { baseRevision: 7 }));
        expect(alice.lock.isHolding(h.serverId)).toBe(true);
        expect(alice.sleeps).toEqual([3000]);
        expect((await alice.lock.inspect(h.serverId)).state).toBe('mine');
        expect((await h.member(BOB).lock.inspect(h.serverId)).state).toBe('held');
    });

    it('writes the phase given in opts and uses a new session id for every claim', async () => {
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 2, { phase: 'uploading' });
        const first = alice.lock.sessionId;
        expect(h.lockContent().phase).toBe('uploading');
        await alice.lock.release(h.serverId);
        await alice.lock.claim(h.serverId, 2);
        expect(alice.lock.sessionId).not.toBe(first);
        expect(h.lockContent().sessionId).toBe(alice.lock.sessionId);
    });

    it('refuses with LOCK_HELD while another member holds the lock', async () => {
        const alice = h.member(ALICE);
        const bob = h.member(BOB);
        await alice.lock.claim(h.serverId, 0);
        await expect(bob.lock.claim(h.serverId, 0)).rejects.toMatchObject({ code: 'LOCK_HELD', message: 'Alice is starting the server.' });
        await alice.lock.update(h.serverId, { phase: 'running' });
        await expect(bob.lock.claim(h.serverId, 0)).rejects.toMatchObject({ code: 'LOCK_HELD', message: 'Alice is running the server.' });

        expect(h.writesBy(BOB.email)).toEqual([]);
        expect(h.lockContent().sessionId).toBe(alice.lock.sessionId);
        expect(bob.lock.isHolding(h.serverId)).toBe(false);
    });

    it('refuses a fresh lock from the same person on another PC, even with allowStaleFromMe', async () => {
        await h.member(ALICE).lock.claim(h.serverId, 0, { phase: 'uploading' });
        const otherPc = h.member(ALICE);
        await expect(otherPc.lock.claim(h.serverId, 0, { allowStaleFromMe: true })).rejects.toMatchObject({ code: 'LOCK_HELD' });
    });

    it('lets another member take over once the lease has run out', async () => {
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 0);
        alice.lock.dispose();                                   // Alice's PC crashed: no more renewals
        const bob = h.member(BOB);

        h.store.advance(44_000);
        await expect(bob.lock.claim(h.serverId, 0)).rejects.toMatchObject({ code: 'LOCK_HELD' });
        h.store.advance(2_000);
        expect((await bob.lock.inspect(h.serverId)).state).toBe('stale');
        await bob.lock.claim(h.serverId, 0);

        expect(h.lockContent().sessionId).toBe(bob.lock.sessionId);
        expect(h.lockContent().host.email).toBe(BOB.email);
        expect(bob.lock.isHolding(h.serverId)).toBe(true);
    });

    it('refuses a stale "uploading" lock from someone else, but lets the same person resume it', async () => {
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 3, { phase: 'uploading' });
        alice.lock.dispose();                                   // Alice's PC crashed mid-upload
        h.store.advance(46_000);

        const bob = h.member(BOB);
        await expect(bob.lock.claim(h.serverId, 3)).rejects.toMatchObject({ code: 'UNFINISHED_UPLOAD' });
        await expect(bob.lock.claim(h.serverId, 3, { allowStaleFromMe: true }))
            .rejects.toMatchObject({ code: 'UNFINISHED_UPLOAD', message: expect.stringContaining('Alice') });
        expect(h.writesBy(BOB.email)).toEqual([]);

        // Alice's app restarts: a new LockService and session; Google treats emails case-insensitively.
        const restarted = h.member({ ...ALICE, email: 'Alice@Example.com' });
        await expect(restarted.lock.claim(h.serverId, 3)).rejects.toMatchObject({ code: 'UNFINISHED_UPLOAD' });
        await restarted.lock.claim(h.serverId, 3, { allowStaleFromMe: true, phase: 'uploading' });
        expect(h.lockContent()).toMatchObject({ sessionId: restarted.lock.sessionId, phase: 'uploading' });
        expect(restarted.lock.isHolding(h.serverId)).toBe(true);
    });

    it('lets exactly one of two members win when both claim at the same moment', async () => {
        h.seedLock(lockOf(ALICE, '', 'free'));
        const bothWriting = barrier(2);                          // both saw "free" before either wrote
        const bothSettling = barrier(2);                         // both writes landed before either reads back
        const gated = (email: string): DriveApi => {
            const view = h.store.as(email);
            return intercept(view, {
                updateContent: async (...args: Parameters<DriveApi['updateContent']>) => {
                    await bothWriting();
                    return view.updateContent(...args);
                },
            });
        };
        const alice = h.member(ALICE, { drive: gated(ALICE.email), sleep: () => bothSettling() });
        const bob = h.member(BOB, { drive: gated(BOB.email), sleep: () => bothSettling() });

        const results = await Promise.allSettled([alice.lock.claim(h.serverId, 0), bob.lock.claim(h.serverId, 0)]);
        const winners = [alice, bob].filter((_, i) => results[i].status === 'fulfilled');
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(winners).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(failures[0].reason).toMatchObject({ code: 'LOCK_HELD', message: 'Someone else started at the same moment.' });

        const winner = winners[0];
        const loser = winner === alice ? bob : alice;
        expect(h.lockContent().sessionId).toBe(winner.lock.sessionId);
        expect(winner.lock.isHolding(h.serverId)).toBe(true);
        expect(loser.lock.isHolding(h.serverId)).toBe(false);
        expect((await loser.lock.inspect(h.serverId)).state).toBe('held');

        const loserWrites = h.writesBy(loser.user.email).length;
        await advance(RENEW_MS * 3);
        expect(h.writesBy(loser.user.email)).toHaveLength(loserWrites);  // the loser never renews
        expect(h.lockContent().sessionId).toBe(winner.lock.sessionId);
        expect(winner.lost).toEqual([]);
    });

    it('lets exactly one win when lock.json does not exist yet, and leaves one lock file', async () => {
        const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
        const alice = h.member(ALICE, { sleep: tick });
        const bob = h.member(BOB, { sleep: tick });

        const results = await Promise.allSettled([alice.lock.claim(h.serverId, 0), bob.lock.claim(h.serverId, 0)]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(failure?.reason).toMatchObject({ code: 'LOCK_HELD' });

        const launchers = h.store.children(h.serverId).filter((n) => n.name === '.launcher');
        expect(launchers).toHaveLength(1);
        expect(h.store.children(launchers[0].id).filter((n) => n.name === 'lock.json')).toHaveLength(1);
        const winner = results[0].status === 'fulfilled' ? alice : bob;
        expect(h.lockContent().sessionId).toBe(winner.lock.sessionId);
    });

    it('can claim again a lock it already holds, and the old session stops renewing', async () => {
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 0);
        const first = alice.lock.sessionId;
        await alice.lock.claim(h.serverId, 1, { phase: 'uploading' });
        expect(alice.lock.sessionId).not.toBe(first);
        expect(h.lockContent()).toMatchObject({ sessionId: alice.lock.sessionId, baseRevision: 1 });

        const writes = h.callsBy(ALICE.email, 'updateContent').length;
        await advance(RENEW_MS);
        expect(h.callsBy(ALICE.email, 'updateContent')).toHaveLength(writes + 1);   // one chain, not two
        expect(alice.lost).toEqual([]);
    });

    it('keeps a claim whose read-back failed, so releaseIfMine can still free it', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const alice = h.member(ALICE);
        // The first getMeta is the read-back: the server had no lock.json, so the first inspect only listed.
        h.store.failNext('getMeta', 1, () => new DriveError('fetch failed', 0));
        await expect(alice.lock.claim(h.serverId, 0)).rejects.toBeInstanceOf(DriveError);
        expect(alice.lock.isHolding(h.serverId)).toBe(false);
        expect(h.lockContent().sessionId).toBe(alice.lock.sessionId);

        await alice.lock.releaseIfMine(h.serverId);
        expect(h.lockContent().phase).toBe('free');
        expect((await h.member(BOB).lock.inspect(h.serverId)).state).toBe('free');
    });

    it("reports a full Drive with the lock file owner's name", async () => {
        h.seedLock(lockOf(ALICE, '', 'free'));
        h.store.failNext('updateContent', 1, () => new DriveError('The user has exceeded their Drive storage quota', 403, 'storageQuotaExceeded'));
        await expect(h.member(BOB).lock.claim(h.serverId, 0))
            .rejects.toMatchObject({ code: 'QUOTA_FULL', message: "alice's Google Drive is full, so nobody can change the files they own." });
    });

    it('reports my own full Drive when creating lock.json fails', async () => {
        const quota = (): Error => new DriveError('The user has exceeded their Drive storage quota', 403, 'storageQuotaExceeded');
        h.store.failNext('createFile', 1, quota);
        await expect(h.member(BOB).lock.claim(h.serverId, 0))
            .rejects.toMatchObject({ code: 'QUOTA_FULL', message: 'Your Google Drive is full, so nobody can change the files you own.' });
    });
});

describe('renewal', () => {
    it('rewrites the lock every renewEveryMs with a fresh modifiedTime and the same content', async () => {
        const alice = h.member(ALICE);
        const bob = h.member(BOB);
        await alice.lock.claim(h.serverId, 0);
        const content = h.lockContent();
        const node = h.lockNode();
        const writes = h.callsBy(ALICE.email, 'updateContent').length;

        h.store.advance(30_000);
        const before = node.modifiedTime;
        await advance(RENEW_MS);
        expect(h.callsBy(ALICE.email, 'updateContent')).toHaveLength(writes + 1);
        expect(node.modifiedTime).toBeGreaterThan(before);
        expect(h.lockContent()).toEqual(content);

        h.store.advance(30_000);                                 // 60 s since the claim, more than the lease
        await advance(RENEW_MS);
        const view = await bob.lock.inspect(h.serverId);
        expect(view.state).toBe('held');
        expect(view.state !== 'free' && view.ageSeconds).toBeLessThan(1);
    });

    it('detects a takeover, calls onLost once and stops renewing', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const alice = h.member(ALICE);
        const bob = h.member(BOB);
        await alice.lock.claim(h.serverId, 0);
        h.store.advance(46_000);                                 // Alice's renewals did not reach Drive
        await bob.lock.claim(h.serverId, 0);

        await advance(RENEW_MS);
        expect(alice.lost).toEqual([[h.serverId, LOST]]);
        expect(alice.lock.isHolding(h.serverId)).toBe(false);
        expect(h.lockContent().sessionId).toBe(bob.lock.sessionId);

        const aliceCalls = h.callsBy(ALICE.email).length;
        await advance(RENEW_MS * 4);
        expect(h.callsBy(ALICE.email)).toHaveLength(aliceCalls);
        expect(alice.lost).toHaveLength(1);
        expect(bob.lock.isHolding(h.serverId)).toBe(true);
        expect(bob.lost).toEqual([]);
    });

    it('keeps renewing through network errors', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 0);
        const writes = (): number => h.callsBy(ALICE.email, 'updateContent').length;
        const start = writes();

        h.store.failNext('getMeta', 1, () => new DriveError('fetch failed', 0));
        await advance(RENEW_MS);
        expect(writes()).toBe(start);
        expect(warn).toHaveBeenCalled();

        h.store.failNext('updateContent', 1, () => new DriveError('Backend Error', 503, 'backendError'));
        await advance(RENEW_MS);
        expect(writes()).toBe(start + 1);                        // attempted, failed

        await advance(RENEW_MS);
        expect(writes()).toBe(start + 2);
        expect(alice.lost).toEqual([]);
        expect(alice.lock.isHolding(h.serverId)).toBe(true);
        expect(h.lockContent().sessionId).toBe(alice.lock.sessionId);
    });

    it('writes lock.json again when it vanished during the session', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 0);
        const oldId = h.lockNode().id;
        await h.store.as(ALICE.email).trash(oldId);              // removed by hand in the Drive website

        await advance(RENEW_MS);
        expect(h.lockNode().id).not.toBe(oldId);
        expect(h.lockContent().sessionId).toBe(alice.lock.sessionId);
        expect(alice.lost).toEqual([]);
        expect(alice.lock.isHolding(h.serverId)).toBe(true);
    });

    it('dispose stops every timer without writing', async () => {
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 0);
        const calls = h.callsBy(ALICE.email).length;
        alice.lock.dispose();
        await advance(RENEW_MS * 4);
        expect(h.callsBy(ALICE.email)).toHaveLength(calls);
        expect(alice.lock.isHolding(h.serverId)).toBe(false);
    });
});

describe('update', () => {
    it('writes the patch at once and renewals keep it', async () => {
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 5);
        await alice.lock.update(h.serverId, {
            phase: 'running', address: 'abc.joinmc.link', players: ['Steve'], startedAt: '2026-10-15T12:00:00.000Z',
        });
        const expected = lockOf(ALICE, alice.lock.sessionId, 'running', {
            baseRevision: 5, address: 'abc.joinmc.link', players: ['Steve'], startedAt: '2026-10-15T12:00:00.000Z',
        });
        expect(h.lockContent()).toEqual(expected);

        await alice.lock.update(h.serverId, { players: [] });
        await advance(RENEW_MS);
        expect(h.lockContent()).toEqual({ ...expected, players: [] });
    });

    it('throws LOCK_LOST without holding the lock', async () => {
        const alice = h.member(ALICE);
        await expect(alice.lock.update(h.serverId, { phase: 'running' })).rejects.toMatchObject({ code: 'LOCK_LOST' });
        expect(h.writesBy(ALICE.email)).toEqual([]);
    });

    it('does not overwrite a lock someone else took over: onLost, then LOCK_LOST', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const alice = h.member(ALICE);
        const bob = h.member(BOB);
        await alice.lock.claim(h.serverId, 0);
        h.store.advance(46_000);
        await bob.lock.claim(h.serverId, 0);
        const aliceWrites = h.writesBy(ALICE.email).length;

        await expect(alice.lock.update(h.serverId, { phase: 'running' })).rejects.toMatchObject({ code: 'LOCK_LOST', message: LOST });
        expect(alice.lost).toEqual([[h.serverId, LOST]]);
        expect(h.writesBy(ALICE.email)).toHaveLength(aliceWrites);
        expect(h.lockContent().sessionId).toBe(bob.lock.sessionId);

        await advance(RENEW_MS);
        expect(alice.lost).toHaveLength(1);
    });
});

describe('release', () => {
    it('frees the lock, keeps the host for history and stops renewing', async () => {
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 0);
        await alice.lock.update(h.serverId, { phase: 'running', address: 'abc.joinmc.link', players: ['Steve'] });
        const sessionId = alice.lock.sessionId;
        await alice.lock.release(h.serverId);

        expect(h.lockContent()).toMatchObject({ phase: 'free', sessionId, host: { name: 'Alice' }, address: null, players: [] });
        expect(alice.lock.isHolding(h.serverId)).toBe(false);
        const view = await h.member(BOB).lock.inspect(h.serverId);
        expect(view.state).toBe('free');
        expect(view.lock?.host.email).toBe(ALICE.email);

        const calls = h.callsBy(ALICE.email).length;
        await advance(RENEW_MS * 4);
        expect(h.callsBy(ALICE.email)).toHaveLength(calls);
        expect((await alice.lock.inspect(h.serverId)).state).toBe('free');
    });

    it('releaseIfMine never touches a lock this PC does not hold', async () => {
        const alice = h.member(ALICE);
        const bob = h.member(BOB);
        await alice.lock.claim(h.serverId, 0);
        const content = h.lockContent();

        await bob.lock.releaseIfMine(h.serverId);
        await bob.lock.release(h.serverId);
        expect(h.writesBy(BOB.email)).toEqual([]);
        expect(h.lockContent()).toEqual(content);
        expect(alice.lock.isHolding(h.serverId)).toBe(true);
    });

    it('releaseIfMine leaves alone a lock that was taken over from this PC', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const alice = h.member(ALICE);
        const bob = h.member(BOB);
        await bob.lock.claim(h.serverId, 0);
        h.store.advance(46_000);                                 // Bob's renewals did not reach Drive
        await alice.lock.claim(h.serverId, 0);                   // before Bob's next renewal notices
        const bobWrites = h.writesBy(BOB.email).length;

        await bob.lock.releaseIfMine(h.serverId);
        expect(h.writesBy(BOB.email)).toHaveLength(bobWrites);
        expect(h.lockContent().sessionId).toBe(alice.lock.sessionId);
        expect(bob.lock.isHolding(h.serverId)).toBe(false);
        await advance(RENEW_MS);
        expect(bob.lost).toEqual([]);                            // released on purpose, not lost
        expect(alice.lock.isHolding(h.serverId)).toBe(true);
    });

    it('releaseIfMine logs errors instead of throwing, and can be retried', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 0);
        h.store.failNext('getMeta', 1, () => new DriveError('fetch failed', 0));
        await expect(alice.lock.releaseIfMine(h.serverId)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled();
        expect(h.lockContent().phase).toBe('claiming');

        await advance(RENEW_MS);                                 // renewing stopped with the first attempt
        expect(h.lockContent().phase).toBe('claiming');
        await alice.lock.releaseIfMine(h.serverId);
        expect(h.lockContent().phase).toBe('free');
    });

    it('release propagates Drive errors', async () => {
        const alice = h.member(ALICE);
        await alice.lock.claim(h.serverId, 0);
        h.store.failNext('updateContent', 1, () => new DriveError('fetch failed', 0));
        await expect(alice.lock.release(h.serverId)).rejects.toBeInstanceOf(DriveError);
        expect(alice.lock.isHolding(h.serverId)).toBe(false);
    });
});
