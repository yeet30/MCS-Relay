// The server list and everything about a server folder that is not syncing: create, delete, rename,
// members, join and leave. Owned servers are the folders inside "Minecraft Shared Servers" in my Drive;
// joined servers are the folder ids stored in settings.joinedServerIds.
import fs from 'node:fs';
import path from 'node:path';
import type { ServerInfo } from '../../shared/ipc';
import type { LockContent, MemberRole, ServerMember, ServerSummary, UserInfo } from '../../shared/types';
import { DEFAULT_SHARED_IGNORES } from '../../shared/paths';
import { DriveError, FOLDER_MIME } from '../drive/types';
import type { DriveApi, DriveFileMeta } from '../drive/types';
import { AppError } from '../errors';
import type { AppData } from '../store/appData';
import { isValidServerId } from '../store/appData';
import type { Dialogs, SettingsService } from '../settings/SettingsService';
import type { LauncherFiles } from '../sync/launcherFiles';
import { writeRules } from '../sync/manifest';

export const ROOT_FOLDER_NAME = 'Minecraft Shared Servers';
export const MAX_OWNED_SERVERS = 3;
const MAX_NAME_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 2000;

export interface DrivePermission {
    id: string;
    emailAddress: string;
    displayName: string;
    role: string;
    photoLink?: string;
}

/** The part of DriveFiles this service uses (DriveFiles satisfies it; tests pass a fake). */
export interface ServersDrive extends Pick<DriveApi, 'getMeta' | 'listChildren' | 'createFolder' | 'trash' | 'rename'> {
    findFolders(query: string): Promise<DriveFileMeta[]>;
    listPermissions(fileId: string): Promise<DrivePermission[]>;
    addPermission(fileId: string, email: string, role: 'writer' | 'reader', message: string): Promise<void>;
    deletePermission(fileId: string, permissionId: string): Promise<void>;
}

export interface ServersServiceDeps {
    drive: ServersDrive;
    launcher: LauncherFiles;
    auth: { me(): Promise<UserInfo> };
    settings: SettingsService;
    appData: AppData;
    dialogs: Dialogs;
    /** Runs before an owner trashes a server folder: SyncEngine.markForeignFilesDeleted, so the files other
     *  members own become placeholders their apps delete for good. A failure cancels the delete. */
    beforeDelete: (serverId: string) => Promise<unknown>;
}

const ROLE_ORDER: MemberRole[] = ['owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader'];

export class ServersService {
    private readonly drive: ServersDrive;
    private readonly launcher: LauncherFiles;
    private readonly auth: { me(): Promise<UserInfo> };
    private readonly settings: SettingsService;
    private readonly appData: AppData;
    private readonly dialogs: Dialogs;
    private readonly beforeDelete: (serverId: string) => Promise<unknown>;

    constructor(deps: ServersServiceDeps) {
        this.drive = deps.drive;
        this.launcher = deps.launcher;
        this.auth = deps.auth;
        this.settings = deps.settings;
        this.appData = deps.appData;
        this.dialogs = deps.dialogs;
        this.beforeDelete = deps.beforeDelete;
    }

    /** Owned servers first, then joined ones. One me() per call and one permissions request per folder (F40). */
    async list(): Promise<ServerSummary[]> {
        const [me, rootId] = await Promise.all([this.auth.me(), this.findRoot()]);
        const ownedFolders = rootId ? await this.drive.listChildren(rootId, { foldersOnly: true }) : [];
        const ownedIds = new Set(ownedFolders.map((f) => f.id));
        const joinedIds = this.settings.get().joinedServerIds.filter((id) => !ownedIds.has(id));

        const [owned, joined] = await Promise.all([
            Promise.all(ownedFolders.map((folder) => this.summarize(folder, 'owned', me))),
            Promise.all(joinedIds.map((id) => this.joinedSummary(id, me))),
        ]);
        return [...owned, ...joined.filter((s): s is ServerSummary => s !== null)];
    }

    async create(): Promise<ServerSummary> {
        const me = await this.auth.me();
        const rootId = await this.ensureRoot();
        const existing = await this.drive.listChildren(rootId, { foldersOnly: true });
        if (existing.length >= MAX_OWNED_SERVERS) {
            throw new AppError('INVALID', `You can own at most ${MAX_OWNED_SERVERS} servers. Delete one to create a new one.`);
        }
        const folder = await this.drive.createFolder(nextServerName(existing.map((f) => f.name)), rootId);
        try {
            await this.launcher.ensureFile(folder.id, 'lock.json', JSON.stringify(freeLock(me), null, 2));
            await writeRules(this.launcher, folder.id, initialRules(this.appData.legacyBlacklist()));
        } catch (err) {
            // A server folder without its .launcher files would look like a broken server; undo it.
            this.launcher.forget(folder.id);
            await this.drive.trash(folder.id).catch((trashErr: unknown) => {
                console.warn(`[servers] could not remove the half-created server ${folder.id}:`, trashErr);
            });
            throw err;
        }
        console.log(`[servers] created ${folder.name} (${folder.id})`);
        return this.summarize(folder, 'owned', me, 'owner');
    }

    async delete(id: string): Promise<void> {
        requireId(id);
        let meta: DriveFileMeta;
        try {
            meta = await this.drive.getMeta(id);
        } catch (err) {
            if (!isDriveStatus(err, 404)) throw err;
            console.warn(`[servers] ${id} is already gone from Drive; forgetting it on this PC`);
            this.forgetLocally(id);
            return;
        }
        if (!isOwnedByMe(meta)) {
            throw new AppError('FORBIDDEN', 'Only the owner can delete this server. You can leave it instead.');
        }
        await this.beforeDelete(id);
        await this.drive.trash(id);
        this.forgetLocally(id);
        console.log(`[servers] deleted ${meta.name} (${id})`);
    }

    async rename(id: string, name: string): Promise<void> {
        requireId(id);
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (trimmed === '') throw new AppError('INVALID', 'The server name cannot be empty.');
        if (trimmed.length > MAX_NAME_LENGTH) throw new AppError('INVALID', `The server name can be at most ${MAX_NAME_LENGTH} characters long.`);
        await this.drive.rename(id, trimmed);
    }

    async invite(id: string, email: string, role: 'writer' | 'reader', message: string): Promise<void> {
        requireId(id);
        const address = typeof email === 'string' ? email.trim() : '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new AppError('INVALID', 'Enter a valid email address.');
        if (role !== 'writer' && role !== 'reader') throw new AppError('INVALID', 'Choose whether the member may change the server or only view it.');
        const note = typeof message === 'string' ? message.trim() : '';
        if (note.length > MAX_MESSAGE_LENGTH) throw new AppError('INVALID', `The message can be at most ${MAX_MESSAGE_LENGTH} characters long.`);
        await this.drive.addPermission(id, address, role, inviteMessage(id, note));
    }

    async removeMember(id: string, permissionId: string): Promise<void> {
        requireId(id);
        if (typeof permissionId !== 'string' || permissionId.trim() === '') throw new AppError('INVALID', 'No member was chosen.');
        await this.drive.deletePermission(id, permissionId);
    }

    /** Removes my own access and forgets the server on this PC. */
    async leave(id: string): Promise<void> {
        requireId(id);
        const me = await this.auth.me();
        let permissions: DrivePermission[] = [];
        try {
            permissions = await this.drive.listPermissions(id);
        } catch (err) {
            // Gone, or I may not see the member list: there is nothing to remove, only forget it here.
            if (!isDriveStatus(err, 404) && !isDriveStatus(err, 403)) throw err;
        }
        const mine = permissions.find((p) => sameEmail(p.emailAddress, me.email));
        if (mine?.role === 'owner') {
            throw new AppError('FORBIDDEN', 'You own this server, so you cannot leave it. Delete it instead.');
        }
        if (mine) {
            try {
                await this.drive.deletePermission(id, mine.id);
            } catch (err) {
                if (isDriveStatus(err, 403)) {
                    // A viewer may not be allowed to remove permissions, not even their own. The server is still
                    // forgotten here; the owner can remove the access.
                    console.warn(`[servers] Drive refused to remove my access to ${id}; forgetting it locally only`, err);
                } else if (!isDriveStatus(err, 404)) {
                    throw err;
                }
            }
        }
        this.forgetLocally(id);
    }

    /** Accepts a folder id or a Drive folder link. */
    async join(folderIdOrUrl: string): Promise<ServerSummary> {
        const requested = parseFolderId(folderIdOrUrl);
        let meta: DriveFileMeta;
        try {
            meta = await this.drive.getMeta(requested);
        } catch (err) {
            if (isDriveStatus(err, 404)) {
                throw new AppError('NOT_FOUND', 'No server with this ID was found. Check the ID, or ask the owner to invite you first.', requested);
            }
            throw err;
        }
        if (meta.trashed) throw new AppError('NOT_FOUND', 'This server was deleted by its owner.');
        if (meta.mimeType !== FOLDER_MIME) throw new AppError('INVALID', 'This ID belongs to a file, not to a server folder.');
        if (!meta.parents?.length && isOwnedByMe(meta)) throw new AppError('INVALID', 'This is your whole Google Drive, not a server folder.');

        const [me, rootId] = await Promise.all([this.auth.me(), isOwnedByMe(meta) ? this.findRoot() : Promise.resolve(null)]);
        if (rootId === meta.id) throw new AppError('INVALID', 'This is the folder that holds your servers, not a server.');
        const owned = rootId !== null && (meta.parents ?? []).includes(rootId);
        if (!owned) this.settings.addJoined(meta.id);
        return this.summarize(meta, owned ? 'owned' : 'joined', me);
    }

    async chooseLocalPath(id: string): Promise<string | null> {
        requireId(id);
        const chosen = await this.dialogs.chooseFolder('Choose the folder for this server on this PC');
        if (!chosen) return null;
        this.settings.setLocalPath(id, chosen);
        return this.settings.getServer(id).localPath;
    }

    async openFolder(id: string): Promise<void> {
        const localPath = this.settings.getServer(id).localPath;
        if (!localPath) throw new AppError('NO_LOCAL_PATH', 'Choose a folder for this server on this PC first.');
        if (!fs.existsSync(localPath)) throw new AppError('NOT_FOUND', `The folder ${localPath} does not exist any more.`);
        await this.dialogs.openPath(localPath);
    }

    info(id: string): ServerInfo {
        const localPath = this.settings.getServer(id).localPath;
        if (!localPath) return { maxPlayers: null };
        let text: string;
        try {
            text = fs.readFileSync(path.join(localPath, 'server.properties'), 'utf8');
        } catch {
            return { maxPlayers: null };
        }
        return { maxPlayers: parseMaxPlayers(text) };
    }

    /* -------------------------------------------------------------- helpers */

    private async summarize(meta: DriveFileMeta, kind: ServerSummary['kind'], me: UserInfo, knownRole?: MemberRole): Promise<ServerSummary> {
        const members = (await this.permissionsOf(meta.id))
            .filter((p) => p.emailAddress)
            .map(toMember)
            .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
        const mine = members.find((m) => sameEmail(m.email, me.email));
        return {
            id: meta.id,
            name: meta.name,
            kind,
            localPath: this.settings.getServer(meta.id).localPath,
            members,
            myRole: knownRole ?? mine?.role ?? roleFromMeta(meta),
        };
    }

    private async joinedSummary(id: string, me: UserInfo): Promise<ServerSummary | null> {
        let meta: DriveFileMeta;
        try {
            meta = await this.drive.getMeta(id);
        } catch (err) {
            // Kept in settings: access may come back (shared again, or the folder restored from the trash).
            if (isDriveStatus(err, 404) || isDriveStatus(err, 403)) {
                console.warn(`[servers] joined server ${id} is not available: ${err.message}`);
                return null;
            }
            throw err;
        }
        if (meta.trashed || meta.mimeType !== FOLDER_MIME) return null;
        return this.summarize(meta, 'joined', me);
    }

    /** The member list; empty when Drive does not let me read it. */
    private async permissionsOf(folderId: string): Promise<DrivePermission[]> {
        try {
            return await this.drive.listPermissions(folderId);
        } catch (err) {
            if (!isDriveStatus(err, 403) && !isDriveStatus(err, 404)) throw err;
            console.warn(`[servers] cannot read the members of ${folderId}:`, err.message);
            return [];
        }
    }

    private async findRoot(): Promise<string | null> {
        return (await this.findRoots())[0]?.id ?? null;
    }

    private async findRoots(): Promise<DriveFileMeta[]> {
        const query = `name = '${escapeQuery(ROOT_FOLDER_NAME)}' and mimeType = '${FOLDER_MIME}' and 'me' in owners and trashed = false`;
        return oldestFirst(await this.drive.findFolders(query));
    }

    private async ensureRoot(): Promise<string> {
        const existing = await this.findRoot();
        if (existing) return existing;
        const created = await this.drive.createFolder(ROOT_FOLDER_NAME, 'root');
        // Two of my PCs may create it at the same moment: keep the oldest, as with the .launcher files.
        const oldest = (await this.findRoots())[0]?.id ?? created.id;
        if (oldest !== created.id) {
            await this.drive.trash(created.id).catch((err: unknown) => {
                console.warn('[servers] could not trash a duplicate root folder:', err);
            });
        }
        return oldest;
    }

    private forgetLocally(id: string): void {
        this.settings.removeJoined(id);
        if (this.settings.get().selectedServerId === id) this.settings.set({ selectedServerId: null });
        this.appData.removeServer(id);
        this.launcher.forget(id);
    }
}

/* ------------------------------------------------------------------ pure helpers (exported for tests) */

/** "Server-N" with the lowest N that is not taken. */
export function nextServerName(taken: string[]): string {
    const names = new Set(taken.map((n) => n.toLowerCase()));
    for (let n = 1; ; n++) {
        if (!names.has(`server-${n}`)) return `Server-${n}`;
    }
}

/** A Drive folder id from an id, a Drive link, or a pasted line of the old invitation email ("➜ <id>"). */
export function parseFolderId(input: string): string {
    const text = typeof input === 'string' ? input.trim() : '';
    const notAServer = new AppError('INVALID', "That doesn't look like a server ID or a Google Drive folder link.");
    if (/^https?:\/\//i.test(text) || /drive\.google\.com/i.test(text)) {
        const match = /\/folders\/([A-Za-z0-9_-]+)/.exec(text) ?? /[?&]id=([A-Za-z0-9_-]+)/.exec(text) ?? /\/d\/([A-Za-z0-9_-]+)/.exec(text);
        if (!match || !isValidServerId(match[1])) throw notAServer;
        return match[1];
    }
    const id = text.replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]+$/g, '');
    // "root" and friends are aliases Drive resolves to my own My Drive.
    if (!isValidServerId(id) || /^(root|appdatafolder|drive)$/i.test(id)) throw notAServer;
    return id;
}

/** max-players from server.properties text (Java properties: "#"/"!" comments, "=", ":" or space). */
export function parseMaxPlayers(text: string): number | null {
    let result: number | null = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
        const match = /^max-players\s*(?:[=:]|\s)\s*(.*)$/.exec(line);
        if (!match) continue;
        const value = match[1].trim();
        result = /^\d{1,9}$/.test(value) ? Number(value) : null;
    }
    return result;
}

/** The defaults plus the old app's ignore list, without legacy entries a default already covers
 *  ("logs" next to "logs/"). */
export function initialRules(legacy: string[]): string[] {
    const rules = [...DEFAULT_SHARED_IGNORES];
    for (const rule of legacy) {
        const bare = rule.endsWith('/') ? rule.slice(0, -1) : rule;
        if (!rules.includes(bare) && !rules.includes(`${bare}/`)) rules.push(rule);
    }
    return rules;
}

function inviteMessage(serverId: string, note: string): string {
    const instructions = 'You have been invited to a shared Minecraft server. To join, open Drive Launcher, '
        + `choose "Join a server" and paste this server ID (or the folder link from this email):\n\n${serverId}`;
    return note ? `${note}\n\n${instructions}` : instructions;
}

function freeLock(me: UserInfo): LockContent {
    return {
        format: 2, sessionId: '', host: { name: me.name, email: me.email }, phase: 'free', leaseSeconds: 45,
        baseRevision: 0, startedAt: null, address: null, players: [],
    };
}

function toMember(p: DrivePermission): ServerMember {
    const member: ServerMember = {
        permissionId: p.id,
        email: p.emailAddress,
        name: p.displayName || p.emailAddress,
        role: toRole(p.role),
    };
    if (p.photoLink) member.photoLink = p.photoLink;
    return member;
}

function toRole(role: string): MemberRole {
    return (ROLE_ORDER as string[]).includes(role) ? (role as MemberRole) : 'reader';
}

function roleFromMeta(meta: DriveFileMeta): MemberRole | null {
    if (isOwnedByMe(meta)) return 'owner';
    if (!meta.capabilities) return null;
    return meta.capabilities.canAddChildren ? 'writer' : 'reader';
}

function isOwnedByMe(meta: DriveFileMeta): boolean {
    return meta.ownedByMe === true || (meta.owners ?? []).some((o) => o.me === true);
}

function oldestFirst(items: DriveFileMeta[]): DriveFileMeta[] {
    const time = (m: DriveFileMeta) => (m.createdTime ? Date.parse(m.createdTime) : Number.POSITIVE_INFINITY);
    return [...items].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
}

function sameEmail(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function escapeQuery(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isDriveStatus(err: unknown, status: number): err is DriveError {
    return err instanceof DriveError && err.status === status;
}

function requireId(id: unknown): void {
    if (!isValidServerId(id)) throw new AppError('INVALID', 'Invalid server id.');
}
