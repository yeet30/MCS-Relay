import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import type { InstallProgress } from '../../shared/types';
import { javaNeededFromOutput } from '../processes/MinecraftProcess';
import { JavaInstaller, javaExe } from './JavaInstaller';

/** A Temurin zip as Adoptium ships it: everything inside one "jdk-...-jre" folder. */
function temurinZip(top: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        zip.addBuffer(Buffer.from('java'), `${top}/bin/java.exe`);
        zip.addBuffer(Buffer.from('release'), `${top}/release`);
        zip.end();
        const chunks: Buffer[] = [];
        zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
        zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
        zip.outputStream.on('error', reject);
    });
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup(o: { builds?: number[]; badChecksum?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-java-'));
    dirs.push(dir);
    const zip = await temurinZip('jdk-25.0.5+8-jre');
    const builds = o.builds ?? [8, 11, 17, 21, 25];
    const asked: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
        asked.push(url);
        const m = /assets\/latest\/(\d+)\//.exec(url);
        if (m) {
            const version = Number(m[1]);
            if (!builds.includes(version)) return new Response('[]');
            return new Response(JSON.stringify([{
                release_name: `jdk-${version}+1`,
                binary: { package: {
                    name: `OpenJDK${version}U-jre_x64_windows_hotspot.zip`, link: `https://github.example/temurin${version}.zip`, size: zip.length,
                    checksum: o.badChecksum ? 'f'.repeat(64) : createHash('sha256').update(zip).digest('hex'),
                } },
            }]));
        }
        if (url.endsWith('.zip')) return new Response(new Uint8Array(zip));
        return new Response('not found', { status: 404 });
    });
    const servers: Record<string, { javaPath?: string }> = { s1: {} };
    const settings = {
        getServer: vi.fn((id: string) => servers[id]),
        setServer: vi.fn((id: string, patch: { javaPath?: string | null }) => Object.assign(servers[id], patch)),
    };
    const progress: Array<InstallProgress | null> = [];
    const java = new JavaInstaller({ dir, settings: settings as never, appVersion: '1.0.0', fetchImpl, emit: (p) => void progress.push(p) });
    return { java, dir, settings, servers, asked, progress, fetchImpl };
}

describe('JavaInstaller', () => {
    it('downloads Temurin from Adoptium, checks it, unpacks it and makes it the server\'s Java', async () => {
        const t = await setup();
        const result = await t.java.install('s1', 21);
        const exe = javaExe(path.join(t.dir, 'temurin-21'));
        expect(result).toEqual({ javaPath: exe, major: 21 });
        expect(fs.readFileSync(exe, 'utf8')).toBe('java');
        expect(t.servers.s1.javaPath).toBe(exe);
        expect(t.asked[0]).toBe('https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse');
        expect(fs.readdirSync(t.dir)).toEqual(['temurin-21']);              // no zip or half-unpacked folder left
        expect(t.progress.at(-1)).toBeNull();
    });

    it('takes the next version up when Adoptium has no Windows build of the one asked for', async () => {
        const t = await setup();
        expect((await t.java.install('s1', 16)).major).toBe(17);
    });

    it('downloads a version once per PC', async () => {
        const t = await setup();
        await t.java.install('s1', 25);
        t.fetchImpl.mockClear();
        await t.java.install('s1', 25);
        expect(t.fetchImpl).not.toHaveBeenCalled();
    });

    it('does not use a download that does not match Adoptium\'s checksum', async () => {
        const t = await setup({ badChecksum: true });
        await expect(t.java.install('s1', 21)).rejects.toMatchObject({ code: 'CHECKSUM' });
        expect(fs.readdirSync(t.dir)).toEqual([]);
        expect(t.servers.s1.javaPath).toBeUndefined();
    });

    it('says so when there is nothing to download', async () => {
        const t = await setup({ builds: [] });
        await expect(t.java.install('s1', 21)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

describe('javaNeededFromOutput', () => {
    it('reads the Java a server needs from Java\'s complaint that it is too old', () => {
        const out = 'Error: LinkageError occurred while loading main class net.minecraft.bundler.Main\n'
            + '\tjava.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0';
        expect(javaNeededFromOutput(out)).toBe(21);
        expect(javaNeededFromOutput('(class file version 69.0)')).toBe(25);
        expect(javaNeededFromOutput('Done (4.2s)! For help, type "help"')).toBeNull();
    });
});
