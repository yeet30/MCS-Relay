import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { InstallProgress } from '../../shared/types';
import { AppError } from '../errors';
import { javaMajor, ServerInstaller } from './ServerInstaller';

const JAR = Buffer.from('pretend this is a server jar');
const sha1 = createHash('sha1').update(JAR).digest('hex');
const sha256 = createHash('sha256').update(JAR).digest('hex');

const ROUTES: Record<string, unknown> = {
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': {
        versions: [
            { id: '1.21.5-pre1', type: 'snapshot', releaseTime: '2025-03-01T00:00:00Z', url: 'https://m/pre.json' },
            { id: '1.21.4', type: 'release', releaseTime: '2024-12-03T00:00:00Z', url: 'https://m/1.21.4.json' },
            { id: '1.2.5', type: 'release', releaseTime: '2012-03-29T22:00:00Z', url: 'https://m/1.2.5.json' },
            { id: '1.2.4', type: 'release', releaseTime: '2012-03-21T22:00:00Z', url: 'https://m/1.2.4.json' },
            { id: 'b1.7.3', type: 'old_beta', releaseTime: '2011-07-08T00:00:00Z', url: 'https://m/b.json' },
            { id: '1.0', type: 'release', releaseTime: '2011-11-18T00:00:00Z', url: 'https://m/1.0.json' },
        ],
    },
    'https://m/1.21.4.json': { downloads: { server: { url: 'https://dl/server.jar', sha1, size: JAR.length } }, javaVersion: { majorVersion: 21 } },
    'https://fill.papermc.io/v3/projects/paper': { versions: { '1.21': ['1.21.4', '1.21.4-rc1'], '1.20': ['1.20.6'] } },
    'https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds': [
        { channel: 'BETA', downloads: { 'server:default': { name: 'paper-1.21.4-233.jar', url: 'https://dl/beta.jar', size: 1, checksums: { sha256: 'x' } } } },
        { channel: 'STABLE', downloads: { 'server:default': { name: 'paper-1.21.4-232.jar', url: 'https://dl/paper.jar', size: JAR.length, checksums: { sha256 } } } },
    ],
    'https://meta.fabricmc.net/v2/versions/game': [{ version: '1.21.5-pre1', stable: false }, { version: '1.21.4', stable: true }],
    'https://meta.fabricmc.net/v2/versions/loader/1.21.4': [{ loader: { version: '0.20.2', stable: false } }, { loader: { version: '0.20.1', stable: true } }],
    'https://meta.fabricmc.net/v2/versions/installer': [{ version: '1.1.2', stable: true }],
};
const FILES = new Set(['https://dl/server.jar', 'https://dl/paper.jar', 'https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.20.1/1.1.2/server/jar']);

let folder: string;
beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-install-'));
});
afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
});

function setup(opts: { body?: Buffer; busy?: boolean; java?: string | null } = {}) {
    const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        expect(init?.headers?.['User-Agent']).toMatch(/^MCS-Relay\/1\.0\.4 \(https:\/\/mcs-relay\.com\)$/);
        if (FILES.has(url)) return new Response(new Uint8Array(opts.body ?? JAR), { status: 200, headers: { 'content-length': String((opts.body ?? JAR).length) } });
        if (url in ROUTES) return new Response(JSON.stringify(ROUTES[url]), { status: 200 });
        return new Response('not found', { status: 404 });
    });
    const progress: Array<InstallProgress | null> = [];
    const installer = new ServerInstaller({
        settings: { getServer: () => ({ localPath: folder, javaFlags: { minRAM: 1024, maxRAM: 2048, customFlags: '' } }) },
        isBusy: () => opts.busy ?? false,
        emit: (p) => progress.push(p),
        appVersion: '1.0.4',
        fetchImpl,
        execImpl: async () => {
            if (opts.java === null) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
            return { stdout: '', stderr: opts.java ?? 'openjdk version "17.0.9" 2023-10-17\nOpenJDK Runtime Environment' };
        },
    });
    return { installer, fetchImpl, progress };
}

describe('ServerInstaller', () => {
    test('lists versions newest first, with the unstable ones marked, and only those that have a server', async () => {
        const { installer } = setup();
        expect(await installer.versions('vanilla')).toEqual([{ id: '1.21.5-pre1', stable: false }, { id: '1.21.4', stable: true }, { id: '1.2.5', stable: true }]);
        expect(await installer.versions('paper')).toEqual([{ id: '1.21.4', stable: true }, { id: '1.21.4-rc1', stable: false }, { id: '1.20.6', stable: true }]);
        expect((await installer.versions('fabric')).map((v) => v.stable)).toEqual([false, true]);
    });

    test('vanilla is saved as server.jar after its sha1 checks out, and says which Java it needs', async () => {
        const { installer, progress } = setup();
        expect(await installer.install('srv', 'vanilla', '1.21.4')).toEqual({ file: 'server.jar', javaNeeded: 21 });
        expect(fs.readFileSync(path.join(folder, 'server.jar'))).toEqual(JAR);
        expect(progress[0]).toEqual({ serverId: 'srv', done: 0, total: JAR.length });
        expect(progress.at(-1)).toBeNull();
    });

    test('Paper takes the newest stable build and keeps its name', async () => {
        const { installer } = setup();
        expect((await installer.install('srv', 'paper', '1.21.4')).file).toBe('paper-1.21.4-232.jar');
        expect(fs.existsSync(path.join(folder, 'paper-1.21.4-232.jar'))).toBe(true);
    });

    test('Fabric gets the server launcher of the newest stable loader', async () => {
        const { installer } = setup();
        expect((await installer.install('srv', 'fabric', '1.21.4')).file).toBe('fabric-server-mc.1.21.4-loader.0.20.1-launcher.1.1.2.jar');
    });

    test('a download that does not match the official checksum is thrown away', async () => {
        const { installer } = setup({ body: Buffer.from('tampered') });
        const err = await installer.install('srv', 'vanilla', '1.21.4').catch((e: unknown) => e);
        expect((err as AppError).code).toBe('CHECKSUM');
        expect(fs.readdirSync(folder)).toEqual([]);
    });

    test('a folder that has a server program, or a server in use, is left alone', async () => {
        fs.writeFileSync(path.join(folder, 'spigot.jar'), 'x');
        const has = await setup().installer.install('srv', 'vanilla', '1.21.4').catch((e: unknown) => e);
        expect((has as AppError).message).toContain('spigot.jar');
        fs.rmSync(path.join(folder, 'spigot.jar'));
        const busy = await setup({ busy: true }).installer.install('srv', 'vanilla', '1.21.4').catch((e: unknown) => e);
        expect((busy as AppError).code).toBe('BUSY');
        expect(fs.readdirSync(folder)).toEqual([]);
    });

    test('an unknown version is explained', async () => {
        const err = await setup().installer.install('srv', 'vanilla', '9.9').catch((e: unknown) => e);
        expect((err as AppError).code).toBe('NOT_FOUND');
    });

    test('the folder check reports a server program and the Java this PC has', async () => {
        expect(await setup().installer.folder('srv')).toEqual({ hasServer: false, javaFound: 17 });
        fs.writeFileSync(path.join(folder, 'server.jar'), 'x');
        expect(await setup({ java: null }).installer.folder('srv')).toEqual({ hasServer: true, javaFound: null });
    });

    test('reads Java versions old and new', () => {
        expect(javaMajor('java version "1.8.0_421"')).toBe(8);
        expect(javaMajor('openjdk version "21.0.5" 2024-10-15')).toBe(21);
        expect(javaMajor('openjdk version "25" 2025-09-16')).toBe(25);
        expect(javaMajor('nothing')).toBeNull();
    });
});
