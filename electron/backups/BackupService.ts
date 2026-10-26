// World backups: zip files of a server's world folders (world, world_nether, world_the_end, or the level-name of
// server.properties). Backups made on this PC are kept in the server folder's mcs-relay-backups/, which a builtin rule
// leaves out of the sync. Uploaded ones are kept in the server's .launcher/backups/ on Google Drive, where every member
// sees them; they use the uploader's Drive storage. The same backup has the same file name in both places.
//
// Restoring only changes the world in this PC's folder; it becomes the shared world when this PC next hosts or
// uploads its changes, like any other change made here. Before restoring, the current world is backed up.
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { APP_PROPS } from '../../shared/types';
import type { BackupInfo, BackupList, BackupProgress, UserInfo } from '../../shared/types';
import type { DriveFiles } from '../drive/DriveFiles';
import type { DriveFileMeta } from '../drive/types';
import { AppError, toAppError } from '../errors';
import type { SettingsService } from '../settings/SettingsService';
import type { LauncherFiles } from '../sync/launcherFiles';

export const BACKUPS_FOLDER = 'mcs-relay-backups';
/** The automatic backup, inside BACKUPS_FOLDER: a plain copy of the world folders, so a new run copies only what
 *  changed. Its description sits beside the copies. */
const AUTO_FOLDER = 'auto';
const AUTO_META = 'mcs-relay-auto.json';
const META_FILE = 'mcs-relay-backup.json';
const FILE_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2}) ([^\\/]+)\.zip$/;
const MAX_NAME = 40;
/** Region and entity files are compressed by Minecraft already: zipping them again only costs time. */
const STORED_RE = /\.(mca|mcc)$/i;
const PROGRESS_MS = 250;

interface BackupMeta {
    format: 1;
    name: string;
    createdAt: string;
    worlds: string[];
    by: string;
    app: string;
}

interface WorldFile {
    abs: string;
    rel: string;
    size: number;
    mtime: Date;
}

export interface BackupDeps {
    settings: Pick<SettingsService, 'getServer'>;
    drive: Pick<DriveFiles, 'listChildren' | 'createFile' | 'download' | 'trash'>;
    launcher: Pick<LauncherFiles, 'findSubfolder' | 'ensureSubfolder'>;
    session: {
        /** While this PC hosts the server: holds its saves until the returned function is called. */
        pauseSavingFor(serverId: string): Promise<(() => void) | null>;
        isBusy(): boolean;
    };
    hasUnfinishedUpload: (serverId: string) => boolean;
    me: () => Promise<UserInfo>;
    emit: (progress: BackupProgress | null) => void;
    appVersion: string;
    now?: () => Date;
}

/** "Before the end fight" stays; characters Windows refuses in file names are replaced. */
export function cleanBackupName(raw: string): string {
    // eslint-disable-next-line no-control-regex
    const name = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
    return name.slice(0, MAX_NAME).trim() || 'Backup';
}

/** "2026-10-24_18-30-05 Before the end fight.zip" -> its name and time; null for any other file. */
export function parseBackupFileName(fileName: string): { name: string; createdAt: Date } | null {
    const m = FILE_NAME_RE.exec(fileName);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, name] = m;
    return { name, createdAt: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) };
}

function backupFileName(name: string, at: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())} ${name}.zip`;
}

/** The world folders of a server folder that exist: level-name from server.properties (default "world") and the
 *  _nether and _the_end folders Paper and Spigot keep beside it. */
export async function findWorlds(root: string): Promise<string[]> {
    let level = 'world';
    try {
        const props = await fs.readFile(path.join(root, 'server.properties'), 'utf8');
        const m = /^[ \t]*level-name[ \t]*[=:][ \t]*(.*?)[ \t]*\r?$/m.exec(props);
        if (m && m[1] && isSafeFolderName(m[1])) level = m[1];
    } catch {
        // no server.properties yet: the default name
    }
    const worlds: string[] = [];
    for (const name of [level, `${level}_nether`, `${level}_the_end`]) {
        if ((await fs.stat(path.join(root, name)).catch(() => null))?.isDirectory()) worlds.push(name);
    }
    return worlds;
}

function isSafeFolderName(name: string): boolean {
    return name !== '' && name !== '.' && name !== '..' && !/[\\/:*?"<>|]/.test(name) && name !== BACKUPS_FOLDER && name !== '.launcher';
}

async function walk(root: string, rel: string, out: WorldFile[]): Promise<void> {
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
            await walk(root, childRel, out);
        } else if (entry.isFile() && entry.name !== 'session.lock') {   // held open by a running server
            const abs = path.join(root, childRel);
            const stat = await fs.stat(abs);
            out.push({ abs, rel: childRel, size: stat.size, mtime: stat.mtime });
        }
    }
}

/** Makes `dest` hold the same files as `src`: copies what is new or changed (size or modification time), deletes what
 *  is no longer there. Returns how many files were copied and the bytes the copy holds. */
async function mirror(src: string, dest: string): Promise<{ copied: number; bytes: number }> {
    await fs.mkdir(dest, { recursive: true });
    const wanted = new Set<string>();
    let copied = 0;
    let bytes = 0;
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            wanted.add(entry.name);
            const inner = await mirror(from, to);
            copied += inner.copied;
            bytes += inner.bytes;
        } else if (entry.isFile() && entry.name !== 'session.lock') {
            wanted.add(entry.name);
            const [a, b] = await Promise.all([fs.stat(from), fs.stat(to).catch(() => null)]);
            bytes += a.size;
            if (b?.isFile() && b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 2) continue;
            await fs.copyFile(from, to);
            await fs.utimes(to, a.atime, a.mtime);
            copied++;
        }
    }
    for (const entry of await fs.readdir(dest, { withFileTypes: true })) {
        if (!wanted.has(entry.name)) await fs.rm(path.join(dest, entry.name), { recursive: true, force: true });
    }
    return { copied, bytes };
}

/** The backup's description and the bytes its world files hold, without unpacking anything. */
async function inspectZip(file: string): Promise<{ meta: BackupMeta; total: number }> {
    const damaged = (err: unknown) => new AppError('INVALID', 'The backup file is damaged and cannot be read.', err instanceof Error ? err.message : String(err));
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, opened) => (err || !opened ? reject(damaged(err)) : resolve(opened)));
    });
    try {
        let metaText: string | null = null;
        let total = 0;
        await new Promise<void>((resolve, reject) => {
            zip.on('error', reject);
            zip.on('end', () => resolve());
            zip.on('entry', (entry: yauzl.Entry) => {
                if (entry.fileName !== META_FILE) {
                    total += entry.uncompressedSize;
                    zip.readEntry();
                    return;
                }
                zip.openReadStream(entry, (err, stream) => {
                    if (err || !stream) {
                        reject(err);
                        return;
                    }
                    const chunks: Buffer[] = [];
                    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
                    stream.on('error', reject);
                    stream.on('end', () => {
                        metaText = Buffer.concat(chunks).toString('utf8');
                        zip.readEntry();
                    });
                });
            });
            zip.readEntry();
        });
        const meta = parseMeta(metaText);
        if (!meta) throw new AppError('INVALID', 'This file is not an MCS-Relay backup.');
        return { meta, total };
    } catch (err) {
        throw err instanceof AppError ? err : damaged(err);
    } finally {
        zip.close();
    }
}

async function readAutoMeta(folder: string): Promise<{ at: string; worlds: string[]; bytes: number } | null> {
    try {
        const raw = JSON.parse(await fs.readFile(path.join(folder, AUTO_META), 'utf8')) as { at?: unknown; worlds?: unknown; bytes?: unknown };
        if (typeof raw.at !== 'string' || !Array.isArray(raw.worlds) || !raw.worlds.every((w) => typeof w === 'string' && isSafeFolderName(w))) return null;
        return { at: raw.at, worlds: raw.worlds as string[], bytes: typeof raw.bytes === 'number' ? raw.bytes : 0 };
    } catch {
        return null;
    }
}

function parseMeta(text: string | null): BackupMeta | null {
    if (!text) return null;
    try {
        const raw = JSON.parse(text) as Partial<BackupMeta>;
        if (raw.format !== 1 || !Array.isArray(raw.worlds) || raw.worlds.length === 0) return null;
        if (!raw.worlds.every((w) => typeof w === 'string' && isSafeFolderName(w))) return null;
        return {
            format: 1, worlds: raw.worlds, name: typeof raw.name === 'string' ? raw.name : 'Backup',
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '', by: typeof raw.by === 'string' ? raw.by : '',
            app: typeof raw.app === 'string' ? raw.app : '',
        };
    } catch {
        return null;
    }
}

/** Unpacks the files of `worlds` into root; anything else in the zip is skipped (yauzl refuses ".." and absolute paths). */
function extract(file: string, root: string, worlds: Set<string>, onBytes: (done: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true }, (openErr, zip) => {
            if (openErr || !zip) {
                reject(openErr);
                return;
            }
            let done = 0;
            zip.on('error', reject);
            zip.on('end', () => resolve());
            zip.on('entry', (entry: yauzl.Entry) => {
                const name = entry.fileName;
                if (!worlds.has(name.split('/')[0])) {
                    zip.readEntry();
                    return;
                }
                const target = path.join(root, ...name.split('/').filter(Boolean));
                if (name.endsWith('/')) {
                    fs.mkdir(target, { recursive: true }).then(() => zip.readEntry(), reject);
                    return;
                }
                zip.openReadStream(entry, (err, stream) => {
                    if (err || !stream) {
                        reject(err);
                        return;
                    }
                    fs.mkdir(path.dirname(target), { recursive: true })
                        .then(() => pipeline(stream, createWriteStream(target)))
                        .then(() => {
                            done += entry.uncompressedSize;
                            onBytes(done);
                            zip.readEntry();
                        }, reject);
                });
            });
            zip.readEntry();
        });
    });
}

export class BackupService {
    private running: Promise<unknown> | null = null;
    private readonly now: () => Date;

    constructor(private readonly d: BackupDeps) {
        this.now = d.now ?? (() => new Date());
    }

    isBusy(): boolean {
        return this.running !== null;
    }

    /** Resolves once no backup task runs (quitting waits for one: a restore cut short leaves half a world). */
    async whenIdle(): Promise<void> {
        while (this.running) await this.running.catch(() => undefined);
    }

    async list(serverId: string): Promise<BackupList> {
        const byName = new Map<string, BackupInfo>();
        const root = this.d.settings.getServer(serverId).localPath;
        if (root) {
            const names = await fs.readdir(path.join(root, BACKUPS_FOLDER)).catch(() => [] as string[]);
            for (const fileName of names) {
                const parsed = parseBackupFileName(fileName);
                if (!parsed) continue;
                const stat = await fs.stat(path.join(root, BACKUPS_FOLDER, fileName)).catch(() => null);
                if (!stat?.isFile()) continue;
                byName.set(fileName, { fileName, name: parsed.name, createdAt: parsed.createdAt.toISOString(), size: stat.size, local: true, cloud: null });
            }
        }
        let cloudError: string | null = null;
        try {
            for (const meta of await this.cloudFiles(serverId)) {
                const parsed = parseBackupFileName(meta.name);
                if (!parsed) continue;
                const owner = meta.owners?.[0];
                const cloud = {
                    id: meta.id,
                    by: owner?.me ? 'you' : owner?.displayName || owner?.emailAddress || 'a member',
                    canDelete: meta.capabilities?.canTrash ?? meta.ownedByMe ?? false,
                };
                const known = byName.get(meta.name);
                if (known) {
                    known.cloud = cloud;
                } else {
                    const at = meta.appProperties?.[APP_PROPS.backupAt] ?? parsed.createdAt.toISOString();
                    byName.set(meta.name, { fileName: meta.name, name: parsed.name, createdAt: at, size: meta.size ?? 0, local: false, cloud });
                }
            }
        } catch (err) {
            cloudError = toAppError(err).message;
            console.warn(`[backups] cannot list the cloud backups of ${serverId}:`, err);
        }
        const backups = [...byName.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.fileName.localeCompare(a.fileName));
        return { backups, cloudError, auto: root ? await this.autoInfo(root) : null };
    }

    /** Backs up the world in this PC's folder; with `upload`, also puts it in the cloud. */
    create(serverId: string, rawName: string, upload: boolean): Promise<BackupInfo> {
        return this.exclusive(async () => {
            const root = this.folderOf(serverId);
            const worlds = await findWorlds(root);
            if (worlds.length === 0) throw new AppError('INVALID', 'There is no world in this server folder yet. Start the server once to make one.');
            this.progress(serverId, 'saving', 0, 0, true);
            const resume = await this.d.session.pauseSavingFor(serverId);
            let info: BackupInfo;
            try {
                info = await this.pack(serverId, root, worlds, cleanBackupName(rawName));
            } finally {
                resume?.();
            }
            return upload ? this.uploadFile(serverId, root, info) : info;
        });
    }

    upload(serverId: string, fileName: string): Promise<BackupInfo> {
        return this.exclusive(async () => {
            const root = this.folderOf(serverId);
            const parsed = this.requireName(fileName);
            const stat = await fs.stat(path.join(root, BACKUPS_FOLDER, fileName)).catch(() => null);
            if (!stat) throw new AppError('NOT_FOUND', 'That backup is not on this PC anymore.');
            const info: BackupInfo = { fileName, name: parsed.name, createdAt: parsed.createdAt.toISOString(), size: stat.size, local: true, cloud: null };
            return this.uploadFile(serverId, root, info);
        });
    }

    download(serverId: string, cloudId: string): Promise<void> {
        return this.exclusive(async () => {
            const root = this.folderOf(serverId);
            const meta = (await this.cloudFiles(serverId)).find((f) => f.id === cloudId);
            if (!meta) throw new AppError('NOT_FOUND', 'That backup is not in the cloud anymore.');
            this.requireName(meta.name);
            const target = path.join(root, BACKUPS_FOLDER, meta.name);
            const part = `${target}.part`;
            await fs.mkdir(path.dirname(target), { recursive: true });
            const total = meta.size ?? 0;
            this.progress(serverId, 'downloading', 0, total, true);
            try {
                const result = await this.d.drive.download(cloudId, part, { onProgress: (done) => this.progress(serverId, 'downloading', done, total) });
                if (meta.md5Checksum && result.md5 !== meta.md5Checksum) {
                    throw new AppError('CHECKSUM', 'The downloaded backup does not match the one in the cloud. Try again.');
                }
                await fs.rename(part, target);
            } catch (err) {
                await fs.rm(part, { force: true });
                throw err;
            }
            console.log(`[backups] downloaded ${meta.name} for ${serverId}`);
        });
    }

    /** Replaces the world in this PC's folder with the backup, after backing up the current one. */
    restore(serverId: string, fileName: string): Promise<void> {
        return this.exclusive(async () => {
            const root = this.folderOf(serverId);
            this.requireName(fileName);
            if (this.d.session.isBusy()) throw new AppError('BUSY', 'Stop the server first: a world cannot be restored while it is in use.');
            if (this.d.hasUnfinishedUpload(serverId)) {
                throw new AppError('UNFINISHED_UPLOAD', 'This server has an unfinished upload. Let it finish before restoring a backup.');
            }
            const file = path.join(root, BACKUPS_FOLDER, fileName);
            if (!(await fs.stat(file).catch(() => null))) throw new AppError('NOT_FOUND', 'That backup is not on this PC. Download it first.');
            const { meta, total } = await inspectZip(file);

            const current = await findWorlds(root);
            if (current.length > 0) await this.pack(serverId, root, current, cleanBackupName(`Before restoring ${meta.name}`));

            this.progress(serverId, 'restoring', 0, total, true);
            for (const world of meta.worlds) await fs.rm(path.join(root, world), { recursive: true, force: true });
            await extract(file, root, new Set(meta.worlds), (done) => this.progress(serverId, 'restoring', done, total));
            console.log(`[backups] restored ${fileName} into ${serverId} (${meta.worlds.join(', ')})`);
        });
    }

    /** The automatic backup, while this PC hosts: the one copy is brought up to date (only changed files are copied),
     *  with the server's saving paused meanwhile. Skipped while another backup task runs. */
    autoBackup(serverId: string): Promise<void> {
        return this.exclusive(async () => {
            const root = this.folderOf(serverId);
            const worlds = await findWorlds(root);
            if (worlds.length === 0) return;
            const auto = path.join(root, BACKUPS_FOLDER, AUTO_FOLDER);
            const resume = await this.d.session.pauseSavingFor(serverId);
            let copied = 0;
            let bytes = 0;
            try {
                for (const world of worlds) {
                    const result = await mirror(path.join(root, world), path.join(auto, world));
                    copied += result.copied;
                    bytes += result.bytes;
                }
            } finally {
                resume?.();
            }
            for (const entry of await fs.readdir(auto, { withFileTypes: true })) {
                if (entry.isDirectory() && !worlds.includes(entry.name)) await fs.rm(path.join(auto, entry.name), { recursive: true, force: true });
            }
            await fs.writeFile(path.join(auto, AUTO_META), JSON.stringify({ at: this.now().toISOString(), worlds, bytes }, null, 2));
            console.log(`[backups] automatic backup of ${serverId}: ${copied} files copied, ${bytes} bytes in all`);
        });
    }

    /** Replaces the world in this PC's folder with the automatic backup, after backing up the current one. */
    restoreAuto(serverId: string): Promise<void> {
        return this.exclusive(async () => {
            const root = this.folderOf(serverId);
            if (this.d.session.isBusy()) throw new AppError('BUSY', 'Stop the server first: a world cannot be restored while it is in use.');
            if (this.d.hasUnfinishedUpload(serverId)) {
                throw new AppError('UNFINISHED_UPLOAD', 'This server has an unfinished upload. Let it finish before restoring a backup.');
            }
            const auto = path.join(root, BACKUPS_FOLDER, AUTO_FOLDER);
            const meta = await readAutoMeta(auto);
            if (!meta) throw new AppError('NOT_FOUND', 'There is no automatic backup of this server on this PC yet.');
            const current = await findWorlds(root);
            if (current.length > 0) await this.pack(serverId, root, current, 'Before restoring the automatic backup');
            this.progress(serverId, 'restoring', 0, meta.bytes, true);
            for (const world of meta.worlds) {
                await fs.rm(path.join(root, world), { recursive: true, force: true });
                await fs.cp(path.join(auto, world), path.join(root, world), { recursive: true, preserveTimestamps: true });
            }
            console.log(`[backups] restored the automatic backup of ${serverId} from ${meta.at}`);
        });
    }

    private async autoInfo(root: string): Promise<{ at: string; size: number } | null> {
        const meta = await readAutoMeta(path.join(root, BACKUPS_FOLDER, AUTO_FOLDER));
        return meta ? { at: meta.at, size: meta.bytes } : null;
    }

    deleteLocal(serverId: string, fileName: string): Promise<void> {
        return this.exclusive(async () => {
            const root = this.folderOf(serverId);
            this.requireName(fileName);
            await fs.rm(path.join(root, BACKUPS_FOLDER, fileName), { force: true });
        });
    }

    deleteCloud(serverId: string, cloudId: string): Promise<void> {
        return this.exclusive(async () => {
            const meta = (await this.cloudFiles(serverId)).find((f) => f.id === cloudId);
            if (!meta) return;
            await this.d.drive.trash(cloudId);
        });
    }

    /** The folder the backups made on this PC are kept in (created when missing). */
    async localFolder(serverId: string): Promise<string> {
        const folder = path.join(this.folderOf(serverId), BACKUPS_FOLDER);
        await fs.mkdir(folder, { recursive: true });
        return folder;
    }

    /* -------------------------------------------------------------- internals */

    private async pack(serverId: string, root: string, worlds: string[], name: string): Promise<BackupInfo> {
        const files: WorldFile[] = [];
        for (const world of worlds) await walk(root, world, files);
        const total = files.reduce((sum, f) => sum + f.size, 0);
        const createdAt = this.now();
        // Two backups with one name in the same second (a double click) would otherwise share a file.
        let fileName = backupFileName(name, createdAt);
        for (let n = 2; await fs.stat(path.join(root, BACKUPS_FOLDER, fileName)).catch(() => null); n++) {
            name = `${name.replace(/ \(\d+\)$/, '')} (${n})`;
            fileName = backupFileName(name, createdAt);
        }
        const target = path.join(root, BACKUPS_FOLDER, fileName);
        const part = `${target}.part`;
        await fs.mkdir(path.dirname(target), { recursive: true });

        const me = await this.d.me().catch(() => null);
        const meta: BackupMeta = { format: 1, name, createdAt: createdAt.toISOString(), worlds, by: me?.name ?? '', app: this.d.appVersion };
        const zip = new yazl.ZipFile();
        zip.addBuffer(Buffer.from(JSON.stringify(meta, null, 2)), META_FILE, { mtime: createdAt });
        for (const file of files) zip.addFile(file.abs, file.rel, { compress: !STORED_RE.test(file.rel), mtime: file.mtime });
        zip.end();

        let written = 0;
        this.progress(serverId, 'packing', 0, total, true);
        const meter = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
                written += chunk.length;
                this.progress(serverId, 'packing', Math.min(written, total), total);
                callback(null, chunk);
            },
        });
        try {
            await pipeline(zip.outputStream, meter, createWriteStream(part));
            await fs.rename(part, target);
        } catch (err) {
            await fs.rm(part, { force: true });
            throw new AppError('INVALID', 'The backup could not be written.', err instanceof Error ? err.message : String(err));
        }
        const size = (await fs.stat(target)).size;
        console.log(`[backups] made ${fileName} of ${serverId}: ${files.length} files, ${worlds.join(', ')}, ${size} bytes`);
        return { fileName, name, createdAt: createdAt.toISOString(), size, local: true, cloud: null };
    }

    private async uploadFile(serverId: string, root: string, info: BackupInfo): Promise<BackupInfo> {
        const folder = await this.d.launcher.ensureSubfolder(serverId, 'backups');
        const existing = await this.d.drive.listChildren(folder, { name: info.fileName });
        if (existing.length > 0) return { ...info, cloud: { id: existing[0].id, by: 'you', canDelete: true } };
        this.progress(serverId, 'uploading', 0, info.size, true);
        const result = await this.d.drive.createFile(
            info.fileName, folder, { kind: 'file', path: path.join(root, BACKUPS_FOLDER, info.fileName), size: info.size },
            { onProgress: (done) => this.progress(serverId, 'uploading', done, info.size) },
            { [APP_PROPS.backupAt]: info.createdAt },
        );
        console.log(`[backups] uploaded ${info.fileName} of ${serverId}`);
        return { ...info, cloud: { id: result.id, by: 'you', canDelete: true } };
    }

    private async cloudFiles(serverId: string): Promise<DriveFileMeta[]> {
        const folder = await this.d.launcher.findSubfolder(serverId, 'backups');
        return folder ? this.d.drive.listChildren(folder) : [];
    }

    private folderOf(serverId: string): string {
        const root = this.d.settings.getServer(serverId).localPath;
        if (!root) throw new AppError('NO_LOCAL_PATH', 'Choose a folder on this PC for this server first.');
        return root;
    }

    private requireName(fileName: string): { name: string; createdAt: Date } {
        const parsed = typeof fileName === 'string' ? parseBackupFileName(fileName) : null;
        if (!parsed) throw new AppError('INVALID', 'That is not a backup made by MCS-Relay.');
        return parsed;
    }

    private lastProgress = 0;

    /** Progress for the window, at most every PROGRESS_MS unless `force`. */
    private progress(serverId: string, action: BackupProgress['action'], done: number, total: number, force = false): void {
        const at = Date.now();
        if (!force && at - this.lastProgress < PROGRESS_MS) return;
        this.lastProgress = at;
        this.d.emit({ serverId, action, done, total });
    }

    /** One backup task at a time; the window hears when it ends. */
    private async exclusive<T>(task: () => Promise<T>): Promise<T> {
        if (this.running) throw new AppError('BUSY', 'Another backup task is still running.');
        const run = task();
        this.running = run;
        try {
            return await run;
        } finally {
            this.running = null;
            this.d.emit(null);
        }
    }
}
