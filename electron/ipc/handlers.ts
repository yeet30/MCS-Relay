// One line per entry of Commands in shared/ipc.ts. Arguments come from the renderer and are unknown at
// runtime, so each one is checked here before a service sees it.
import path from 'node:path';
import type { AuthStatus } from '../../shared/ipc';
import type { ConflictChoice, LogoState, UpdateState } from '../../shared/types';
import { LOGO_STATES } from '../../shared/types';
import { toPosix } from '../../shared/paths';
import { AppError } from '../errors';
import type { GoogleAuth } from '../auth/GoogleAuth';
import type { BackupService } from '../backups/BackupService';
import type { JavaInstaller } from '../installer/JavaInstaller';
import type { ModpackService } from '../modpacks/ModpackService';
import type { ServerInstaller } from '../installer/ServerInstaller';
import type { PlayitLink } from '../playit/PlayitLink';
import { isValidServerId } from '../store/appData';
import type { ServerProperties } from '../servers/ServerProperties';
import type { Whitelist } from '../servers/Whitelist';
import type { ServersService } from '../servers/ServersService';
import type { SessionController } from '../session/SessionController';
import type { ReportService } from '../report/ReportService';
import type { Dialogs, SettingsService } from '../settings/SettingsService';
import type { ChangeTracker } from '../sync/changeTracker';
import type { SyncEngine } from '../sync/SyncEngine';
import type { TransferEngine } from '../transfer/TransferEngine';
import type { Handle } from './handle';

export interface HandlerDeps {
    auth: Pick<GoogleAuth, 'status' | 'login' | 'logout'>;
    servers: Pick<ServersService,
        'list' | 'create' | 'delete' | 'rename' | 'invite' | 'removeMember' | 'leave' | 'join' | 'chooseLocalPath' | 'openFolder' | 'info'
        | 'isOwner' | 'serversFolder' | 'pickFolder' | 'checkFolder' | 'setUpFolder'>;
    session: Pick<SessionController,
        'getState' | 'preflight' | 'lastReport' | 'start' | 'stop' | 'resolve' | 'retryUpload' | 'dismiss' | 'command'
        | 'steps' | 'consoleLines' | 'select' | 'isBusy' | 'resumeUnfinishedUploads' | 'getProgress' | 'syncNow' | 'cancel' | 'repair' | 'abandonUpload'
        | 'setPrimaryTunnel'>;
    settings: Pick<SettingsService, 'get' | 'set' | 'getServer' | 'setServer' | 'pickPlayitPath' | 'pickJavaPath'>;
    sync: Pick<SyncEngine, 'getRules' | 'setRules'>;
    transfers: Pick<TransferEngine, 'snapshot'>;
    changes: Pick<ChangeTracker, 'all'>;
    dialogs: Pick<Dialogs, 'chooseFolder' | 'chooseFile' | 'openPath'>;
    report: Pick<ReportService, 'send' | 'save'>;
    installer: Pick<ServerInstaller, 'versions' | 'folder' | 'install'>;
    java: Pick<JavaInstaller, 'install'>;
    modpacks: Pick<ModpackService, 'search' | 'versions' | 'install' | 'checkZip' | 'importZip' | 'info'>;
    properties: Pick<ServerProperties, 'read' | 'write'>;
    whitelist: Pick<Whitelist, 'list' | 'add' | 'remove'>;
    playit: Pick<PlayitLink, 'getState' | 'link' | 'cancelLink' | 'check' | 'reopen' | 'unlink'>;
    backups: Pick<BackupService, 'list' | 'create' | 'upload' | 'download' | 'restore' | 'restoreAuto' | 'deleteLocal' | 'deleteCloud' | 'localFolder' | 'isBusy'>;
    app: {
        quitResponse(confirmed: boolean): void;
        openExternal(url: string): Promise<void>;
        setLogoState(state: LogoState): void;
        updateState(): UpdateState;
        checkForUpdates(): Promise<UpdateState>;
        installUpdate(): void;
        openLogFolder(): Promise<void>;
    };
}

const CHOICES: readonly ConflictChoice[] = ['keep-cloud', 'keep-local', 'combine'];
const MAX_TEXT = 2000;
const MAX_REPORT = 20_000;
const MAX_RULES = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalid(message: string): AppError {
    return new AppError('INVALID', message);
}

function text(value: unknown, what: string, opts: { allowEmpty?: boolean; max?: number } = {}): string {
    if (typeof value !== 'string') throw invalid(`The ${what} is missing.`);
    if (!opts.allowEmpty && value.trim() === '') throw invalid(`The ${what} is empty.`);
    if (value.length > (opts.max ?? MAX_TEXT)) throw invalid(`The ${what} is too long.`);
    return value;
}

function id(value: unknown): string {
    if (!isValidServerId(value)) throw invalid('The server id is not valid.');
    return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw invalid(`The ${what} is not valid.`);
    return value as T;
}

function bool(value: unknown, what: string): boolean {
    if (typeof value !== 'boolean') throw invalid(`The ${what} is not valid.`);
    return value;
}

function object<T>(value: unknown, what: string): T {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`The ${what} is not valid.`);
    return value as T;
}

export function httpsUrl(value: unknown): string {
    const s = text(value, 'link');
    let url: URL;
    try {
        url = new URL(s);
    } catch {
        throw invalid('The link is not valid.');
    }
    if (url.protocol !== 'https:') throw invalid('Only https links can be opened.');
    return url.toString();
}

/** A picked file or folder as a sync rule: POSIX, relative to the server folder, "/" at the end for folders. */
export function ruleFromPick(root: string, picked: string, kind: 'file' | 'folder'): string {
    const rel = path.relative(root, picked);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw invalid('Choose something inside the server folder.');
    }
    const posix = toPosix(rel);
    return kind === 'folder' ? `${posix}/` : posix;
}

export function registerHandlers(handle: Handle, d: HandlerDeps): void {
    // A backup reads or replaces the world folders, so nothing may download into them meanwhile.
    const notDuringBackup = () => {
        if (d.backups.isBusy()) throw new AppError('BUSY', 'Wait until the backup has finished.');
    };
    const afterLogin = (status: AuthStatus): AuthStatus => {
        if (status.loggedIn) {
            // Uploads a previous run could not finish are completed as soon as Drive is reachable.
            void d.session.resumeUnfinishedUploads().catch((err: unknown) => console.warn('[ipc] resuming uploads failed:', err));
        }
        return status;
    };

    handle('auth:status', () => d.auth.status());
    handle('auth:login', async () => afterLogin(await d.auth.login()));
    handle('auth:logout', async () => {
        if (d.session.isBusy()) throw new AppError('BUSY', 'Stop the server and wait for the upload before logging out.');
        await d.session.select(null);
        await d.auth.logout();
    });

    handle('servers:list', () => d.servers.list());
    const MODES = ['new', 'existing'] as const;
    handle('servers:create', (name) => d.servers.create(text(name, 'name', { max: 100 })));
    handle('servers:serversFolder', () => d.servers.serversFolder());
    handle('servers:pickFolder', (kind, current) => d.servers.pickFolder(oneOf(kind, ['parent', 'existing'] as const, 'folder kind'), current === null ? null : text(current, 'folder', { max: 1000 })));
    handle('servers:checkFolder', (mode, folder, name) => d.servers.checkFolder(oneOf(mode, MODES, 'choice'), text(folder, 'folder', { max: 1000 }), text(name, 'name', { max: 100 })));
    handle('servers:setUpFolder', (serverId, mode, folder, name) => d.servers.setUpFolder(id(serverId), oneOf(mode, MODES, 'choice'), text(folder, 'folder', { max: 1000 }), text(name, 'name', { max: 100 })));
    handle('servers:delete', (serverId, removeLocal) => {
        const sid = id(serverId);
        if (d.session.isBusy() && d.session.getState().serverId === sid) {
            throw new AppError('BUSY', 'Stop this server before deleting it.');
        }
        return d.servers.delete(sid, bool(removeLocal, 'folder choice'));
    });
    handle('servers:rename', (serverId, name) => d.servers.rename(id(serverId), text(name, 'name', { max: 100 }).trim()));
    handle('servers:invite', (serverId, email, role, message) => {
        const address = text(email, 'email address', { max: 254 }).trim();
        if (!EMAIL_RE.test(address)) throw invalid('That does not look like an email address.');
        return d.servers.invite(id(serverId), address, oneOf(role, ['writer', 'reader'] as const, 'role'), text(message, 'message', { allowEmpty: true }));
    });
    handle('servers:removeMember', (serverId, permissionId) => d.servers.removeMember(id(serverId), text(permissionId, 'member', { max: 200 })));
    handle('servers:leave', (serverId, removeLocal) => {
        const sid = id(serverId);
        if (d.session.isBusy() && d.session.getState().serverId === sid) {
            throw new AppError('BUSY', 'Stop this server before leaving it.');
        }
        return d.servers.leave(sid, bool(removeLocal, 'folder choice'));
    });
    handle('servers:join', (folderId) => d.servers.join(text(folderId, 'server link', { max: 500 }).trim()));
    handle('servers:chooseLocalPath', (serverId) => {
        const sid = id(serverId);
        if (d.session.isBusy() && d.session.getState().serverId === sid) {
            throw new AppError('BUSY', 'The folder cannot be changed while the server is in use.');
        }
        return d.servers.chooseLocalPath(sid);
    });
    handle('servers:openFolder', (serverId) => d.servers.openFolder(id(serverId)));
    handle('servers:info', (serverId) => d.servers.info(id(serverId)));
    handle('servers:select', (serverId) => d.session.select(serverId === null ? null : id(serverId)));

    handle('session:get', () => d.session.getState());
    handle('session:preflight', (serverId) => d.session.preflight(id(serverId)));
    handle('session:lastReport', () => d.session.lastReport());
    handle('session:start', (serverId) => {
        notDuringBackup();
        return d.session.start(id(serverId));
    });
    handle('session:stop', () => d.session.stop());
    handle('session:resolve', (serverId, choice) => {
        notDuringBackup();
        return d.session.resolve(id(serverId), oneOf(choice, CHOICES, 'choice'));
    });
    handle('session:retryUpload', () => d.session.retryUpload());
    handle('session:cancel', () => d.session.cancel());
    handle('session:setPrimaryTunnel', (address) => {
        if (typeof address !== 'string' || address === '') throw invalid('Choose one of the playit.gg tunnels.');
        return d.session.setPrimaryTunnel(address);
    });
    handle('session:abandonUpload', () => d.session.abandonUpload());
    handle('session:repair', async (serverId) => {
        const sid = id(serverId);
        // Repair overwrites what another member uploaded: only the owner decides that.
        if (!(await d.servers.isOwner(sid))) throw new AppError('FORBIDDEN', 'Only the owner of the server can repair it.');
        return d.session.repair(sid);
    });
    handle('session:syncNow', (serverId, direction) => {
        notDuringBackup();
        return d.session.syncNow(id(serverId), oneOf(direction, ['down', 'up'] as const, 'direction'));
    });
    handle('session:dismiss', () => d.session.dismiss());
    handle('session:command', (command) => d.session.command(text(command, 'command', { max: 1000 })));
    handle('session:changes', () => d.changes.all());
    handle('session:transfers', () => d.transfers.snapshot());
    handle('session:steps', () => d.session.steps());
    handle('session:console', () => d.session.consoleLines());
    handle('session:progress', () => d.session.getProgress());

    handle('settings:get', () => d.settings.get());
    handle('settings:set', (patch) => d.settings.set(object(patch, 'settings change')));
    handle('settings:getServer', (serverId) => d.settings.getServer(id(serverId)));
    handle('settings:setServer', (serverId, patch) => d.settings.setServer(id(serverId), object(patch, 'server settings change')));
    handle('settings:pickPlayitPath', () => d.settings.pickPlayitPath());
    handle('settings:pickJavaPath', () => d.settings.pickJavaPath());

    handle('rules:get', (serverId) => d.sync.getRules(id(serverId)));
    handle('rules:set', (serverId, ignore) => {
        if (!Array.isArray(ignore) || ignore.length > MAX_RULES) throw invalid('The list of ignored files is not valid.');
        return d.sync.setRules(id(serverId), ignore.map((rule) => text(rule, 'rule', { allowEmpty: true, max: 500 })));
    });
    handle('rules:pickPath', async (serverId, kind) => {
        const sid = id(serverId);
        const pickKind = oneOf(kind, ['file', 'folder'] as const, 'kind');
        const root = d.settings.getServer(sid).localPath;
        if (!root) throw new AppError('NO_LOCAL_PATH', 'Choose a folder on this PC for this server first.');
        const picked = pickKind === 'folder'
            ? await d.dialogs.chooseFolder('Choose a folder to leave out of the sync', root)
            : await d.dialogs.chooseFile('Choose a file to leave out of the sync', undefined, root);
        return picked === null ? null : ruleFromPick(root, picked, pickKind);
    });

    handle('app:quitResponse', (confirmed) => d.app.quitResponse(bool(confirmed, 'answer')));
    handle('app:openExternal', (url) => d.app.openExternal(httpsUrl(url)));
    handle('app:setLogoState', (state) => {
        if (!LOGO_STATES.includes(state)) throw invalid('Unknown logo state.');
        d.app.setLogoState(state);
    });
    handle('app:updateState', () => d.app.updateState());
    handle('app:checkForUpdates', () => d.app.checkForUpdates());
    handle('app:installUpdate', () => d.app.installUpdate());

    handle('report:send', (description, includeLog) => d.report.send(text(description, 'description', { max: MAX_REPORT }), bool(includeLog, 'log choice')));
    handle('report:save', (description, includeLog) => d.report.save(text(description, 'description', { max: MAX_REPORT }), bool(includeLog, 'log choice')));
    handle('report:openLogFolder', () => d.app.openLogFolder());

    const backupFile = (value: unknown) => text(value, 'backup', { max: 300 });
    handle('backups:list', (serverId) => d.backups.list(id(serverId)));
    handle('backups:create', (serverId, name, upload) => d.backups.create(id(serverId), text(name, 'name', { allowEmpty: true, max: 100 }), bool(upload, 'upload choice')));
    handle('backups:upload', (serverId, fileName) => d.backups.upload(id(serverId), backupFile(fileName)));
    handle('backups:download', (serverId, cloudId) => d.backups.download(id(serverId), backupFile(cloudId)));
    handle('backups:restore', (serverId, fileName) => d.backups.restore(id(serverId), backupFile(fileName)));
    handle('backups:restoreAuto', (serverId) => d.backups.restoreAuto(id(serverId)));
    handle('backups:deleteLocal', (serverId, fileName) => d.backups.deleteLocal(id(serverId), backupFile(fileName)));
    handle('backups:deleteCloud', (serverId, cloudId) => d.backups.deleteCloud(id(serverId), backupFile(cloudId)));
    const KINDS = ['vanilla', 'paper', 'fabric', 'forge', 'neoforge'] as const;
    handle('installer:versions', (kind) => d.installer.versions(oneOf(kind, KINDS, 'server type')));
    handle('installer:folder', (serverId) => d.installer.folder(id(serverId)));
    handle('installer:install', (serverId, kind, version) => {
        notDuringBackup();
        return d.installer.install(id(serverId), oneOf(kind, KINDS, 'server type'), text(version, 'version', { max: 100 }));
    });
    handle('servers:properties', (serverId) => d.properties.read(id(serverId)));
    handle('servers:setProperties', (serverId, changes) => {
        if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('The changes must be a list of properties.');
        const entries = Object.entries(changes as Record<string, unknown>);
        if (entries.length > 500) throw invalid('Too many properties at once.');
        if (entries.some(([, value]) => typeof value !== 'string')) throw invalid('Property values must be text.');
        if (d.session.isBusy() && d.session.getState().serverId === serverId) {
            throw new AppError('BUSY', 'server.properties can be changed between sessions: Minecraft reads it when the server starts.');
        }
        return d.properties.write(id(serverId), Object.fromEntries(entries) as Record<string, string>);
    });
    // While this PC hosts the server, it reads whitelist.json again right away.
    const reloadWhitelist = (serverId: string) => {
        const state = d.session.getState();
        if (state.phase !== 'running' || state.serverId !== serverId || !state.javaRunning) return;
        try {
            d.session.command('whitelist reload');
        } catch (err) {
            console.warn('[whitelist] could not reload it on the running server:', err instanceof Error ? err.message : String(err));
        }
    };
    handle('servers:whitelist', (serverId) => d.whitelist.list(id(serverId)));
    handle('servers:whitelistAdd', async (serverId, name) => {
        const players = await d.whitelist.add(id(serverId), text(name, 'player name', { max: 16 }));
        reloadWhitelist(serverId as string);
        return players;
    });
    handle('servers:whitelistRemove', async (serverId, uuid) => {
        const players = await d.whitelist.remove(id(serverId), text(uuid, 'player', { max: 40 }));
        reloadWhitelist(serverId as string);
        return players;
    });
    const modrinthId = (value: unknown, what: string) => {
        const s = text(value, what, { max: 64 });
        if (!/^[\w-]+$/.test(s)) throw invalid(`That ${what} is not valid.`);
        return s;
    };
    handle('modpacks:search', (query, offset) => {
        if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10_000) throw invalid('That page is not valid.');
        return d.modpacks.search(text(query, 'search', { allowEmpty: true, max: 100 }), offset);
    });
    handle('modpacks:versions', (projectId) => d.modpacks.versions(modrinthId(projectId, 'modpack')));
    handle('modpacks:install', (serverId, versionId) => {
        notDuringBackup();
        if (d.session.isBusy() && d.session.getState().serverId === serverId) throw new AppError('BUSY', 'Stop the server first.');
        return d.modpacks.install(id(serverId), modrinthId(versionId, 'modpack version'));
    });
    handle('modpacks:pickZip', async () => {
        const file = await d.dialogs.chooseFile('Choose the server pack zip', [{ name: 'Server pack', extensions: ['zip'] }]);
        return file ? d.modpacks.checkZip(file) : null;
    });
    handle('modpacks:importZip', (serverId, zipPath) => {
        notDuringBackup();
        if (d.session.isBusy() && d.session.getState().serverId === serverId) throw new AppError('BUSY', 'Stop the server first.');
        const file = text(zipPath, 'zip file', { max: 1000 });
        if (!path.isAbsolute(file)) throw invalid('Choose the zip file with the file picker.');
        return d.modpacks.importZip(id(serverId), file);
    });
    handle('modpacks:info', (serverId) => d.modpacks.info(id(serverId)));
    handle('installer:installJava', (serverId, major) => {
        if (typeof major !== 'number' || !Number.isInteger(major) || major < 8 || major > 99) throw invalid('That Java version is not valid.');
        if (d.session.isBusy() && d.session.getState().serverId === serverId) throw new AppError('BUSY', 'Java can be changed between sessions.');
        return d.java.install(id(serverId), major);
    });

    handle('backups:openFolder', async (serverId) => d.dialogs.openPath(await d.backups.localFolder(id(serverId))));

    handle('playit:state', () => d.playit.getState());
    handle('playit:link', () => d.playit.link());
    handle('playit:cancelLink', () => d.playit.cancelLink());
    handle('playit:check', () => d.playit.check());
    handle('playit:reopen', () => d.playit.reopen());
    handle('playit:unlink', () => {
        if (d.session.isBusy()) throw new AppError('BUSY', 'playit.gg can be unlinked between sessions.');
        return d.playit.unlink();
    });
}
