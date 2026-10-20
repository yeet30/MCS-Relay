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

export interface AppSettings {
    selectedServerId: ServerId | null;
    playitggPath: string;
    usePlayitgg: boolean;
    launchServer: boolean;              // false = the app only syncs and holds the lock; you run Java yourself
    joinedServerIds: ServerId[];
}

export interface ServerSettings {
    localPath: string | null;
    javaFlags: JavaFlags;
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
} as const;

/** Placeholders (0-byte files marked as deleted) that still wait for their owners. */
export interface PendingCleanup {
    mine: number;                       // mine: my app deletes these by itself
    others: Array<{ ownerEmail: string; count: number }>;
}

export interface Manifest {
    format: 2;
    revision: number;                   // +1 on every successful commit
    parentRevision: number;             // the revision the committing PC started from
    author: { name: string; email: string };
    createdAt: string;                  // ISO time of the commit
    files: Record<string, ManifestEntry>;
    folders: Record<string, string>;    // relative folder path ("world/region") -> Drive folder id
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
}

/* ------------------------------------------------------------------ lock */

export type LockPhase =
    | 'free' | 'claiming' | 'downloading' | 'launching' | 'running'
    | 'stopping' | 'uploading' | 'releasing';

export interface LockContent {
    format: 2;
    sessionId: string;
    host: { name: string; email: string };
    phase: LockPhase;
    leaseSeconds: number;
    baseRevision: number;
    startedAt: string | null;
    address: string | null;
    players: string[];
}

export type LockView =
    | { state: 'free'; lock: LockContent | null }
    | { state: 'mine' | 'held' | 'stale'; lock: LockContent; ageSeconds: number };

/* ------------------------------------------------------------------ session */

export type SessionPhase =
    | 'idle' | 'checking' | 'claiming' | 'downloading' | 'launching' | 'running'
    | 'stopping' | 'uploading' | 'releasing' | 'failed' | 'upload-pending';

export interface SessionState {
    phase: SessionPhase;
    serverId: ServerId | null;
    startedAt: string | null;           // when the server became "running"
    address: string | null;             // playit.gg address
    players: string[];
    javaRunning: boolean;
    error: AppErrorInfo | null;         // set in "failed" and "upload-pending"
}

/** One line of the progress log. A task keeps its id: a later message with the same id replaces it, so a
 *  "loading" line turns into "done" or "error" in place. */
export interface StepMessage {
    id: number;
    message: string;
    status: 'loading' | 'done' | 'error';
    importance: 'major' | 'minor';
    at: string;
}

/* ------------------------------------------------------------------ progress of a whole start or stop */

export type ProgressStageKey =
    | 'check' | 'claim' | 'scan' | 'download' | 'playit' | 'java' | 'watch'
    | 'stop-java' | 'stop-playit' | 'folders' | 'files' | 'commit' | 'cleanup' | 'release';

export interface ProgressStage {
    key: ProgressStageKey;
    label: string;
    done: number;                       // units done; a transfer stage counts finished files plus the share of files in flight
    total: number;                      // units: 1 for a single action, one per file or folder otherwise
    state: 'pending' | 'active' | 'done' | 'failed' | 'skipped';
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
