// Two PCs, one fake Google Drive: the sync engine end to end, with the real planner, scanner,
// manifest code, transfer engine and app-data store. Only Drive and the lock are fakes.
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_PROPS, DEFAULT_JAVA_FLAGS } from '../../shared/types';
import type { LockView, UserInfo } from '../../shared/types';
import { FakeDriveStore } from '../../test/fakes/FakeDrive';
import { DriveError } from '../drive/types';
import { AppError } from '../errors';
import { AppData } from '../store/appData';
import { TransferEngine } from '../transfer/TransferEngine';
import { LauncherFiles } from './launcherFiles';
import { readManifest } from './manifest';
import type { ProgressSink } from './progressSink';
import { SyncEngine, windowsPathProblem } from './SyncEngine';
import { pathHash } from './tags';

const ALICE: UserInfo = { name: 'Alice', email: 'alice@example.com', picture: '' };
const BOB: UserInfo = { name: 'Bob', email: 'bob@example.com', picture: '' };
const WRITES = new Set(['createFolder', 'createFile', 'updateContent', 'trash', 'deleteForever', 'rename', 'markDeleted']);

interface Pc {
    user: UserInfo;
    root: string;
    appData: AppData;
    launcher: LauncherFiles;
    sync: SyncEngine;
    lockView: LockView;
    steps: string[];
}

let store: FakeDriveStore;
let serverId: string;
let temp: string;
let alice: Pc;
let bob: Pc;

async function makePc(user: UserInfo, name: string, platform: NodeJS.Platform = 'linux'): Promise<Pc> {
    const root = path.join(temp, name, 'server');
    await mkdir(root, { recursive: true });
    const drive = store.as(user.email);
    const launcher = new LauncherFiles(drive);
    const appData = new AppData(path.join(temp, name, 'userData'));
    const me = async () => user;
    const pc: Pc = { user, root, appData, launcher, sync: null as unknown as SyncEngine, lockView: { state: 'free', lock: null }, steps: [] };
    pc.sync = new SyncEngine({
        drive, launcher, appData, me, platform,
        lock: { inspect: async () => pc.lockView, sessionId: `session-${name}` },
        transfers: new TransferEngine({ drive, me, emit: () => undefined, backoffMs: () => 0, maxAttempts: 3 }),
        settings: { getServer: () => ({ localPath: root, javaFlags: { ...DEFAULT_JAVA_FLAGS } }) },
        step: (message) => pc.steps.push(message),
        now: () => store.now(),
    });
    return pc;
}

async function put(pc: Pc, rel: string, text: string): Promise<void> {
    const abs = path.join(pc.root, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text);
}

async function read(pc: Pc, rel: string): Promise<string | null> {
    try {
        return await readFile(path.join(pc.root, ...rel.split('/')), 'utf8');
    } catch {
        return null;
    }
}

/** A full session as the session controller runs it: preflight, download, (play), upload. */
async function session(pc: Pc, play: () => Promise<void> = async () => undefined): Promise<{ uploaded: number; deleted: number; revision: number }> {
    const report = await pc.sync.preflight(serverId);
    await pc.sync.download(serverId, report);
    await play();
    return pc.sync.uploadSession(serverId);
}

function writesDuring(): () => number {
    const before = store.calls.length;
    return () => store.calls.slice(before).filter((c) => WRITES.has(c.op)).length;
}

beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'mdh-sync-'));
    store = new FakeDriveStore();
    serverId = store.createRoot('Server-1', ALICE.email);
    alice = await makePc(ALICE, 'alice');
    bob = await makePc(BOB, 'bob');
});

afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
});

describe('a new server', () => {
    it('reports new-server, then uploads everything as revision 1', async () => {
        await put(alice, 'server.properties', 'motd=hi');
        await put(alice, 'world/level.dat', 'level');
        await put(alice, 'world/region/r.0.0.mca', 'region');
        await put(alice, 'logs/latest.log', 'not shared');
        await put(alice, 'world/session.lock', 'never shared');

        const report = await alice.sync.preflight(serverId);
        expect(report.status).toBe('new-server');
        expect(report.plan.upload).toEqual(['server.properties', 'world/level.dat', 'world/region/r.0.0.mca']);
        expect(report.firstSyncOnThisPc).toBe(true);

        await alice.sync.download(serverId, report);
        const result = await alice.sync.uploadSession(serverId);
        expect(result).toEqual({ uploaded: 3, deleted: 0, revision: 1 });

        const manifest = await readManifest(alice.launcher, serverId);
        expect(manifest?.revision).toBe(1);
        expect(manifest?.author.email).toBe(ALICE.email);
        expect(Object.keys(manifest?.files ?? {}).sort()).toEqual(['server.properties', 'world/level.dat', 'world/region/r.0.0.mca']);
        const region = store.findPath(serverId, 'world/region/r.0.0.mca');
        expect(region?.appProperties).toEqual({
            [APP_PROPS.server]: serverId, [APP_PROPS.path]: 'world/region/r.0.0.mca', [APP_PROPS.pathHash]: pathHash('world/region/r.0.0.mca'),
        });
        expect(manifest?.files['world/region/r.0.0.mca'].driveId).toBe(region?.id);
        expect(manifest?.folders).toMatchObject({ world: store.findPath(serverId, 'world')?.id });
        expect(store.findPath(serverId, 'logs')).toBeUndefined();
        // The shared rules file is created with the defaults on the first upload.
        expect(store.findPath(serverId, '.launcher/sync-rules.json')).toBeDefined();
        expect(alice.appData.readBase(serverId)?.revision).toBe(1);
        expect(alice.appData.readJournal(serverId)).toBeNull();

        expect((await alice.sync.preflight(serverId)).status).toBe('in-sync');
    });

    it('preflight never writes to Drive, even for a server with no .launcher folder', async () => {
        await put(alice, 'a.txt', 'a');
        const writes = writesDuring();
        await alice.sync.preflight(serverId);
        expect(writes()).toBe(0);
        expect(store.findPath(serverId, '.launcher')).toBeUndefined();
    });

    it('reports no-local-path when the folder is gone', async () => {
        await rm(alice.root, { recursive: true });
        expect((await alice.sync.preflight(serverId)).status).toBe('no-local-path');
    });
});

describe('two PCs taking turns', () => {
    beforeEach(async () => {
        await put(alice, 'server.properties', 'motd=hi');
        await put(alice, 'world/level.dat', 'level-1');
        await put(alice, 'world/region/r.0.0.mca', 'region-1');
        await session(alice);
    });

    it('the second PC downloads everything and ends in sync', async () => {
        const report = await bob.sync.preflight(serverId);
        expect(report.status).toBe('cloud-newer');
        expect(report.downloadBytes).toBe('motd=hi'.length + 'level-1'.length + 'region-1'.length);
        await bob.sync.download(serverId, report);
        expect(await read(bob, 'world/region/r.0.0.mca')).toBe('region-1');
        expect(bob.appData.readBase(serverId)?.revision).toBe(1);
        expect((await bob.sync.preflight(serverId)).status).toBe('in-sync');
        // Nothing changed, nothing is uploaded and no revision is made.
        expect(await bob.sync.uploadSession(serverId)).toEqual({ uploaded: 0, deleted: 0, revision: 1 });
    });

    it('changes are written into the same Drive file, which keeps its owner', async () => {
        const before = store.findPath(serverId, 'world/level.dat')!;
        await session(bob, () => put(bob, 'world/level.dat', 'level-2'));
        const after = store.findPath(serverId, 'world/level.dat')!;
        expect(after.id).toBe(before.id);
        expect(after.ownerEmail).toBe(ALICE.email);
        expect(Buffer.from(after.content).toString()).toBe('level-2');
        expect((await readManifest(bob.launcher, serverId))?.revision).toBe(2);

        const report = await alice.sync.preflight(serverId);
        expect(report.status).toBe('cloud-newer');
        expect(report.plan.download).toEqual(['world/level.dat']);
        await alice.sync.download(serverId, report);
        expect(await read(alice, 'world/level.dat')).toBe('level-2');
    });

    it('a file deleted by someone who does not own it becomes a placeholder its owner deletes later', async () => {
        await session(bob, async () => {
            await rm(path.join(bob.root, 'world', 'region', 'r.0.0.mca'));
        });
        const manifest = await readManifest(bob.launcher, serverId);
        expect(manifest?.files['world/region/r.0.0.mca']).toBeUndefined();
        const pending = store.findPath(serverId, '.launcher/pending-delete/r.0.0.mca')!;
        expect(pending.ownerEmail).toBe(ALICE.email);
        expect(pending.content.length).toBe(0);
        expect(pending.appProperties).toMatchObject({
            [APP_PROPS.tombstone]: '1', [APP_PROPS.server]: serverId, [APP_PROPS.deletedBy]: BOB.email,
        });
        expect(store.findPath(serverId, 'world/region/r.0.0.mca')).toBeUndefined();

        // Bob's preflight sees one file waiting for Alice; Alice's sees one of her own.
        expect((await bob.sync.preflight(serverId)).cleanup).toEqual({ mine: 0, others: [{ ownerEmail: ALICE.email, count: 1 }] });
        const report = await alice.sync.preflight(serverId);
        expect(report.cleanup).toEqual({ mine: 1, others: [] });
        expect(report.plan.deleteLocal).toEqual(['world/region/r.0.0.mca']);

        expect(await alice.sync.cleanupMyPlaceholders()).toBe(1);
        expect(store.nodes.has(pending.id)).toBe(false);          // deleted for good, not trashed
        await alice.sync.download(serverId, report);
        expect(await read(alice, 'world/region/r.0.0.mca')).toBeNull();
    });

    it('the owner deleting their own file trashes it', async () => {
        const id = store.findPath(serverId, 'world/level.dat')!.id;
        await session(alice, () => rm(path.join(alice.root, 'world', 'level.dat')));
        expect(store.node(id).trashed).toBe(true);
        expect(store.node(id).content.length).toBeGreaterThan(0);
    });

    it('cleanup skips a placeholder that the current manifest still lists', async () => {
        const id = store.findPath(serverId, 'world/level.dat')!.id;
        // As if Bob's upload had made the placeholder and then failed before committing.
        await store.as(BOB.email).markDeleted(id, { [APP_PROPS.tombstone]: '1', [APP_PROPS.server]: serverId });
        expect(await alice.sync.cleanupMyPlaceholders()).toBe(0);
        expect(store.nodes.has(id)).toBe(true);
    });

    it('new files from the other PC are owned by that PC and placed in the right folders', async () => {
        await session(bob, () => put(bob, 'world/DIM-1/region/r.1.1.mca', 'nether'));
        const file = store.findPath(serverId, 'world/DIM-1/region/r.1.1.mca')!;
        expect(file.ownerEmail).toBe(BOB.email);
        const manifest = await readManifest(bob.launcher, serverId);
        expect(manifest?.folders['world/DIM-1/region']).toBe(store.findPath(serverId, 'world/DIM-1/region')?.id);
        // Folders are not created twice.
        expect(store.children(serverId).filter((n) => n.name === 'world')).toHaveLength(1);
    });
});

describe('when both PCs changed something', () => {
    beforeEach(async () => {
        await put(alice, 'a.txt', 'a-1');
        await put(alice, 'b.txt', 'b-1');
        await session(alice);
        await session(bob);
    });

    it('different files: combine downloads theirs and uploads mine', async () => {
        await session(bob, () => put(bob, 'a.txt', 'a-bob'));
        await put(alice, 'b.txt', 'b-alice');

        const report = await alice.sync.preflight(serverId);
        expect(report.status).toBe('diverged');
        expect(report.allowedChoices).toEqual(['combine', 'keep-cloud', 'keep-local']);
        await expect(alice.sync.download(serverId, report)).rejects.toMatchObject({ code: 'CONFLICT' });

        const resolved = await alice.sync.resolve(serverId, 'combine');
        expect(resolved.pendingChoice).toBe('combine');
        await alice.sync.download(serverId, resolved);
        expect(await read(alice, 'a.txt')).toBe('a-bob');
        expect(await read(alice, 'b.txt')).toBe('b-alice');
        const result = await alice.sync.uploadSession(serverId);
        expect(result.revision).toBe(3);
        const manifest = await readManifest(alice.launcher, serverId);
        expect(Buffer.from(store.node(manifest!.files['b.txt'].driveId).content).toString()).toBe('b-alice');
        expect(Buffer.from(store.node(manifest!.files['a.txt'].driveId).content).toString()).toBe('a-bob');
        expect(alice.sync.pendingChoice(serverId)).toBeNull();
    });

    it('the same file: combine is not offered; keep-cloud backs up my version first', async () => {
        await session(bob, () => put(bob, 'a.txt', 'a-bob'));
        await put(alice, 'a.txt', 'a-alice');
        await put(alice, 'only-here.txt', 'mine');

        const report = await alice.sync.preflight(serverId);
        expect(report.plan.conflicts).toEqual(['a.txt']);
        expect(report.allowedChoices).toEqual(['keep-cloud', 'keep-local']);
        await expect(alice.sync.resolve(serverId, 'combine')).rejects.toBeInstanceOf(AppError);

        const resolved = await alice.sync.resolve(serverId, 'keep-cloud');
        expect(resolved.pendingChoice).toBe('keep-cloud');
        await alice.sync.download(serverId, resolved);
        expect(await read(alice, 'a.txt')).toBe('a-bob');
        expect(await read(alice, 'only-here.txt')).toBeNull();

        const backups = path.join(temp, 'alice', 'userData', 'servers', serverId, 'backups');
        const [dir] = await readdir(backups);
        expect(await readFile(path.join(backups, dir, 'a.txt'), 'utf8')).toBe('a-alice');
        expect(await readFile(path.join(backups, dir, 'only-here.txt'), 'utf8')).toBe('mine');
        expect((await alice.sync.uploadSession(serverId)).uploaded).toBe(0);
    });

    it('keep-local makes my copy the next revision', async () => {
        await session(bob, () => put(bob, 'a.txt', 'a-bob'));
        await put(alice, 'a.txt', 'a-alice');
        const resolved = await alice.sync.resolve(serverId, 'keep-local');
        expect(resolved.status).toBe('local-changes');
        await alice.sync.download(serverId, resolved);
        expect(await read(alice, 'a.txt')).toBe('a-alice');
        await alice.sync.uploadSession(serverId);
        const report = await bob.sync.preflight(serverId);
        await bob.sync.download(serverId, report);
        expect(await read(bob, 'a.txt')).toBe('a-alice');
    });

    it('an upload refuses to overwrite a cloud that moved on', async () => {
        await session(bob, () => put(bob, 'a.txt', 'a-bob'));
        await put(alice, 'b.txt', 'b-alice');
        // Alice skips the download step (as the old app could) and tries to upload.
        await expect(alice.sync.uploadSession(serverId)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await readManifest(alice.launcher, serverId))?.author.email).toBe(BOB.email);
    });
});

describe('failures and resuming', () => {
    beforeEach(async () => {
        await put(alice, 'a.txt', 'a-1');
        await session(alice);
    });

    it('a failed upload commits nothing, keeps the journal, and the retry creates no duplicates', async () => {
        await put(alice, 'new-1.txt', 'one');
        await put(alice, 'new-2.txt', 'two');
        await put(alice, 'a.txt', 'a-2');
        const fatal = () => new DriveError('Forbidden', 403, 'forbidden');
        store.failNext('createFile', 1, fatal, (args) => args[0] === 'new-2.txt');

        await expect(alice.sync.uploadSession(serverId)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
        expect((await readManifest(alice.launcher, serverId))?.revision).toBe(1);
        expect(alice.appData.readJournal(serverId)).toMatchObject({ baseRevision: 1, sessionId: 'session-alice' });
        expect(store.children(serverId).filter((n) => n.name === 'new-1.txt')).toHaveLength(1);

        const creates = () => store.calls.filter((c) => c.op === 'createFile').length;
        const before = creates();
        const result = await alice.sync.uploadSession(serverId);
        expect(result.revision).toBe(2);
        expect(creates() - before).toBe(1);                         // only new-2.txt
        expect(store.children(serverId).filter((n) => n.name === 'new-1.txt')).toHaveLength(1);
        expect(alice.appData.readJournal(serverId)).toBeNull();
    });

    it('an upload whose commit landed before the app stopped is finished, not reported as a conflict', async () => {
        await put(alice, 'a.txt', 'a-2');
        await alice.sync.uploadSession(serverId);
        // Simulate a crash between the commit and the base write: old base, journal still there.
        const base = alice.appData.readBase(serverId)!;
        alice.appData.writeBase(serverId, { ...base, revision: 1 });
        alice.appData.writeJournal(serverId, { format: 1, serverId, startedAt: 'x', baseRevision: 1, sessionId: 's' });

        expect(await alice.sync.uploadSession(serverId)).toEqual({ uploaded: 0, deleted: 0, revision: 2 });
        expect(alice.appData.readBase(serverId)?.revision).toBe(2);
        expect(alice.appData.readJournal(serverId)).toBeNull();
    });

    it('a failed download stops the start and leaves the base alone', async () => {
        await session(bob);
        await session(alice, () => put(alice, 'a.txt', 'a-2'));
        store.failNext('download', 10, () => new DriveError('Forbidden', 403, 'forbidden'));
        const report = await bob.sync.preflight(serverId);
        await expect(bob.sync.download(serverId, report)).rejects.toMatchObject({ code: 'DOWNLOAD_INCOMPLETE' });
        expect(bob.appData.readBase(serverId)?.revision).toBe(1);
        expect(await read(bob, 'a.txt')).toBe('a-1');
    });

    it('a file trashed by hand on the Drive website is created again', async () => {
        const id = store.findPath(serverId, 'a.txt')!.id;
        store.node(id).trashed = true;
        await put(alice, 'a.txt', 'a-2');
        await alice.sync.uploadSession(serverId);
        const manifest = await readManifest(alice.launcher, serverId);
        expect(manifest?.files['a.txt'].driveId).not.toBe(id);
        expect(Buffer.from(store.node(manifest!.files['a.txt'].driveId).content).toString()).toBe('a-2');
    });

    it('a stale upload makes the server unfinished-upload, unless it is mine and this PC has its journal', async () => {
        const stale = (email: string): LockView => ({
            state: 'stale', ageSeconds: 300,
            lock: { format: 2, sessionId: 'x', host: { name: 'X', email }, phase: 'uploading', leaseSeconds: 45, baseRevision: 1, startedAt: null, address: null, players: [] },
        });
        alice.lockView = stale(BOB.email);
        expect((await alice.sync.preflight(serverId)).status).toBe('unfinished-upload');
        alice.lockView = stale(ALICE.email);
        // Mine, but from another PC: this one cannot resume it.
        expect((await alice.sync.preflight(serverId)).status).toBe('unfinished-upload');
        alice.appData.writeJournal(serverId, { format: 1, serverId, startedAt: '2026-10-21T10:00:00Z', baseRevision: 1, sessionId: 'x', logged: true });
        expect(await alice.sync.preflight(serverId)).toMatchObject({ status: 'in-sync', unfinishedHere: true });
        // Left behind by this PC before its journal was written: nothing had been sent.
        alice.appData.deleteJournal(serverId);
        alice.lockView = { ...stale(ALICE.email), leftByThisPc: true } as LockView;
        expect(await alice.sync.preflight(serverId)).toMatchObject({ status: 'in-sync', unfinishedHere: false });
    });
});

/** Drive calls by operation while `run` runs. */
async function callsDuring(run: () => Promise<unknown>): Promise<Array<{ op: string; args: unknown[] }>> {
    const before = store.calls.length;
    await run();
    return store.calls.slice(before);
}

function countOf(calls: Array<{ op: string; args: unknown[] }>, op: string, when: (args: unknown[]) => boolean = () => true): number {
    return calls.filter((c) => c.op === op && when(c.args)).length;
}

/** listChildren without a name filter: a folder listed to look inside it, not a lookup of one .launcher file. */
const unnamedListing = (args: unknown[]): boolean => (args[1] as { name?: string } | undefined)?.name === undefined;

function recorder(): { sink: ProgressSink; events: string[]; totals: Map<string, number> } {
    const events: string[] = [];
    const totals = new Map<string, number>();
    const sink: ProgressSink = {
        enter: (key, message) => void events.push(`enter ${key}: ${message}`),
        setTotal: (key, units) => void totals.set(key, units),
        report: () => undefined,
        settle: () => undefined,
        complete: (key, message) => void events.push(`complete ${key}: ${message ?? ''}`),
        skip: (key) => void events.push(`skip ${key}`),
    };
    return { sink, events, totals };
}

function journalFile(pc: Pc, name: string): string {
    return path.join(path.dirname(pc.root), 'userData', 'servers', serverId, name);
}

describe('big first uploads', () => {
    it('creates every folder once, level by level, tagged with its path, and reports every stage', async () => {
        for (let i = 0; i < 12; i++) await put(alice, `mods/pack-${i}/textures/block/a.png`, `png-${i}`);
        const report = await alice.sync.preflight(serverId);
        await alice.sync.download(serverId, report);
        const progress = recorder();
        const calls = await callsDuring(() => alice.sync.uploadSession(serverId, undefined, progress.sink));

        // mods + 12 packs + 12 textures + 12 block folders, each made once, without looking inside new folders
        expect(countOf(calls, 'createFolder')).toBe(37);
        expect(countOf(calls, 'listChildren', unnamedListing)).toBe(1);
        expect(progress.totals.get('folders')).toBe(37);
        expect(progress.totals.get('files')).toBe(12);
        expect(store.findPath(serverId, 'mods/pack-3/textures/block')?.appProperties).toMatchObject({
            [APP_PROPS.server]: serverId, [APP_PROPS.pathHash]: pathHash('mods/pack-3/textures/block'),
        });
        expect(progress.events).toEqual(expect.arrayContaining([
            'complete scan: Checked 12 files',
            'complete folders: Created 37 folders on Google Drive',
            'complete files: Uploaded 12 files',
            'complete commit: Saved revision 1',
        ]));
    });

    it('a create whose answer got lost is not made a second time', async () => {
        await put(alice, 'world/region/r.0.0.mca', 'region');
        await put(alice, 'world/level.dat', 'level');
        store.loseNextResponse('createFolder', 1, (args) => args[0] === 'region');
        store.loseNextResponse('createFile', 1, (args) => args[0] === 'level.dat');
        await session(alice);
        const world = store.findPath(serverId, 'world')!;
        expect(store.children(world.id).filter((n) => n.name === 'region')).toHaveLength(1);
        expect(store.children(world.id).filter((n) => n.name === 'level.dat')).toHaveLength(1);
        expect((await readManifest(alice.launcher, serverId))?.revision).toBe(1);
    });

    it('paths too long for a Drive property are tagged by their hash instead of failing', async () => {
        const deep = `resourcepacks/${'Liminal Resources/'.repeat(4)}assets/kubejs/textures/block/unused/reality_frame5.png`;
        expect(Buffer.byteLength(`${APP_PROPS.path}${deep}`)).toBeGreaterThan(124);
        await put(alice, deep, 'png');
        await session(alice);
        const file = store.findPath(serverId, deep)!;
        expect(file.appProperties[APP_PROPS.path]).toBeUndefined();
        expect(file.appProperties[APP_PROPS.pathHash]).toBe(pathHash(deep));
    });
});

describe('retrying and resuming an upload', () => {
    async function firstAttemptFails(): Promise<void> {
        for (let i = 0; i < 20; i++) await put(alice, `world/dim-${i % 4}/region/r.${i}.mca`, `r-${i}`);
        const report = await alice.sync.preflight(serverId);
        await alice.sync.download(serverId, report);
        store.failNext('createFile', 1, () => new DriveError('Forbidden', 403, 'forbidden'), (args) => args[0] === 'r.7.mca');
        await expect(alice.sync.uploadSession(serverId)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
    }

    function sameNameTwice(): string[] {
        const seen = new Set<string>();
        const twice: string[] = [];
        for (const node of store.nodes.values()) {
            if (node.trashed) continue;
            const key = `${node.parentId}/${node.name}`;
            if (seen.has(key)) twice.push(node.name);
            seen.add(key);
        }
        return twice;
    }

    it('a retry sends only the failed file and does not look through the folders again', async () => {
        await firstAttemptFails();
        const calls = await callsDuring(() => alice.sync.uploadSession(serverId));
        expect(countOf(calls, 'createFile', (args) => args[0] !== 'manifest.json')).toBe(1);
        expect(countOf(calls, 'createFolder')).toBe(0);
        expect(countOf(calls, 'listChildren', unnamedListing)).toBe(0);
        // one search for what the failed attempt may have made, one for leftovers after the commit
        expect(countOf(calls, 'listMyTagged')).toBe(2);
        expect(sameNameTwice()).toEqual([]);
        expect((await readManifest(alice.launcher, serverId))?.revision).toBe(1);
    });

    it('after a crash, a file whose upload started but was never logged as done is found, not uploaded twice', async () => {
        await put(alice, 'world/level.dat', 'level');
        await put(alice, 'world/region/r.0.0.mca', 'region');
        const report = await alice.sync.preflight(serverId);
        await alice.sync.download(serverId, report);
        // Everything reaches Drive but the commit fails, as if the app had died right before it.
        store.failNext('createFile', 1, () => new DriveError('Forbidden', 403, 'forbidden'), (args) => args[0] === 'manifest.json');
        await expect(alice.sync.uploadSession(serverId)).rejects.toThrow('Forbidden');
        // ...and the "done" line of level.dat never made it to disk.
        const log = journalFile(alice, 'journal.log');
        const lines = (await readFile(log, 'utf8')).split('\n').filter((line) => !(line.includes('"done"') && line.includes('world/level.dat')));
        await writeFile(log, lines.join('\n'));

        const calls = await callsDuring(() => alice.sync.uploadSession(serverId));
        expect(countOf(calls, 'createFile', (args) => args[0] === 'level.dat' || args[0] === 'r.0.0.mca')).toBe(0);
        expect(sameNameTwice()).toEqual([]);
        const manifest = await readManifest(alice.launcher, serverId);
        expect(Object.keys(manifest?.files ?? {}).sort()).toEqual(['world/level.dat', 'world/region/r.0.0.mca']);
    });

    it('a journal written before the log existed is resumed without duplicates', async () => {
        await firstAttemptFails();
        const journalPath = journalFile(alice, 'journal.json');
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
        delete journal.logged;
        await writeFile(journalPath, JSON.stringify(journal));
        await rm(journalFile(alice, 'journal.log'));

        const calls = await callsDuring(() => alice.sync.uploadSession(serverId));
        expect(countOf(calls, 'createFile', (args) => args[0] !== 'manifest.json')).toBe(1);
        expect(countOf(calls, 'createFolder')).toBe(0);
        expect(sameNameTwice()).toEqual([]);
    });

    it('after the commit, files of mine the manifest does not use go to the trash, nobody else\'s', async () => {
        await put(alice, 'a.txt', 'a');
        await session(alice);
        const tags = (p: string) => ({ [APP_PROPS.server]: serverId, [APP_PROPS.pathHash]: pathHash(p) });
        const leftover = store.addNode({ name: 'a.txt', mimeType: 'text/plain', parentId: serverId, ownerEmail: ALICE.email, appProperties: tags('a.txt') });
        const bobs = store.addNode({ name: 'b.txt', mimeType: 'text/plain', parentId: serverId, ownerEmail: BOB.email, appProperties: tags('b.txt') });
        const used = store.findPath(serverId, 'a.txt')!;

        const progress = recorder();
        await put(alice, 'a.txt', 'a-2');
        await alice.sync.uploadSession(serverId, undefined, progress.sink);
        expect(store.node(leftover.id).trashed).toBe(true);
        expect(store.node(bobs.id).trashed).toBe(false);
        expect(store.node(used.id).trashed).toBe(false);
        expect(progress.events).toContain('complete cleanup: Moved 1 leftover file to the trash');
    });
});

describe('repairing another member\'s unfinished upload', () => {
    const bobStale: LockView = {
        state: 'stale', ageSeconds: 600,
        lock: { format: 2, sessionId: 'bob', host: { name: 'Bob', email: BOB.email }, phase: 'uploading', leaseSeconds: 45, baseRevision: 1, startedAt: null, address: null, players: [] },
    };

    beforeEach(async () => {
        await put(alice, 'server.properties', 'motd=hi');
        await put(alice, 'world/level.dat', 'level-1');
        await put(alice, 'world/region/r.0.0.mca', 'region-1');
        await session(alice);                                       // revision 1
        // Bob's upload stops half way: level.dat is overwritten in place, r.0.0.mca (Alice's) is emptied into a
        // placeholder, a new region file is created, and one file fails, so nothing is committed.
        await bob.sync.download(serverId, await bob.sync.preflight(serverId));
        await put(bob, 'world/level.dat', 'level-bob');
        await rm(path.join(bob.root, 'world', 'region', 'r.0.0.mca'));
        await put(bob, 'world/region/r.9.9.mca', 'bob-new');
        await put(bob, 'world/stuck.dat', 'never arrives');
        store.failNext('createFile', 3, () => new DriveError('Forbidden', 403, 'forbidden'), (args) => args[0] === 'stuck.dat');
        await expect(bob.sync.uploadSession(serverId)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
        alice.lockView = bobStale;
    });

    function cloudText(rel: string, manifest: { files: Record<string, { driveId: string }> }): string {
        return store.text(manifest.files[rel].driveId);
    }

    it('puts this PC\'s copy back wherever the cloud differs and commits it as the next revision', async () => {
        expect((await alice.sync.preflight(serverId)).status).toBe('unfinished-upload');
        const levelId = store.findPath(serverId, 'world/level.dat')!.id;
        expect(store.text(levelId)).toBe('level-bob');

        const result = await alice.sync.uploadSession(serverId, undefined, undefined, { repair: true });
        expect(result.revision).toBe(2);
        const manifest = (await readManifest(alice.launcher, serverId))!;
        expect(manifest.author.email).toBe(ALICE.email);
        expect(manifest.files['world/level.dat'].driveId).toBe(levelId);         // overwritten in place
        expect(cloudText('world/level.dat', manifest)).toBe('level-1');
        expect(cloudText('world/region/r.0.0.mca', manifest)).toBe('region-1'); // created again
        expect(cloudText('server.properties', manifest)).toBe('motd=hi');
        expect(Object.keys(manifest.files).sort()).toEqual(['server.properties', 'world/level.dat', 'world/region/r.0.0.mca']);
        expect(alice.appData.readJournal(serverId)).toBeNull();

        // Bob's app cannot finish his upload on top of the repaired cloud: it stops with a conflict instead.
        bob.lockView = { state: 'free', lock: null };
        await expect(bob.sync.uploadSession(serverId)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('a paused or failed repair is continued as a repair', async () => {
        store.failNext('updateContent', 1, () => new DriveError('Forbidden', 403, 'forbidden'));
        await expect(alice.sync.uploadSession(serverId, undefined, undefined, { repair: true })).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
        expect(alice.sync.unfinishedRepair(serverId)).toBe(true);

        const result = await alice.sync.uploadSession(serverId);
        expect(result.revision).toBe(2);
        expect(cloudText('world/level.dat', (await readManifest(alice.launcher, serverId))!)).toBe('level-1');
        expect(alice.sync.unfinishedRepair(serverId)).toBe(false);
    });

    it('needs this PC to have the last saved version', async () => {
        await put(alice, 'server.properties', 'motd=changed');
        alice.appData.writeBase(serverId, { format: 2, serverId, revision: 0, files: {}, folders: {} });
        await expect(alice.sync.uploadSession(serverId, undefined, undefined, { repair: true }))
            .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('cannot repair') });
        expect((await readManifest(alice.launcher, serverId))?.revision).toBe(1);
    });
});

describe('cancelling an upload for good', () => {
    beforeEach(async () => {
        await put(alice, 'server.properties', 'motd=hi');
        await put(alice, 'world/level.dat', 'level-1');
        await put(alice, 'world/region/r.0.0.mca', 'region-1');
        await session(alice);                                       // revision 1
    });

    it('saves what reached Drive as an incomplete revision; the rest goes up with the next upload', async () => {
        await put(alice, 'world/level.dat', 'level-2');
        await put(alice, 'world/region/r.0.0.mca', 'region-2');
        await put(alice, 'world/region/r.9.9.mca', 'new');
        const levelId = store.findPath(serverId, 'world/level.dat')!.id;
        store.failNext('updateContent', 1, () => new DriveError('Forbidden', 403, 'forbidden'), (args) => args[0] === levelId);
        await expect(alice.sync.uploadSession(serverId)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });

        expect(await alice.sync.commitPartial(serverId)).toEqual({ revision: 2, sent: 2, planned: 3 });
        const saved = (await readManifest(alice.launcher, serverId))!;
        expect(saved.incomplete).toMatchObject({ by: { email: ALICE.email }, sent: 2, planned: 3 });
        expect(store.text(saved.files['world/region/r.0.0.mca'].driveId)).toBe('region-2');
        expect(store.text(saved.files['world/region/r.9.9.mca'].driveId)).toBe('new');
        expect(store.text(saved.files['world/level.dat'].driveId)).toBe('level-1');     // never sent: still the old one
        expect(alice.appData.readJournal(serverId)).toBeNull();

        // The others are told before they play it.
        expect((await bob.sync.preflight(serverId)).remoteIncomplete).toMatchObject({ sent: 2, planned: 3 });
        // Alice still has the rest, and her next upload sends it and clears the mark.
        const report = await alice.sync.preflight(serverId);
        expect(report).toMatchObject({ status: 'local-changes', baseRevision: 2 });
        expect(report.plan.upload).toEqual(['world/level.dat']);
        await alice.sync.uploadSession(serverId);
        const after = (await readManifest(alice.launcher, serverId))!;
        expect(after.revision).toBe(3);
        expect(after.incomplete).toBeUndefined();
        expect(store.text(after.files['world/level.dat'].driveId)).toBe('level-2');
    });

    it('leaves the cloud alone when nothing had been sent', async () => {
        await put(alice, 'world/level.dat', 'level-2');
        alice.appData.writeJournal(serverId, { format: 1, serverId, startedAt: '2026-10-21T10:00:00Z', baseRevision: 1, sessionId: 'x', logged: true, planned: 1 });
        expect(await alice.sync.commitPartial(serverId)).toBeNull();
        expect((await readManifest(alice.launcher, serverId))?.revision).toBe(1);
        expect(alice.appData.readJournal(serverId)).toBeNull();
    });
});

describe('deleting a whole server', () => {
    it('hands every file the owner does not own back to its owner', async () => {
        await put(alice, 'a.txt', 'a');
        await session(alice);
        await session(bob, () => put(bob, 'bob.txt', 'b'));
        const progress: Array<[number, number]> = [];
        const calls = await callsDuring(async () => {
            expect(await alice.sync.markForeignFilesDeleted(serverId, (done, total) => progress.push([done, total]))).toBe(1);
        });
        // One search for the tagged files instead of a lookup per file.
        expect(countOf(calls, 'listTagged')).toBe(1);
        expect(countOf(calls, 'getMeta')).toBe(0);
        expect(progress).toEqual([[0, 1], [1, 1]]);
        const bobs = store.findPath(serverId, 'bob.txt')!;
        expect(bobs.appProperties[APP_PROPS.tombstone]).toBe('1');
        expect(bobs.content.length).toBe(0);
        expect(store.findPath(serverId, 'a.txt')!.appProperties[APP_PROPS.tombstone]).toBeUndefined();
        // The manifest still lists bob.txt, so Bob's cleanup leaves it until the folder is gone.
        expect(await bob.sync.cleanupMyPlaceholders()).toBe(0);
        // Alice deletes the server folder for good: her files go, Bob's are left without a folder.
        for (const node of [...store.nodes.values()]) if (node.ownerEmail === ALICE.email) store.nodes.delete(node.id);
        expect(await bob.sync.cleanupMyPlaceholders()).toBe(1);
        expect(store.nodes.has(bobs.id)).toBe(false);
    });
});

describe('rules', () => {
    it('creates sync-rules.json with the defaults and keeps user rules normalised', async () => {
        expect((await alice.sync.getRules(serverId)).ignore).toEqual(['logs/', 'crash-reports/', 'debug/', '*.tmp']);
        const rules = await alice.sync.setRules(serverId, [' backups/ ', '', 'a/../b', 'backups/']);
        expect(rules.ignore).toEqual(['backups/']);
        expect(rules.builtin).toContain('.launcher/');
        await put(alice, 'backups/old.zip', 'zip');
        await put(alice, 'logs/latest.log', 'log');
        expect((await alice.sync.preflight(serverId)).plan.upload).toEqual(['logs/latest.log']);
    });
});

describe('Windows names', () => {
    it('explains which cloud names this PC cannot store', () => {
        expect(windowsPathProblem('world/aux.dat')).toMatch(/reserved/);
        expect(windowsPathProblem('world/a:b')).toMatch(/character/);
        expect(windowsPathProblem('world/name.')).toMatch(/dot or a space/);
        expect(windowsPathProblem('world/region/r.0.0.mca')).toBeNull();
    });

    it('refuses to download them on Windows instead of failing half way', async () => {
        await put(alice, 'world/aux.dat', 'x');
        await session(alice);
        const win = await makePc(BOB, 'bob-win', 'win32');
        const report = await win.sync.preflight(serverId);
        await expect(win.sync.download(serverId, report)).rejects.toThrow(/aux\.dat/);
        await expect(stat(path.join(win.root, 'world'))).rejects.toThrow();
    });
});
