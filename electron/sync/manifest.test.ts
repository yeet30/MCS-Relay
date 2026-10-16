import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDriveStore } from '../../test/fakes/FakeDrive';
import { DEFAULT_SHARED_IGNORES } from '../../shared/paths';
import type { BaseSnapshot, Manifest } from '../../shared/types';
import { AppError } from '../errors';
import { LauncherFiles } from './launcherFiles';
import {
    baseToSnapshot, emptyManifest, manifestToSnapshot, parseManifest, parseRules, readManifest, readRules,
    serializeManifest, serializeRules, writeManifest, writeRules,
} from './manifest';

const MD5_A = '0cc175b9c0f1b6a831c399e269772661';
const MD5_B = '92eb5ffee6ae2fec3ad71c777531578f';

function sample(): Manifest {
    return {
        format: 2,
        revision: 43,
        parentRevision: 42,
        author: { name: 'Alex', email: 'alex@example.com' },
        createdAt: '2026-10-15T12:00:00.000Z',
        files: {
            'world/region/r.0.0.mca': { size: 4096, md5: MD5_B, driveId: 'd2' },
            'server.properties': { size: 1, md5: MD5_A, driveId: 'd1' },
        },
        folders: { 'world/region': 'f2', world: 'f1' },
    };
}

function expectInvalid(text: string): void {
    let caught: unknown;
    try {
        parseManifest(text);
    } catch (err) {
        caught = err;
    }
    expect(caught, text).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('INVALID');
}

function withField(field: string, value: unknown): string {
    return JSON.stringify({ ...sample(), [field]: value });
}

describe('emptyManifest', () => {
    it('is revision 0 with no files and no folders', () => {
        const m = emptyManifest({ name: 'Alex', email: 'alex@example.com' });
        expect(m).toMatchObject({ format: 2, revision: 0, parentRevision: 0, author: { name: 'Alex', email: 'alex@example.com' }, files: {}, folders: {} });
        expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false);
    });
});

describe('serializeManifest / parseManifest', () => {
    it('round-trips', () => {
        const m = sample();
        const text = serializeManifest(m);
        expect(parseManifest(text)).toEqual(m);
        expect(serializeManifest(parseManifest(text))).toBe(text);
    });

    it('writes a stable key order with files and folders sorted by path, 2-space indented', () => {
        const text = serializeManifest(sample());
        expect(Object.keys(JSON.parse(text))).toEqual(['format', 'revision', 'parentRevision', 'author', 'createdAt', 'files', 'folders']);
        expect(Object.keys(JSON.parse(text).files)).toEqual(['server.properties', 'world/region/r.0.0.mca']);
        expect(Object.keys(JSON.parse(text).folders)).toEqual(['world', 'world/region']);
        expect(text).toContain('\n  "revision": 43,');
        expect(text).toContain('"size": 4096,\n      "md5": "92eb5ffee6ae2fec3ad71c777531578f",\n      "driveId": "d2"');

        const shuffled = sample();
        shuffled.files = Object.fromEntries(Object.entries(shuffled.files).reverse());
        expect(serializeManifest(shuffled)).toBe(text);
    });

    it('fills a missing "folders" with {}', () => {
        const raw = JSON.parse(serializeManifest(sample()));
        delete raw.folders;
        expect(parseManifest(JSON.stringify(raw)).folders).toEqual({});
    });

    it('drops unknown fields', () => {
        const m = parseManifest(JSON.stringify({ ...sample(), extra: 1 }));
        expect(m).toEqual(sample());
    });

    it('throws AppError INVALID for anything that is not a format 2 manifest', () => {
        expectInvalid('');
        expectInvalid('{not json');
        expectInvalid('[]');
        expectInvalid('null');
        expectInvalid(withField('format', 1));
        expectInvalid(withField('format', '2'));
        expectInvalid(withField('revision', undefined));
        expectInvalid(withField('revision', -1));
        expectInvalid(withField('revision', 1.5));
        expectInvalid(withField('revision', '43'));
        expectInvalid(withField('parentRevision', null));
        expectInvalid(withField('author', 'Alex'));
        expectInvalid(withField('author', { name: 'Alex' }));
        expectInvalid(withField('createdAt', 123));
        expectInvalid(withField('files', []));
        expectInvalid(withField('files', { a: { size: 1, md5: MD5_A } }));
        expectInvalid(withField('files', { a: { size: '1', md5: MD5_A, driveId: 'd' } }));
        expectInvalid(withField('files', { a: { size: -1, md5: MD5_A, driveId: 'd' } }));
        expectInvalid(withField('files', { a: 'x' }));
        expectInvalid(withField('folders', []));
        expectInvalid(withField('folders', { world: 5 }));
    });

    it('refuses paths that could point outside the server folder', () => {
        for (const bad of ['../evil.jar', 'world/../../evil', '/etc/passwd', 'C:/Windows/x', 'world\\level.dat', 'a//b', './a', 'a/', '']) {
            expectInvalid(withField('files', { [bad]: { size: 1, md5: MD5_A, driveId: 'd' } }));
        }
        expectInvalid(withField('folders', { '../up': 'f' }));
    });

    it('the error message is written for the user, the detail for the log', () => {
        try {
            parseManifest('{');
            expect.unreachable();
        } catch (err) {
            expect((err as AppError).message).toMatch(/manifest\.json/);
            expect((err as AppError).detail).toMatch(/^manifest\.json: not JSON/);
        }
    });
});

describe('snapshots', () => {
    it('manifestToSnapshot keeps size, md5 and driveId', () => {
        const snap = manifestToSnapshot(sample());
        expect([...snap.keys()]).toEqual(['server.properties', 'world/region/r.0.0.mca']);
        expect(snap.get('world/region/r.0.0.mca')).toEqual({ size: 4096, md5: MD5_B, driveId: 'd2' });
    });

    it('manifestToSnapshot(null) and baseToSnapshot(null) are empty', () => {
        expect(manifestToSnapshot(null).size).toBe(0);
        expect(baseToSnapshot(null).size).toBe(0);
    });

    it('baseToSnapshot keeps the local mtime', () => {
        const base: BaseSnapshot = {
            format: 2, serverId: 's', revision: 3, folders: {},
            files: { 'level.dat': { size: 5, md5: MD5_A, driveId: 'd1', mtimeMs: 1234.5 } },
        };
        expect(baseToSnapshot(base).get('level.dat')).toEqual({ size: 5, md5: MD5_A, driveId: 'd1', mtimeMs: 1234.5 });
    });
});

describe('rules', () => {
    it('parseRules returns the normalized ignore list', () => {
        const text = JSON.stringify({ format: 1, ignore: [' logs\\ ', '*.tmp', 'logs/', '../x', '', 7, 'world/stats'] });
        expect(parseRules(text)).toEqual(['logs/', '*.tmp', 'world/stats']);
    });

    it('parseRules falls back to the defaults for bad JSON or a missing list', () => {
        expect(parseRules('{oops')).toEqual(DEFAULT_SHARED_IGNORES);
        expect(parseRules('{"format":1}')).toEqual(DEFAULT_SHARED_IGNORES);
        expect(parseRules('[]')).toEqual(DEFAULT_SHARED_IGNORES);
        const copy = parseRules('');
        copy.push('mutated');
        expect(DEFAULT_SHARED_IGNORES).not.toContain('mutated');
    });

    it('an empty list stays empty (the members removed every rule)', () => {
        expect(parseRules('{"format":1,"ignore":[]}')).toEqual([]);
    });

    it('serializeRules writes { format: 1, ignore } and round-trips', () => {
        const text = serializeRules(['logs/', '*.tmp']);
        expect(JSON.parse(text)).toEqual({ format: 1, ignore: ['logs/', '*.tmp'] });
        expect(parseRules(text)).toEqual(['logs/', '*.tmp']);
    });
});

describe('Drive access through LauncherFiles', () => {
    let store: FakeDriveStore;
    let serverId: string;
    let launcher: LauncherFiles;

    beforeEach(() => {
        store = new FakeDriveStore();
        serverId = store.createRoot('Server-1', 'owner@example.com');
        launcher = new LauncherFiles(store.as('owner@example.com'));
    });

    it('readManifest and readRules return null when nothing exists yet', async () => {
        expect(await readManifest(launcher, serverId)).toBeNull();
        expect(await readRules(launcher, serverId)).toBeNull();
    });

    it('readManifest and readRules return null when .launcher exists without the file', async () => {
        await launcher.ensureFolder(serverId);
        expect(await readManifest(launcher, serverId)).toBeNull();
        expect(await readRules(launcher, serverId)).toBeNull();
    });

    it('writeManifest creates .launcher/manifest.json; readManifest reads it back', async () => {
        await writeManifest(launcher, serverId, sample());

        const node = store.findPath(serverId, '.launcher/manifest.json');
        expect(node).toBeDefined();
        expect(store.text(node!.id)).toBe(serializeManifest(sample()));
        expect(await readManifest(launcher, serverId)).toEqual(sample());
    });

    it('writeManifest updates the same file in place', async () => {
        await writeManifest(launcher, serverId, sample());
        const first = store.findPath(serverId, '.launcher/manifest.json')!;
        const next = { ...sample(), revision: 44, parentRevision: 43 };

        await writeManifest(launcher, serverId, next);

        const launcherFolder = store.findPath(serverId, '.launcher')!;
        expect(store.children(launcherFolder.id).filter((n) => n.name === 'manifest.json')).toHaveLength(1);
        expect(store.findPath(serverId, '.launcher/manifest.json')!.id).toBe(first.id);
        expect((await readManifest(launcher, serverId))?.revision).toBe(44);
    });

    it('another member reads what the owner wrote', async () => {
        await writeManifest(launcher, serverId, sample());
        await writeRules(launcher, serverId, ['logs/', 'world/stats']);
        const friend = new LauncherFiles(store.as('friend@example.com'));

        expect(await readManifest(friend, serverId)).toEqual(sample());
        expect(await readRules(friend, serverId)).toEqual(['logs/', 'world/stats']);
    });

    it('writeRules creates .launcher/sync-rules.json without the builtin rules', async () => {
        await writeRules(launcher, serverId, ['logs/', '*.tmp']);

        const node = store.findPath(serverId, '.launcher/sync-rules.json')!;
        expect(JSON.parse(store.text(node.id))).toEqual({ format: 1, ignore: ['logs/', '*.tmp'] });
        expect(await readRules(launcher, serverId)).toEqual(['logs/', '*.tmp']);

        await writeRules(launcher, serverId, ['debug/']);
        expect(await readRules(launcher, serverId)).toEqual(['debug/']);
    });

    it('readManifest throws AppError INVALID for a damaged manifest', async () => {
        await launcher.writeText(serverId, 'manifest.json', '{"format": 2, "revision": "x"}');
        await expect(readManifest(launcher, serverId)).rejects.toMatchObject({ name: 'AppError', code: 'INVALID' });
    });

    it('readRules falls back to the defaults for a damaged sync-rules.json', async () => {
        await launcher.writeText(serverId, 'sync-rules.json', 'not json');
        expect(await readRules(launcher, serverId)).toEqual(DEFAULT_SHARED_IGNORES);
    });
});
