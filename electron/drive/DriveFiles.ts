// DriveApi over Drive v3 REST, plus the folder and permission operations ServersService needs.
// Retries: a call WITH TransferOptions comes from the TransferEngine, which retries jobs itself and must see
// rate limits at once to reduce its lanes, so those requests are sent with retry: false. Every other call
// (LauncherFiles, LockService, metadata) lets DriveClient retry with backoff.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { APP_PROPS } from '../../shared/types';
import type { DriveClient } from './DriveClient';
import { ChecksumError, DriveError, FOLDER_MIME } from './types';
import type {
    DownloadResult, DriveApi, DriveCapabilities, DriveFileMeta, DriveOwner, MetaWithClock, TransferOptions,
    UploadResult, UploadSource,
} from './types';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export const META_FIELDS = 'id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,trashed,ownedByMe,'
    + 'owners(emailAddress,displayName,me),'
    + 'capabilities(canTrash,canDelete,canModifyContent,canRename,canAddChildren,canMoveItemWithinDrive,canRemoveMyDriveParent),'
    + 'parents,appProperties';
const UPLOAD_FIELDS = 'id,md5Checksum,size';
const PERMISSION_FIELDS = 'nextPageToken,permissions(id,type,emailAddress,displayName,role,photoLink)';

/** Google's line between one-request and resumable uploads. */
export const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;
/** Resumable chunk size; must be a multiple of 256 KiB. */
export const CHUNK_SIZE = 8 * 1024 * 1024;
/** Chunk failures in a row (without new bytes confirmed) before a resumable upload gives up. */
const MAX_RESUMES = 3;

export interface DrivePermission {
    id: string;
    emailAddress: string;
    displayName: string;
    role: string;
    photoLink?: string;
}

/** Escapes a value for use inside '...' in a Drive query. */
export function escapeQueryValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
    return undefined;
}

function bool(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function malformed(what: string): Error {
    return new Error(`Google Drive sent an unexpected answer (${what}).`);
}

/** Drive's JSON file resource -> DriveFileMeta (sizes arrive as strings). */
export function parseMeta(raw: unknown): DriveFileMeta {
    if (!isRecord(raw)) throw malformed('file is not an object');
    const id = str(raw.id);
    if (!id) throw malformed('file without id');
    const meta: DriveFileMeta = { id, name: str(raw.name) ?? '', mimeType: str(raw.mimeType) ?? '' };
    const size = num(raw.size);
    if (size !== undefined) meta.size = size;
    if (str(raw.md5Checksum)) meta.md5Checksum = str(raw.md5Checksum);
    if (str(raw.createdTime)) meta.createdTime = str(raw.createdTime);
    if (str(raw.modifiedTime)) meta.modifiedTime = str(raw.modifiedTime);
    if (bool(raw.trashed) !== undefined) meta.trashed = bool(raw.trashed);
    if (bool(raw.ownedByMe) !== undefined) meta.ownedByMe = bool(raw.ownedByMe);
    if (Array.isArray(raw.owners)) {
        meta.owners = raw.owners.filter(isRecord).map((o): DriveOwner => {
            const owner: DriveOwner = { emailAddress: str(o.emailAddress) ?? '' };
            if (str(o.displayName) !== undefined) owner.displayName = str(o.displayName);
            if (bool(o.me) !== undefined) owner.me = bool(o.me);
            return owner;
        });
    }
    if (isRecord(raw.capabilities)) {
        const caps: DriveCapabilities = {};
        for (const [key, value] of Object.entries(raw.capabilities)) {
            if (typeof value === 'boolean') (caps as Record<string, boolean>)[key] = value;
        }
        meta.capabilities = caps;
    }
    if (Array.isArray(raw.parents)) meta.parents = raw.parents.filter((p): p is string => typeof p === 'string');
    if (isRecord(raw.appProperties)) {
        const props: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw.appProperties)) {
            if (typeof value === 'string') props[key] = value;
        }
        meta.appProperties = props;
    }
    return meta;
}

function parseUploadResult(raw: unknown): UploadResult {
    if (!isRecord(raw) || !str(raw.id)) throw malformed('upload without id');
    return { id: str(raw.id) ?? '', md5Checksum: str(raw.md5Checksum) ?? '', size: num(raw.size) ?? 0 };
}

/** Oldest first; the id breaks ties so every member's app picks the same "oldest" file. */
function byCreatedTime(a: DriveFileMeta, b: DriveFileMeta): number {
    const ta = Date.parse(a.createdTime ?? '') || 0;
    const tb = Date.parse(b.createdTime ?? '') || 0;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** multipart/related body: JSON metadata, then the media bytes. */
export function multipartBody(metadata: object, media: Uint8Array, boundary: string): Uint8Array<ArrayBuffer> {
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
        + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const out = new Uint8Array(Buffer.byteLength(head) + media.length + Buffer.byteLength(tail));
    out.set(Buffer.from(head, 'utf8'), 0);
    out.set(media, Buffer.byteLength(head));
    out.set(Buffer.from(tail, 'utf8'), Buffer.byteLength(head) + media.length);
    return out;
}

/** "bytes=0-524287" -> 524288 (the next byte to send). No header -> 0. */
export function confirmedBytes(rangeHeader: string | null): number {
    if (!rangeHeader) return 0;
    const match = /bytes=(\d+)-(\d+)/.exec(rangeHeader);
    return match ? Number(match[2]) + 1 : 0;
}

function fileUrl(fileId: string): string {
    return `${DRIVE_API}/files/${encodeURIComponent(fileId)}`;
}

async function readSource(source: UploadSource): Promise<Uint8Array<ArrayBuffer>> {
    // Copy so fetch gets a plain ArrayBuffer-backed view (files here are at most 5 MiB).
    return source.kind === 'bytes' ? new Uint8Array(source.data) : new Uint8Array(await readFile(source.path));
}

function sourceSize(source: UploadSource): number {
    return source.kind === 'bytes' ? source.data.length : source.size;
}

/** A failed chunk worth asking the session where it stands: dropped connection or a 5xx. */
function isResumable(err: unknown): err is DriveError {
    return err instanceof DriveError && (err.status === 0 || err.status >= 500);
}

function isFsError(err: unknown): boolean {
    return err instanceof Error && typeof (err as Error & { syscall?: unknown }).syscall === 'string';
}

export class DriveFiles implements DriveApi {
    constructor(private readonly client: DriveClient) {}

    /* ------------------------------------------------------------------ metadata */

    async getMeta(fileId: string): Promise<MetaWithClock> {
        const { data, serverNow } = await this.client.request('GET', fileUrl(fileId), {
            query: { fields: META_FIELDS, supportsAllDrives: true },
        });
        return { ...parseMeta(data), serverNow };
    }

    async listChildren(folderId: string, filter?: { name?: string; foldersOnly?: boolean }): Promise<DriveFileMeta[]> {
        const clauses = [`'${escapeQueryValue(folderId)}' in parents`, 'trashed = false'];
        if (filter?.name !== undefined) clauses.push(`name = '${escapeQueryValue(filter.name)}'`);
        if (filter?.foldersOnly) clauses.push(`mimeType = '${FOLDER_MIME}'`);
        return this.listFiles(clauses.join(' and '));
    }

    async createFolder(name: string, parentId: string, opts?: TransferOptions, appProperties?: Record<string, string>): Promise<DriveFileMeta> {
        const json: Record<string, unknown> = { name, mimeType: FOLDER_MIME, parents: [parentId] };
        if (appProperties && Object.keys(appProperties).length > 0) json.appProperties = appProperties;
        const { data } = await this.client.request('POST', `${DRIVE_API}/files`, {
            query: { fields: META_FIELDS, supportsAllDrives: true },
            json,
            retry: opts === undefined,
            signal: opts?.signal,
        });
        return parseMeta(data);
    }

    async readText(fileId: string): Promise<string> {
        const { data } = await this.client.request('GET', fileUrl(fileId), {
            query: { alt: 'media', supportsAllDrives: true },
            expect: 'text',
        });
        return typeof data === 'string' ? data : '';
    }

    async trash(fileId: string): Promise<void> {
        await this.client.request('PATCH', fileUrl(fileId), {
            query: { fields: 'id', supportsAllDrives: true },
            json: { trashed: true },
            expect: 'none',
        });
    }

    async deleteForever(fileId: string): Promise<void> {
        await this.client.request('DELETE', fileUrl(fileId), {
            query: { supportsAllDrives: true },
            expect: 'none',
        });
    }

    async rename(fileId: string, name: string): Promise<void> {
        await this.client.request('PATCH', fileUrl(fileId), {
            query: { fields: 'id', supportsAllDrives: true },
            json: { name },
            expect: 'none',
        });
    }

    async markDeleted(fileId: string, appProperties: Record<string, string>, moveTo?: { addParent: string; removeParent: string }): Promise<void> {
        // Content, appProperties and the move in ONE request, so a placeholder is never half made.
        const boundary = `mdh-${randomUUID()}`;
        await this.client.request('PATCH', `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}`, {
            query: {
                uploadType: 'multipart',
                fields: 'id',
                supportsAllDrives: true,
                addParents: moveTo?.addParent,
                removeParents: moveTo?.removeParent,
            },
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body: multipartBody({ appProperties }, new Uint8Array(0), boundary),
            expect: 'none',
        });
    }

    async listTombstones(filter: { mineOnly: boolean; serverId?: string }): Promise<DriveFileMeta[]> {
        const clauses = [`appProperties has { key='${APP_PROPS.tombstone}' and value='1' }`, 'trashed = false'];
        if (filter.mineOnly) clauses.push("'me' in owners");
        if (filter.serverId !== undefined) {
            clauses.push(`appProperties has { key='${APP_PROPS.server}' and value='${escapeQueryValue(filter.serverId)}' }`);
        }
        return this.listFiles(clauses.join(' and '));
    }

    async listMyTagged(serverId: string): Promise<DriveFileMeta[]> {
        return this.listFiles([
            `appProperties has { key='${APP_PROPS.server}' and value='${escapeQueryValue(serverId)}' }`,
            "'me' in owners",
            'trashed = false',
        ].join(' and '));
    }

    async listTagged(serverId: string): Promise<DriveFileMeta[]> {
        return this.listFiles([
            `appProperties has { key='${APP_PROPS.server}' and value='${escapeQueryValue(serverId)}' }`,
            'trashed = false',
        ].join(' and '));
    }

    /* ------------------------------------------------------------------ content */

    async createFile(
        name: string, parentId: string, source: UploadSource, opts?: TransferOptions, appProperties?: Record<string, string>,
    ): Promise<UploadResult> {
        const metadata: Record<string, unknown> = { name, parents: [parentId] };
        if (appProperties && Object.keys(appProperties).length > 0) metadata.appProperties = appProperties;
        const retry = opts === undefined;
        if (sourceSize(source) <= SIMPLE_UPLOAD_LIMIT) {
            const bytes = await readSource(source);
            const boundary = `mdh-${randomUUID()}`;
            const { data } = await this.client.request('POST', `${DRIVE_UPLOAD}/files`, {
                query: { uploadType: 'multipart', fields: UPLOAD_FIELDS, supportsAllDrives: true },
                headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                body: multipartBody(metadata, bytes, boundary),
                retry,
                signal: opts?.signal,
            });
            opts?.onProgress?.(bytes.length);
            return parseUploadResult(data);
        }
        return this.resumable('POST', `${DRIVE_UPLOAD}/files`, metadata, source, opts);
    }

    async updateContent(fileId: string, source: UploadSource, opts?: TransferOptions): Promise<UploadResult> {
        const url = `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}`;
        if (sourceSize(source) <= SIMPLE_UPLOAD_LIMIT) {
            const bytes = await readSource(source);
            const { data } = await this.client.request('PATCH', url, {
                query: { uploadType: 'media', fields: UPLOAD_FIELDS, supportsAllDrives: true },
                headers: { 'Content-Type': 'application/octet-stream' },
                body: bytes,
                retry: opts === undefined,
                signal: opts?.signal,
            });
            opts?.onProgress?.(bytes.length);
            return parseUploadResult(data);
        }
        return this.resumable('PATCH', url, {}, source, opts);
    }

    async download(fileId: string, destPath: string, opts?: TransferOptions): Promise<DownloadResult> {
        const signal = opts?.signal;
        const { response } = await this.client.request('GET', fileUrl(fileId), {
            query: { alt: 'media', supportsAllDrives: true },
            retry: opts === undefined,
            signal,
            expect: 'response',
        });
        await mkdir(path.dirname(destPath), { recursive: true });
        const hash = createHash('md5');
        let size = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                hash.update(chunk);
                size += chunk.length;
                opts?.onProgress?.(size);
                callback(null, chunk);
            },
        });
        const body = response.body
            ? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)
            : Readable.from([]);
        try {
            if (signal) await pipeline(body, meter, createWriteStream(destPath), { signal });
            else await pipeline(body, meter, createWriteStream(destPath));
        } catch (err) {
            if (signal?.aborted) throw signal.reason ?? err;
            if (isFsError(err)) throw err;
            // The connection dropped mid-body; undici reports that as "terminated", which is not obviously retryable.
            throw new DriveError(`Download interrupted: ${err instanceof Error ? err.message : String(err)}`, 0);
        }
        return { md5: hash.digest('hex'), size };
    }

    /* ------------------------------------------------------------------ admin (ServersService) */

    /** Non-trashed folders matching a raw Drive query, oldest first. */
    async findFolders(query: string): Promise<DriveFileMeta[]> {
        return this.listFiles(`(${query}) and mimeType = '${FOLDER_MIME}' and trashed = false`);
    }

    /** People with access (permissions without an email address, such as "anyone with the link", are left out). */
    async listPermissions(fileId: string): Promise<DrivePermission[]> {
        const out: DrivePermission[] = [];
        let pageToken: string | undefined;
        do {
            const { data } = await this.client.request('GET', `${fileUrl(fileId)}/permissions`, {
                query: { fields: PERMISSION_FIELDS, pageSize: 100, pageToken, supportsAllDrives: true },
            });
            if (!isRecord(data)) throw malformed('permission list');
            for (const raw of Array.isArray(data.permissions) ? data.permissions : []) {
                if (!isRecord(raw) || !str(raw.id) || !str(raw.emailAddress)) continue;
                const permission: DrivePermission = {
                    id: str(raw.id) ?? '',
                    emailAddress: str(raw.emailAddress) ?? '',
                    displayName: str(raw.displayName) ?? '',
                    role: str(raw.role) ?? '',
                };
                if (str(raw.photoLink)) permission.photoLink = str(raw.photoLink);
                out.push(permission);
            }
            pageToken = str(data.nextPageToken);
        } while (pageToken);
        return out;
    }

    async addPermission(fileId: string, email: string, role: 'writer' | 'reader', message: string): Promise<void> {
        await this.client.request('POST', `${fileUrl(fileId)}/permissions`, {
            query: {
                sendNotificationEmail: true,
                emailMessage: message.trim() ? message : undefined,
                fields: 'id',
                supportsAllDrives: true,
            },
            json: { type: 'user', role, emailAddress: email },
            expect: 'none',
        });
    }

    async deletePermission(fileId: string, permissionId: string): Promise<void> {
        await this.client.request('DELETE', `${fileUrl(fileId)}/permissions/${encodeURIComponent(permissionId)}`, {
            query: { supportsAllDrives: true },
            expect: 'none',
        });
    }

    /* ------------------------------------------------------------------ internals */

    private async listFiles(q: string): Promise<DriveFileMeta[]> {
        const out: DriveFileMeta[] = [];
        let pageToken: string | undefined;
        do {
            const { data } = await this.client.request('GET', `${DRIVE_API}/files`, {
                query: {
                    q,
                    fields: `nextPageToken,files(${META_FIELDS})`,
                    orderBy: 'createdTime',
                    pageSize: 1000,
                    pageToken,
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                },
            });
            if (!isRecord(data)) throw malformed('file list');
            for (const raw of Array.isArray(data.files) ? data.files : []) out.push(parseMeta(raw));
            pageToken = str(data.nextPageToken);
        } while (pageToken);
        return out.sort(byCreatedTime);
    }

    // Resumable upload: open a session, send 8 MiB chunks, follow 308 "Range" answers, and after a dropped
    // chunk ask the session how much it has ("Content-Range: bytes */total") and continue from there.
    private async resumable(
        method: 'POST' | 'PATCH', url: string, metadata: Record<string, unknown>, source: UploadSource, opts?: TransferOptions,
    ): Promise<UploadResult> {
        const signal = opts?.signal;
        if (source.kind === 'bytes') return this.resumableFrom(method, url, metadata, source.data.length, opts, (offset, buffer, length) => {
            buffer.set(source.data.subarray(offset, offset + length));
            return Promise.resolve(length);
        });
        const handle: FileHandle = await open(source.path, 'r');
        try {
            const total = (await handle.stat()).size;
            return await this.resumableFrom(method, url, metadata, total, opts, async (offset, buffer, length) => {
                signal?.throwIfAborted();
                const { bytesRead } = await handle.read(buffer, 0, length, offset);
                return bytesRead;
            });
        } finally {
            await handle.close();
        }
    }

    private async resumableFrom(
        method: 'POST' | 'PATCH', url: string, metadata: Record<string, unknown>, total: number, opts: TransferOptions | undefined,
        read: (offset: number, buffer: Uint8Array<ArrayBuffer>, length: number) => Promise<number>,
    ): Promise<UploadResult> {
        const signal = opts?.signal;
        const retry = opts === undefined;
        const { response: started } = await this.client.request(method, url, {
            query: { uploadType: 'resumable', fields: UPLOAD_FIELDS, supportsAllDrives: true },
            headers: { 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(total) },
            json: metadata,
            retry,
            signal,
            expect: 'none',
        });
        const session = started.headers.get('location');
        if (!session) throw new DriveError('Google Drive did not return an upload session.', 500, 'noUploadSession');

        const buffer = new Uint8Array(Math.min(CHUNK_SIZE, total));
        let offset = 0;
        let stalls = 0;                 // status checks or answers in a row that brought no new bytes
        let needStatus = false;         // after a failed request, ask before sending more (never re-send blindly)
        for (;;) {
            const askStatus = needStatus || offset >= total;
            let answer: Response;
            try {
                if (askStatus) {
                    answer = await this.sessionStatus(session, total, signal);
                } else {
                    const length = Math.min(CHUNK_SIZE, total - offset);
                    const got = await read(offset, buffer, length);
                    if (got !== length) throw new ChecksumError(`The file changed while it was uploading (expected ${total} bytes).`);
                    ({ response: answer } = await this.client.request('PUT', session, {
                        headers: { 'Content-Range': `bytes ${offset}-${offset + length - 1}/${total}` },
                        body: buffer.subarray(0, length),
                        retry: false,
                        signal,
                        expect: 'response',
                    }));
                }
            } catch (err) {
                if (!isResumable(err)) throw err;
                if (askStatus && ++stalls > MAX_RESUMES) throw err;
                console.warn(`[drive] upload at byte ${offset}/${total} failed (${err.status} ${err.message}); asking the session where it stands`);
                needStatus = true;
                await this.client.wait(stalls, signal);
                continue;
            }
            needStatus = false;
            if (answer.status === 200 || answer.status === 201) {
                const result = parseUploadResult(await answer.json());
                opts?.onProgress?.(total);
                return result;
            }
            // 308 Resume Incomplete: Range says how many bytes Google has kept.
            await answer.arrayBuffer().catch(() => undefined);
            const confirmed = Math.min(confirmedBytes(answer.headers.get('range')), total);
            if (confirmed > offset) {
                stalls = 0;
            } else if (++stalls > MAX_RESUMES) {
                throw new DriveError('The resumable upload stopped making progress.', 500, 'uploadStalled');
            }
            offset = confirmed;
            opts?.onProgress?.(offset);
        }
    }

    /** Asks an upload session how many bytes it has: 308 with Range, or 200/201 when it is complete. */
    private async sessionStatus(session: string, total: number, signal?: AbortSignal): Promise<Response> {
        const { response } = await this.client.request('PUT', session, {
            headers: { 'Content-Range': `bytes */${total}` },
            body: new Uint8Array(0),
            retry: false,
            signal,
            expect: 'response',
        });
        return response;
    }
}
