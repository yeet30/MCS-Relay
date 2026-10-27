// Downloads Java for a server: Eclipse Temurin, the free OpenJDK build of the Adoptium project, from its official
// API (api.adoptium.net). It is the portable zip of the Java runtime (no installer, no administrator), checked
// against the sha256 Adoptium publishes, unpacked into <userData>/java/temurin-<version>, and set as the server's Java
// on this PC. Nothing is hosted or passed on by MCS-Relay: each PC downloads from Adoptium directly.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import yauzl from 'yauzl';
import type { InstallProgress, JavaInstallResult } from '../../shared/types';
import { AppError } from '../errors';
import type { SettingsService } from '../settings/SettingsService';
import type { FetchFn } from './ServerInstaller';

const ADOPTIUM = 'https://api.adoptium.net/v3';
/** Java versions without a Windows runtime build (16, say) take the next one up: newer Java runs those servers too. */
const NEWER_TRIES = 3;
const PROGRESS_MS = 250;

interface AdoptiumAsset {
    release_name: string;
    binary: { package: { name: string; link: string; checksum: string; size: number } };
}

export interface JavaInstallerDeps {
    /** <userData>/java */
    dir: string;
    settings: Pick<SettingsService, 'getServer' | 'setServer'>;
    emit: (progress: InstallProgress | null) => void;
    appVersion: string;
    fetchImpl?: FetchFn;
}

/** The java.exe below a Temurin folder: the zip holds one folder ("jdk-25.0.5+8-jre") with bin/java.exe in it. */
export const javaExe = (folder: string): string => path.join(folder, 'bin', 'java.exe');

export class JavaInstaller {
    private readonly fetchImpl: FetchFn;
    private running = false;
    private lastProgress = 0;

    constructor(private readonly d: JavaInstallerDeps) {
        this.fetchImpl = d.fetchImpl ?? ((url, init) => fetch(url, init));
    }

    /** Java `major` (or the next version Adoptium has for Windows) for this server, downloaded once per PC. */
    async install(serverId: string, major: number): Promise<JavaInstallResult> {
        if (!Number.isInteger(major) || major < 8 || major > 99) throw new AppError('INVALID', 'That Java version is not valid.');
        if (this.running) throw new AppError('BUSY', 'Java is already being downloaded.');
        this.running = true;
        try {
            for (let version = major; version <= major + NEWER_TRIES; version++) {
                const folder = path.join(this.d.dir, `temurin-${version}`);
                if (existsSync(javaExe(folder))) return this.use(serverId, folder, version);
                const asset = await this.latest(version);
                if (!asset) continue;
                console.log(`[java] downloading ${asset.release_name} (${asset.binary.package.name}) from Adoptium for Java ${major}`);
                await this.download(serverId, asset, folder);
                return this.use(serverId, folder, version);
            }
            throw new AppError('NOT_FOUND', `Adoptium has no Java ${major} for Windows to download. Get it from adoptium.net and choose it in Settings > Scripts.`);
        } finally {
            this.running = false;
            this.d.emit(null);
        }
    }

    private use(serverId: string, folder: string, version: number): JavaInstallResult {
        const javaPath = javaExe(folder);
        this.d.settings.setServer(serverId, { javaPath });
        console.log(`[java] ${serverId} now starts with ${javaPath}`);
        return { javaPath, major: version };
    }

    /** The newest Windows x64 runtime zip of a Java version; null when Adoptium has none. */
    private async latest(version: number): Promise<AdoptiumAsset | null> {
        const url = `${ADOPTIUM}/assets/latest/${version}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`;
        const response = await this.request(url);
        if (response.status === 404) return null;
        if (!response.ok) throw new AppError('NETWORK', `Adoptium answered ${response.status}. Try again later.`, url);
        const assets = (await response.json()) as AdoptiumAsset[];
        return assets.find((a) => a.binary?.package?.name?.endsWith('.zip')) ?? null;
    }

    private async download(serverId: string, asset: AdoptiumAsset, folder: string): Promise<void> {
        const pkg = asset.binary.package;
        await fs.mkdir(this.d.dir, { recursive: true });
        const zip = `${folder}.zip.part`;
        const unpacking = `${folder}.part`;
        const response = await this.request(pkg.link);
        if (!response.ok || !response.body) throw new AppError('NETWORK', `The Java download answered ${response.status}. Try again later.`, pkg.link);
        const hash = createHash('sha256');
        let done = 0;
        this.progress(serverId, 0, pkg.size, true);
        const meter = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
                done += chunk.length;
                hash.update(chunk);
                this.progress(serverId, done, pkg.size);
                callback(null, chunk);
            },
        });
        try {
            await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), meter, createWriteStream(zip));
            if (hash.digest('hex') !== pkg.checksum.toLowerCase()) {
                throw new AppError('CHECKSUM', 'The downloaded Java does not match the official one, so it was not used. Try again.');
            }
            await fs.rm(unpacking, { recursive: true, force: true });
            await unzipStripped(zip, unpacking);
            if (!existsSync(javaExe(unpacking))) throw new AppError('JAVA', 'The downloaded Java has no java.exe in it.', pkg.name);
            await fs.rm(folder, { recursive: true, force: true });
            await fs.rename(unpacking, folder);
        } catch (err) {
            await fs.rm(unpacking, { recursive: true, force: true });
            if (err instanceof AppError) throw err;
            throw new AppError('NETWORK', 'The Java download was interrupted. Try again.', err instanceof Error ? err.message : String(err));
        } finally {
            await fs.rm(zip, { force: true });
        }
    }

    private async request(url: string): Promise<Response> {
        try {
            return await this.fetchImpl(url, { headers: { 'User-Agent': `MCS-Relay/${this.d.appVersion} (https://mcs-relay.com)` } });
        } catch (err) {
            throw new AppError('NETWORK', 'Adoptium could not be reached. Check your internet connection.', err instanceof Error ? err.message : String(err));
        }
    }

    private progress(serverId: string, done: number, total: number, force = false): void {
        const now = Date.now();
        if (!force && now - this.lastProgress < PROGRESS_MS) return;
        this.lastProgress = now;
        this.d.emit({ serverId, done, total });
    }
}

/** Unpacks a zip whose files all sit in one top folder into `root`, without that folder. yauzl refuses ".." and
 *  absolute names, so nothing lands outside `root`. */
function unzipStripped(file: string, root: string): Promise<void> {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true }, (openErr, zip) => {
            if (openErr || !zip) {
                reject(openErr ?? new Error('The zip could not be opened.'));
                return;
            }
            zip.on('error', reject);
            zip.on('end', () => resolve());
            zip.on('entry', (entry: yauzl.Entry) => {
                const parts = entry.fileName.split('/').filter(Boolean).slice(1);
                if (parts.length === 0) {
                    zip.readEntry();
                    return;
                }
                const target = path.join(root, ...parts);
                if (entry.fileName.endsWith('/')) {
                    fs.mkdir(target, { recursive: true }).then(() => zip.readEntry(), reject);
                    return;
                }
                zip.openReadStream(entry, (err, stream) => {
                    if (err || !stream) {
                        reject(err ?? new Error(`${entry.fileName} could not be read.`));
                        return;
                    }
                    fs.mkdir(path.dirname(target), { recursive: true })
                        .then(() => pipeline(stream, createWriteStream(target)))
                        .then(() => zip.readEntry(), reject);
                });
            });
            zip.readEntry();
        });
    });
}
