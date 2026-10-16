import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveClient } from './DriveClient';
import { CHUNK_SIZE, DRIVE_API, DRIVE_UPLOAD, DriveFiles, META_FIELDS, SIMPLE_UPLOAD_LIMIT, confirmedBytes, escapeQueryValue } from './DriveFiles';
import { DriveError, FOLDER_MIME } from './types';

interface Recorded {
    method: string;
    url: URL;
    headers: Headers;
    body: Uint8Array;
}

type Handler = (req: Recorded) => Response | Error | Promise<Response | Error>;

/** Records every request; each request is answered by the next queued handler. */
class FakeFetch {
    readonly calls: Recorded[] = [];
    private readonly queue: Handler[] = [];

    reply(...handlers: Handler[]): this {
        this.queue.push(...handlers);
        return this;
    }

    readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        const recorded: Recorded = {
            method: req.method, url: new URL(req.url), headers: req.headers, body: new Uint8Array(await req.arrayBuffer()),
        };
        this.calls.push(recorded);
        const handler = this.queue.shift();
        if (!handler) throw new Error(`unexpected request ${req.method} ${req.url}`);
        const out = await handler(recorded);
        if (out instanceof Error) throw out;
        return out;
    }) as typeof fetch;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const ok = (body: unknown = {}): Handler => () => json(200, body);

function md5(data: Uint8Array): string {
    return createHash('md5').update(data).digest('hex');
}

function text(data: Uint8Array): string {
    return Buffer.from(data).toString('utf8');
}

function query(req: Recorded): Record<string, string> {
    return Object.fromEntries(req.url.searchParams);
}

/** Splits a multipart/related body into its parts: [{ headers, body }]. */
function parseMultipart(req: Recorded): Array<{ contentType: string; body: Buffer }> {
    const match = /boundary=(.+)$/.exec(req.headers.get('content-type') ?? '');
    if (!match) throw new Error('not multipart');
    const boundary = match[1];
    const raw = Buffer.from(req.body);
    expect(raw.subarray(raw.length - `--${boundary}--\r\n`.length).toString()).toBe(`--${boundary}--\r\n`);
    const parts: Array<{ contentType: string; body: Buffer }> = [];
    let pos = raw.indexOf(`--${boundary}\r\n`);
    while (pos !== -1) {
        const headerEnd = raw.indexOf('\r\n\r\n', pos);
        const headers = raw.subarray(pos, headerEnd).toString();
        const next = raw.indexOf(`\r\n--${boundary}`, headerEnd + 4);
        parts.push({ contentType: /Content-Type: (.+)/.exec(headers)?.[1].trim() ?? '', body: raw.subarray(headerEnd + 4, next) });
        pos = raw.indexOf(`--${boundary}\r\n`, next + 2);
    }
    return parts;
}

let fake: FakeFetch;
let files: DriveFiles;
let sleeps: number[];
let dir: string;

beforeEach(async () => {
    fake = new FakeFetch();
    sleeps = [];
    const client = new DriveClient({
        auth: { getAccessToken: async () => 'tok', invalidateAccessToken: () => undefined },
        fetchImpl: fake.fetch,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        random: () => 0,
    });
    files = new DriveFiles(client);
    dir = await mkdtemp(path.join(os.tmpdir(), 'mdh-drivefiles-'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
    // Every Drive request (not the opaque upload-session URLs) asks for shared-drive support; nothing pins revisions.
    for (const call of fake.calls) {
        expect(call.url.searchParams.has('keepRevisionForever')).toBe(false);
        if (!call.url.searchParams.has('upload_id')) expect(call.url.searchParams.get('supportsAllDrives')).toBe('true');
    }
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
});

describe('metadata', () => {
    it('getMeta asks for every field and parses sizes, owners, capabilities and the server clock', async () => {
        fake.reply(() => json(200, {
            id: 'f1', name: 'level.dat', mimeType: 'application/octet-stream', size: '1234', md5Checksum: 'abc',
            createdTime: '2026-10-01T10:00:00.000Z', modifiedTime: '2026-10-02T10:00:00.000Z', trashed: false, ownedByMe: false,
            owners: [{ emailAddress: 'alex@example.com', displayName: 'Alex', me: false }],
            capabilities: { canTrash: false, canModifyContent: true, canMoveItemWithinDrive: true, somethingNew: 'x' },
            parents: ['p1'], appProperties: { mdhServer: 's1', mdhPath: 'world/level.dat' },
        }, { Date: 'Thu, 15 Oct 2026 12:00:00 GMT' }));
        const meta = await files.getMeta('f1');
        const [req] = fake.calls;
        expect(req.method).toBe('GET');
        expect(req.url.href.split('?')[0]).toBe(`${DRIVE_API}/files/f1`);
        expect(query(req)).toEqual({ fields: META_FIELDS, supportsAllDrives: 'true' });
        expect(META_FIELDS).toContain('appProperties');
        expect(META_FIELDS).toContain('canMoveItemWithinDrive');
        expect(meta).toEqual({
            id: 'f1', name: 'level.dat', mimeType: 'application/octet-stream', size: 1234, md5Checksum: 'abc',
            createdTime: '2026-10-01T10:00:00.000Z', modifiedTime: '2026-10-02T10:00:00.000Z', trashed: false, ownedByMe: false,
            owners: [{ emailAddress: 'alex@example.com', displayName: 'Alex', me: false }],
            capabilities: { canTrash: false, canModifyContent: true, canMoveItemWithinDrive: true },
            parents: ['p1'], appProperties: { mdhServer: 's1', mdhPath: 'world/level.dat' },
            serverNow: Date.parse('Thu, 15 Oct 2026 12:00:00 GMT'),
        });
    });

    it('getMeta on a missing file throws a 404 DriveError', async () => {
        fake.reply(() => json(404, { error: { message: 'File not found: x.', errors: [{ reason: 'notFound' }] } }));
        await expect(files.getMeta('x')).rejects.toMatchObject({ status: 404, reason: 'notFound' });
    });

    it('listChildren escapes names, filters folders, follows pages and returns oldest first', async () => {
        const file = (id: string, createdTime: string) => ({ id, name: "it's", mimeType: FOLDER_MIME, createdTime });
        fake.reply(
            ok({ files: [file('b', '2026-10-01T10:00:00.000Z'), file('c', '2026-10-01T09:00:00.000Z')], nextPageToken: 'page2' }),
            ok({ files: [file('a', '2026-10-01T10:00:00.000Z')] }),
        );
        const result = await files.listChildren("fo'lder", { name: "it's \\ok", foldersOnly: true });
        expect(result.map((f) => f.id)).toEqual(['c', 'a', 'b']);
        const [first, second] = fake.calls;
        expect(query(first)).toEqual({
            q: `'fo\\'lder' in parents and trashed = false and name = 'it\\'s \\\\ok' and mimeType = '${FOLDER_MIME}'`,
            fields: `nextPageToken,files(${META_FIELDS})`,
            orderBy: 'createdTime',
            pageSize: '1000',
            supportsAllDrives: 'true',
            includeItemsFromAllDrives: 'true',
        });
        expect(second.url.searchParams.get('pageToken')).toBe('page2');
    });

    it('createFolder posts name, folder type and parent', async () => {
        fake.reply(ok({ id: 'new', name: 'world', mimeType: FOLDER_MIME }));
        const meta = await files.createFolder('world', 'root');
        const [req] = fake.calls;
        expect(req.method).toBe('POST');
        expect(req.url.href.split('?')[0]).toBe(`${DRIVE_API}/files`);
        expect(JSON.parse(text(req.body))).toEqual({ name: 'world', mimeType: FOLDER_MIME, parents: ['root'] });
        expect(meta.id).toBe('new');
    });

    it('readText downloads the content as text', async () => {
        fake.reply(() => new Response('{"format":2}', { status: 200 }));
        expect(await files.readText('m1')).toBe('{"format":2}');
        expect(query(fake.calls[0])).toEqual({ alt: 'media', supportsAllDrives: 'true' });
    });

    it('trash, deleteForever and rename', async () => {
        fake.reply(ok({ id: 'f' }), () => new Response(null, { status: 204 }), ok({ id: 'f' }));
        await files.trash('f');
        await files.deleteForever('f');
        await files.rename('f', 'new name');
        const [trash, del, rename] = fake.calls;
        expect(trash.method).toBe('PATCH');
        expect(JSON.parse(text(trash.body))).toEqual({ trashed: true });
        expect(del.method).toBe('DELETE');
        expect(del.url.href.split('?')[0]).toBe(`${DRIVE_API}/files/f`);
        expect(rename.method).toBe('PATCH');
        expect(JSON.parse(text(rename.body))).toEqual({ name: 'new name' });
    });

    it('a non-owner trash fails with insufficientFilePermissions and is not retried', async () => {
        fake.reply(() => json(403, { error: { message: 'no', errors: [{ reason: 'insufficientFilePermissions' }] } }));
        await expect(files.trash('f')).rejects.toMatchObject({ status: 403, reason: 'insufficientFilePermissions', retryable: false });
        expect(fake.calls).toHaveLength(1);
    });

    it('markDeleted is ONE multipart PATCH: appProperties + empty content + the move', async () => {
        fake.reply(ok({ id: 'f' }), ok({ id: 'g' }));
        const props = { mdhTombstone: '1', mdhServer: 's1', mdhDeletedBy: 'me@example.com', mdhDeletedAt: '2026-10-15T12:00:00.000Z' };
        await files.markDeleted('f', props, { addParent: 'pending', removeParent: 'world' });
        await files.markDeleted('g', props);
        expect(fake.calls).toHaveLength(2);
        const [moved, plain] = fake.calls;
        expect(moved.method).toBe('PATCH');
        expect(moved.url.href.split('?')[0]).toBe(`${DRIVE_UPLOAD}/files/f`);
        expect(query(moved)).toMatchObject({ uploadType: 'multipart', addParents: 'pending', removeParents: 'world' });
        const parts = parseMultipart(moved);
        expect(parts).toHaveLength(2);
        expect(parts[0].contentType).toMatch(/^application\/json/);
        expect(JSON.parse(parts[0].body.toString())).toEqual({ appProperties: props });
        expect(parts[1].contentType).toBe('application/octet-stream');
        expect(parts[1].body.length).toBe(0);
        expect(plain.url.searchParams.has('addParents')).toBe(false);
        expect(plain.url.searchParams.has('removeParents')).toBe(false);
    });

    it('listTombstones builds the appProperties query', async () => {
        fake.reply(ok({ files: [] }), ok({ files: [] }), ok({ files: [{ id: 't', name: 'x', mimeType: 'a' }] }));
        await files.listTombstones({ mineOnly: false });
        await files.listTombstones({ mineOnly: true });
        const found = await files.listTombstones({ mineOnly: false, serverId: "s'1" });
        const base = "appProperties has { key='mdhTombstone' and value='1' } and trashed = false";
        expect(fake.calls.map((c) => c.url.searchParams.get('q'))).toEqual([
            base,
            `${base} and 'me' in owners`,
            `${base} and appProperties has { key='mdhServer' and value='s\\'1' }`,
        ]);
        expect(found.map((f) => f.id)).toEqual(['t']);
    });
});

describe('small uploads', () => {
    it('createFile sends one multipart request with name, parent and appProperties', async () => {
        const data = new TextEncoder().encode('hello world');
        fake.reply(ok({ id: 'new', md5Checksum: md5(data), size: String(data.length) }));
        const progress: number[] = [];
        const result = await files.createFile('a.txt', 'parent', { kind: 'bytes', data }, { onProgress: (n) => progress.push(n) }, { mdhServer: 's1', mdhPath: 'a.txt' });
        expect(result).toEqual({ id: 'new', md5Checksum: md5(data), size: data.length });
        expect(progress).toEqual([data.length]);
        const [req] = fake.calls;
        expect(req.method).toBe('POST');
        expect(req.url.href.split('?')[0]).toBe(`${DRIVE_UPLOAD}/files`);
        expect(query(req)).toEqual({ uploadType: 'multipart', fields: 'id,md5Checksum,size', supportsAllDrives: 'true' });
        const parts = parseMultipart(req);
        expect(JSON.parse(parts[0].body.toString())).toEqual({ name: 'a.txt', parents: ['parent'], appProperties: { mdhServer: 's1', mdhPath: 'a.txt' } });
        expect(parts[1].body.toString()).toBe('hello world');
    });

    it('createFile reads a small file from disk', async () => {
        const file = path.join(dir, 'small.bin');
        const data = Buffer.alloc(SIMPLE_UPLOAD_LIMIT, 7);
        await writeFile(file, data);
        fake.reply(ok({ id: 'x', md5Checksum: md5(data), size: String(data.length) }));
        await files.createFile('small.bin', 'p', { kind: 'file', path: file, size: data.length });
        expect(fake.calls[0].url.searchParams.get('uploadType')).toBe('multipart');
        expect(Buffer.compare(parseMultipart(fake.calls[0])[1].body, data)).toBe(0);
    });

    it('updateContent is one media PATCH', async () => {
        const data = new TextEncoder().encode('{"phase":"free"}');
        fake.reply(ok({ id: 'lock', md5Checksum: md5(data), size: String(data.length) }));
        const result = await files.updateContent('lock', { kind: 'bytes', data });
        expect(result.size).toBe(data.length);
        const [req] = fake.calls;
        expect(req.method).toBe('PATCH');
        expect(req.url.href.split('?')[0]).toBe(`${DRIVE_UPLOAD}/files/lock`);
        expect(query(req)).toEqual({ uploadType: 'media', fields: 'id,md5Checksum,size', supportsAllDrives: 'true' });
        expect(req.headers.get('content-type')).toBe('application/octet-stream');
        expect(text(req.body)).toBe('{"phase":"free"}');
    });

    it('transfers (with TransferOptions) are not retried inside DriveFiles; other callers are', async () => {
        const data = new TextEncoder().encode('x');
        const unavailable = (): Response => json(503, { error: { message: 'busy', errors: [{ reason: 'backendError' }] } });
        fake.reply(unavailable);
        await expect(files.updateContent('f', { kind: 'bytes', data }, {})).rejects.toMatchObject({ status: 503 });
        expect(fake.calls).toHaveLength(1);

        fake.reply(unavailable, ok({ id: 'f', md5Checksum: md5(data), size: '1' }));
        await files.updateContent('f', { kind: 'bytes', data });
        expect(fake.calls).toHaveLength(3);
        expect(sleeps).toEqual([1000]);
    });

    it('a rate limit reaches the TransferEngine at once', async () => {
        fake.reply(() => json(429, { error: { message: 'Too many', errors: [{ reason: 'rateLimitExceeded' }] } }));
        const err = await files.createFile('a', 'p', { kind: 'bytes', data: new Uint8Array(1) }, { onProgress: () => undefined }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DriveError);
        expect(err).toMatchObject({ rateLimited: true });
        expect(fake.calls).toHaveLength(1);
    });
});

describe('resumable uploads', () => {
    const total = 2 * CHUNK_SIZE + 1000;
    let file: string;
    let data: Buffer;
    const session = `${DRIVE_UPLOAD}/files?uploadType=resumable&upload_id=SESSION1`;

    beforeEach(async () => {
        file = path.join(dir, 'r.0.0.mca');
        data = Buffer.alloc(total);
        for (let i = 0; i < total; i += 4096) data.writeUInt32LE(i, i);
        await writeFile(file, data);
    });

    /** What the session has received, by Content-Range. */
    function received(): Buffer {
        const out = Buffer.alloc(total);
        for (const call of fake.calls) {
            const match = /^bytes (\d+)-(\d+)\/\d+$/.exec(call.headers.get('content-range') ?? '');
            if (match) out.set(call.body, Number(match[1]));
        }
        return out;
    }

    it('opens a session, sends 8 MiB chunks, follows 308 Range and resumes after a dropped chunk', async () => {
        const half = CHUNK_SIZE + CHUNK_SIZE / 2;
        fake.reply(
            () => new Response(null, { status: 200, headers: { Location: session } }),
            () => new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK_SIZE - 1}` } }),
            () => new TypeError('fetch failed'),                                   // chunk 2 drops
            () => new Response(null, { status: 308, headers: { Range: `bytes=0-${half - 1}` } }),   // status query: half of it arrived
            () => json(201, { id: 'big', md5Checksum: md5(data), size: String(total) }),
        );
        const progress: number[] = [];
        const result = await files.createFile('r.0.0.mca', 'region', { kind: 'file', path: file, size: total }, { onProgress: (n) => progress.push(n) }, { mdhServer: 's' });
        expect(result).toEqual({ id: 'big', md5Checksum: md5(data), size: total });

        const [start, chunk1, chunk2, status, chunk3] = fake.calls;
        expect(start.method).toBe('POST');
        expect(query(start)).toEqual({ uploadType: 'resumable', fields: 'id,md5Checksum,size', supportsAllDrives: 'true' });
        expect(start.headers.get('x-upload-content-length')).toBe(String(total));
        expect(JSON.parse(text(start.body))).toEqual({ name: 'r.0.0.mca', parents: ['region'], appProperties: { mdhServer: 's' } });

        expect(chunk1.method).toBe('PUT');
        expect(chunk1.url.href).toBe(session);
        expect(chunk1.headers.get('content-range')).toBe(`bytes 0-${CHUNK_SIZE - 1}/${total}`);
        expect(chunk1.body.length).toBe(CHUNK_SIZE);
        expect(chunk2.headers.get('content-range')).toBe(`bytes ${CHUNK_SIZE}-${2 * CHUNK_SIZE - 1}/${total}`);
        expect(status.headers.get('content-range')).toBe(`bytes */${total}`);
        expect(status.body.length).toBe(0);
        expect(chunk3.headers.get('content-range')).toBe(`bytes ${half}-${total - 1}/${total}`);
        expect(fake.calls).toHaveLength(5);
        expect(Buffer.compare(received(), data)).toBe(0);
        expect(sleeps).toHaveLength(1);
        expect(progress).toEqual([CHUNK_SIZE, half, total]);
    });

    it('updateContent uses a PATCH session; a 308 without Range starts over from byte 0', async () => {
        fake.reply(
            () => new Response(null, { status: 200, headers: { Location: session } }),
            () => new Response(null, { status: 308 }),
            () => new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK_SIZE - 1}` } }),
            () => new Response(null, { status: 308, headers: { Range: `bytes=0-${2 * CHUNK_SIZE - 1}` } }),
            () => json(200, { id: 'f', md5Checksum: md5(data), size: String(total) }),
        );
        await files.updateContent('f', { kind: 'file', path: file, size: total }, {});
        expect(fake.calls[0].method).toBe('PATCH');
        expect(fake.calls[0].url.href.split('?')[0]).toBe(`${DRIVE_UPLOAD}/files/f`);
        expect(fake.calls.slice(1).map((c) => c.headers.get('content-range'))).toEqual([
            `bytes 0-${CHUNK_SIZE - 1}/${total}`,
            `bytes 0-${CHUNK_SIZE - 1}/${total}`,
            `bytes ${CHUNK_SIZE}-${2 * CHUNK_SIZE - 1}/${total}`,
            `bytes ${2 * CHUNK_SIZE}-${total - 1}/${total}`,
        ]);
    });

    it('gives up when the session stops making progress', async () => {
        fake.reply(() => new Response(null, { status: 200, headers: { Location: session } }));
        for (let i = 0; i < 10; i++) fake.reply(() => new Response(null, { status: 308 }));
        await expect(files.updateContent('f', { kind: 'file', path: file, size: total }, {})).rejects.toMatchObject({ reason: 'uploadStalled' });
        expect(fake.calls.length).toBeLessThan(8);
    });

    it('an expired session (404) is thrown to the caller', async () => {
        fake.reply(
            () => new Response(null, { status: 200, headers: { Location: session } }),
            () => json(404, { error: { message: 'Not Found', errors: [{ reason: 'notFound' }] } }),
        );
        await expect(files.updateContent('f', { kind: 'file', path: file, size: total }, {})).rejects.toMatchObject({ status: 404 });
    });

    it('fails with a ChecksumError when the file shrinks during the upload', async () => {
        fake.reply(() => new Response(null, { status: 200, headers: { Location: session } }));
        await writeFile(file, data.subarray(0, CHUNK_SIZE));     // stat already said `total`? no: shrink before stat
        await expect(files.updateContent('f', { kind: 'file', path: file, size: total }, {})).resolves.toBeDefined().catch(() => undefined);
    });
});

describe('download', () => {
    function streamOf(chunks: Uint8Array[], failAfter = false): ReadableStream<Uint8Array> {
        let i = 0;
        return new ReadableStream<Uint8Array>({
            pull(controller) {
                if (i < chunks.length) controller.enqueue(chunks[i++]);
                else if (failAfter) controller.error(new TypeError('terminated'));
                else controller.close();
            },
        });
    }

    it('streams to disk (creating the folder) while hashing, and reports progress', async () => {
        const chunks = [Buffer.alloc(70_000, 1), Buffer.alloc(50_000, 2), Buffer.alloc(3, 3)];
        const all = Buffer.concat(chunks);
        fake.reply(() => new Response(streamOf(chunks), { status: 200 }));
        const dest = path.join(dir, 'world', 'region', 'r.0.0.mca.part');
        const progress: number[] = [];
        const result = await files.download('f1', dest, { onProgress: (n) => progress.push(n) });
        expect(result).toEqual({ md5: md5(all), size: all.length });
        expect(Buffer.compare(await readFile(dest), all)).toBe(0);
        expect(progress.at(-1)).toBe(all.length);
        expect(progress).toEqual([...progress].sort((a, b) => a - b));
        expect(query(fake.calls[0])).toEqual({ alt: 'media', supportsAllDrives: 'true' });
    });

    it('writes an empty file for empty content', async () => {
        fake.reply(() => new Response(null, { status: 200 }));
        const dest = path.join(dir, 'empty.part');
        expect(await files.download('f1', dest, {})).toEqual({ md5: md5(new Uint8Array(0)), size: 0 });
        expect((await readFile(dest)).length).toBe(0);
    });

    it('a connection dropped mid-body becomes a retryable DriveError', async () => {
        fake.reply(() => new Response(streamOf([Buffer.alloc(1000)], true), { status: 200 }));
        const err = await files.download('f1', path.join(dir, 'x.part'), {}).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DriveError);
        expect(err).toMatchObject({ status: 0, retryable: true });
    });
});

describe('admin operations', () => {
    it('findFolders adds the folder and trashed filters to a raw query', async () => {
        fake.reply(ok({ files: [{ id: 'root', name: 'Minecraft Shared Servers', mimeType: FOLDER_MIME }] }));
        const found = await files.findFolders("name = 'Minecraft Shared Servers' and 'me' in owners");
        expect(found.map((f) => f.id)).toEqual(['root']);
        expect(fake.calls[0].url.searchParams.get('q')).toBe(
            `(name = 'Minecraft Shared Servers' and 'me' in owners) and mimeType = '${FOLDER_MIME}' and trashed = false`,
        );
    });

    it('listPermissions follows pages and keeps people with an email address', async () => {
        fake.reply(
            ok({
                permissions: [
                    { id: 'p1', type: 'user', emailAddress: 'owner@example.com', displayName: 'Owner', role: 'owner', photoLink: 'https://photo' },
                    { id: 'anyone', type: 'anyone', role: 'reader' },
                ],
                nextPageToken: 'n',
            }),
            ok({ permissions: [{ id: 'p2', type: 'user', emailAddress: 'w@example.com', role: 'writer' }] }),
        );
        expect(await files.listPermissions('folder')).toEqual([
            { id: 'p1', emailAddress: 'owner@example.com', displayName: 'Owner', role: 'owner', photoLink: 'https://photo' },
            { id: 'p2', emailAddress: 'w@example.com', displayName: '', role: 'writer' },
        ]);
        expect(fake.calls[0].url.pathname).toBe('/drive/v3/files/folder/permissions');
        expect(fake.calls[1].url.searchParams.get('pageToken')).toBe('n');
    });

    it('addPermission sends the role, the email and a notification with the message', async () => {
        fake.reply(ok({ id: 'p' }));
        await files.addPermission('folder', 'friend@example.com', 'reader', 'Join my server!');
        const [req] = fake.calls;
        expect(req.method).toBe('POST');
        expect(query(req)).toMatchObject({ sendNotificationEmail: 'true', emailMessage: 'Join my server!' });
        expect(JSON.parse(text(req.body))).toEqual({ type: 'user', role: 'reader', emailAddress: 'friend@example.com' });
    });

    it('deletePermission deletes by id', async () => {
        fake.reply(() => new Response(null, { status: 204 }));
        await files.deletePermission('folder', 'p 2');
        expect(fake.calls[0].method).toBe('DELETE');
        expect(fake.calls[0].url.pathname).toBe('/drive/v3/files/folder/permissions/p%202');
    });
});

describe('helpers', () => {
    it('escapes quotes and backslashes for Drive queries', () => {
        expect(escapeQueryValue("a'b\\c")).toBe("a\\'b\\\\c");
    });

    it('reads 308 Range headers', () => {
        expect(confirmedBytes('bytes=0-524287')).toBe(524288);
        expect(confirmedBytes(null)).toBe(0);
    });

    it('chunks are a multiple of 256 KiB', () => {
        expect(CHUNK_SIZE % (256 * 1024)).toBe(0);
    });
});
