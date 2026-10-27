// The one contract between the renderer and the main process.
// Every request channel is listed in Commands, every pushed event in Events.
// The main process registers handlers with handle() (electron/ipc/handle.ts), the renderer
// calls them with invoke() (src/api.ts). A renamed or mistyped channel is a compile error.
import type {
    AppErrorInfo, AppSettings, BackupInfo, BackupList, BackupProgress, InstallableVersion, InstallProgress, InstallResult,
    PlayitLinkState, ServerFolderInfo, ServerKind, ChangeBatch, ConflictChoice, LockView, LogoState, MemberRole, ServerId, ServerMember,
    ServerSettings, ServerSettingsPatch, ServerSummary, SessionProgress, SessionState, StepMessage, SyncReport, SyncRules,
    TransferSnapshot, UpdateState, UserInfo,
} from './types';

export type Result<T> =
    | { ok: true; value: T }
    | { ok: false; error: AppErrorInfo };

export interface AuthStatus {
    loggedIn: boolean;
    user: UserInfo | null;
}

export interface ServerInfo {
    maxPlayers: number | null;          // from the local server.properties
}

export interface QuitPrompt {
    phase: SessionState['phase'];
    sessionActive: boolean;             // something would be interrupted by quitting
    backup: boolean;                    // a backup is being made, moved or restored: quitting waits for it
}

/** Every request the renderer can make: channel -> (arguments) => result. */
export interface Commands {
    'auth:status': () => AuthStatus;
    'auth:login': () => AuthStatus;
    'auth:logout': () => void;

    'servers:list': () => ServerSummary[];
    /** A new server folder in my Drive with this name (the wizard's first step). */
    'servers:create': (name: string) => ServerSummary;
    /** Where new server folders go on this PC. */
    'servers:serversFolder': () => string;
    'servers:pickFolder': (kind: 'parent' | 'existing', current: string | null) => string | null;
    /** Checks a folder for a server before it is created: "new" takes the parent, "existing" the server folder.
     *  Returns the server's folder. */
    'servers:checkFolder': (mode: 'new' | 'existing', folder: string, name: string) => string;
    /** Makes the new server's folder, or links its existing one, and sets it as the server's folder on this PC. */
    'servers:setUpFolder': (serverId: ServerId, mode: 'new' | 'existing', folder: string, name: string) => string;
    /** `removeLocal`: the server's folder on this PC goes to the Recycle Bin too. */
    'servers:delete': (serverId: ServerId, removeLocal: boolean) => void;
    'servers:rename': (serverId: ServerId, name: string) => void;
    /** The new member, as Drive describes them. */
    'servers:invite': (serverId: ServerId, email: string, role: Extract<MemberRole, 'writer' | 'reader'>, message: string) => ServerMember;
    'servers:removeMember': (serverId: ServerId, permissionId: string) => void;
    'servers:leave': (serverId: ServerId, removeLocal: boolean) => void;
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
    'session:setPrimaryTunnel': (address: string) => void;
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
    'settings:setServer': (serverId: ServerId, patch: ServerSettingsPatch) => ServerSettings;
    /** Opens the file picker; the path is stored only with settings:set. */
    'settings:pickPlayitPath': () => string | null;
    /** Opens the file picker for a server's java.exe; the path is stored only with settings:setServer. */
    'settings:pickJavaPath': () => string | null;

    'rules:get': (serverId: ServerId) => SyncRules;
    'rules:set': (serverId: ServerId, ignore: string[]) => SyncRules;
    /** Opens a file or folder picker inside the server's local folder and returns the chosen item as a rule:
     *  a POSIX path relative to the server folder, with a trailing "/" for folders. null when cancelled. */
    'rules:pickPath': (serverId: ServerId, kind: 'file' | 'folder') => string | null;

    'app:quitResponse': (confirmed: boolean) => void;
    'app:openExternal': (url: string) => void;
    /** The taskbar and tray icons follow the comparator in the title bar. */
    'app:setLogoState': (state: LogoState) => void;
    'app:updateState': () => UpdateState;
    'app:checkForUpdates': () => UpdateState;
    /** Quits, installs the downloaded update and starts the app again. Refused while a session is busy. */
    'app:installUpdate': () => void;

    /** Shares a problem report with the developer through the reporter's Google Drive (see ReportService). */
    'report:send': (description: string, includeLog: boolean) => void;
    /** Saves a problem report as a text file where the user chooses; the path, or null when cancelled. */
    'report:save': (description: string, includeLog: boolean) => string | null;
    'report:openLogFolder': () => void;

    'backups:list': (serverId: ServerId) => BackupList;
    /** Backs up the world in this PC's folder; with `upload`, also puts the backup in the cloud. */
    'backups:create': (serverId: ServerId, name: string, upload: boolean) => BackupInfo;
    'backups:upload': (serverId: ServerId, fileName: string) => BackupInfo;
    'backups:download': (serverId: ServerId, cloudId: string) => void;
    /** Replaces the world in this PC's folder with the backup, after backing up the current world. */
    'backups:restore': (serverId: ServerId, fileName: string) => void;
    /** Replaces the world in this PC's folder with the automatic backup, after backing up the current world. */
    'backups:restoreAuto': (serverId: ServerId) => void;
    'backups:deleteLocal': (serverId: ServerId, fileName: string) => void;
    'backups:deleteCloud': (serverId: ServerId, cloudId: string) => void;
    'backups:openFolder': (serverId: ServerId) => void;

    /** The versions a server program can be downloaded in, newest first. */
    'installer:versions': (kind: ServerKind) => InstallableVersion[];
    'installer:folder': (serverId: ServerId) => ServerFolderInfo;
    /** Downloads the server program from its official source into the server's folder on this PC. */
    'installer:install': (serverId: ServerId, kind: ServerKind, version: string) => InstallResult;

    'playit:state': () => PlayitLinkState;
    /** Links this PC to the user's playit.gg account: downloads the agent, opens playit.gg's approval page in the
     *  browser and makes the Minecraft Java tunnel. Resolves when linked, or quietly when cancelled. */
    'playit:link': () => void;
    'playit:cancelLink': () => void;
    /** Opens the approval page again, for a closed browser tab. */
    'playit:reopen': () => void;
    /** Forgets the link on this PC and deletes its tunnel. Refused while a session is busy. */
    'playit:unlink': () => void;
}

/** Every event the main process pushes: channel -> payload. */
export interface Events {
    'session:state': SessionState;
    'session:step': StepMessage;
    'session:progress': SessionProgress;
    'sync:report': SyncReport;
    'lock:update': { serverId: ServerId; view: LockView };
    /** A server is being deleted: `done` of `total` files of other members handed back to them. */
    'servers:deleting': { serverId: ServerId; done: number; total: number };
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
    /** The app's own update: checking, downloading, ready to install. */
    'app:update': UpdateState;
    /** A backup task: how far it is; null when it has ended (done or failed). */
    'backups:progress': BackupProgress | null;
    /** A server program download: how far it is; null when it has ended. */
    'installer:progress': InstallProgress | null;
    'playit:state': PlayitLinkState;
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

export const COMMAND_PREFIXES = ['auth:', 'servers:', 'session:', 'settings:', 'rules:', 'app:', 'report:', 'backups:', 'installer:', 'playit:'] as const;
