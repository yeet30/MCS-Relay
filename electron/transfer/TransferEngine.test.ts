import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferSnapshot } from '../../shared/types';
import { FakeDriveStore, md5Hex } from '../../test/fakes/FakeDrive';
import type { FakeNode } from '../../test/fakes/FakeDrive';
import { DriveError, FOLDER_MIME } from '../drive/types';
import type { DriveApi } from '../drive/types';
import { AppError } from '../errors';
import { TransferEngine } from './TransferEngine';
import type { JobOutcome, TransferEngineDeps, TransferJob } from './TransferEngine';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const NO_PERMISSION = (): DriveError =>
    new DriveError('The user does not have sufficient permissions for this file.', 403, 'insufficientFilePermissions');
const QUOTA_FULL = (): DriveError => new DriveError('The user\'s Drive storage quota has been exceeded.', 403, 'storageQuotaExceeded');
const RATE_LIMITED = (): DriveError => new DriveError('Rate limit exceeded', 429, 'rateLimitExceeded');

/** A DriveApi that behaves like `base` except for the methods in `patch`. */
function override(base: DriveApi, patch: Partial<DriveApi>): DriveApi {
    return new Proxy(base, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && prop in patch) return patch[prop as keyof DriveApi];
            return Reflect.get(target, prop, receiver);
        },
    });
}

function inLanes(s: TransferSnapshot): number {
    return s.lanes.filter((l) => l.path !== null).length;
}

async function filesUnder(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
}

async function exists(p: string): Promise<boolean> {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
}

let store: FakeDriveStore;
let root: string;
let world: string;
let pending: string;
let tmp: string;

beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store = new FakeDriveStore();
    root = store.createRoot('Server-1', ALICE);
    world = store.addNode({ name: 'world', mimeType: FOLDER_MIME, parentId: root, ownerEmail: ALICE }).id;
    const launcher = store.addNode({ name: '.launcher', mimeType: FOLDER_MIME, parentId: root, ownerEmail: ALICE }).id;
    pending = store.addNode({ name: 'pending-delete', mimeType: FOLDER_MIME, parentId: launcher, ownerEmail: ALICE }).id;
    tmp = await mkdtemp(path.join(os.tmpdir(), 'mdh-transfer-'));
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
});

function remoteFile(name: string, text: string, owner: string, parentId = world, extra: Partial<FakeNode> = {}): FakeNode {
    return store.addNode({ name, mimeType: 'application/octet-stream', parentId, ownerEmail: owner, content: enc(text), ...extra });
}

function makeEngine(drive: DriveApi, extra: Partial<TransferEngineDeps> = {}): { engine: TransferEngine; snaps: TransferSnapshot[] } {
    const snaps: TransferSnapshot[] = [];
    const engine = new TransferEngine({
        drive,
        me: async () => ({ name: 'Alice', email: ALICE, picture: '' }),
        emit: (s) => snaps.push(s),
        backoffMs: () => 1,
        tickMs: 5,
        ...extra,
    });
    return { engine, snaps };
}

function downloadJob(node: FakeNode, rel: string, md5 = md5Hex(node.content)): TransferJob {
    return { kind: 'download', path: rel, driveId: node.id, size: node.content.length, md5, dest: path.join(tmp, ...rel.split('/')) };
}

async function localFile(rel: string, text: string): Promise<{ source: string; size: number; md5: string }> {
    const source = path.join(tmp, ...rel.split('/'));
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, text);
    return { source, size: Buffer.byteLength(text), md5: md5Hex(enc(text)) };
}

function calls(op: keyof DriveApi): unknown[][] {
    return store.calls.filter((c) => c.op === op).map((c) => c.args);
}

function outcomeFor(done: JobOutcome[], rel: string): JobOutcome | undefined {
    return done.find((o) => o.path === rel);
}

describe('TransferEngine downloads', () => {
    it('writes the bytes into place and reports the local mtime', async () => {
        const level = remoteFile('level.dat', 'level data', BOB);
        const region = store.addNode({ name: 'region', mimeType: FOLDER_MIME, parentId: world, ownerEmail: ALICE }).id;
        const mca = remoteFile('r.0.0.mca', 'region data '.repeat(1000), ALICE, region);
        await localFile('world/level.dat', 'old local content');
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Downloading', [
            downloadJob(level, 'world/level.dat'),
            downloadJob(mca, 'world/region/r.0.0.mca'),
        ]);

        expect(result.failed).toEqual([]);
        expect(result.done).toHaveLength(2);
        for (const [node, rel] of [[level, 'world/level.dat'], [mca, 'world/region/r.0.0.mca']] as const) {
            const dest = path.join(tmp, ...rel.split('/'));
            expect(new Uint8Array(await readFile(dest))).toEqual(node.content);
            const info = await stat(dest);
            expect(outcomeFor(result.done, rel)).toEqual({
                kind: 'download', path: rel, driveId: node.id, md5: md5Hex(node.content), size: node.content.length, mtimeMs: info.mtimeMs,
            });
        }
        expect((await filesUnder(tmp)).filter((f) => f.endsWith('.part'))).toEqual([]);
    });

    it('retries a checksum mismatch and then fails without touching the destination', async () => {
        const node = remoteFile('level.dat', 'level data', BOB);
        const { engine } = makeEngine(store.as(ALICE), { maxAttempts: 3 });

        const result = await engine.run('Downloading', [downloadJob(node, 'world/level.dat', 'ffffffffffffffffffffffffffffffff')]);

        expect(result.done).toEqual([]);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].error.code).toBe('CHECKSUM');
        expect(calls('download')).toHaveLength(3);
        expect(await exists(path.join(tmp, 'world', 'level.dat'))).toBe(false);
        expect(await exists(path.join(tmp, 'world', 'level.dat.part'))).toBe(false);
    });

    it('fails a permanent 403 at once and keeps going with the other jobs', async () => {
        const denied = remoteFile('secret.dat', 'secret', BOB);
        const fine = remoteFile('fine.dat', 'fine', BOB);
        store.failNext('download', 5, NO_PERMISSION, (args) => args[0] === denied.id);
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Downloading', [downloadJob(denied, 'world/secret.dat'), downloadJob(fine, 'world/fine.dat')]);

        expect(result.done.map((o) => o.path)).toEqual(['world/fine.dat']);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].job.path).toBe('world/secret.dat');
        expect(result.failed[0].error.code).toBe('FORBIDDEN');
        expect(calls('download').filter((args) => args[0] === denied.id)).toHaveLength(1);
    });

    it('halves the lanes on a 429 and retries the throttled job', async () => {
        const nodes = Array.from({ length: 6 }, (_, i) => remoteFile(`f${i}.dat`, `content ${i}`, BOB));
        store.failNext('download', 1, RATE_LIMITED);
        const { engine, snaps } = makeEngine(store.as(ALICE), { lanes: { start: 4, min: 1, max: 12 } });

        const result = await engine.run('Downloading', nodes.map((n, i) => downloadJob(n, `world/f${i}.dat`)));

        expect(result.failed).toEqual([]);
        expect(result.done).toHaveLength(6);
        expect(calls('download')).toHaveLength(7);
        expect(snaps[0].laneLimit).toBe(4);
        expect(engine.snapshot().laneLimit).toBe(2);
    });

    it('treats a rate-limit 403 like a 429', async () => {
        const node = remoteFile('a.dat', 'a', BOB);
        store.failNext('download', 2, () => new DriveError('User rate limit exceeded', 403, 'userRateLimitExceeded'));
        const { engine } = makeEngine(store.as(ALICE), { lanes: { start: 8, min: 1, max: 12 } });

        const result = await engine.run('Downloading', [downloadJob(node, 'world/a.dat')]);

        expect(result.done).toHaveLength(1);
        expect(calls('download')).toHaveLength(3);
        // Two 429s right after each other are one congestion event: halved once, not twice.
        expect(engine.snapshot().laneLimit).toBe(4);
    });

    it('never runs more jobs at once than there are lanes', async () => {
        const base = store.as(ALICE);
        let running = 0;
        let peak = 0;
        const drive = override(base, {
            download: async (fileId, destPath, opts) => {
                running += 1;
                peak = Math.max(peak, running);
                await delay(60);
                try {
                    return await base.download(fileId, destPath, opts);
                } finally {
                    running -= 1;
                }
            },
        });
        const nodes = Array.from({ length: 8 }, (_, i) => remoteFile(`f${i}.dat`, `content ${i}`, BOB));
        const { engine } = makeEngine(drive, { lanes: { start: 3, min: 1, max: 12 } });

        const result = await engine.run('Downloading', nodes.map((n, i) => downloadJob(n, `world/f${i}.dat`)));

        expect(result.done).toHaveLength(8);
        expect(peak).toBe(3);
    });
});

describe('TransferEngine uploads', () => {
    it('creates new files with appProperties and verifies the md5', async () => {
        const file = await localFile('world/new.dat', 'brand new');
        const appProperties = { mdhServer: root, mdhPath: 'world/new.dat' };
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [{
            kind: 'upload', path: 'world/new.dat', name: 'new.dat', size: file.size, md5: file.md5, source: file.source,
            parentId: world, appProperties,
        }]);

        expect(result.failed).toEqual([]);
        const created = store.findPath(root, 'world/new.dat');
        expect(created).toBeDefined();
        expect(created?.ownerEmail).toBe(ALICE);
        expect(created?.appProperties).toEqual(appProperties);
        expect(Buffer.from(created?.content ?? []).toString()).toBe('brand new');
        expect(calls('createFile')[0][3]).toEqual(appProperties);
        expect(result.done).toEqual([{ kind: 'upload', path: 'world/new.dat', driveId: created?.id, md5: file.md5, size: file.size }]);
    });

    it('updates existing files in place, even ones another member owns', async () => {
        const node = remoteFile('level.dat', 'old', BOB);
        const file = await localFile('world/level.dat', 'new level data');
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [{
            kind: 'upload', path: 'world/level.dat', name: 'level.dat', size: file.size, md5: file.md5, source: file.source, driveId: node.id,
        }]);

        expect(result.done).toEqual([{ kind: 'upload', path: 'world/level.dat', driveId: node.id, md5: file.md5, size: file.size }]);
        expect(store.text(node.id)).toBe('new level data');
        expect(node.ownerEmail).toBe(BOB);
        expect(calls('createFile')).toHaveLength(0);
    });

    it('retries a checksum mismatch by updating the file it created instead of creating duplicates', async () => {
        const file = await localFile('world/new.dat', 'brand new');
        const { engine } = makeEngine(store.as(ALICE), { maxAttempts: 3 });

        const result = await engine.run('Uploading', [{
            kind: 'upload', path: 'world/new.dat', name: 'new.dat', size: file.size, md5: '00000000000000000000000000000000',
            source: file.source, parentId: world, appProperties: { mdhServer: root, mdhPath: 'world/new.dat' },
        }]);

        expect(result.failed[0].error.code).toBe('CHECKSUM');
        expect(calls('createFile')).toHaveLength(1);
        expect(calls('updateContent')).toHaveLength(2);
        expect(store.children(world).filter((n) => n.name === 'new.dat')).toHaveLength(1);
    });

    it('reuses a file created by an attempt whose answer got lost', async () => {
        const base = store.as(ALICE);
        let first = true;
        const drive = override(base, {
            createFile: async (name, parentId, source, opts, appProperties) => {
                const created = await base.createFile(name, parentId, source, opts, appProperties);
                if (first) {
                    first = false;
                    throw new DriveError('Backend Error', 503, 'backendError');
                }
                return created;
            },
        });
        const file = await localFile('world/new.dat', 'brand new');
        const { engine } = makeEngine(drive);

        const result = await engine.run('Uploading', [{
            kind: 'upload', path: 'world/new.dat', name: 'new.dat', size: file.size, md5: file.md5,
            source: file.source, parentId: world, appProperties: { mdhServer: root, mdhPath: 'world/new.dat' },
        }]);

        const copies = store.children(world).filter((n) => n.name === 'new.dat');
        expect(copies).toHaveLength(1);
        expect(result.done).toEqual([{ kind: 'upload', path: 'world/new.dat', driveId: copies[0].id, md5: file.md5, size: file.size }]);
        expect(calls('createFile')).toHaveLength(1);
        expect(calls('updateContent')).toHaveLength(1);
    });

    it('does not retry when the owner\'s storage is full and names the owner', async () => {
        const node = remoteFile('level.dat', 'old', BOB);
        const file = await localFile('world/level.dat', 'new');
        store.failNext('updateContent', 5, QUOTA_FULL);
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [{
            kind: 'upload', path: 'world/level.dat', name: 'level.dat', size: file.size, md5: file.md5, source: file.source, driveId: node.id,
        }]);

        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].error.code).toBe('QUOTA_FULL');
        expect(result.failed[0].error.message).toBe('bob\'s Google Drive is full, so nobody can change the files they own.');
        expect(calls('updateContent')).toHaveLength(1);
    });

    it('reports my own full storage when a new file cannot be created', async () => {
        const file = await localFile('world/new.dat', 'new');
        store.failNext('createFile', 5, QUOTA_FULL);
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [{
            kind: 'upload', path: 'world/new.dat', name: 'new.dat', size: file.size, md5: file.md5, source: file.source, parentId: world,
        }]);

        expect(result.failed[0].error.code).toBe('QUOTA_FULL');
        expect(result.failed[0].error.message).toMatch(/^Your Google Drive is full/);
        expect(calls('createFile')).toHaveLength(1);
    });
});

describe('TransferEngine delete-remote', () => {
    const job = (driveId: string, pendingFolderId: string | null = pending): TransferJob =>
        ({ kind: 'delete-remote', path: 'world/old.dat', driveId, serverId: root, pendingFolderId });

    it('trashes files I own', async () => {
        const node = remoteFile('old.dat', 'old', ALICE);
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [job(node.id)]);

        expect(result.done).toEqual([{ kind: 'delete-remote', path: 'world/old.dat', method: 'trashed' }]);
        expect(node.trashed).toBe(true);
        expect(calls('markDeleted')).toHaveLength(0);
    });

    it('turns a file someone else owns into a placeholder in pending-delete', async () => {
        const node = remoteFile('old.dat', 'old content', BOB, world, { appProperties: { mdhServer: root, mdhPath: 'world/old.dat' } });
        const { engine } = makeEngine(store.as(ALICE), { now: () => Date.UTC(2026, 9, 15, 13, 0, 0) });

        const result = await engine.run('Uploading', [job(node.id)]);

        expect(result.done).toEqual([{ kind: 'delete-remote', path: 'world/old.dat', method: 'placeholder' }]);
        expect(node.trashed).toBe(false);
        expect(node.ownerEmail).toBe(BOB);
        expect(node.content).toHaveLength(0);
        expect(node.parentId).toBe(pending);
        expect(node.appProperties).toEqual({
            mdhServer: root, mdhPath: 'world/old.dat', mdhTombstone: '1', mdhDeletedBy: ALICE, mdhDeletedAt: '2026-10-15T13:00:00.000Z',
        });
        expect(calls('trash')).toHaveLength(0);
    });

    it('marks in place when the owner does not let editors move the file', async () => {
        const node = remoteFile('old.dat', 'old content', BOB, world, { writersCanShare: false });
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [job(node.id)]);

        expect(result.done).toEqual([{ kind: 'delete-remote', path: 'world/old.dat', method: 'placeholder' }]);
        expect(node.parentId).toBe(world);
        expect(node.appProperties.mdhTombstone).toBe('1');
        expect(node.content).toHaveLength(0);
        expect(calls('markDeleted')).toHaveLength(1);
        expect(calls('markDeleted')[0][2]).toBeUndefined();
    });

    it('retries without the move when the move is refused with a 403', async () => {
        const node = remoteFile('old.dat', 'old content', BOB);
        store.failNext('markDeleted', 1, NO_PERMISSION, (args) => args[2] !== undefined);
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [job(node.id)]);

        expect(result.done).toEqual([{ kind: 'delete-remote', path: 'world/old.dat', method: 'placeholder' }]);
        const marks = calls('markDeleted');
        expect(marks).toHaveLength(2);
        expect(marks[0][2]).toEqual({ addParent: pending, removeParent: world });
        expect(marks[1][2]).toBeUndefined();
        expect(node.parentId).toBe(world);
        expect(node.appProperties.mdhTombstone).toBe('1');
    });

    it('marks in place when there is no pending-delete folder', async () => {
        const node = remoteFile('old.dat', 'old content', BOB);
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [job(node.id, null)]);

        expect(result.done[0]).toMatchObject({ method: 'placeholder' });
        expect(node.parentId).toBe(world);
        expect(calls('markDeleted')[0][2]).toBeUndefined();
    });

    it('treats missing and trashed files as already gone', async () => {
        const trashed = remoteFile('gone.dat', 'x', BOB, world, { trashed: true });
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [job('does-not-exist'), { ...job(trashed.id), path: 'world/gone.dat' }]);

        expect(result.failed).toEqual([]);
        expect(result.done.map((o) => o.kind === 'delete-remote' && o.method)).toEqual(['already-gone', 'already-gone']);
    });

    it('fails with FORBIDDEN when I may neither trash nor change the file', async () => {
        const node = remoteFile('old.dat', 'old content', BOB);
        const base = store.as(ALICE);
        const drive = override(base, {
            getMeta: async (fileId) => ({ ...(await base.getMeta(fileId)), capabilities: { canTrash: false, canModifyContent: false } }),
        });
        const { engine } = makeEngine(drive);

        const result = await engine.run('Uploading', [job(node.id)]);

        expect(result.failed[0].error.code).toBe('FORBIDDEN');
        expect(calls('getMeta')).toHaveLength(1);
        expect(calls('markDeleted')).toHaveLength(0);
        expect(node.content).not.toHaveLength(0);
    });

    it('names the owner when their storage is full and does not retry', async () => {
        const node = remoteFile('old.dat', 'old content', BOB);
        store.failNext('markDeleted', 5, QUOTA_FULL);
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Uploading', [job(node.id)]);

        expect(result.failed[0].error).toMatchObject({ code: 'QUOTA_FULL', message: 'bob\'s Google Drive is full, so nobody can change the files they own.' });
        expect(calls('markDeleted')).toHaveLength(1);
    });
});

describe('TransferEngine delete-local', () => {
    it('deletes the file and the folders it leaves empty, never the server root', async () => {
        const a = await localFile('world/region/r.0.0.mca', 'a');
        await localFile('world/level.dat', 'keep');
        const b = await localFile('lonely/deep/file.txt', 'b');
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Downloading', [
            { kind: 'delete-local', path: 'world/region/r.0.0.mca', target: a.source },
            { kind: 'delete-local', path: 'lonely/deep/file.txt', target: b.source },
            { kind: 'delete-local', path: 'never/existed.txt', target: path.join(tmp, 'never', 'existed.txt') },
        ]);

        expect(result.failed).toEqual([]);
        expect(result.done).toHaveLength(3);
        expect(await filesUnder(tmp)).toEqual(['world/level.dat']);
        expect(await exists(path.join(tmp, 'world', 'region'))).toBe(false);
        expect(await exists(path.join(tmp, 'lonely'))).toBe(false);
        expect(await exists(tmp)).toBe(true);
    });

    it('runs local deletions before downloads, so a file can make room for a folder', async () => {
        const old = await localFile('world/x', 'a file where a folder will be');
        const folder = store.addNode({ name: 'x', mimeType: FOLDER_MIME, parentId: world, ownerEmail: BOB }).id;
        const node = remoteFile('a.dat', 'inside the folder', BOB, folder);
        const { engine } = makeEngine(store.as(ALICE));

        const result = await engine.run('Downloading', [
            downloadJob(node, 'world/x/a.dat'),
            { kind: 'delete-local', path: 'world/x', target: old.source },
        ]);

        expect(result.failed).toEqual([]);
        expect(await readFile(path.join(tmp, 'world', 'x', 'a.dat'), 'utf8')).toBe('inside the folder');
    });
});

describe('TransferEngine run', () => {
    it('never rejects because of failed jobs', async () => {
        const fine = remoteFile('fine.dat', 'fine', BOB);
        const file = await localFile('world/up.dat', 'up');
        const { engine } = makeEngine(store.as(ALICE), { maxAttempts: 2 });

        const result = await engine.run('Mixed', [
            downloadJob(fine, 'world/fine.dat'),
            { kind: 'download', path: 'world/missing.dat', driveId: 'nope', size: 3, md5: 'x', dest: path.join(tmp, 'world', 'missing.dat') },
            { kind: 'upload', path: 'world/up.dat', name: 'up.dat', size: file.size, md5: file.md5, source: file.source },
            { kind: 'upload', path: 'world/vanished.dat', name: 'v.dat', size: 1, md5: 'x', source: path.join(tmp, 'nope'), driveId: fine.id },
        ]);

        expect(result.done.map((o) => o.path)).toEqual(['world/fine.dat']);
        expect(result.failed.map((f) => [f.job.path, f.error.code]).sort()).toEqual([
            ['world/missing.dat', 'NOT_FOUND'],
            ['world/up.dat', 'INVALID'],
            ['world/vanished.dat', 'UNKNOWN'],
        ]);
    });

    it('reports snapshots whose numbers add up', async () => {
        const nodes = Array.from({ length: 5 }, (_, i) => remoteFile(`f${i}.dat`, 'x'.repeat(100 * (i + 1)), BOB));
        const jobs: TransferJob[] = nodes.map((n, i) => downloadJob(n, `world/f${i}.dat`));
        jobs.push({ kind: 'download', path: 'world/broken.dat', driveId: nodes[0].id, size: 100, md5: 'bad', dest: path.join(tmp, 'broken.dat') });
        const old = await localFile('old.txt', 'old');
        jobs.push({ kind: 'delete-local', path: 'old.txt', target: old.source });
        const { engine, snaps } = makeEngine(store.as(ALICE), { maxAttempts: 2 });

        const result = await engine.run('Downloading', jobs);

        expect(snaps.length).toBeGreaterThanOrEqual(2);
        for (const s of snaps) {
            expect(s.filesDone + s.filesFailed + s.filesQueued + inLanes(s)).toBe(s.filesTotal);
            expect(s.bytesDone).toBeLessThanOrEqual(s.bytesTotal);
        }
        expect(snaps[0]).toMatchObject({ active: true, label: 'Downloading', filesTotal: 7, filesDone: 0, filesQueued: 7 });
        const last = snaps[snaps.length - 1];
        expect(last).toEqual(engine.snapshot());
        expect(last).toMatchObject({
            active: false, filesTotal: 7, filesDone: 6, filesFailed: 1, filesQueued: 0,
            bytesTotal: 100 + 200 + 300 + 400 + 500 + 100, bytesDone: 1500, lanes: [],
        });
        expect(last.failures).toEqual([{ path: 'world/broken.dat', kind: 'download', message: result.failed[0].error.message }]);
        expect(result.done).toHaveLength(6);
    });

    it('rejects at once when the signal is already aborted', async () => {
        const node = remoteFile('a.dat', 'a', BOB);
        const { engine } = makeEngine(store.as(ALICE));
        const controller = new AbortController();
        controller.abort();

        await expect(engine.run('Downloading', [downloadJob(node, 'world/a.dat')], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(calls('download')).toHaveLength(0);
    });

    it('rejects on abort, cancels requests in flight and drops waiting jobs', async () => {
        const base = store.as(ALICE);
        let started = 0;
        let sawSignal = false;
        const drive = override(base, {
            download: (_fileId, _destPath, opts) => new Promise((_resolve, reject) => {
                started += 1;
                sawSignal = opts?.signal !== undefined;
                opts?.signal?.addEventListener('abort', () => {
                    const err = new Error('This operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                }, { once: true });
            }),
        });
        const nodes = Array.from({ length: 10 }, (_, i) => remoteFile(`f${i}.dat`, `content ${i}`, BOB));
        const { engine } = makeEngine(drive, { lanes: { start: 2, min: 1, max: 12 } });
        const controller = new AbortController();

        const running = engine.run('Downloading', nodes.map((n, i) => downloadJob(n, `world/f${i}.dat`)), controller.signal);
        await vi.waitFor(() => expect(started).toBe(2));
        controller.abort(new AppError('LOCK_LOST', 'Another member took over the server.'));

        await expect(running).rejects.toMatchObject({ code: 'LOCK_LOST' });
        expect(sawSignal).toBe(true);
        expect(engine.snapshot().active).toBe(false);
        await delay(30);
        expect(started).toBe(2);                    // nothing else was started after the abort
    });

    it('does not trigger Node\'s listener-leak warning with many lanes listening to the signal', async () => {
        const base = store.as(ALICE);
        const drive = override(base, {
            download: async (fileId, destPath, opts) => {
                const listener = (): void => undefined;
                opts?.signal?.addEventListener('abort', listener);  // what fetch does for every request
                await delay(30);
                opts?.signal?.removeEventListener('abort', listener);
                return base.download(fileId, destPath, opts);
            },
        });
        const warnings: Error[] = [];
        const onWarning = (w: Error): void => {
            warnings.push(w);
        };
        process.on('warning', onWarning);
        try {
            const nodes = Array.from({ length: 12 }, (_, i) => remoteFile(`f${i}.dat`, `content ${i}`, BOB));
            const { engine } = makeEngine(drive, { lanes: { start: 12, min: 1, max: 12 } });
            const result = await engine.run('Downloading', nodes.map((n, i) => downloadJob(n, `world/f${i}.dat`)), new AbortController().signal);
            await delay(10);
            expect(result.done).toHaveLength(12);
            expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
        } finally {
            process.off('warning', onWarning);
        }
    });

    it('runs one transfer at a time', async () => {
        const a = remoteFile('a.dat', 'a', BOB);
        const b = remoteFile('b.dat', 'b', BOB);
        const { engine, snaps } = makeEngine(store.as(ALICE));

        const [first, second] = await Promise.all([
            engine.run('First', [downloadJob(a, 'world/a.dat')]),
            engine.run('Second', [downloadJob(b, 'world/b.dat')]),
        ]);

        expect(first.done).toHaveLength(1);
        expect(second.done).toHaveLength(1);
        const labels = snaps.map((s) => s.label);
        expect(labels.lastIndexOf('First')).toBeLessThan(labels.indexOf('Second'));
    });
});

describe('TransferEngine create-folder and journal hooks', () => {
    function folderJob(name: string, parentId = world): TransferJob {
        const relPath = `world/${name}`;
        return { kind: 'create-folder', path: relPath, name, parentId, serverId: root, appProperties: { mdhServer: root, mdhPath: relPath } };
    }

    it('creates folders in parallel lanes and reports each one', async () => {
        const { engine, snaps } = makeEngine(store.as(ALICE));
        const result = await engine.run('Creating folders', ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => folderJob(n)));
        expect(result.failed).toEqual([]);
        expect(result.done.map((o) => o.path).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `world/${n}`));
        expect(store.children(world).filter((n) => n.mimeType === FOLDER_MIME)).toHaveLength(6);
        expect(snaps.some((s) => s.lanes.some((l) => l.kind === 'create-folder'))).toBe(true);
    });

    it('a retry after a lost answer finds the folder the first attempt made', async () => {
        store.loseNextResponse('createFolder', 1);
        const { engine } = makeEngine(store.as(ALICE));
        const result = await engine.run('Creating folders', [folderJob('region')]);
        expect(result.failed).toEqual([]);
        const made = store.children(world).filter((n) => n.name === 'region');
        expect(made).toHaveLength(1);
        expect(result.done[0]).toEqual({ kind: 'create-folder', path: 'world/region', driveId: made[0].id });
    });

    it('calls onStart before a job\'s first request and onDone once it finished', async () => {
        const order: string[] = [];
        const drive = override(store.as(ALICE), {
            createFolder: async (...args: Parameters<DriveApi['createFolder']>) => {
                order.push(`request ${args[0]}`);
                return store.as(ALICE).createFolder(...args);
            },
        });
        const { engine } = makeEngine(drive);
        await engine.run('Creating folders', [folderJob('x')], undefined, {
            onStart: (job) => void order.push(`start ${job.path}`),
            onDone: (o) => void order.push(`done ${o.path}`),
        });
        expect(order).toEqual(['start world/x', 'request x', 'done world/x']);
    });
});
