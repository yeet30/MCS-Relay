import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import yazl from 'yazl';
import { MODPACK_FILE, ModpackService, packPath } from './ModpackService';

const MOD = Buffer.from('pretend this is a mod');
const CLIENT_MOD = Buffer.from('a client-only mod');
const hash = (data: Buffer, algorithm: 'sha1' | 'sha512') => createHash(algorithm).update(data).digest('hex');

function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
    const zip = new yazl.ZipFile();
    for (const [name, data] of Object.entries(files)) zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), name);
    zip.end();
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
        zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
        zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
        zip.outputStream.on('error', reject);
    });
}

function index(over: { files?: unknown[]; dependencies?: Record<string, string> } = {}) {
    return JSON.stringify({
        formatVersion: 1, game: 'minecraft', name: 'Test Pack',
        files: over.files ?? [
            { path: 'mods/good.jar', hashes: { sha1: hash(MOD, 'sha1'), sha512: hash(MOD, 'sha512') }, env: { client: 'required', server: 'required' }, downloads: ['https://cdn.modrinth.com/data/a/good.jar'], fileSize: MOD.length },
            { path: 'mods/shaders.jar', hashes: { sha512: hash(CLIENT_MOD, 'sha512') }, env: { client: 'required', server: 'unsupported' }, downloads: ['https://cdn.modrinth.com/data/b/shaders.jar'], fileSize: CLIENT_MOD.length },
        ],
        dependencies: over.dependencies ?? { minecraft: '1.21.1', 'fabric-loader': '0.16.9' },
    });
}

let folder: string;
let mrpack: Buffer;

function setup(pack: Buffer) {
    const fetched: string[] = [];
    const agents: string[] = [];
    const routes: Record<string, unknown> = {
        'https://api.modrinth.com/v2/version/ver1': {
            id: 'ver1', project_id: 'proj1', name: 'Test Pack 2.0', version_number: '2.0', game_versions: ['1.21.1'], loaders: ['fabric'],
            version_type: 'release', date_published: '2026-01-01T00:00:00Z',
            files: [{ url: 'https://cdn.modrinth.com/data/proj1/pack.mrpack', filename: 'pack.mrpack', primary: true, size: pack.length, hashes: { sha1: hash(pack, 'sha1') } }],
        },
        'https://api.modrinth.com/v2/project/proj1': { id: 'proj1', slug: 'test-pack', title: 'Test Pack' },
        'https://api.modrinth.com/v2/project/proj1/version': [
            { id: 'ver1', name: 'Test Pack 2.0', version_number: '2.0', game_versions: ['1.21.1'], loaders: ['fabric'], version_type: 'release', date_published: '2026-01-01T00:00:00Z', files: [{ filename: 'pack.mrpack', primary: true, size: 1234, hashes: {} }] },
            { id: 'ver0', name: 'Quilt edition', version_number: '1.0', game_versions: ['1.20.1'], loaders: ['quilt'], version_type: 'beta', date_published: '2025-01-01T00:00:00Z', files: [{ filename: 'pack.mrpack', primary: true, size: 1, hashes: {} }] },
        ],
    };
    const bodies: Record<string, Buffer> = {
        'https://cdn.modrinth.com/data/proj1/pack.mrpack': pack,
        'https://cdn.modrinth.com/data/a/good.jar': MOD,
        'https://cdn.modrinth.com/data/b/shaders.jar': CLIENT_MOD,
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        fetched.push(url);
        agents.push(String((init?.headers as Record<string, string>)?.['User-Agent']));
        if (url.startsWith('https://api.modrinth.com/v2/search?')) {
            return new Response(JSON.stringify({
                total_hits: 1,
                hits: [{ project_id: 'proj1', slug: 'test-pack', title: 'Test Pack', description: 'Mods.', icon_url: null, downloads: 5, author: 'someone', categories: ['adventure', 'fabric', 'quilt'], versions: ['1.21.1'] }],
            }), { status: 200 });
        }
        if (url in routes) return new Response(JSON.stringify(routes[url]), { status: 200 });
        if (url in bodies) return new Response(new Uint8Array(bodies[url]), { status: 200 });
        return new Response('not found', { status: 404 });
    });
    const install = vi.fn(async () => ({ file: 'fabric-server-launch.jar', javaNeeded: 21 }));
    const runInstallerFile = vi.fn(async () => 17);
    const emitted: unknown[] = [];
    const service = new ModpackService({
        settings: { getServer: () => ({ localPath: folder }) } as never,
        installer: { install, runInstallerFile },
        emit: (p) => emitted.push(p),
        appVersion: '1.2.0',
        fetchImpl: fetchImpl as never,
    });
    return { service, fetched, agents, install, runInstallerFile, emitted };
}

beforeEach(async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-modpack-'));
    mrpack = await zipOf({
        'modrinth.index.json': index(),
        'overrides/config/pack.toml': 'difficulty = 2',
        'overrides/mods/bundled.jar': 'bundled',
        'server-overrides/config/pack.toml': 'difficulty = 3',
    });
});

afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
});

describe('ModpackService', () => {
    test('searches modpacks that run on a server, naming the loaders MCS-Relay installs', async () => {
        const { service, fetched, agents } = setup(mrpack);
        const result = await service.search('', 0);
        expect(result).toEqual({
            total: 1,
            hits: [{ id: 'proj1', slug: 'test-pack', title: 'Test Pack', description: 'Mods.', iconUrl: null, downloads: 5, author: 'someone', loaders: ['fabric'], gameVersions: ['1.21.1'] }],
        });
        const params = new URL(fetched[0]).searchParams;
        expect(params.get('index')).toBe('downloads');
        expect(JSON.parse(params.get('facets') ?? '')).toContainEqual(['server_side:required', 'server_side:optional']);
        expect(agents[0]).toBe('yeet30/MCS-Relay/1.2.0 (https://mcs-relay.com)');
    });

    test('lists only the versions with a loader MCS-Relay installs', async () => {
        const versions = await setup(mrpack).service.versions('proj1');
        expect(versions.map((v) => v.id)).toEqual(['ver1']);
        expect(versions[0]).toMatchObject({ versionNumber: '2.0', loaders: ['fabric'], type: 'release', size: 1234 });
    });

    test('installs the loader, the server-side files, then the overrides, and notes the pack', async () => {
        const { service, install, fetched, emitted } = setup(mrpack);
        const result = await service.install('srv', 'ver1');
        expect(install).toHaveBeenCalledWith('srv', 'fabric', '1.21.1', '0.16.9');
        expect(fs.readFileSync(path.join(folder, 'mods', 'good.jar'))).toEqual(MOD);
        expect(fs.existsSync(path.join(folder, 'mods', 'shaders.jar'))).toBe(false);
        expect(fetched).not.toContain('https://cdn.modrinth.com/data/b/shaders.jar');
        expect(fs.readFileSync(path.join(folder, 'mods', 'bundled.jar'), 'utf8')).toBe('bundled');
        // server-overrides come last, so they win.
        expect(fs.readFileSync(path.join(folder, 'config', 'pack.toml'), 'utf8')).toBe('difficulty = 3');
        expect(fs.readdirSync(folder).filter((n) => n.includes('mrpack') || n.endsWith('.part'))).toEqual([]);
        expect(result).toEqual({
            javaNeeded: 21,
            info: {
                source: 'modrinth', title: 'Test Pack', projectId: 'proj1', slug: 'test-pack', versionId: 'ver1', versionNumber: '2.0',
                minecraft: '1.21.1', loader: 'fabric', url: 'https://modrinth.com/modpack/test-pack/version/ver1',
            },
        });
        expect(await service.info('srv')).toEqual(result.info);
        expect(emitted.at(-1)).toBeNull();
    });

    test('Forge and NeoForge packs install their loader at the version they name', async () => {
        const pack = await zipOf({ 'modrinth.index.json': index({ dependencies: { minecraft: '1.21.1', neoforge: '21.1.77' } }) });
        const { service, install } = setup(pack);
        await service.install('srv', 'ver1');
        expect(install).toHaveBeenCalledWith('srv', 'neoforge', '1.21.1', '21.1.77');
    });

    test('refuses Quilt packs before installing anything', async () => {
        const pack = await zipOf({ 'modrinth.index.json': index({ dependencies: { minecraft: '1.21.1', 'quilt-loader': '0.27.0' } }) });
        const { service, install } = setup(pack);
        await expect(service.install('srv', 'ver1')).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('Quilt') });
        expect(install).not.toHaveBeenCalled();
    });

    test('refuses a file outside the server folder, or from a host Modrinth does not allow', async () => {
        const escape = await zipOf({ 'modrinth.index.json': index({ files: [{ path: '../../evil.jar', hashes: { sha512: 'x' }, env: { server: 'required' }, downloads: ['https://cdn.modrinth.com/x.jar'] }] }) });
        await expect(setup(escape).service.install('srv', 'ver1')).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('outside') });
        const host = await zipOf({ 'modrinth.index.json': index({ files: [{ path: 'mods/x.jar', hashes: { sha512: 'x' }, env: { server: 'required' }, downloads: ['https://example.com/x.jar'] }] }) });
        const { service, install } = setup(host);
        await expect(service.install('srv', 'ver1')).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('does not allow') });
        expect(install).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(path.dirname(folder), 'evil.jar'))).toBe(false);
    });

    test('a file that does not match its checksum stops the install', async () => {
        const pack = await zipOf({ 'modrinth.index.json': index({ files: [{ path: 'mods/good.jar', hashes: { sha512: hash(CLIENT_MOD, 'sha512') }, env: { server: 'required' }, downloads: ['https://cdn.modrinth.com/data/a/good.jar'] }] }) });
        await expect(setup(pack).service.install('srv', 'ver1')).rejects.toMatchObject({ code: 'CHECKSUM' });
        // The folder is emptied again, so the install can be tried again.
        expect(fs.readdirSync(folder)).toEqual([]);
    });

    test('only a new, empty folder gets a pack, and its files are left alone', async () => {
        fs.writeFileSync(path.join(folder, 'world.dat'), 'mine');
        const { service, install } = setup(mrpack);
        await expect(service.install('srv', 'ver1')).rejects.toMatchObject({ code: 'INVALID' });
        expect(install).not.toHaveBeenCalled();
        expect(fs.readdirSync(folder)).toEqual(['world.dat']);
    });

    test('imports a server pack zip without its top folder, and runs the Forge installer in it', async () => {
        const zipPath = path.join(os.tmpdir(), `mcs-serverpack-${process.pid}.zip`);
        fs.writeFileSync(zipPath, await zipOf({
            'All the Mods 10/forge-1.21.1-52.0.10-installer.jar': 'installer',
            'All the Mods 10/mods/a.jar': 'a',
        }));
        try {
            const { service, runInstallerFile } = setup(mrpack);
            const result = await service.importZip('srv', zipPath);
            expect(runInstallerFile).toHaveBeenCalledWith('srv', 'forge-1.21.1-52.0.10-installer.jar');
            expect(fs.readFileSync(path.join(folder, 'mods', 'a.jar'), 'utf8')).toBe('a');
            expect(result).toEqual({ info: { source: 'zip', title: `mcs-serverpack-${process.pid}` }, javaNeeded: 17 });
            expect(JSON.parse(fs.readFileSync(path.join(folder, MODPACK_FILE), 'utf8'))).toEqual(result.info);
        } finally {
            fs.rmSync(zipPath, { force: true });
        }
    });

    test('a pack note links only to Modrinth', async () => {
        fs.writeFileSync(path.join(folder, MODPACK_FILE), JSON.stringify({ source: 'modrinth', title: 'X', url: 'https://evil.example/' }));
        expect(await setup(mrpack).service.info('srv')).toEqual({ source: 'modrinth', title: 'X', url: undefined });
        fs.writeFileSync(path.join(folder, MODPACK_FILE), 'not json');
        expect(await setup(mrpack).service.info('srv')).toBeNull();
    });

    test('packPath keeps paths inside the folder', () => {
        expect(packPath('mods/a.jar')).toBe('mods/a.jar');
        expect(packPath('config\\b.toml')).toBe('config/b.toml');
        expect(packPath('./mods//c.jar')).toBe('mods/c.jar');
        expect(packPath('../x')).toBeNull();
        expect(packPath('mods/../../x')).toBeNull();
        expect(packPath('/etc/x')).toBeNull();
        expect(packPath('C:/Windows/x')).toBeNull();
        expect(packPath('')).toBeNull();
    });
});
