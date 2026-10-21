import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LockContent, UserInfo } from '../../shared/types';
import { FakeDriveStore } from '../../test/fakes/FakeDrive';
import { DriveError, FOLDER_MIME } from '../drive/types';
import type { DriveApi, DriveFileMeta } from '../drive/types';
import { AppError } from '../errors';
import { SettingsService } from '../settings/SettingsService';
import type { Dialogs } from '../settings/SettingsService';
import { AppData } from '../store/appData';
import { LauncherFiles } from '../sync/launcherFiles';
import {
    MAX_OWNED_SERVERS, ROOT_FOLDER_NAME, ServersService, nextServerName, parseFolderId, parseMaxPlayers,
} from './ServersService';
import type { DrivePermission, ServersDrive } from './ServersService';

const ALICE: UserInfo = { name: 'Alice', email: 'alice@example.com', picture: '' };
const BOB: UserInfo = { name: 'Bob', email: 'bob@example.com', picture: '' };

/** Permissions shared by every user's view, keyed by file id. */
class FakeSharing {
    readonly perms = new Map<string, DrivePermission[]>();
    readonly invites: Array<{ fileId: string; email: string; role: string; message: string }> = [];
    private seq = 0;

    add(fileId: string, email: string, role: string): DrivePermission {
        const perm = { id: `perm-${++this.seq}`, emailAddress: email, displayName: email.split('@')[0], role };
        this.perms.set(fileId, [...(this.perms.get(fileId) ?? []), perm]);
        return perm;
    }
}

const notFound = (id: string) => new DriveError(`File not found: ${id}`, 404, 'notFound');

/** DriveFiles' admin operations over the in-memory FakeDrive. Users only see what they own or what was
 *  shared with them (directly or through a parent folder), like Drive's real 404s. */
class FakeAdminDrive implements ServersDrive {
    readonly view: DriveApi;
    readonly counts = { listPermissions: 0, findFolders: 0 };

    constructor(private readonly store: FakeDriveStore, private readonly sharing: FakeSharing, private readonly user: string) {
        this.view = store.as(user);
    }

    private canSee(id: string): boolean {
        for (let node = this.store.nodes.get(id); node; node = node.parentId ? this.store.nodes.get(node.parentId) : undefined) {
            if (node.ownerEmail === this.user) return true;
            if ((this.sharing.perms.get(node.id) ?? []).some((p) => p.emailAddress === this.user)) return true;
        }
        return false;
    }

    async getMeta(fileId: string) {
        if (!this.canSee(fileId)) throw notFound(fileId);
        return this.view.getMeta(fileId);
    }

    listChildren(folderId: string, filter?: { name?: string; foldersOnly?: boolean }) {
        return this.view.listChildren(folderId, filter);
    }

    async createFolder(name: string, parentId: string) {
        const meta = await this.view.createFolder(name, parentId);
        this.sharing.add(meta.id, this.user, 'owner');
        return meta;
    }

    trash(fileId: string) {
        return this.view.trash(fileId);
    }

    rename(fileId: string, name: string) {
        return this.view.rename(fileId, name);
    }

    async findFolders(query: string): Promise<DriveFileMeta[]> {
        this.counts.findFolders += 1;
        const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1].replace(/\\(.)/g, '$1');
        const mineOnly = query.includes("'me' in owners");
        const matches = [...this.store.nodes.values()].filter((n) =>
            n.mimeType === FOLDER_MIME && !n.trashed && (name === undefined || n.name === name)
            && (!mineOnly || n.ownerEmail === this.user) && this.canSee(n.id));
        // Drive's search order is not creation order.
        return Promise.all(matches.reverse().map((n) => this.view.getMeta(n.id)));
    }

    async listPermissions(fileId: string): Promise<DrivePermission[]> {
        this.counts.listPermissions += 1;
        if (!this.canSee(fileId)) throw notFound(fileId);
        return [...(this.sharing.perms.get(fileId) ?? [])];
    }

    async addPermission(fileId: string, email: string, role: 'writer' | 'reader', message: string): Promise<void> {
        if (!this.canSee(fileId)) throw notFound(fileId);
        this.sharing.invites.push({ fileId, email, role, message });
        this.sharing.add(fileId, email, role);
    }

    async deletePermission(fileId: string, permissionId: string): Promise<void> {
        const perms = this.sharing.perms.get(fileId) ?? [];
        const perm = perms.find((p) => p.id === permissionId);
        if (!perm) throw new DriveError('Permission not found', 404, 'notFound');
        if (perm.role === 'owner') throw new DriveError('The owner cannot be removed', 403, 'cannotRemoveOwner');
        this.sharing.perms.set(fileId, perms.filter((p) => p.id !== permissionId));
    }
}

interface Actor {
    drive: FakeAdminDrive;
    launcher: LauncherFiles;
    appData: AppData;
    settings: SettingsService;
    dialogs: { [K in keyof Dialogs]: ReturnType<typeof vi.fn> } & Dialogs;
    me: ReturnType<typeof vi.fn>;
    beforeDelete: ReturnType<typeof vi.fn>;
    servers: ServersService;
    dataDir: string;
}

let tmp: string;
let store: FakeDriveStore;
let sharing: FakeSharing;
let alice: Actor;
let bob: Actor;

function actor(user: UserInfo): Actor {
    const dataDir = path.join(tmp, user.name);
    const drive = new FakeAdminDrive(store, sharing, user.email);
    const launcher = new LauncherFiles(store.as(user.email));
    const appData = new AppData(dataDir);
    const dialogs = {
        chooseFolder: vi.fn(async () => null),
        chooseFile: vi.fn(async () => null),
        openPath: vi.fn(async () => undefined),
    };
    const settings = new SettingsService({ appData, dialogs });
    const me = vi.fn(async () => user);
    const beforeDelete = vi.fn(async () => 0);
    const servers = new ServersService({ drive, launcher, auth: { me }, settings, appData, dialogs, beforeDelete });
    return { drive, launcher, appData, settings, dialogs, me, beforeDelete, servers, dataDir };
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-servers-'));
    store = new FakeDriveStore();
    sharing = new FakeSharing();
    // Drive's "root" alias for Alice's My Drive.
    store.addNode({ id: 'root', name: 'My Drive', mimeType: FOLDER_MIME, parentId: null, ownerEmail: ALICE.email });
    alice = actor(ALICE);
    bob = actor(BOB);
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function expectAppError(promise: Promise<unknown>, code: AppError['code']): Promise<AppError> {
    const err = await promise.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
}

const launcherText = (serverId: string, name: string): string | undefined => {
    const node = store.findPath(serverId, `.launcher/${name}`);
    return node ? store.text(node.id) : undefined;
};

describe('create', () => {
    test('creates the root folder, Server-1 and its .launcher files', async () => {
        fs.mkdirSync(alice.dataDir, { recursive: true });
        fs.writeFileSync(path.join(alice.dataDir, 'localStore.migrated.json'), JSON.stringify({
            localVariables: { watcherBlacklist: ['world\\data\\DistantHorizons.sqlite', 'logs', 'lock.json'] },
        }));

        const summary = await alice.servers.create();

        const roots = [...store.nodes.values()].filter((n) => n.name === ROOT_FOLDER_NAME);
        expect(roots).toHaveLength(1);
        expect(roots[0].parentId).toBe('root');
        expect(summary).toMatchObject({ name: 'Server-1', kind: 'owned', localPath: null, myRole: 'owner' });
        expect(store.node(summary.id).parentId).toBe(roots[0].id);
        expect(summary.members).toEqual([{ permissionId: expect.any(String), email: ALICE.email, name: 'alice', role: 'owner' }]);

        const lock = JSON.parse(launcherText(summary.id, 'lock.json') ?? 'null') as LockContent;
        expect(lock).toMatchObject({ format: 2, phase: 'free', players: [], address: null });
        const rules = JSON.parse(launcherText(summary.id, 'sync-rules.json') ?? 'null') as { format: number; ignore: string[] };
        expect(rules.format).toBe(1);
        expect(rules.ignore).toEqual(['logs/', 'crash-reports/', 'debug/', '*.tmp', 'world/data/DistantHorizons.sqlite']);
    });

    test('reuses the oldest root folder and picks the lowest free name', async () => {
        const first = await alice.servers.create();
        const second = await alice.servers.create();
        await alice.drive.trash(first.id);
        const third = await alice.servers.create();
        expect([first.name, second.name, third.name]).toEqual(['Server-1', 'Server-2', 'Server-1']);
        expect([...store.nodes.values()].filter((n) => n.name === ROOT_FOLDER_NAME && !n.trashed)).toHaveLength(1);
    });

    test(`refuses more than ${MAX_OWNED_SERVERS} owned servers`, async () => {
        for (let i = 0; i < MAX_OWNED_SERVERS; i++) await alice.servers.create();
        await expectAppError(alice.servers.create(), 'INVALID');
    });

    test('a failure while writing .launcher removes the half-created server', async () => {
        store.failNext('createFile', 1, () => new DriveError('backend error', 500, 'backendError'));
        await expect(alice.servers.create()).rejects.toBeInstanceOf(DriveError);
        const servers = [...store.nodes.values()].filter((n) => n.name.startsWith('Server-'));
        expect(servers.map((n) => n.trashed)).toEqual([true]);
        await expect(alice.servers.create()).resolves.toMatchObject({ name: 'Server-1' });
    });
});

describe('list', () => {
    test('owned and joined servers with members, one permissions call per folder and one me()', async () => {
        const s1 = await alice.servers.create();
        const s2 = await alice.servers.create();
        await alice.servers.invite(s1.id, BOB.email, 'writer', '');
        await alice.servers.invite(s2.id, BOB.email, 'reader', '');
        await bob.servers.join(s1.id);
        await bob.servers.join(s2.id);
        bob.settings.setLocalPath(s1.id, path.join(tmp, 'bob-s1'));

        bob.me.mockClear();
        bob.drive.counts.listPermissions = 0;
        const list = await bob.servers.list();

        expect(bob.me).toHaveBeenCalledTimes(1);
        expect(bob.drive.counts.listPermissions).toBe(2);
        expect(list.map((s) => [s.name, s.kind, s.myRole, s.localPath])).toEqual([
            ['Server-1', 'joined', 'writer', path.join(tmp, 'bob-s1')],
            ['Server-2', 'joined', 'reader', null],
        ]);
        expect(list[0].members.map((m) => [m.email, m.role])).toEqual([[ALICE.email, 'owner'], [BOB.email, 'writer']]);

        alice.drive.counts.listPermissions = 0;
        const owned = await alice.servers.list();
        expect(owned.map((s) => [s.name, s.kind, s.myRole])).toEqual([['Server-1', 'owned', 'owner'], ['Server-2', 'owned', 'owner']]);
        expect(alice.drive.counts.listPermissions).toBe(2);
    });

    test('no root folder yet: empty list without creating anything', async () => {
        await expect(alice.servers.list()).resolves.toEqual([]);
        expect([...store.nodes.values()].some((n) => n.name === ROOT_FOLDER_NAME)).toBe(false);
    });

    test('a joined id that is also owned is listed once, as owned', async () => {
        const s1 = await alice.servers.create();
        alice.settings.addJoined(s1.id);
        const list = await alice.servers.list();
        expect(list.map((s) => [s.id, s.kind])).toEqual([[s1.id, 'owned']]);
    });

    test('joined servers that are gone or trashed are skipped but remembered', async () => {
        const s1 = await alice.servers.create();
        await alice.servers.invite(s1.id, BOB.email, 'writer', '');
        await bob.servers.join(s1.id);
        bob.settings.addJoined('missing-folder');
        await alice.drive.trash(s1.id);
        await expect(bob.servers.list()).resolves.toEqual([]);
        expect(bob.settings.get().joinedServerIds).toEqual([s1.id, 'missing-folder']);
    });

    test('permissions Drive will not show leave members empty and derive my role from the folder', async () => {
        const s1 = await alice.servers.create();
        await alice.servers.invite(s1.id, BOB.email, 'writer', '');
        await bob.servers.join(s1.id);
        vi.spyOn(bob.drive, 'listPermissions').mockRejectedValue(new DriveError('nope', 403, 'insufficientFilePermissions'));
        const [summary] = await bob.servers.list();
        expect(summary).toMatchObject({ id: s1.id, members: [], myRole: 'writer' });
    });

    test('network errors are not swallowed', async () => {
        await alice.servers.create();
        vi.spyOn(alice.drive, 'listPermissions').mockRejectedValue(new DriveError('offline', 0));
        await expect(alice.servers.list()).rejects.toBeInstanceOf(DriveError);
    });
});

describe('join', () => {
    test('by id or by folder link', async () => {
        const s1 = await alice.servers.create();
        await alice.servers.invite(s1.id, BOB.email, 'writer', '');
        const summary = await bob.servers.join(`https://drive.google.com/drive/u/0/folders/${s1.id}?usp=sharing`);
        expect(summary).toMatchObject({ id: s1.id, kind: 'joined', myRole: 'writer', name: 'Server-1' });
        expect(bob.settings.get().joinedServerIds).toEqual([s1.id]);
        await bob.servers.join(s1.id);
        expect(bob.settings.get().joinedServerIds).toEqual([s1.id]);
    });

    test('a folder that was not shared with me is NOT_FOUND', async () => {
        const s1 = await alice.servers.create();
        await expectAppError(bob.servers.join(s1.id), 'NOT_FOUND');
        expect(bob.settings.get().joinedServerIds).toEqual([]);
    });

    test('files, trashed folders, my Drive root and my servers folder are refused', async () => {
        const s1 = await alice.servers.create();
        const lockId = store.findPath(s1.id, '.launcher/lock.json')?.id ?? '';
        await expectAppError(alice.servers.join(lockId), 'INVALID');
        await expectAppError(alice.servers.join('root'), 'INVALID');
        const rootFolder = [...store.nodes.values()].find((n) => n.name === ROOT_FOLDER_NAME);
        await expectAppError(alice.servers.join(rootFolder?.id ?? ''), 'INVALID');
        await alice.drive.trash(s1.id);
        await expectAppError(alice.servers.join(s1.id), 'NOT_FOUND');
    });

    test('joining my own server does not add it to the joined list', async () => {
        const s1 = await alice.servers.create();
        await expect(alice.servers.join(s1.id)).resolves.toMatchObject({ kind: 'owned', myRole: 'owner' });
        expect(alice.settings.get().joinedServerIds).toEqual([]);
    });

    test('garbage input is INVALID before any request', async () => {
        await expectAppError(bob.servers.join('   '), 'INVALID');
        await expectAppError(bob.servers.join('https://example.com/nothing'), 'INVALID');
    });
});

describe('members', () => {
    test('invite uses the chosen role and includes the server id in the email', async () => {
        const s1 = await alice.servers.create();
        await alice.servers.invite(s1.id, '  bob@example.com ', 'reader', 'Come play!');
        expect(sharing.invites).toEqual([{ fileId: s1.id, email: BOB.email, role: 'reader', message: expect.stringContaining('Come play!') }]);
        expect(sharing.invites[0].message).toContain(s1.id);
    });

    test('invite validates its input', async () => {
        const s1 = await alice.servers.create();
        await expectAppError(alice.servers.invite(s1.id, 'not-an-email', 'writer', ''), 'INVALID');
        await expectAppError(alice.servers.invite(s1.id, BOB.email, 'owner' as 'writer', ''), 'INVALID');
        await expectAppError(alice.servers.invite(s1.id, BOB.email, 'writer', 'x'.repeat(3000)), 'INVALID');
        expect(sharing.invites).toEqual([]);
    });

    test('removeMember deletes the permission', async () => {
        const s1 = await alice.servers.create();
        await alice.servers.invite(s1.id, BOB.email, 'writer', '');
        const bobPerm = (sharing.perms.get(s1.id) ?? []).find((p) => p.emailAddress === BOB.email);
        await alice.servers.removeMember(s1.id, bobPerm?.id ?? '');
        expect((sharing.perms.get(s1.id) ?? []).map((p) => p.emailAddress)).toEqual([ALICE.email]);
        await expectAppError(alice.servers.removeMember(s1.id, ' '), 'INVALID');
    });

    test('leave removes my permission and forgets the server here', async () => {
        const s1 = await alice.servers.create();
        await alice.servers.invite(s1.id, BOB.email, 'writer', '');
        await bob.servers.join(s1.id);
        bob.settings.set({ selectedServerId: s1.id });
        bob.settings.setLocalPath(s1.id, path.join(tmp, 'bob-s1'));

        await bob.servers.leave(s1.id);

        expect((sharing.perms.get(s1.id) ?? []).map((p) => p.emailAddress)).toEqual([ALICE.email]);
        expect(bob.settings.get()).toMatchObject({ joinedServerIds: [], selectedServerId: null });
        expect(bob.settings.getServer(s1.id).localPath).toBeNull();
        await expectAppError(bob.servers.join(s1.id), 'NOT_FOUND');
    });

    test('leave still forgets the server when Drive refuses to remove the permission', async () => {
        const s1 = await alice.servers.create();
        await alice.servers.invite(s1.id, BOB.email, 'reader', '');
        await bob.servers.join(s1.id);
        vi.spyOn(bob.drive, 'deletePermission').mockRejectedValue(new DriveError('nope', 403, 'insufficientFilePermissions'));
        await bob.servers.leave(s1.id);
        expect(bob.settings.get().joinedServerIds).toEqual([]);
    });

    test('the owner cannot leave', async () => {
        const s1 = await alice.servers.create();
        await expectAppError(alice.servers.leave(s1.id), 'FORBIDDEN');
    });
});

describe('delete and rename', () => {
    test('the owner marks foreign files first, then trashes the folder and forgets it', async () => {
        const s1 = await alice.servers.create();
        alice.settings.set({ selectedServerId: s1.id });
        alice.settings.setLocalPath(s1.id, path.join(tmp, 'alice-s1'));
        const order: string[] = [];
        alice.beforeDelete.mockImplementation(async (id: string) => {
            order.push(`before:${id}:${store.node(id).trashed}`);
            return 2;
        });

        await alice.servers.delete(s1.id);

        expect(order).toEqual([`before:${s1.id}:false`]);
        expect(store.node(s1.id).trashed).toBe(true);
        expect(alice.settings.get().selectedServerId).toBeNull();
        expect(alice.settings.getServer(s1.id).localPath).toBeNull();
    });

    test('a member cannot delete, and nothing is marked', async () => {
        const s1 = await alice.servers.create();
        await alice.servers.invite(s1.id, BOB.email, 'writer', '');
        await bob.servers.join(s1.id);
        await expectAppError(bob.servers.delete(s1.id), 'FORBIDDEN');
        expect(bob.beforeDelete).not.toHaveBeenCalled();
        expect(store.node(s1.id).trashed).toBe(false);
    });

    test('a failing beforeDelete keeps the folder', async () => {
        const s1 = await alice.servers.create();
        alice.beforeDelete.mockRejectedValue(new AppError('NETWORK', 'offline'));
        await expectAppError(alice.servers.delete(s1.id), 'NETWORK');
        expect(store.node(s1.id).trashed).toBe(false);
    });

    test('rename trims and validates', async () => {
        const s1 = await alice.servers.create();
        await alice.servers.rename(s1.id, '  Survival  ');
        expect(store.node(s1.id).name).toBe('Survival');
        await expectAppError(alice.servers.rename(s1.id, '   '), 'INVALID');
        await expectAppError(alice.servers.rename(s1.id, 'x'.repeat(101)), 'INVALID');
        await expectAppError(alice.servers.rename('../x', 'ok'), 'INVALID');
    });
});

describe('local folder', () => {
    test('chooseLocalPath stores the chosen folder', async () => {
        const folder = path.join(tmp, 'mc');
        alice.dialogs.chooseFolder.mockResolvedValueOnce(folder);
        await expect(alice.servers.chooseLocalPath('srv1')).resolves.toBe(folder);
        expect(alice.settings.getServer('srv1').localPath).toBe(folder);
        await expect(alice.servers.chooseLocalPath('srv1')).resolves.toBeNull();
        expect(alice.settings.getServer('srv1').localPath).toBe(folder);
    });

    test('a server deleted on Drive by hand stops blocking its folder and is forgotten after the next listing', async () => {
        const gone = await alice.servers.create();
        const kept = await alice.servers.create();
        const folder = path.join(tmp, 'mc');
        alice.dialogs.chooseFolder.mockResolvedValue(folder);
        await alice.servers.chooseLocalPath(gone.id);
        store.node(gone.id).trashed = true;                 // deleted in the Drive website, the app not told

        await alice.servers.list();
        await expect(alice.servers.chooseLocalPath(kept.id)).resolves.toBe(folder);
        await vi.waitFor(() => expect(alice.appData.serverIds()).not.toContain(gone.id));
        // Two servers that both exist still cannot share a folder.
        const third = await alice.servers.create();
        await alice.servers.list();
        await expectAppError(alice.servers.chooseLocalPath(third.id), 'INVALID');
    });

    test('openFolder needs an existing local folder', async () => {
        await expectAppError(alice.servers.openFolder('srv1'), 'NO_LOCAL_PATH');
        const folder = path.join(tmp, 'mc');
        alice.settings.setLocalPath('srv1', folder);
        await expectAppError(alice.servers.openFolder('srv1'), 'NOT_FOUND');
        fs.mkdirSync(folder);
        await alice.servers.openFolder('srv1');
        expect(alice.dialogs.openPath).toHaveBeenCalledWith(folder);
    });

    test('info reads max-players from server.properties', () => {
        expect(alice.servers.info('srv1')).toEqual({ maxPlayers: null });
        const folder = path.join(tmp, 'mc');
        fs.mkdirSync(folder);
        alice.settings.setLocalPath('srv1', folder);
        expect(alice.servers.info('srv1')).toEqual({ maxPlayers: null });
        fs.writeFileSync(path.join(folder, 'server.properties'), '#Minecraft server properties\r\nmotd=Hi\r\nmax-players=12\r\n');
        expect(alice.servers.info('srv1')).toEqual({ maxPlayers: 12 });
    });
});

describe('pure helpers', () => {
    test('nextServerName', () => {
        expect(nextServerName([])).toBe('Server-1');
        expect(nextServerName(['Server-1', 'server-3'])).toBe('Server-2');
        expect(nextServerName(['Survival', 'Server-2'])).toBe('Server-1');
    });

    test('parseFolderId', () => {
        const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
        expect(parseFolderId(id)).toBe(id);
        expect(parseFolderId(`  ➜ ${id} `)).toBe(id);
        expect(parseFolderId(`https://drive.google.com/drive/folders/${id}?usp=drive_link`)).toBe(id);
        expect(parseFolderId(`https://drive.google.com/drive/u/1/folders/${id}`)).toBe(id);
        expect(parseFolderId(`https://drive.google.com/open?id=${id}`)).toBe(id);
        expect(parseFolderId(`drive.google.com/drive/folders/${id}`)).toBe(id);
        for (const bad of ['', 'root', 'ROOT', 'https://drive.google.com/drive/my-drive', 'two words', 'a/b']) {
            expect(() => parseFolderId(bad)).toThrow(AppError);
        }
    });

    test('parseMaxPlayers', () => {
        expect(parseMaxPlayers('max-players=20')).toBe(20);
        expect(parseMaxPlayers('max-players = 8\n')).toBe(8);
        expect(parseMaxPlayers('max-players:5')).toBe(5);
        expect(parseMaxPlayers('#max-players=99\nmax-players=3')).toBe(3);
        expect(parseMaxPlayers('max-players=20\nmax-players=30')).toBe(30);
        expect(parseMaxPlayers('max-players=')).toBeNull();
        expect(parseMaxPlayers('max-players=lots')).toBeNull();
        expect(parseMaxPlayers('max-players-extra=4')).toBeNull();
        expect(parseMaxPlayers('')).toBeNull();
    });
});
