// Downloads a Minecraft server program into a server folder, from the official sources only:
//   vanilla: Mojang's version list (piston-meta.mojang.com), saved as server.jar, checked with its sha1;
//   Paper:   PaperMC's download service (fill.papermc.io), the newest stable build, checked with its sha256;
//   Fabric:  Fabric's meta service, the ready-made server launcher for the newest stable loader (it fetches the
//            vanilla server itself on its first start).
// Nothing is hosted or passed on by MCS-Relay: each PC downloads from those services directly.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { InstallableVersion, InstallProgress, InstallResult, ServerFolderInfo, ServerKind } from '../../shared/types';
import { AppError } from '../errors';
import { applyChanges, parseProperties, PROPERTIES_FILE } from '../servers/ServerProperties';
import type { SettingsService } from '../settings/SettingsService';

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER = 'https://fill.papermc.io/v3/projects/paper';
const FABRIC = 'https://meta.fabricmc.net/v2';
/** The oldest version Mojang offers a server download for: 1.0 to 1.2.4 have none. */
const FIRST_WITH_SERVER = '1.2.5';
const PROGRESS_MS = 250;

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface InstallerDeps {
    settings: Pick<SettingsService, 'getServer'>;
    /** A session is using this server: its folder must not change. */
    isBusy: (serverId: string) => boolean;
    emit: (progress: InstallProgress | null) => void;
    appVersion: string;
    fetchImpl?: FetchFn;
    execImpl?: ExecFn;
}

interface Download {
    url: string;
    file: string;
    size: number | null;
    hash: { algorithm: 'sha1' | 'sha256'; value: string } | null;
}

const defaultExec: ExecFn = (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000, encoding: 'utf8' }, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
});

/** The major version in `java -version` output: "21.0.5" -> 21, "1.8.0_421" -> 8. */
export function javaMajor(output: string): number | null {
    const m = /version "(\d+)(?:\.(\d+))?/.exec(output);
    if (!m) return null;
    const first = Number(m[1]);
    return first === 1 && m[2] ? Number(m[2]) : first;
}

/** Root .jar files other than installers: a folder with one already has a server program. */
async function serverJars(folder: string): Promise<string[]> {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isFile() && /\.jar$/i.test(e.name) && !/installer/i.test(e.name)).map((e) => e.name);
}

/** "white-list=false" in the folder's server.properties, unless it already says something about the whitelist. */
async function whitelistOffUnlessSet(folder: string): Promise<void> {
    const file = path.join(folder, PROPERTIES_FILE);
    const before = await fs.readFile(file, 'latin1').catch(() => '');
    if ('white-list' in parseProperties(before)) return;
    await fs.writeFile(file, applyChanges(before, { 'white-list': 'false' }), 'latin1');
}

export class ServerInstaller {
    private readonly fetchImpl: FetchFn;
    private readonly execImpl: ExecFn;
    private readonly cache = new Map<ServerKind, InstallableVersion[]>();
    private running: string | null = null;
    private lastProgress = 0;

    constructor(private readonly d: InstallerDeps) {
        this.fetchImpl = d.fetchImpl ?? ((url, init) => fetch(url, init));
        this.execImpl = d.execImpl ?? defaultExec;
    }

    /** The versions a kind of server can be downloaded in, newest first. */
    async versions(kind: ServerKind): Promise<InstallableVersion[]> {
        const cached = this.cache.get(kind);
        if (cached) return cached;
        let list: InstallableVersion[];
        if (kind === 'vanilla') {
            const manifest = await this.json<{ versions: Array<{ id: string; type: string }> }>(MOJANG_MANIFEST);
            // The list is newest first: everything up to 1.2.5 has a server download, nothing after it does.
            const oldest = manifest.versions.findIndex((v) => v.id === FIRST_WITH_SERVER);
            list = (oldest >= 0 ? manifest.versions.slice(0, oldest + 1) : manifest.versions)
                .filter((v) => v.type === 'release' || v.type === 'snapshot')
                .map((v) => ({ id: v.id, stable: v.type === 'release' }));
        } else if (kind === 'paper') {
            const project = await this.json<{ versions: Record<string, string[]> }>(PAPER);
            list = Object.values(project.versions).flat().map((id) => ({ id, stable: !/-(rc|pre)/i.test(id) }));
        } else {
            const games = await this.json<Array<{ version: string; stable: boolean }>>(`${FABRIC}/versions/game`);
            list = games.map((g) => ({ id: g.version, stable: g.stable }));
        }
        this.cache.set(kind, list);
        return list;
    }

    /** Whether the folder has a server program yet, and the Java this PC would start it with. */
    async folder(serverId: string): Promise<ServerFolderInfo> {
        const settings = this.d.settings.getServer(serverId);
        const hasServer = settings.localPath ? (await serverJars(settings.localPath)).length > 0 : false;
        return { hasServer, javaFound: await this.javaFound(settings.javaPath ?? 'java') };
    }

    /** Downloads the server program into the server's (empty of jars) folder on this PC. A new server gets
     *  "white-list=false" before its first start: Minecraft 26.x turns the whitelist on by default, and with nobody on
     *  it nobody could join. */
    async install(serverId: string, kind: ServerKind, version: string): Promise<InstallResult> {
        if (this.running) throw new AppError('BUSY', 'A server is already being downloaded.');
        const folder = this.d.settings.getServer(serverId).localPath;
        if (!folder) throw new AppError('NO_LOCAL_PATH', 'Choose a folder on this PC for this server first.');
        if (this.d.isBusy(serverId)) throw new AppError('BUSY', 'Stop the server first.');
        const existing = await serverJars(folder);
        if (existing.length > 0) {
            throw new AppError('INVALID', `This folder already has a server program (${existing.join(', ')}). Download a new one into an empty folder.`);
        }
        this.running = serverId;
        try {
            const download = await this.resolve(kind, version);
            await this.download(serverId, download, folder);
            console.log(`[installer] ${kind} ${version} downloaded into ${serverId} as ${download.file}`);
            await whitelistOffUnlessSet(folder);
            return { file: download.file, javaNeeded: await this.javaNeeded(version) };
        } finally {
            this.running = null;
            this.d.emit(null);
        }
    }

    /* -------------------------------------------------------------- internals */

    private async resolve(kind: ServerKind, version: string): Promise<Download> {
        if (kind === 'vanilla') {
            const entry = await this.mojangVersion(version);
            if (!entry) throw new AppError('NOT_FOUND', `Mojang has no Minecraft ${version}.`);
            const details = await this.json<{ downloads?: { server?: { url: string; sha1: string; size: number } } }>(entry.url);
            const server = details.downloads?.server;
            if (!server) throw new AppError('NOT_FOUND', `Mojang offers no server download for Minecraft ${version}.`);
            return { url: server.url, file: 'server.jar', size: server.size, hash: { algorithm: 'sha1', value: server.sha1 } };
        }
        if (kind === 'paper') {
            type Build = { channel: string; downloads: Record<string, { name: string; url: string; size: number; checksums?: { sha256?: string } }> };
            const builds = await this.json<Build[]>(`${PAPER}/versions/${encodeURIComponent(version)}/builds`);
            const build = builds.find((b) => b.channel === 'STABLE') ?? builds[0];
            const jar = build?.downloads['server:default'];
            if (!jar) throw new AppError('NOT_FOUND', `PaperMC has no build of Paper ${version}.`);
            const sha256 = jar.checksums?.sha256;
            return { url: jar.url, file: safeName(jar.name), size: jar.size, hash: sha256 ? { algorithm: 'sha256', value: sha256 } : null };
        }
        const loaders = await this.json<Array<{ loader: { version: string; stable: boolean } }>>(`${FABRIC}/versions/loader/${encodeURIComponent(version)}`);
        const loader = (loaders.find((l) => l.loader.stable) ?? loaders[0])?.loader.version;
        if (!loader) throw new AppError('NOT_FOUND', `Fabric does not support Minecraft ${version} yet.`);
        const installers = await this.json<Array<{ version: string; stable: boolean }>>(`${FABRIC}/versions/installer`);
        const installer = (installers.find((i) => i.stable) ?? installers[0])?.version;
        if (!installer) throw new AppError('NOT_FOUND', 'Fabric\'s download service gave no installer version.');
        return {
            url: `${FABRIC}/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`,
            file: safeName(`fabric-server-mc.${version}-loader.${loader}-launcher.${installer}.jar`),
            size: null,
            hash: null,
        };
    }

    private async download(serverId: string, d: Download, folder: string): Promise<void> {
        const target = path.join(folder, d.file);
        const part = `${target}.part`;
        const response = await this.request(d.url);
        const total = d.size ?? (Number(response.headers.get('content-length')) || 0);
        const hash = d.hash ? createHash(d.hash.algorithm) : null;
        let done = 0;
        this.progress(serverId, 0, total, true);
        const meter = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
                done += chunk.length;
                hash?.update(chunk);
                this.progress(serverId, done, total);
                callback(null, chunk);
            },
        });
        const body = response.body ? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>) : Readable.from([]);
        try {
            await pipeline(body, meter, createWriteStream(part));
            if (hash && d.hash && hash.digest('hex') !== d.hash.value.toLowerCase()) {
                throw new AppError('CHECKSUM', 'The downloaded server program does not match the official one. Try again.');
            }
            await fs.rename(part, target);
        } catch (err) {
            await fs.rm(part, { force: true });
            if (err instanceof AppError) throw err;
            throw new AppError('NETWORK', 'The download was interrupted. Try again.', err instanceof Error ? err.message : String(err));
        }
    }

    private async mojangVersion(version: string): Promise<{ url: string } | null> {
        const manifest = await this.json<{ versions: Array<{ id: string; url: string }> }>(MOJANG_MANIFEST);
        return manifest.versions.find((v) => v.id === version) ?? null;
    }

    /** The Java a Minecraft version needs, from Mojang's details for it; null when Mojang does not know the version
     *  (a Paper release candidate, say) or cannot be reached. */
    private async javaNeeded(version: string): Promise<number | null> {
        try {
            const entry = await this.mojangVersion(version);
            if (!entry) return null;
            const details = await this.json<{ javaVersion?: { majorVersion?: number } }>(entry.url);
            return details.javaVersion?.majorVersion ?? 8;
        } catch {
            return null;
        }
    }

    private async javaFound(command: string): Promise<number | null> {
        try {
            const { stdout, stderr } = await this.execImpl(command, ['-version']);
            return javaMajor(stderr || stdout);
        } catch {
            return null;
        }
    }

    private async request(url: string): Promise<Response> {
        let response: Response;
        try {
            // PaperMC asks every app to say who it is and how to reach its maker.
            response = await this.fetchImpl(url, { headers: { 'User-Agent': `MCS-Relay/${this.d.appVersion} (https://mcs-relay.com)` } });
        } catch (err) {
            throw new AppError('NETWORK', 'The download service could not be reached. Check your internet connection.', err instanceof Error ? err.message : String(err));
        }
        if (!response.ok) throw new AppError('NETWORK', `The download service answered ${response.status}. Try again later.`, url);
        return response;
    }

    private async json<T>(url: string): Promise<T> {
        return (await (await this.request(url)).json()) as T;
    }

    private progress(serverId: string, done: number, total: number, force = false): void {
        const now = Date.now();
        if (!force && now - this.lastProgress < PROGRESS_MS) return;
        this.lastProgress = now;
        this.d.emit({ serverId, done, total });
    }
}

/** A file name from a download service, without anything that could leave the folder. */
function safeName(name: string): string {
    const base = path.basename(name.replace(/\\/g, '/'));
    if (!/^[\w.+-]+\.jar$/.test(base)) throw new AppError('INVALID', 'The download service gave an unexpected file name.', name);
    return base;
}
