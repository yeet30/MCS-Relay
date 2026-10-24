// One line per entry of Commands in shared/ipc.ts. Arguments come from the renderer and are unknown at
// runtime, so each one is checked here before a service sees it.
import path from 'node:path';
import type { AuthStatus } from '../../shared/ipc';
import type { ConflictChoice, LogoState, UpdateState } from '../../shared/types';
import { LOGO_STATES } from '../../shared/types';
import { toPosix } from '../../shared/paths';
import { AppError } from '../errors';
import type { GoogleAuth } from '../auth/GoogleAuth';
import { isValidServerId } from '../store/appData';
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
        | 'isOwner'>;
    session: Pick<SessionController,
        'getState' | 'preflight' | 'lastReport' | 'start' | 'stop' | 'resolve' | 'retryUpload' | 'dismiss' | 'command'
        | 'steps' | 'consoleLines' | 'select' | 'isBusy' | 'resumeUnfinishedUploads' | 'getProgress' | 'syncNow' | 'cancel' | 'repair' | 'abandonUpload'
        | 'setPrimaryTunnel'>;
    settings: Pick<SettingsService, 'get' | 'set' | 'getServer' | 'setServer' | 'pickPlayitPath' | 'pickJavaPath'>;
    sync: Pick<SyncEngine, 'getRules' | 'setRules'>;
    transfers: Pick<TransferEngine, 'snapshot'>;
    changes: Pick<ChangeTracker, 'all'>;
    dialogs: Pick<Dialogs, 'chooseFolder' | 'chooseFile'>;
    report: Pick<ReportService, 'send' | 'save'>;
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
    handle('servers:create', () => d.servers.create());
    handle('servers:delete', (serverId) => {
        const sid = id(serverId);
        if (d.session.isBusy() && d.session.getState().serverId === sid) {
            throw new AppError('BUSY', 'Stop this server before deleting it.');
        }
        return d.servers.delete(sid);
    });
    handle('servers:rename', (serverId, name) => d.servers.rename(id(serverId), text(name, 'name', { max: 100 }).trim()));
    handle('servers:invite', (serverId, email, role, message) => {
        const address = text(email, 'email address', { max: 254 }).trim();
        if (!EMAIL_RE.test(address)) throw invalid('That does not look like an email address.');
        return d.servers.invite(id(serverId), address, oneOf(role, ['writer', 'reader'] as const, 'role'), text(message, 'message', { allowEmpty: true }));
    });
    handle('servers:removeMember', (serverId, permissionId) => d.servers.removeMember(id(serverId), text(permissionId, 'member', { max: 200 })));
    handle('servers:leave', (serverId) => {
        const sid = id(serverId);
        if (d.session.isBusy() && d.session.getState().serverId === sid) {
            throw new AppError('BUSY', 'Stop this server before leaving it.');
        }
        return d.servers.leave(sid);
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
    handle('session:start', (serverId) => d.session.start(id(serverId)));
    handle('session:stop', () => d.session.stop());
    handle('session:resolve', (serverId, choice) => d.session.resolve(id(serverId), oneOf(choice, CHOICES, 'choice')));
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
    handle('session:syncNow', (serverId, direction) => d.session.syncNow(id(serverId), oneOf(direction, ['down', 'up'] as const, 'direction')));
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
}
