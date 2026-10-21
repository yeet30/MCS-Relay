// The one contract between the renderer and the main process.
// Every request channel is listed in Commands, every pushed event in Events.
// The main process registers handlers with handle() (electron/ipc/handle.ts), the renderer
// calls them with invoke() (src/api.ts). A renamed or mistyped channel is a compile error.
import type {
    AppErrorInfo, AppSettings, ChangeBatch, ConflictChoice, LockView, MemberRole, ServerId,
    ServerSettings, ServerSummary, SessionProgress, SessionState, StepMessage, SyncReport, SyncRules,
    TransferSnapshot, UserInfo,
} from './types';

export type Result<T> =
    | { ok: true; value: T }
    | { ok: false; error: AppErrorInfo };

export interface AuthStatus {
    loggedIn: boolean;
    user: UserInfo | null;
    collaborationEnabled: boolean;      // the full Drive scope has been granted
}

export interface ServerInfo {
    maxPlayers: number | null;          // from the local server.properties
}

export interface QuitPrompt {
    phase: SessionState['phase'];
    sessionActive: boolean;             // something would be interrupted by quitting
}

/** Every request the renderer can make: channel -> (arguments) => result. */
export interface Commands {
    'auth:status': () => AuthStatus;
    'auth:login': () => AuthStatus;
    'auth:enableCollaboration': () => AuthStatus;
    'auth:logout': () => void;

    'servers:list': () => ServerSummary[];
    'servers:create': () => ServerSummary;
    'servers:delete': (serverId: ServerId) => void;
    'servers:rename': (serverId: ServerId, name: string) => void;
    'servers:invite': (serverId: ServerId, email: string, role: Extract<MemberRole, 'writer' | 'reader'>, message: string) => void;
    'servers:removeMember': (serverId: ServerId, permissionId: string) => void;
    'servers:leave': (serverId: ServerId) => void;
    'servers:join': (folderId: string) => ServerSummary;
    'servers:chooseLocalPath': (serverId: ServerId) => string | null;
    'servers:openFolder': (serverId: ServerId) => void;
    'servers:info': (serverId: ServerId) => ServerInfo;
    'servers:select': (serverId: ServerId | null) => void;

    'session:get': () => SessionState;
    'session:preflight': (serverId: ServerId) => SyncReport;
    'session:lastReport': () => SyncReport | null;
    'session:start': (serverId: ServerId) => void;
    'session:stop': () => void;
    'session:resolve': (serverId: ServerId, choice: ConflictChoice) => SyncReport;
    'session:retryUpload': () => void;
    'session:cancel': () => void;
    /** Cancels the upload for good: what was sent is saved as an incomplete revision and the server is freed. */
    'session:abandonUpload': () => void;
    'session:repair': (serverId: ServerId) => void;
    /** Sync without playing: download the latest version, or upload this PC's changes, under the lock. */
    'session:syncNow': (serverId: ServerId, direction: 'down' | 'up') => void;
    'session:dismiss': () => void;
    'session:command': (command: string) => void;
    'session:changes': () => ChangeBatch;
    'session:transfers': () => TransferSnapshot;
    'session:steps': () => StepMessage[];
    'session:console': () => string[];
    'session:progress': () => SessionProgress;

    'settings:get': () => AppSettings;
    'settings:set': (patch: Partial<Omit<AppSettings, 'joinedServerIds'>>) => AppSettings;
    'settings:getServer': (serverId: ServerId) => ServerSettings;
    'settings:setServer': (serverId: ServerId, patch: Partial<Omit<ServerSettings, 'localPath'>>) => ServerSettings;
    'settings:choosePlayitPath': () => string | null;

    'rules:get': (serverId: ServerId) => SyncRules;
    'rules:set': (serverId: ServerId, ignore: string[]) => SyncRules;
    /** Opens a file or folder picker inside the server's local folder and returns the chosen item as a rule:
     *  a POSIX path relative to the server folder, with a trailing "/" for folders. null when cancelled. */
    'rules:pickPath': (serverId: ServerId, kind: 'file' | 'folder') => string | null;

    'app:quitResponse': (confirmed: boolean) => void;
    'app:openExternal': (url: string) => void;
}

/** Every event the main process pushes: channel -> payload. */
export interface Events {
    'session:state': SessionState;
    'session:step': StepMessage;
    'session:progress': SessionProgress;
    'sync:report': SyncReport;
    'lock:update': { serverId: ServerId; view: LockView };
    /** A check outside a run is going through the folder: `done` of `total` files (hashing a big world takes a while). */
    'sync:checking': { serverId: ServerId; done: number; total: number };
    'transfer:progress': TransferSnapshot;
    'changes:batch': ChangeBatch;
    'changes:reset': null;
    'console:output': string[];
    'app:confirmQuit': QuitPrompt;
    'app:quitting': null;
    /** A start or stop finished: play the chime (sent only when the sound is on). */
    'app:chime': { outcome: 'done' | 'failed' };
}

export type CommandName = keyof Commands;
export type EventName = keyof Events;
export type CommandArgs<C extends CommandName> = Parameters<Commands[C]>;
export type CommandResult<C extends CommandName> = ReturnType<Commands[C]>;

/** The shape preload.ts exposes as window.api. Deliberately untyped per channel:
 *  the typed wrappers live in src/api.ts and electron/ipc/handle.ts. */
export interface BridgeApi {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (payload: unknown) => void) => () => void;
}

export const COMMAND_PREFIXES = ['auth:', 'servers:', 'session:', 'settings:', 'rules:', 'app:'] as const;
