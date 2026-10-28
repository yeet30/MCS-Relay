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
// and makes sure it has its mod loader: it runs the Forge or NeoForge installer the pack contains, or, when the pack
// has none (some packs' start scripts download it on their first run), installs the loader the pack names in its
// manifest.json, its variables.txt (ServerPackCreator's) or its start scripts. CurseForge's pack for players (the zip
// its big Download button gives: manifest.json, a list of mod IDs to download, and no mods) is refused: a server
// cannot run from it. CurseForge's own API needs a key that may not be shared.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import yauzl from 'yauzl';
import type { InstallProgress, ModpackHit, ModpackInfo, ModpackInstallResult, ModpackSearch, ModpackVersion, ModpackZip } from '../../shared/types';
import { AppError } from '../errors';
import { neoforgeMc } from '../installer/ServerInstaller';
import type { FetchFn, Loader, ServerInstaller } from '../installer/ServerInstaller';
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

/** CurseForge's manifest.json: in a pack for players, and in some server packs. */
interface CurseManifest {
    manifestType?: string;
    name?: string;
    version?: string;
    minecraft?: { version?: string; modLoaders?: Array<{ id?: string; primary?: boolean }> };
    files?: unknown[];
}

/** A zip's entry names, and the folder all of them sit in ("" for none; it is left out when unpacking). */
async function zipNames(zipPath: string): Promise<{ names: string[]; top: string }> {
    const names: string[] = [];
    await eachEntry(zipPath, (name) => {
        names.push(name.replace(/\\/g, '/'));
        return null;
    });
    const firsts = new Set(names.map((n) => n.split('/')[0]));
    const top = firsts.size === 1 && names.every((n) => n.includes('/')) ? `${[...firsts][0]}/` : '';
    return { names, top };
}

/** One small text file in a zip; null when it is not there. */
async function readEntry(zipPath: string, name: string): Promise<string | null> {
    let text: string | null = null;
    await eachEntry(zipPath, (n) => (n.replace(/\\/g, '/') === name ? 'read' : null), (_n, data) => {
        text = data.toString('utf8');
    });
    return text;
}

function parseManifest(text: string | null): CurseManifest | null {
    if (!text) return null;
    try {
        const m = JSON.parse(text.replace(/^\uFEFF/, '')) as CurseManifest;
        return m && typeof m === 'object' ? m : null;
    } catch {
        return null;
    }
}

/** The mod loader a server pack names, for one that does not include its installer: from its manifest.json
 *  ("forge-47.2.0" for Minecraft 1.20.1), its variables.txt (ServerPackCreator's MINECRAFT_VERSION, MODLOADER,
 *  MODLOADER_VERSION) or its start scripts (an installer's file name, or NEOFORGE_VERSION=21.1.77). */
export function packLoader(files: { manifest?: string | null; variables?: string | null; scripts?: string[] }): { loader: Loader; minecraft: string; version: string } | null {
    const manifest = parseManifest(files.manifest ?? null);
    const mc = manifest?.minecraft?.version;
    const loaders = manifest?.minecraft?.modLoaders ?? [];
    const id = (loaders.find((l) => l.primary) ?? loaders[0])?.id;
    const fromId = id ? /^(forge|neoforge|fabric)-(.+)$/i.exec(id) : null;
    if (fromId) {
        const loader = fromId[1].toLowerCase() as Loader;
        const minecraft = mc ?? (loader === 'neoforge' ? neoforgeMc(fromId[2]) : null);
        if (minecraft) return { loader, minecraft, version: fromId[2] };
    }

    if (files.variables) {
        const value = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]+?)"?\\s*$`, 'mi').exec(files.variables ?? '')?.[1];
        const loader = value('MODLOADER')?.toLowerCase();
        const minecraft = value('MINECRAFT_VERSION');
        const version = value('MODLOADER_VERSION');
        if ((loader === 'forge' || loader === 'neoforge' || loader === 'fabric') && minecraft && version) return { loader, minecraft, version };
    }

    for (const script of files.scripts ?? []) {
        const forge = /(?<!neo)forge-(\d+(?:\.\d+)+)-(\d+(?:\.\d+)+)-installer\.jar/i.exec(script);
        if (forge) return { loader: 'forge', minecraft: forge[1], version: forge[2] };
        // NeoForge numbers have three parts ("21.1.77"), four from Minecraft 26 on ("26.3.0.12").
        const neo = /neoforge-(\d+(?:\.\d+){2,3}(?:-beta)?)-installer\.jar/i.exec(script) ?? /NEOFORGE_VERSION\s*=\s*"?(\d+(?:\.\d+){2,3}(?:-beta)?)/i.exec(script);
        const neoMc = neo ? neoforgeMc(neo[1]) : null;
        if (neo && neoMc) return { loader: 'neoforge', minecraft: neoMc, version: neo[1] };
    }
    return null;
}

/** A pack goes into the new server's folder, empty until then: that lets a failed install be undone by emptying it. */
async function emptyFolder(folder: string): Promise<void> {
    if ((await fs.readdir(folder).catch(() => [])).length > 0) {
        throw new AppError('INVALID', 'A modpack can only be installed into a new, empty server folder.');
    }
}

async function clearFolder(folder: string): Promise<void> {
    for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
        await fs.rm(path.join(folder, name), { recursive: true, force: true }).catch(() => undefined);
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
        await emptyFolder(folder);
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
        } catch (err) {
            // Half a pack is no use: the folder is emptied again, so trying again starts clean.
            await clearFolder(folder);
            throw err;
        } finally {
            await fs.rm(packFile, { force: true });
            await fs.rm(`${packFile}.part`, { force: true });
            this.running = null;
            this.d.emit(null);
        }
    }

    /** Looks inside a zip chosen to make a server from: is it CurseForge's pack for players rather than a server pack? */
    async checkZip(zipPath: string): Promise<ModpackZip> {
        if (!/\.zip$/i.test(zipPath) || !existsSync(zipPath)) throw new AppError('INVALID', 'Choose a .zip file.');
        const { names, top } = await zipNames(zipPath);
        // A pack for players has its manifest.json at the top and no mods folder there: its mods are only listed (a
        // few may come in its overrides folder).
        if (!names.includes(`${top}manifest.json`) || names.some((n) => n.startsWith(`${top}mods/`) || /^[^/]+\.jar$/i.test(n.slice(top.length)))) {
            return { path: zipPath, clientPack: null };
        }
        const manifest = parseManifest(await readEntry(zipPath, `${top}manifest.json`));
        if (manifest?.manifestType !== 'minecraftModpack') return { path: zipPath, clientPack: null };
        return {
            path: zipPath,
            clientPack: {
                name: manifest.name || path.basename(zipPath).replace(/\.zip$/i, ''),
                version: manifest.version || null,
                mods: Array.isArray(manifest.files) ? manifest.files.length : 0,
            },
        };
    }

    /** Unpacks a server pack zip (CurseForge's, say) into the server's new folder; a zip whose files all sit in one
     *  folder is unpacked without it. The pack's mod loader is installed: its own Forge or NeoForge installer is run,
     *  or the loader it names is downloaded. */
    async importZip(serverId: string, zipPath: string): Promise<ModpackInstallResult> {
        const folder = this.folder(serverId);
        if (this.running) throw new AppError('BUSY', 'A modpack is already being installed.');
        const checked = await this.checkZip(zipPath);
        if (checked.clientPack) {
            const { name, mods } = checked.clientPack;
            throw new AppError('INVALID', `This zip is ${name} for players: it only lists its ${mods} mods, so a server cannot run from it. On the pack's CurseForge page, download its Server Files and use that zip.`);
        }
        await emptyFolder(folder);
        this.running = serverId;
        try {
            const { top } = await zipNames(zipPath);
            let count = 0;
            this.d.emit({ serverId, done: 0, total: 0 });
            await eachEntry(zipPath, (name) => {
                const rel = packPath(name.replace(/\\/g, '/').slice(top.length));
                if (!rel) return null;
                count += 1;
                return path.join(folder, ...rel.split('/'));
            });
            console.log(`[modpack] ${serverId}: unpacked ${count} files from ${path.basename(zipPath)}`);
            const javaNeeded = await this.loaderFor(serverId, folder);
            const info: ModpackInfo = { source: 'zip', title: path.basename(zipPath).replace(/\.zip$/i, '') };
            await fs.writeFile(path.join(folder, MODPACK_FILE), `${JSON.stringify(info, null, 2)}\n`);
            return { info, javaNeeded };
        } catch (err) {
            await clearFolder(folder);
            throw err;
        } finally {
            this.running = null;
            this.d.emit(null);
        }
    }

    /** Makes sure an unpacked server pack can start: a server program, or the Forge or NeoForge libraries, or else
     *  the loader installed from its installer or from what the pack names. The Java it needs, when known. */
    private async loaderFor(serverId: string, folder: string): Promise<number | null> {
        const entries = await fs.readdir(folder, { withFileTypes: true });
        const files = entries.filter((e) => e.isFile()).map((e) => e.name);
        if (entries.some((e) => e.isDirectory() && e.name === 'libraries')) return null;
        const installerJar = files.find((n) => /^(forge|neoforge)-.+-installer\.jar$/i.test(n));
        if (installerJar) return this.d.installer.runInstallerFile(serverId, installerJar);
        if (files.some((n) => /\.jar$/i.test(n))) return null;

        const read = (name: string) => fs.readFile(path.join(folder, name), 'utf8').catch(() => null);
        const scripts = await Promise.all(files.filter((n) => /\.(bat|cmd|sh|ps1)$/i.test(n)).map(read));
        const named = packLoader({ manifest: await read('manifest.json'), variables: await read('variables.txt'), scripts: scripts.filter((t): t is string => t !== null) });
        if (!named) {
            throw new AppError('INVALID', 'This server pack has no Minecraft server or mod loader in it, and does not say which one it needs. Check that it is the pack\'s Server Files zip.');
        }
        console.log(`[modpack] ${serverId}: the pack has no loader installer; installing ${named.loader} ${named.version} for ${named.minecraft}`);
        return (await this.d.installer.install(serverId, named.loader, named.minecraft, named.version)).javaNeeded;
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
