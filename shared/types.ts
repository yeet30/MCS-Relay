// Types shared by the main process and the renderer.
// Paths in every stored or transmitted structure are POSIX-style and relative to the
// server folder ("world/region/r.0.0.mca"), produced by toPosix() in shared/paths.ts.

export type ServerId = string;

/* ------------------------------------------------------------------ users and servers */

export interface UserInfo {
    name: string;
    email: string;
    picture: string;
}

export type MemberRole = 'owner' | 'writer' | 'reader' | 'commenter' | 'organizer' | 'fileOrganizer';

export interface ServerMember {
    permissionId: string;
    email: string;
    name: string;
    role: MemberRole;
    photoLink?: string;
}

export interface ServerSummary {
    id: ServerId;
    name: string;
    kind: 'owned' | 'joined';
    localPath: string | null;
    members: ServerMember[];
    myRole: MemberRole | null;
}

/* ------------------------------------------------------------------ settings */

export interface JavaFlags {
    minRAM: number;
    maxRAM: number;
    customFlags: string;
}

/** The app's colour themes: light grey with red (default, from the logo), the earlier mint green, and dark. */
/** The comparator in the title bar, the taskbar and the tray: unpowered while nobody runs the selected server,
 *  powered from behind while this PC runs it (the desktop icon's look), and with its front torch lit too while
 *  someone else runs it. */
export type LogoState = 'off' | 'here' | 'elsewhere';
export const LOGO_STATES: readonly LogoState[] = ['off', 'here', 'elsewhere'];

/** The app's own update. 'unavailable': a development build, which never checks. */
export interface UpdateState {
    current: string;                    // the version running now
    status: 'unavailable' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error';
    version: string | null;             // the newer version, while it downloads and once it is ready
    percent: number;                    // download progress, 0..100
    error: string | null;
}

export type ThemeName = 'light' | 'mint' | 'dark';
export const THEMES: readonly ThemeName[] = ['light', 'mint', 'dark'];

/** The window around the page in each theme: the page colour (shown before it paints) and the title bar, whose
 *  minimise and close buttons Windows draws in `titleText`. The page draws the rest of the bar in `titleBar`. */
export const WINDOW_COLORS: Record<ThemeName, { page: string; titleBar: string; titleText: string }> = {
    light: { page: '#e6e6e8', titleBar: '#ffffff', titleText: '#1c1c20' },
    mint: { page: '#1b2822', titleBar: '#213129', titleText: '#e6ece9' },
    dark: { page: '#141416', titleBar: '#1c1c1f', titleText: '#e7e7ea' },
};

/** Height of the title bar, in px: the page leaves this much room at the top. */
export const TITLE_BAR_HEIGHT = 32;

/** The version of the terms of use (website/terms.html). Raise it when they change in a way people must agree to
 *  again: everyone who agreed to an older version is asked once more. */
export const TERMS_VERSION = 1;
export const TERMS_URL = 'https://mcs-relay.com/terms.html';

/** Where problem reports are shared to (see electron/report/ReportService.ts). Empty: the app can only save reports
 *  as files. */
export const REPORT_INBOX: string = 'yeet4em@gmail.com';

export interface AppSettings {
    selectedServerId: ServerId | null;
    playitggPath: string;
    usePlayitgg: boolean;
    launchServer: boolean;              // false = the app only syncs and holds the lock; you run Java yourself
    joinedServerIds: ServerId[];
    eulaAccepted: boolean;              // this Google account accepted the Minecraft EULA in the app
    termsAccepted: number;              // the TERMS_VERSION this Google account agreed to; 0: none yet
    notifications: boolean;             // a desktop notification when a start or stop finishes in the background
    notificationSound: boolean;         // a short chime when a start or stop finishes
    theme: ThemeName;                   // per PC, like the other display settings
    /** The playit.gg tunnel shown first while this PC hosts (its address); null: the Minecraft Java one. */
    playitPrimary: string | null;
}

export interface ServerSettings {
    localPath: string | null;
    javaFlags: JavaFlags;
    /** The Java program this server starts with on this PC; missing: "java" from PATH. */
    javaPath?: string;
}

/** A change to a server's settings on this PC (the folder goes through servers:chooseLocalPath). javaPath null: back to
 *  "java" from PATH. */
export interface ServerSettingsPatch {
    javaFlags?: Partial<JavaFlags>;
    javaPath?: string | null;
}

export const DEFAULT_JAVA_FLAGS: JavaFlags = { minRAM: 2048, maxRAM: 4096, customFlags: '' };

/* ------------------------------------------------------------------ manifest, base, snapshots */

export interface ManifestEntry {
    size: number;
    md5: string;                        // hex, matches Drive's md5Checksum
    driveId: string;
}

/** Drive appProperties the app puts on files. appProperties are private to this OAuth client, so every
 *  member's copy of the app sees them and other apps do not. */
export const APP_PROPS = {
    server: 'mdhServer',                // the server folder id, on every file and folder the app creates
    path: 'mdhPath',                    // the relative path, only when it fits Drive's 124-byte limit per property
    pathHash: 'mdhPathHash',            // sha1 of the relative path: identifies the file whatever its length
    tombstone: 'mdhTombstone',          // "1" on a placeholder: deleted, waiting for its owner to delete it for good
    deletedBy: 'mdhDeletedBy',
    deletedAt: 'mdhDeletedAt',
    backupAt: 'mdhBackupAt',            // on a world backup in .launcher/backups: when it was made (ISO)
} as const;

/** One backup of a server's world, a zip file: on this PC (in the server folder's mcs-relay-backups/), in Google
 *  Drive (in the server's .launcher/backups/, which every member sees), or both. The same backup has the same file
 *  name in both places: "<yyyy-mm-dd_hh-mm-ss> <name>.zip". */
export interface BackupInfo {
    fileName: string;
    name: string;                       // what the user called it
    createdAt: string;                  // ISO
    size: number;                       // bytes
    local: boolean;
    cloud: { id: string; by: string; canDelete: boolean } | null;
}

export interface BackupList {
    backups: BackupInfo[];              // newest first
    cloudError: string | null;          // the cloud ones could not be listed
}

/** The server programs MCS-Relay can download (see electron/installer/ServerInstaller.ts). */
export type ServerKind = 'vanilla' | 'paper' | 'fabric';

export interface InstallableVersion {
    id: string;                         // "1.21.4"
    stable: boolean;                    // false: a snapshot, pre-release or release candidate
}

export interface ServerFolderInfo {
    hasServer: boolean;                 // a server .jar is in the folder already
    javaFound: number | null;           // the major version of the Java this server starts with on this PC
}

export interface InstallResult {
    file: string;                       // the jar now in the folder
    javaNeeded: number | null;          // the Java this Minecraft version needs
}

/** A server program download; done and total count bytes (total 0: unknown). */
export interface InstallProgress {
    serverId: ServerId;
    done: number;
    total: number;
}

/** A backup task underway; done and total count bytes. */
export interface BackupProgress {
    serverId: ServerId;
    action: 'saving' | 'packing' | 'uploading' | 'downloading' | 'restoring';
    done: number;
    total: number;
}

/** Placeholders (0-byte files marked as deleted) that still wait for their owners. */
export interface PendingCleanup {
    mine: number;                       // mine: my app deletes these by itself
    others: Array<{ ownerEmail: string; count: number }>;
}

/** On a revision saved from an upload its uploader cancelled: only part of their session reached the cloud. */
export interface IncompleteUpload {
    by: { name: string; email: string };
    at: string;                         // when the upload was cancelled
    sent: number;                       // changes (uploads and deletions) that reached Google Drive
    planned: number | null;             // changes the upload meant to send
}

export interface Manifest {
    format: 2;
    revision: number;                   // +1 on every successful commit
    parentRevision: number;             // the revision the committing PC started from
    author: { name: string; email: string };
    createdAt: string;                  // ISO time of the commit
    files: Record<string, ManifestEntry>;
    folders: Record<string, string>;    // relative folder path ("world/region") -> Drive folder id
    incomplete?: IncompleteUpload;      // set when the uploader cancelled; the next full upload clears it
}

export interface BaseEntry extends ManifestEntry {
    mtimeMs: number;                    // this PC's modified time right after the last sync; -1 forces a re-hash
}

/** What this PC and the cloud last agreed on. Stored per server in the app's data folder. */
export interface BaseSnapshot {
    format: 2;
    serverId: ServerId;
    revision: number;
    files: Record<string, BaseEntry>;
    folders: Record<string, string>;
}

export interface SnapshotEntry {
    size: number;
    md5: string;
    mtimeMs?: number;
    driveId?: string;
}

/** path -> entry. Used for base, local and remote alike when planning. */
export type Snapshot = Map<string, SnapshotEntry>;

/* ------------------------------------------------------------------ planning */

export interface SyncPlan {
    upload: string[];                   // changed or added locally
    download: string[];                 // changed or added in the cloud
    deleteRemote: string[];             // deleted locally
    deleteLocal: string[];              // deleted in the cloud
    conflicts: string[];                // changed differently on both sides
}

export type SyncStatus =
    | 'in-sync'
    | 'local-changes'                   // only this PC changed things
    | 'cloud-newer'                     // only the cloud changed
    | 'diverged'                        // both changed; the user must choose
    | 'new-server'                      // no manifest in the cloud yet; the first session seeds it
    | 'unfinished-upload'               // someone's upload stopped halfway (stale lock in phase "uploading")
    | 'no-local-path'                   // the server has no local folder on this PC yet
    | 'error';

export type ConflictChoice = 'keep-cloud' | 'keep-local' | 'combine';

export interface SyncReport {
    serverId: ServerId;
    status: SyncStatus;
    firstSyncOnThisPc: boolean;         // no base.json yet
    baseRevision: number | null;
    remoteRevision: number | null;
    remoteAuthor: { name: string; email: string } | null;
    remoteCreatedAt: string | null;
    plan: SyncPlan;
    downloadBytes: number;
    uploadBytes: number;
    allowedChoices: ConflictChoice[];   // non-empty only when status is "diverged"
    pendingChoice: ConflictChoice | null;
    cleanup: PendingCleanup;            // placeholders in this server folder waiting for their owners
    lock: LockView;
    checkedAt: string;
    error?: string;
    /** This PC has an upload of this server that did not finish; Start (or an upload) finishes it first. */
    unfinishedHere?: boolean;
    /** The cloud's last revision was saved from a cancelled upload. */
    remoteIncomplete?: IncompleteUpload | null;
}

/* ------------------------------------------------------------------ lock */

export type LockPhase =
    | 'free' | 'claiming' | 'downloading' | 'launching' | 'running'
    | 'stopping' | 'uploading' | 'releasing';

/** One tunnel of the host's playit.gg agent, as the agent lists it. */
export interface PlayitTunnel {
    /** What players connect to: "name.joinmc.link" for Minecraft Java, otherwise "host:port". */
    address: string;
    /** The playit.gg tunnel type ("minecraft-java", "minecraft-bedrock", ...), or for a plain port tunnel its
     *  protocol: "tcp", "udp" or "tcp+udp". */
    type: string;
    /** Where playit.gg sends it on the host's PC, such as 127.0.0.1:24454. */
    local: string;
}

export interface LockContent {
    format: 2;
    sessionId: string;
    host: { name: string; email: string };
    phase: LockPhase;
    leaseSeconds: number;
    baseRevision: number;
    startedAt: string | null;
    address: string | null;             // the tunnel the host shows first
    players: string[];
    tunnels: PlayitTunnel[];            // every tunnel of the host's playit.gg (older apps write none)
}

/** `leftByThisPc`: a stale lock this PC claimed in an earlier run of the app that crashed or was killed (only one
 *  copy of the app runs at a time, so nobody renews it any more, whatever its age says). */
export type LockView =
    | { state: 'free'; lock: LockContent | null }
    | { state: 'mine' | 'held' | 'stale'; lock: LockContent; ageSeconds: number; leftByThisPc?: boolean };

/* ------------------------------------------------------------------ session */

export type SessionPhase =
    | 'idle' | 'checking' | 'claiming' | 'downloading' | 'launching' | 'running'
    | 'stopping' | 'uploading' | 'releasing' | 'failed' | 'upload-pending';

export interface SessionState {
    phase: SessionPhase;
    serverId: ServerId | null;
    startedAt: string | null;           // when the server became "running"
    address: string | null;             // the playit.gg tunnel shown first
    /** Without playit.gg: this PC's address on its local network with the server's port, for friends on the same
     *  network. Shown on this PC only, never written to the lock. */
    lanAddress: string | null;
    tunnels: PlayitTunnel[];            // every tunnel playit.gg reported
    players: string[];
    javaRunning: boolean;
    error: AppErrorInfo | null;         // set in "failed" and "upload-pending"
}

/** One line of the progress log. A task keeps its id: a later message with the same id replaces it, so a
 *  "loading" line turns into "done" or "error" in place. */
export interface StepMessage {
    id: number;
    message: string;
    status: 'loading' | 'done' | 'error' | 'cancelled';
    importance: 'major' | 'minor';
    at: string;
    endedAt?: string;                   // when a task's line stopped loading: the UI shows how long it took
}

/* ------------------------------------------------------------------ progress of a whole start or stop */

export type ProgressStageKey =
    | 'check' | 'claim' | 'scan' | 'download' | 'playit' | 'java' | 'watch'
    | 'stop-java' | 'stop-playit' | 'verify' | 'folders' | 'files' | 'commit' | 'cleanup' | 'release';

/** What a run of the progress bar is: a start, a stop with its upload, a retried or resumed upload, a sync
 *  without playing (down / up), or a repair of another member's unfinished upload. */
export type RunKind = 'start' | 'stop' | 'retry' | 'resume' | 'down' | 'up' | 'repair';

export interface ProgressStage {
    key: ProgressStageKey;
    label: string;
    done: number;                       // units done; a transfer stage counts finished files plus the share of files in flight
    total: number;                      // units: 1 for a single action, one per file or folder otherwise
    state: 'pending' | 'active' | 'done' | 'failed' | 'cancelled' | 'skipped';
}

/** The bar under the power button. Every action counts as one unit (one folder, one file, stopping Java,
 *  committing...), so the bar covers the whole start or stop, not only the file transfer. */
export interface SessionProgress {
    active: boolean;
    title: string;                      // "Starting Survival", "Stopping and uploading"
    message: string;                    // what is happening now
    unitsDone: number;
    unitsTotal: number;
    fraction: number;                   // 0..1, never goes back during one run
    stages: ProgressStage[];
    outcome: 'running' | 'done' | 'failed' | 'cancelled';
    startedAt: string | null;
    endedAt: string | null;
    note: string | null;                // a hint for this run, e.g. that a first upload takes long
    kind: RunKind | null;               // what Continue does after a cancelled run
    serverId: ServerId | null;
}

/* ------------------------------------------------------------------ transfers */

export interface LaneView {
    lane: number;
    path: string | null;
    kind: TransferKind | null;
    bytesDone: number;
    size: number;
    state: 'active' | 'idle' | 'backoff';
    retryInMs: number | null;
    elapsedMs: number | null;           // how long the job in this lane has been running
}

export type TransferKind = 'download' | 'upload' | 'delete-remote' | 'delete-local' | 'create-folder';

export interface TransferFailure {
    path: string;
    kind: TransferKind;
    message: string;
}

export interface TransferSnapshot {
    active: boolean;
    label: string;                      // "Downloading", "Uploading", "Creating folders"
    filesTotal: number;
    filesDone: number;
    filesFailed: number;
    filesQueued: number;
    bytesTotal: number;
    bytesDone: number;
    bytesPerSec: number;
    filesPerSec: number;
    etaSec: number | null;
    laneLimit: number;
    lanes: LaneView[];
    failures: TransferFailure[];
}

/* ------------------------------------------------------------------ changes during a session */

export type ChangeKind = 'added' | 'changed' | 'removed';
export type ChangeBatch = Array<[path: string, kind: ChangeKind]>;

/* ------------------------------------------------------------------ shared ignore rules */

export interface SyncRules {
    format: 1;
    ignore: string[];                   // shared rules from .launcher/sync-rules.json
    builtin: string[];                  // always applied, defined in code
}

/* ------------------------------------------------------------------ errors */

export type ErrorCode =
    | 'NOT_SIGNED_IN' | 'SCOPE_MISSING' | 'LOCK_HELD' | 'LOCK_LOST' | 'UNFINISHED_UPLOAD'
    | 'CONFLICT' | 'BUSY' | 'NO_LOCAL_PATH' | 'NETWORK' | 'RATE_LIMITED' | 'FORBIDDEN'
    | 'NOT_FOUND' | 'QUOTA_FULL' | 'UPLOAD_INCOMPLETE' | 'DOWNLOAD_INCOMPLETE' | 'CHECKSUM' | 'JAVA'
    | 'PLAYIT' | 'TIMEOUT' | 'INVALID' | 'UNKNOWN';

export interface AppErrorInfo {
    code: ErrorCode;
    message: string;                    // written for the user
    detail?: string;                    // technical detail for logs / "show details"
}
