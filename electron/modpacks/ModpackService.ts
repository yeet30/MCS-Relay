// Modpacks for a new server. From Modrinth (api.modrinth.com: open, no key; it asks only for a User-Agent that says
// who is calling): search, a pack's versions, and installing one into the server's folder. A Modrinth pack is a
// ".mrpack" (https://support.modrinth.com/en/articles/8802351): a zip with modrinth.index.json, which lists the files
// to download with their hashes and whether the server needs each one, the Minecraft version and the mod loader, plus
// "overrides" and "server-overrides" folders copied on top. Installing one:
//   1. download the .mrpack, checked with the sha1 Modrinth gives;
//   2. install the loader the pack names, at its version (ServerInstaller: Fabric, Forge or NeoForge; Quilt is not
//      supported yet);
//   3. download every file the server needs (env.server not "unsupported"), only from the hosts Modrinth allows, each
//      checked with its sha512;
//   4. copy "overrides", then "server-overrides";
//   5. write mcs-relay-modpack.json, so every member sees which pack (and version) to install in their launcher.
// Every path is checked to stay inside the server folder, as the format asks (auto-mcs does the same:
// github.com/macarooni-man/auto-mcs, source/core/server/foundry.py).
// Packs from CurseForge come as a "server pack" zip the user downloaded from CurseForge's site: importZip unpacks one
// (and runs a Forge or NeoForge installer it contains). CurseForge's own API needs a key that may not be shared.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import yauzl from 'yauzl';
import type { InstallProgress, ModpackHit, ModpackInfo, ModpackInstallResult, ModpackSearch, ModpackVersion } from '../../shared/types';
import { AppError } from '../errors';
import type { FetchFn, ServerInstaller } from '../installer/ServerInstaller';
import type { SettingsService } from '../settings/SettingsService';

const API = 'https://api.modrinth.com/v2';
const PAGE = 20;
/** The loaders MCS-Relay installs, as Modrinth names them in a pack's dependencies and categories. */
const LOADERS = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge' } as const;
const PACK_LOADERS = ['fabric', 'forge', 'neoforge'];
/** Where a pack's files may be downloaded from (Modrinth's own list of hosts it allows). */
const FILE_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const DOWNLOADS_AT_ONCE = 6;
const PROGRESS_MS = 250;
export const MODPACK_FILE = 'mcs-relay-modpack.json';

interface ModrinthHit {
    project_id: string; slug: string; title: string; description: string; icon_url: string | null; downloads: number;
    author: string; categories: string[]; versions: string[];
}
interface ModrinthFile { url: string; filename: string; primary: boolean; size: number; hashes: { sha1?: string; sha512?: string } }
interface ModrinthVersion {
    id: string; project_id: string; name: string; version_number: string; game_versions: string[]; loaders: string[];
    version_type: 'release' | 'beta' | 'alpha'; date_published: string; files: ModrinthFile[];
}
interface PackIndex {
    formatVersion: number;
    game: string;
    name?: string;
    files: Array<{ path: string; hashes: { sha1?: string; sha512?: string }; env?: { server?: string }; downloads: string[]; fileSize?: number }>;
    dependencies: Record<string, string>;
}

export interface ModpackDeps {
    settings: Pick<SettingsService, 'getServer'>;
    installer: Pick<ServerInstaller, 'install' | 'runInstallerFile'>;
    emit: (progress: InstallProgress | null) => void;
    appVersion: string;
    fetchImpl?: FetchFn;
}

/** A path inside a pack, made safe: no absolute paths, no drive letters, no "..". null when it would leave the folder. */
export function packPath(raw: string): string | null {
    const p = raw.replace(/\\/g, '/');
    if (p.startsWith('/') || /^[a-z]:/i.test(p)) return null;
    const parts = p.split('/').filter((s) => s !== '' && s !== '.');
    if (parts.length === 0 || parts.some((s) => s === '..')) return null;
    return parts.join('/');
}

function openZip(file: string): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err || !zip ? reject(err ?? new Error('not a zip')) : resolve(zip)));
    });
}

/** Goes through a zip's entries; `each` returns where a file goes (null: skip) and gets its bytes written there. */
async function eachEntry(file: string, each: (name: string) => string | null | 'read', onRead?: (name: string, data: Buffer) => void): Promise<void> {
    const zip = await openZip(file).catch((err: unknown) => {
        throw new AppError('INVALID', 'The modpack file is damaged or is not a zip.', err instanceof Error ? err.message : String(err));
    });
    try {
        await new Promise<void>((resolve, reject) => {
            zip.on('error', reject);
            zip.on('end', () => resolve());
            zip.on('entry', (entry: yauzl.Entry) => {
                if (entry.fileName.endsWith('/')) {
                    zip.readEntry();
                    return;
                }
                const to = each(entry.fileName);
                if (to === null) {
                    zip.readEntry();
                    return;
                }
                zip.openReadStream(entry, (err, stream) => {
                    if (err || !stream) {
                        reject(err ?? new Error(`${entry.fileName} could not be read`));
                        return;
                    }
                    if (to === 'read') {
                        const chunks: Buffer[] = [];
                        stream.on('data', (c: Buffer) => chunks.push(c));
                        stream.on('error', reject);
                        stream.on('end', () => {
                            onRead?.(entry.fileName, Buffer.concat(chunks));
                            zip.readEntry();
                        });
                        return;
                    }
                    fs.mkdir(path.dirname(to), { recursive: true })
                        .then(() => pipeline(stream, createWriteStream(to)))
                        .then(() => zip.readEntry(), reject);
                });
            });
            zip.readEntry();
        });
    } finally {
        zip.close();
    }
}

export class ModpackService {
    private readonly fetchImpl: FetchFn;
    private running: string | null = null;
    private lastProgress = 0;

    constructor(private readonly d: ModpackDeps) {
        this.fetchImpl = d.fetchImpl ?? ((url, init) => fetch(url, init));
    }

    /** Modpacks that run on a server with a loader MCS-Relay installs, most relevant (or most downloaded) first. */
    async search(query: string, offset: number): Promise<ModpackSearch> {
        const facets = JSON.stringify([
            ['project_type:modpack'],
            ['server_side:required', 'server_side:optional'],
            PACK_LOADERS.map((l) => `categories:${l}`),
        ]);
        const params = new URLSearchParams({ query, facets, limit: String(PAGE), offset: String(offset), index: query.trim() ? 'relevance' : 'downloads' });
        const res = await this.json<{ hits: ModrinthHit[]; total_hits: number }>(`${API}/search?${params}`);
        return {
            total: res.total_hits,
            hits: res.hits.map((h): ModpackHit => ({
                id: h.project_id, slug: h.slug, title: h.title, description: h.description, iconUrl: h.icon_url,
                downloads: h.downloads, author: h.author,
                loaders: h.categories.filter((c) => PACK_LOADERS.includes(c)),
                gameVersions: h.versions,
            })),
        };
    }

    /** A pack's versions MCS-Relay can install, newest first. */
    async versions(projectId: string): Promise<ModpackVersion[]> {
        const list = await this.json<ModrinthVersion[]>(`${API}/project/${encodeURIComponent(projectId)}/version`);
        return list
            .filter((v) => v.loaders.some((l) => PACK_LOADERS.includes(l)) && v.files.some((f) => f.filename.endsWith('.mrpack')))
            .map((v) => ({
                id: v.id, name: v.name, versionNumber: v.version_number, gameVersions: v.game_versions,
                loaders: v.loaders.filter((l) => PACK_LOADERS.includes(l)), type: v.version_type, published: v.date_published,
                size: v.files.find((f) => f.primary)?.size ?? v.files[0]?.size ?? 0,
            }));
    }

    /** Installs a Modrinth pack version into the server's (new, empty) folder. */
    async install(serverId: string, versionId: string): Promise<ModpackInstallResult> {
        const folder = this.folder(serverId);
        if (this.running) throw new AppError('BUSY', 'A modpack is already being installed.');
        this.running = serverId;
        const packFile = path.join(folder, '.mcs-relay-modpack.mrpack');
        try {
            const version = await this.json<ModrinthVersion>(`${API}/version/${encodeURIComponent(versionId)}`);
            const project = await this.json<{ id: string; slug: string; title: string }>(`${API}/project/${encodeURIComponent(version.project_id)}`);
            const file = version.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) ?? version.files.find((f) => f.filename.endsWith('.mrpack'));
            if (!file) throw new AppError('NOT_FOUND', 'This version of the modpack has no Modrinth pack file.');
            console.log(`[modpack] ${serverId}: installing ${project.title} ${version.version_number}`);
            await this.download(serverId, file.url, packFile, file.hashes.sha1 ? { algorithm: 'sha1', value: file.hashes.sha1 } : null, file.size);

            let index: PackIndex | null = null;
            await eachEntry(packFile, (name) => (name === 'modrinth.index.json' ? 'read' : null), (_name, data) => {
                index = JSON.parse(data.toString('utf8')) as PackIndex;
            });
            const pack = index as PackIndex | null;
            if (!pack || pack.game !== 'minecraft' || !Array.isArray(pack.files)) throw new AppError('INVALID', 'This modpack file has no valid Modrinth index.');
            const mc = pack.dependencies?.minecraft;
            if (!mc) throw new AppError('INVALID', 'The modpack does not say which Minecraft version it is for.');
            if (pack.dependencies['quilt-loader']) throw new AppError('INVALID', 'This modpack runs on Quilt, which MCS-Relay cannot set up yet. Choose a Fabric, Forge or NeoForge pack.');
            const loaderKey = (Object.keys(LOADERS) as Array<keyof typeof LOADERS>).find((k) => pack.dependencies[k]);
            if (!loaderKey) throw new AppError('INVALID', 'The modpack does not name a mod loader MCS-Relay knows.');
            const loader = LOADERS[loaderKey];

            // The files first, so a problem with them shows before the loader's long install.
            const files = pack.files.filter((f) => f.env?.server !== 'unsupported').map((f) => {
                const rel = packPath(f.path);
                if (!rel) throw new AppError('INVALID', `The modpack wants to put a file outside the server folder (${f.path}), so it was not installed.`);
                const url = f.downloads?.find((u) => { try { return new URL(u).protocol === 'https:' && FILE_HOSTS.has(new URL(u).hostname); } catch { return false; } });
                if (!url) throw new AppError('INVALID', `The modpack wants to download ${rel} from a site Modrinth does not allow, so it was not installed.`);
                const hash = f.hashes?.sha512 ? { algorithm: 'sha512' as const, value: f.hashes.sha512 } : f.hashes?.sha1 ? { algorithm: 'sha1' as const, value: f.hashes.sha1 } : null;
                if (!hash) throw new AppError('INVALID', `The modpack gives no checksum for ${rel}.`);
                return { rel, url, hash, size: f.fileSize ?? 0 };
            });

            const installed = await this.d.installer.install(serverId, loader, mc, pack.dependencies[loaderKey]);
            await this.downloadAll(serverId, folder, files);
            for (const prefix of ['overrides/', 'server-overrides/']) {
                await eachEntry(packFile, (name) => {
                    if (!name.startsWith(prefix)) return null;
                    const rel = packPath(name.slice(prefix.length));
                    return rel ? path.join(folder, ...rel.split('/')) : null;
                });
            }
            const info: ModpackInfo = {
                source: 'modrinth', title: project.title, projectId: project.id, slug: project.slug, versionId: version.id,
                versionNumber: version.version_number, minecraft: mc, loader,
                url: `https://modrinth.com/modpack/${project.slug}/version/${version.id}`,
            };
            await fs.writeFile(path.join(folder, MODPACK_FILE), `${JSON.stringify(info, null, 2)}\n`);
            console.log(`[modpack] ${serverId}: ${project.title} ${version.version_number} installed (${files.length} files, ${loader} for ${mc})`);
            return { info, javaNeeded: installed.javaNeeded };
        } finally {
            await fs.rm(packFile, { force: true });
            await fs.rm(`${packFile}.part`, { force: true });
            this.running = null;
            this.d.emit(null);
        }
    }

    /** Unpacks a server pack zip (CurseForge's, say) into the server's new folder; a zip whose files all sit in one
     *  folder is unpacked without it. A Forge or NeoForge installer in it is run. */
    async importZip(serverId: string, zipPath: string): Promise<ModpackInstallResult> {
        const folder = this.folder(serverId);
        if (!/\.zip$/i.test(zipPath) || !existsSync(zipPath)) throw new AppError('INVALID', 'Choose a .zip file.');
        if (this.running) throw new AppError('BUSY', 'A modpack is already being installed.');
        this.running = serverId;
        try {
            const names: string[] = [];
            await eachEntry(zipPath, (name) => {
                names.push(name);
                return null;
            });
            const firsts = new Set(names.map((n) => n.replace(/\\/g, '/').split('/')[0]));
            const top = firsts.size === 1 && names.every((n) => n.replace(/\\/g, '/').includes('/')) ? `${[...firsts][0]}/` : '';
            let count = 0;
            this.d.emit({ serverId, done: 0, total: 0 });
            await eachEntry(zipPath, (name) => {
                const rel = packPath(name.replace(/\\/g, '/').slice(top.length));
                if (!rel) return null;
                count += 1;
                return path.join(folder, ...rel.split('/'));
            });
            console.log(`[modpack] ${serverId}: unpacked ${count} files from ${path.basename(zipPath)}`);
            const entries = await fs.readdir(folder);
            const installerJar = entries.find((n) => /^(forge|neoforge)-.+-installer\.jar$/i.test(n));
            const hasLibraries = entries.includes('libraries');
            let javaNeeded: number | null = null;
            if (installerJar && !hasLibraries) javaNeeded = await this.d.installer.runInstallerFile(serverId, installerJar);
            const info: ModpackInfo = { source: 'zip', title: path.basename(zipPath).replace(/\.zip$/i, '') };
            await fs.writeFile(path.join(folder, MODPACK_FILE), `${JSON.stringify(info, null, 2)}\n`);
            return { info, javaNeeded };
        } finally {
            this.running = null;
            this.d.emit(null);
        }
    }

    /** The pack a server was made from (its mcs-relay-modpack.json, which every member gets with the server's files). */
    async info(serverId: string): Promise<ModpackInfo | null> {
        const folder = this.d.settings.getServer(serverId).localPath;
        if (!folder) return null;
        try {
            const raw = JSON.parse(await fs.readFile(path.join(folder, MODPACK_FILE), 'utf8')) as Partial<ModpackInfo>;
            if (typeof raw.title !== 'string' || (raw.source !== 'modrinth' && raw.source !== 'zip')) return null;
            // Only a Modrinth page is linked to.
            const url = typeof raw.url === 'string' && raw.url.startsWith('https://modrinth.com/') ? raw.url : undefined;
            return { ...raw, source: raw.source, title: raw.title, url } as ModpackInfo;
        } catch {
            return null;
        }
    }

    /* ---------------------------------------------------------------- downloads */

    private async downloadAll(serverId: string, folder: string, files: Array<{ rel: string; url: string; hash: { algorithm: 'sha1' | 'sha512'; value: string }; size: number }>): Promise<void> {
        const total = files.reduce((n, f) => n + f.size, 0);
        let done = 0;
        let next = 0;
        this.progress(serverId, 0, total, true);
        const worker = async () => {
            while (next < files.length) {
                const f = files[next++];
                await this.fetchFile(f.url, path.join(folder, ...f.rel.split('/')), f.hash, (bytes) => {
                    done += bytes;
                    this.progress(serverId, done, total);
                });
            }
        };
        await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, files.length) }, worker));
    }

    private async download(serverId: string, url: string, target: string, hash: { algorithm: 'sha1'; value: string } | null, size: number): Promise<void> {
        let done = 0;
        this.progress(serverId, 0, size, true);
        await this.fetchFile(url, target, hash, (bytes) => {
            done += bytes;
            this.progress(serverId, done, size);
        });
    }

    /** One file, written beside its place as .part and moved there once its checksum matches. */
    private async fetchFile(url: string, target: string, hash: { algorithm: 'sha1' | 'sha512'; value: string } | null, onBytes: (n: number) => void): Promise<void> {
        const response = await this.request(url);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const part = `${target}.part`;
        const digest = hash ? createHash(hash.algorithm) : null;
        const meter = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
                digest?.update(chunk);
                onBytes(chunk.length);
                callback(null, chunk);
            },
        });
        const body = response.body ? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>) : Readable.from([]);
        try {
            await pipeline(body, meter, createWriteStream(part));
            if (digest && hash && digest.digest('hex') !== hash.value.toLowerCase()) {
                throw new AppError('CHECKSUM', `${path.basename(target)} does not match the modpack's checksum, so the modpack was not installed. Try again.`);
            }
            await fs.rename(part, target);
        } catch (err) {
            await fs.rm(part, { force: true });
            if (err instanceof AppError) throw err;
            throw new AppError('NETWORK', 'A download of the modpack was interrupted. Try again.', err instanceof Error ? err.message : String(err));
        }
    }

    private async request(url: string): Promise<Response> {
        let response: Response;
        try {
            // Modrinth asks every app to say who it is.
            response = await this.fetchImpl(url, { headers: { 'User-Agent': `yeet30/MCS-Relay/${this.d.appVersion} (https://mcs-relay.com)` } });
        } catch (err) {
            throw new AppError('NETWORK', 'Modrinth could not be reached. Check your internet connection.', err instanceof Error ? err.message : String(err));
        }
        if (response.status === 429) throw new AppError('RATE_LIMITED', 'Modrinth asked to slow down. Try again in a minute.');
        if (!response.ok) throw new AppError('NETWORK', `Modrinth answered ${response.status}. Try again later.`, url);
        return response;
    }

    private async json<T>(url: string): Promise<T> {
        return (await (await this.request(url)).json()) as T;
    }

    private folder(serverId: string): string {
        const folder = this.d.settings.getServer(serverId).localPath;
        if (!folder) throw new AppError('NO_LOCAL_PATH', 'Choose a folder on this PC for this server first.');
        return folder;
    }

    private progress(serverId: string, done: number, total: number, force = false): void {
        const now = Date.now();
        if (!force && now - this.lastProgress < PROGRESS_MS) return;
        this.lastProgress = now;
        this.d.emit({ serverId, done, total });
    }
}
