import { createHash } from 'node:crypto';
import { createReadStream, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors';
import type { Snapshot } from '../../shared/types';
import { md5OfFile, scanLocal } from './scanner';

const hoisted = vi.hoisted(() => ({ realCreateReadStream: null as null | typeof import('node:fs').createReadStream }));

// Wraps createReadStream so tests can count reads (each hash opens one stream) and inject failures.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    hoisted.realCreateReadStream = actual.createReadStream;
    return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const readSpy = vi.mocked(createReadStream);
const noRules = (): boolean => false;

function md5(text: string | Buffer): string {
    return createHash('md5').update(text).digest('hex');
}

function readsOf(file: string): number {
    return readSpy.mock.calls.filter(([p]) => path.resolve(String(p)) === path.resolve(file)).length;
}

let root: string;

beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'mdh-scan-'));
    readSpy.mockClear();
    readSpy.mockImplementation(hoisted.realCreateReadStream as typeof createReadStream);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function put(rel: string, content: string | Buffer): Promise<string> {
    const abs = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return abs;
}

describe('md5OfFile', () => {
    it('hashes small, empty and multi-chunk files', async () => {
        const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
        expect(await md5OfFile(await put('a.txt', 'hello'))).toBe(md5('hello'));
        expect(await md5OfFile(await put('empty', ''))).toBe(md5(''));
        expect(await md5OfFile(await put('big.bin', big))).toBe(md5(big));
    });

    it('rejects when the signal is already aborted', async () => {
        const file = await put('a.txt', 'hello');
        const controller = new AbortController();
        controller.abort();
        await expect(md5OfFile(file, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('scanLocal', () => {
    it('returns POSIX relative paths with size, mtime and md5, sorted by path', async () => {
        await put('server.properties', 'motd=hi');
        await put('world/level.dat', 'level');
        await put('world/region/r.0.0.mca', 'region');
        await mkdir(path.join(root, 'empty-folder'));

        const snap = await scanLocal(root, new Map(), noRules);

        expect([...snap.keys()]).toEqual(['server.properties', 'world/level.dat', 'world/region/r.0.0.mca']);
        const st = await stat(path.join(root, 'world', 'region', 'r.0.0.mca'));
        expect(snap.get('world/region/r.0.0.mca')).toEqual({ size: 6, md5: md5('region'), mtimeMs: st.mtimeMs });
    });

    it('fast path: same size and mtime reuse the base md5 and driveId without reading the file', async () => {
        const file = await put('world/level.dat', 'level');
        const st = await stat(file);
        const base: Snapshot = new Map([['world/level.dat', { size: st.size, mtimeMs: st.mtimeMs, md5: 'md5-from-base', driveId: 'drive-1' }]]);

        const snap = await scanLocal(root, base, noRules);

        expect(snap.get('world/level.dat')).toEqual({ size: st.size, mtimeMs: st.mtimeMs, md5: 'md5-from-base', driveId: 'drive-1' });
        expect(readsOf(file)).toBe(0);
    });

    it('re-hashes a file whose mtime changed, even with the same size', async () => {
        const file = await put('world/level.dat', 'level');
        const st = await stat(file);
        await utimes(file, new Date(), new Date(st.mtimeMs + 5000));
        const base: Snapshot = new Map([['world/level.dat', { size: st.size, mtimeMs: st.mtimeMs, md5: 'stale', driveId: 'drive-1' }]]);

        const snap = await scanLocal(root, base, noRules);

        expect(snap.get('world/level.dat')?.md5).toBe(md5('level'));
        expect(snap.get('world/level.dat')?.mtimeMs).not.toBe(st.mtimeMs);
        expect(snap.get('world/level.dat')?.driveId).toBeUndefined();
        expect(readsOf(file)).toBe(1);
    });

    it('re-hashes a file whose size changed, and one whose base mtime is -1', async () => {
        const a = await put('a.txt', 'aaaa');
        const b = await put('b.txt', 'bbbb');
        const stA = await stat(a);
        const stB = await stat(b);
        const base: Snapshot = new Map([
            ['a.txt', { size: stA.size + 1, mtimeMs: stA.mtimeMs, md5: 'stale' }],
            ['b.txt', { size: stB.size, mtimeMs: -1, md5: 'stale' }],
        ]);

        const snap = await scanLocal(root, base, noRules);

        expect(snap.get('a.txt')?.md5).toBe(md5('aaaa'));
        expect(snap.get('b.txt')?.md5).toBe(md5('bbbb'));
        expect(readsOf(a) + readsOf(b)).toBe(2);
    });

    it('does not descend into ignored folders and leaves out ignored files', async () => {
        await put('logs/latest.log', 'log');
        await put('logs/old/1.log', 'log');
        await put('world/level.dat', 'level');
        await put('world/session.lock', 'lock');
        const isIgnored = vi.fn((rel: string) => rel === 'logs' || rel.endsWith('session.lock'));

        const snap = await scanLocal(root, new Map(), isIgnored);

        expect([...snap.keys()]).toEqual(['world/level.dat']);
        const asked = isIgnored.mock.calls.map(([rel]) => rel);
        expect(asked).toContain('logs');
        expect(asked.filter((rel) => rel.startsWith('logs/'))).toEqual([]);
    });

    it('skips a file that vanishes between listing and stat', async () => {
        const gone = await put('world/gone.dat', 'bye');
        await put('world/kept.dat', 'kept');
        // isIgnored runs right after readdir, before the file is stat-ed.
        const isIgnored = (rel: string): boolean => {
            if (rel === 'world/gone.dat') unlinkSync(gone);
            return false;
        };

        const snap = await scanLocal(root, new Map(), isIgnored);

        expect([...snap.keys()]).toEqual(['world/kept.dat']);
    });

    it('skips a file that vanishes between stat and hashing', async () => {
        await put('a.txt', 'a');
        const vanishing = await put('b.txt', 'b');
        await put('c.txt', 'c');
        readSpy.mockImplementation(((p: string, opts: object) => {
            if (path.resolve(String(p)) === path.resolve(vanishing)) {
                return Readable.from((async function* () {
                    yield* [];
                    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
                })());
            }
            return (hoisted.realCreateReadStream as typeof createReadStream)(p, opts);
        }) as typeof createReadStream);

        const snap = await scanLocal(root, new Map(), noRules);

        expect([...snap.keys()]).toEqual(['a.txt', 'c.txt']);
    });

    it('fails with an AppError (instead of skipping) when a file cannot be read', async () => {
        await put('world/level.dat', 'level');
        readSpy.mockImplementation((() => Readable.from((async function* () {
            yield* [];
            throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        })())) as unknown as typeof createReadStream);

        const err = await scanLocal(root, new Map(), noRules).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).message).toContain('world/level.dat');
    });

    it('returns an empty snapshot when the root does not exist or is a file', async () => {
        expect((await scanLocal(path.join(root, 'missing'), new Map(), noRules)).size).toBe(0);
        const file = await put('not-a-folder', 'x');
        expect((await scanLocal(file, new Map(), noRules)).size).toBe(0);
    });

    it('does not follow symlinks or junctions', async () => {
        const outside = await mkdtemp(path.join(os.tmpdir(), 'mdh-outside-'));
        try {
            await writeFile(path.join(outside, 'secret.txt'), 'secret');
            await put('world/level.dat', 'level');
            try {
                await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
            } catch {
                return;     // the OS refused to create a link; nothing to test here
            }

            const snap = await scanLocal(root, new Map(), noRules);

            expect([...snap.keys()]).toEqual(['world/level.dat']);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    it('stops with an AbortError when the signal aborts', async () => {
        await put('a.txt', 'a');
        const controller = new AbortController();
        controller.abort();
        await expect(scanLocal(root, new Map(), noRules, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('scans many files with limited concurrency and gets every hash right', async () => {
        const expected = new Map<string, string>();
        for (let i = 0; i < 40; i++) {
            const rel = `world/region/r.${i}.0.mca`;
            await put(rel, `content-${i}`);
            expected.set(rel, md5(`content-${i}`));
        }
        let open = 0;
        let maxOpen = 0;
        readSpy.mockImplementation(((p: string, opts: object) => {
            const stream = (hoisted.realCreateReadStream as typeof createReadStream)(p, opts);
            open++;
            maxOpen = Math.max(maxOpen, open);
            stream.on('close', () => open--);
            return stream;
        }) as typeof createReadStream);

        const snap = await scanLocal(root, new Map(), noRules);

        expect(new Map([...snap].map(([rel, e]) => [rel, e.md5]))).toEqual(expected);
        expect(maxOpen).toBeLessThanOrEqual(8);
    });
});
