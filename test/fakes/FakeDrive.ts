// An in-memory Google Drive for tests. Several users share one FakeDriveStore; each gets a DriveApi
// view with store.as(email). Ownership follows My Drive rules: the uploader owns a file, every member
// may change its content and metadata, and (by default) only the owner may trash or delete it.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    DriveApi, DriveError, DriveFileMeta, DownloadResult, FOLDER_MIME, MetaWithClock,
    TransferOptions, UploadResult, UploadSource,
} from '../../electron/drive/types';

export interface FakeNode {
    id: string;
    name: string;
    mimeType: string;
    parentId: string | null;
    ownerEmail: string;
    content: Uint8Array;
    createdTime: number;
    modifiedTime: number;
    trashed: boolean;
    revisions: number;
    appProperties: Record<string, string>;
    /** false = the owner turned off "editors can share", so writers cannot move this item */
    writersCanShare: boolean;
}

type Op = keyof DriveApi;

interface Failure {
    op: Op;
    remaining: number;
    error: () => Error;
    when?: (args: unknown[]) => boolean;
}

const NO_PERMISSION = () =>
    new DriveError('The user does not have sufficient permissions for this file.', 403, 'insufficientFilePermissions');

export class FakeDriveStore {
    readonly nodes = new Map<string, FakeNode>();
    readonly calls: Array<{ user: string; op: Op; args: unknown[] }> = [];
    /** My Drive rule: only the owner may trash. Set to false to model a shared drive. */
    ownerOnlyTrash = true;
    private seq = 0;
    private clockMs = Date.UTC(2026, 9, 15, 12, 0, 0);
    private failures: Failure[] = [];
    private lostResponses: Failure[] = [];

    now(): number {
        return this.clockMs;
    }

    advance(ms: number): void {
        this.clockMs += ms;
    }

    /** Every mutation moves the clock by 1 ms so createdTime order is deterministic. */
    tick(): number {
        this.clockMs += 1;
        return this.clockMs;
    }

    newId(): string {
        this.seq += 1;
        return `fake-${this.seq}`;
    }

    addNode(fields: Pick<FakeNode, 'name' | 'mimeType' | 'parentId' | 'ownerEmail'> & Partial<FakeNode>): FakeNode {
        const t = this.tick();
        const node: FakeNode = {
            id: this.newId(), content: new Uint8Array(), createdTime: t, modifiedTime: t, trashed: false,
            revisions: 1, appProperties: {}, writersCanShare: true, ...fields,
        };
        this.nodes.set(node.id, node);
        return node;
    }

    createRoot(name: string, ownerEmail: string): string {
        return this.addNode({ name, mimeType: FOLDER_MIME, parentId: null, ownerEmail }).id;
    }

    as(email: string): DriveApi {
        return new FakeDriveView(this, email);
    }

    /** The next `count` calls of `op` (optionally only those matching `when`) throw `error()`. */
    failNext(op: Op, count: number, error: () => Error, when?: (args: unknown[]) => boolean): void {
        this.failures.push({ op, remaining: count, error, when });
    }

    /** The next `count` calls of `op` succeed on "Drive" but their answer is lost: the caller gets a 500. */
    loseNextResponse(op: Op, count: number, when?: (args: unknown[]) => boolean): void {
        this.lostResponses.push({ op, remaining: count, error: () => new DriveError('Internal Error', 500, 'internalError'), when });
    }

    maybeLose(op: Op, args: unknown[]): void {
        const lost = this.lostResponses.find((f) => f.op === op && f.remaining > 0 && (!f.when || f.when(args)));
        if (!lost) return;
        lost.remaining -= 1;
        throw lost.error();
    }

    maybeFail(op: Op, args: unknown[]): void {
        const failure = this.failures.find((f) => f.op === op && f.remaining > 0 && (!f.when || f.when(args)));
        if (!failure) return;
        failure.remaining -= 1;
        throw failure.error();
    }

    node(id: string): FakeNode {
        const node = this.nodes.get(id);
        if (!node) throw new DriveError(`File not found: ${id}`, 404, 'notFound');
        return node;
    }

    children(folderId: string): FakeNode[] {
        return [...this.nodes.values()]
            .filter((n) => n.parentId === folderId && !n.trashed)
            .sort((a, b) => a.createdTime - b.createdTime);
    }

    /** Follows a relative path ("world/region/r.0.0.mca") from a folder; first non-trashed match per name. */
    findPath(rootId: string, relPath: string): FakeNode | undefined {
        let current: FakeNode | undefined = this.nodes.get(rootId);
        for (const part of relPath.split('/').filter(Boolean)) {
            if (!current) return undefined;
            current = this.children(current.id).find((n) => n.name === part);
        }
        return current;
    }

    text(id: string): string {
        return Buffer.from(this.node(id).content).toString('utf8');
    }
}

/** Drive's limit: 124 bytes per property, key and value together (403 propertyLengthLimitExceeded). */
function checkPropertyLength(props: Record<string, string> | undefined): void {
    for (const [key, value] of Object.entries(props ?? {})) {
        if (Buffer.byteLength(key + value, 'utf8') > 124) {
            throw new DriveError('The property exceeds the maximum length.', 403, 'propertyLengthLimitExceeded');
        }
    }
}

export function md5Hex(data: Uint8Array): string {
    return createHash('md5').update(data).digest('hex');
}

class FakeDriveView implements DriveApi {
    constructor(private readonly store: FakeDriveStore, private readonly user: string) {}

    private enter(op: Op, args: unknown[]): void {
        this.store.calls.push({ user: this.user, op, args });
        this.store.maybeFail(op, args);
    }

    private meta(node: FakeNode): DriveFileMeta {
        const isFolder = node.mimeType === FOLDER_MIME;
        const isOwner = node.ownerEmail === this.user;
        return {
            id: node.id,
            name: node.name,
            mimeType: node.mimeType,
            size: isFolder ? undefined : node.content.length,
            md5Checksum: isFolder ? undefined : md5Hex(node.content),
            createdTime: new Date(node.createdTime).toISOString(),
            modifiedTime: new Date(node.modifiedTime).toISOString(),
            trashed: node.trashed,
            ownedByMe: isOwner,
            owners: [{ emailAddress: node.ownerEmail, displayName: node.ownerEmail.split('@')[0], me: isOwner }],
            capabilities: {
                canTrash: isOwner || !this.store.ownerOnlyTrash,
                canDelete: isOwner,
                canModifyContent: !isFolder,
                canRename: true,
                canAddChildren: isFolder,
                canMoveItemWithinDrive: isOwner || node.writersCanShare,
                canRemoveMyDriveParent: isOwner || node.writersCanShare,
            },
            parents: node.parentId ? [node.parentId] : [],
            appProperties: { ...node.appProperties },
        };
    }

    private folder(id: string): FakeNode {
        const node = this.store.node(id);
        if (node.mimeType !== FOLDER_MIME || node.trashed) throw new DriveError(`Not a folder: ${id}`, 404, 'notFound');
        return node;
    }

    private async bytes(source: UploadSource): Promise<Uint8Array> {
        return source.kind === 'bytes' ? source.data : new Uint8Array(await readFile(source.path));
    }

    async getMeta(fileId: string): Promise<MetaWithClock> {
        this.enter('getMeta', [fileId]);
        return { ...this.meta(this.store.node(fileId)), serverNow: this.store.now() };
    }

    async listChildren(folderId: string, filter?: { name?: string; foldersOnly?: boolean }): Promise<DriveFileMeta[]> {
        this.enter('listChildren', [folderId, filter]);
        this.folder(folderId);
        return this.store.children(folderId)
            .filter((n) => filter?.name === undefined || n.name === filter.name)
            .filter((n) => !filter?.foldersOnly || n.mimeType === FOLDER_MIME)
            .map((n) => this.meta(n));
    }

    async createFolder(name: string, parentId: string, _opts?: TransferOptions, appProperties?: Record<string, string>): Promise<DriveFileMeta> {
        this.enter('createFolder', [name, parentId, appProperties]);
        this.folder(parentId);
        checkPropertyLength(appProperties);
        const node = this.store.addNode({ name, mimeType: FOLDER_MIME, parentId, ownerEmail: this.user, appProperties: { ...appProperties } });
        this.store.maybeLose('createFolder', [name, parentId, appProperties]);
        return this.meta(node);
    }

    async createFile(
        name: string, parentId: string, source: UploadSource, opts?: TransferOptions, appProperties?: Record<string, string>,
    ): Promise<UploadResult> {
        this.enter('createFile', [name, parentId, source, appProperties]);
        this.folder(parentId);
        checkPropertyLength(appProperties);
        const content = await this.bytes(source);
        const node = this.store.addNode({
            name, mimeType: 'application/octet-stream', parentId, ownerEmail: this.user, content,
            appProperties: { ...appProperties },
        });
        this.store.maybeLose('createFile', [name, parentId, source, appProperties]);
        opts?.onProgress?.(content.length);
        return { id: node.id, md5Checksum: md5Hex(content), size: content.length };
    }

    async updateContent(fileId: string, source: UploadSource, opts?: TransferOptions): Promise<UploadResult> {
        this.enter('updateContent', [fileId, source]);
        const node = this.store.node(fileId);
        if (node.mimeType === FOLDER_MIME) throw new DriveError('Folders have no content', 400, 'badRequest');
        const content = await this.bytes(source);
        node.content = content;
        node.modifiedTime = this.store.tick();
        node.revisions += 1;
        opts?.onProgress?.(content.length);
        return { id: node.id, md5Checksum: md5Hex(content), size: content.length };
    }

    async download(fileId: string, destPath: string, opts?: TransferOptions): Promise<DownloadResult> {
        this.enter('download', [fileId, destPath]);
        const node = this.store.node(fileId);
        await mkdir(path.dirname(destPath), { recursive: true });
        await writeFile(destPath, node.content);
        opts?.onProgress?.(node.content.length);
        return { md5: md5Hex(node.content), size: node.content.length };
    }

    async readText(fileId: string): Promise<string> {
        this.enter('readText', [fileId]);
        return Buffer.from(this.store.node(fileId).content).toString('utf8');
    }

    async trash(fileId: string): Promise<void> {
        this.enter('trash', [fileId]);
        const node = this.store.node(fileId);
        if (this.store.ownerOnlyTrash && node.ownerEmail !== this.user) throw NO_PERMISSION();
        node.trashed = true;
        node.modifiedTime = this.store.tick();
    }

    async deleteForever(fileId: string): Promise<void> {
        this.enter('deleteForever', [fileId]);
        const node = this.store.node(fileId);
        if (node.ownerEmail !== this.user) throw NO_PERMISSION();
        this.store.nodes.delete(fileId);
    }

    async rename(fileId: string, name: string): Promise<void> {
        this.enter('rename', [fileId, name]);
        const node = this.store.node(fileId);
        node.name = name;
        node.modifiedTime = this.store.tick();
    }

    async markDeleted(
        fileId: string, appProperties: Record<string, string>, moveTo?: { addParent: string; removeParent: string },
    ): Promise<void> {
        this.enter('markDeleted', [fileId, appProperties, moveTo]);
        const node = this.store.node(fileId);
        if (node.mimeType === FOLDER_MIME) throw new DriveError('Folders have no content', 400, 'badRequest');
        if (moveTo) {
            if (node.ownerEmail !== this.user && !node.writersCanShare) throw NO_PERMISSION();
            if (node.parentId !== moveTo.removeParent) throw new DriveError('Parent mismatch', 400, 'badRequest');
            this.folder(moveTo.addParent);
            node.parentId = moveTo.addParent;
        }
        node.content = new Uint8Array();
        node.appProperties = { ...node.appProperties, ...appProperties };
        node.modifiedTime = this.store.tick();
        node.revisions += 1;
    }

    async listMyTagged(serverId: string): Promise<DriveFileMeta[]> {
        this.enter('listMyTagged', [serverId]);
        return [...this.store.nodes.values()]
            .filter((n) => !n.trashed && n.ownerEmail === this.user && n.appProperties.mdhServer === serverId)
            .sort((a, b) => a.createdTime - b.createdTime)
            .map((n) => this.meta(n));
    }

    async listTagged(serverId: string): Promise<DriveFileMeta[]> {
        this.enter('listTagged', [serverId]);
        return [...this.store.nodes.values()]
            .filter((n) => !n.trashed && n.appProperties.mdhServer === serverId)
            .sort((a, b) => a.createdTime - b.createdTime)
            .map((n) => this.meta(n));
    }

    async listTombstones(filter: { mineOnly: boolean; serverId?: string }): Promise<DriveFileMeta[]> {
        this.enter('listTombstones', [filter]);
        return [...this.store.nodes.values()]
            .filter((n) => !n.trashed && n.appProperties.mdhTombstone === '1')
            .filter((n) => !filter.mineOnly || n.ownerEmail === this.user)
            .filter((n) => filter.serverId === undefined || n.appProperties.mdhServer === filter.serverId)
            .sort((a, b) => a.createdTime - b.createdTime)
            .map((n) => this.meta(n));
    }
}
