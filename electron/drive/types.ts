// The Drive operations the sync, lock and transfer code depend on.
// electron/drive/DriveFiles.ts implements them over HTTP; test/fakes/FakeDrive.ts implements them in memory.

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveOwner {
    emailAddress: string;
    displayName?: string;
    me?: boolean;
}

export interface DriveCapabilities {
    canTrash?: boolean;
    canDelete?: boolean;
    canModifyContent?: boolean;
    canRename?: boolean;
    canAddChildren?: boolean;
    canMoveItemWithinDrive?: boolean;
    canRemoveMyDriveParent?: boolean;
}

export interface DriveFileMeta {
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    md5Checksum?: string;
    createdTime?: string;
    modifiedTime?: string;
    trashed?: boolean;
    ownedByMe?: boolean;
    owners?: DriveOwner[];
    capabilities?: DriveCapabilities;
    parents?: string[];
    appProperties?: Record<string, string>;
}

/** Metadata plus Google's clock: serverNow is the Date header of the same response, in ms. */
export interface MetaWithClock extends DriveFileMeta {
    serverNow: number;
}

export type UploadSource =
    | { kind: 'file'; path: string; size: number }
    | { kind: 'bytes'; data: Uint8Array };

export interface TransferOptions {
    signal?: AbortSignal;
    onProgress?: (bytesDone: number) => void;
}

export interface UploadResult {
    id: string;
    md5Checksum: string;
    size: number;
}

export interface DownloadResult {
    md5: string;
    size: number;
}

export interface DriveApi {
    /** files.get metadata (all DriveFileMeta fields) plus the server clock. Throws DriveError 404 when missing. */
    getMeta(fileId: string): Promise<MetaWithClock>;
    /** Non-trashed children across all pages, oldest createdTime first. Optional exact-name and folder-only filters. */
    listChildren(folderId: string, filter?: { name?: string; foldersOnly?: boolean }): Promise<DriveFileMeta[]>;
    /** With opts (from the TransferEngine) the request is not retried by the client: a create is not
     *  idempotent, so the engine checks for a copy made by the lost attempt before it tries again. */
    createFolder(name: string, parentId: string, opts?: TransferOptions, appProperties?: Record<string, string>): Promise<DriveFileMeta>;
    /** Creates a file. Files of 5 MB or less use one multipart request, larger ones a chunked resumable upload.
     *  appProperties are stored with the file (see APP_PROPS in shared/types.ts). */
    createFile(name: string, parentId: string, source: UploadSource, opts?: TransferOptions, appProperties?: Record<string, string>): Promise<UploadResult>;
    /** Replaces the content of an existing file (same size rule as createFile). */
    updateContent(fileId: string, source: UploadSource, opts?: TransferOptions): Promise<UploadResult>;
    /** Streams the content to destPath (overwriting it), computing the MD5 while writing. */
    download(fileId: string, destPath: string, opts?: TransferOptions): Promise<DownloadResult>;
    readText(fileId: string): Promise<string>;
    /** Moves a file to the trash. Only the owner may do this in My Drive (403 insufficientFilePermissions otherwise). */
    trash(fileId: string): Promise<void>;
    /** Permanently deletes a file. Only the owner may do this in My Drive. */
    deleteForever(fileId: string): Promise<void>;
    rename(fileId: string, name: string): Promise<void>;
    /** Turns a file someone else owns into a placeholder in ONE request: replaces its content with 0 bytes,
     *  merges appProperties, and (when moveTo is given) moves it to another folder. Allowed for any writer. */
    markDeleted(fileId: string, appProperties: Record<string, string>, moveTo?: { addParent: string; removeParent: string }): Promise<void>;
    /** Placeholders (appProperties mdhTombstone = "1"), not trashed. mineOnly adds "'me' in owners";
     *  serverId adds mdhServer = serverId. Results include owners and appProperties. */
    listTombstones(filter: { mineOnly: boolean; serverId?: string }): Promise<DriveFileMeta[]>;
    /** Files and folders I own that this app tagged with mdhServer = serverId (placeholders included), not trashed. */
    listMyTagged(serverId: string): Promise<DriveFileMeta[]>;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

export class DriveError extends Error {
    readonly status: number;                // 0 = network error, no HTTP response
    readonly reason: string | null;         // Drive's error reason, e.g. "insufficientFilePermissions"
    readonly retryable: boolean;
    readonly rateLimited: boolean;
    readonly quotaFull: boolean;            // the file owner's storage is full: nobody can change their files

    constructor(message: string, status: number, reason: string | null = null) {
        super(message);
        this.name = 'DriveError';
        this.status = status;
        this.reason = reason;
        this.quotaFull = status === 403 && reason === 'storageQuotaExceeded';
        this.rateLimited = status === 429 || (status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason));
        this.retryable = status === 0 || this.rateLimited || [500, 502, 503, 504].includes(status);
    }
}

export function isRateLimit(err: unknown): boolean {
    return err instanceof DriveError && err.rateLimited;
}

const NETWORK_ERROR = /ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i;

export function isRetryable(err: unknown): boolean {
    if (err instanceof DriveError) return err.retryable;
    if (!(err instanceof Error) || err.name === 'AbortError') return false;
    // A checksum mismatch or a dropped connection is worth another try.
    return err.name === 'ChecksumError' || NETWORK_ERROR.test(err.message);
}

export class ChecksumError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ChecksumError';
    }
}
