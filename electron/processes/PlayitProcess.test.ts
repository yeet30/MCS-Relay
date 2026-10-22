import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChildProcess, fakeExecFile, fakeSpawn, until } from '../../test/fakes/FakeChildProcess';
import { AppError } from '../errors';
import { stripAnsi } from './MinecraftProcess';
import { PlayitProcess, parsePlayitScreen } from './PlayitProcess';

/** One screen as playit.gg 0.15 draws it, with a Minecraft and a voice chat tunnel. */
const SCREEN = [
    '\x1b[2J\x1b[1;1Hplayit (v0.15.26): 1729600000000 tunnel running, 3 tunnels registered',
    '',
    '',
    'TUNNELS',
    '\x1b[1mfox-river.gl.joinmc.link\x1b[0m => 127.0.0.1:25565 (minecraft-java)',
    'fox-voice.gl.at.ply.gg:41234 => 127.0.0.1:24454 (proto: Udp, port count: 1)',
    'old-map.gl.at.ply.gg:5000 => 127.0.0.1:8123 (disabled)',
    '\tsee: https://playit.gg/account/tunnels/abc',
    'tunnel pending: https://playit.gg/account/tunnels/def',
    '',
].join('\n');

const JAVA = { address: 'fox-river.gl.joinmc.link', type: 'minecraft-java', local: '127.0.0.1:25565' };
const VOICE = { address: 'fox-voice.gl.at.ply.gg:41234', type: 'udp', local: '127.0.0.1:24454' };

describe('parsePlayitScreen', () => {
    it('lists every tunnel that is on, with its type, from the newest screen', () => {
        const older = 'playit (v0.15.26): 1 tunnel running, 1 tunnels registered\n\nTUNNELS\nold.joinmc.link => 127.0.0.1:25565 (minecraft-java)\n';
        const text = stripAnsi(older + SCREEN);
        expect(parsePlayitScreen(text)).toEqual({ tunnels: [JAVA, VOICE], disabled: 1, addUrl: null });
    });

    it('names plain tunnels by protocol and keeps playit.gg types as they are', () => {
        const text = 'TUNNELS\na.ply.gg:1 => 127.0.0.1:2 (proto: Both, port count: 1)\nb.ply.gg:3 => 127.0.0.1:19132 (minecraft-bedrock)\n';
        expect(parsePlayitScreen(text).tunnels.map((t) => t.type)).toEqual(['tcp+udp', 'minecraft-bedrock']);
    });

    it('reports where to add a tunnel when there is none', () => {
        const text = 'playit (v0.15.26): 1 tunnel running, 0 tunnels registered\n\nTUNNELS\nAdd tunnels here: https://playit.gg/account/agents/default\n';
        expect(parsePlayitScreen(text)).toEqual({ tunnels: [], disabled: 0, addUrl: 'https://playit.gg/account/agents/default' });
    });
});

let dir: string;
let exe: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mdh-playit-'));
    exe = path.join(dir, 'playit.exe');
    await writeFile(exe, '');
});

afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
});

function harness(platform: NodeJS.Platform = 'win32', opts: { taskkillFails?: boolean } = {}) {
    const spawn = fakeSpawn();
    const exec = fakeExecFile(() => spawn.calls.map((c) => c.child), opts);
    const playit = new PlayitProcess({ spawnImpl: spawn.spawnImpl, execFileImpl: exec.execFileImpl, platform });
    return { playit, spawn, exec };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
    const err: unknown = await promise.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
}

async function spawned(h: ReturnType<typeof harness>): Promise<FakeChildProcess> {
    await until(() => h.spawn.calls.length === 1);
    return h.spawn.calls[0].child;
}

describe('PlayitProcess.start', () => {
    it('resolves with every tunnel from coloured output', async () => {
        const h = harness();
        const started = h.playit.start(exe, 2000);
        const child = await spawned(h);
        expect(h.spawn.calls[0].command).toBe(exe);
        expect(h.spawn.calls[0].options).toMatchObject({ windowsHide: true });
        child.print(SCREEN);
        await expect(started).resolves.toEqual([JAVA, VOICE]);
        expect(h.playit.isRunning()).toBe(true);
    });

    it('waits for a list that arrives in pieces', async () => {
        const h = harness();
        const started = h.playit.start(exe, 2000);
        const child = await spawned(h);
        child.print('TUNNELS\nabc-12.joinmc.li');
        child.print('nk \x1b');
        child.print('[0m=> 127.0.0.1:25565 (minecraft-java)\n');
        await new Promise((r) => setTimeout(r, 50));
        child.print('v.ply.gg:7 => 127.0.0.1:24454 (proto: Udp, port count: 1)\n');
        await expect(started).resolves.toEqual([
            { address: 'abc-12.joinmc.link', type: 'minecraft-java', local: '127.0.0.1:25565' },
            { address: 'v.ply.gg:7', type: 'udp', local: '127.0.0.1:24454' },
        ]);
    });

    it('tells about tunnels added while it runs', async () => {
        const h = harness();
        const changes: unknown[] = [];
        const started = h.playit.start(exe, 2000, undefined, (tunnels) => changes.push(tunnels));
        const child = await spawned(h);
        child.print('playit (v0.15.26): 1 tunnel running\nTUNNELS\nfox-river.gl.joinmc.link => 127.0.0.1:25565 (minecraft-java)\n');
        await expect(started).resolves.toEqual([JAVA]);
        child.print('playit (v0.15.26): 1 tunnel running\nTUNNELS\nfox-river.gl.joinmc.link => 127.0.0.1:25565 (minecraft-java)\n');
        child.print(SCREEN);
        expect(changes).toEqual([[JAVA, VOICE]]);
    });

    it('fails at once with where to add one when the agent has no tunnels', async () => {
        const h = harness();
        const started = h.playit.start(exe, 5000);
        const child = await spawned(h);
        child.print('playit (v0.15.26): 1 tunnel running, 0 tunnels registered\n\nTUNNELS\nAdd tunnels here: https://playit.gg/account/agents/default\n');
        const err = await expectAppError(started, 'PLAYIT');
        expect(err.message).toContain('no tunnels');
        expect(err.detail).toBe('https://playit.gg/account/agents/default');
        expect(h.playit.isRunning()).toBe(false);
    });

    it('fails with PLAYIT when the executable does not exist', async () => {
        const h = harness();
        await expectAppError(h.playit.start(path.join(dir, 'missing.exe'), 1000), 'PLAYIT');
        await expectAppError(h.playit.start('', 1000), 'PLAYIT');
        expect(h.spawn.calls).toHaveLength(0);
    });

    it('fails with PLAYIT and the output when the agent exits early', async () => {
        const h = harness();
        const started = h.playit.start(exe, 5000);
        const child = await spawned(h);
        child.print('Error: failed to load secret\n', 'stderr');
        await new Promise((r) => setTimeout(r, 20));
        child.exit(1);
        const err = await expectAppError(started, 'PLAYIT');
        expect(err.message).toContain('exit code 1');
        expect(err.detail).toContain('failed to load secret');
        expect(h.playit.isRunning()).toBe(false);
    });

    it('fails with PLAYIT when the program cannot be started', async () => {
        const h = harness();
        h.spawn.next.child = new FakeChildProcess(null);
        const started = h.playit.start(exe, 5000);
        const child = await spawned(h);
        child.failToSpawn('spawn playit.exe EACCES');
        const err = await expectAppError(started, 'PLAYIT');
        expect(err.detail).toContain('EACCES');
    });

    it('kills the agent tree and fails with TIMEOUT when no address appears (Windows)', async () => {
        const h = harness('win32');
        const started = h.playit.start(exe, 100);
        const child = await spawned(h);
        child.print('connecting to tunnel server\n');
        const err = await expectAppError(started, 'TIMEOUT');
        expect(err.detail).toContain('connecting to tunnel server');
        expect(h.exec.calls).toEqual([{ file: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }]);
        expect(h.playit.isRunning()).toBe(false);
    });

    it('stops with SIGTERM on a timeout elsewhere', async () => {
        const h = harness('linux');
        const started = h.playit.start(exe, 100);
        const child = await spawned(h);
        await expectAppError(started, 'TIMEOUT');
        expect(child.signals).toEqual(['SIGTERM']);
        expect(h.exec.calls).toEqual([]);
    });

    it('fails early with a setup message when the agent is not linked to an account', async () => {
        const h = harness();
        const started = h.playit.start(exe, 5000);
        const child = await spawned(h);
        child.print('Visit link to setup https://playit.gg/claim/0a1b2c3d4e\n');
        const err = await expectAppError(started, 'PLAYIT');
        expect(err.message).toContain('not linked');
        expect(err.detail).toBe('https://playit.gg/claim/0a1b2c3d4e');
        expect(h.playit.isRunning()).toBe(false);
    });

    it('kills the agent when the signal aborts', async () => {
        const h = harness();
        const controller = new AbortController();
        const started = h.playit.start(exe, 5000, controller.signal);
        await spawned(h);
        controller.abort();
        await expect(started).rejects.toMatchObject({ name: 'AbortError' });
        expect(h.playit.isRunning()).toBe(false);
    });

    it('refuses to start twice', async () => {
        const h = harness();
        const started = h.playit.start(exe, 2000);
        const child = await spawned(h);
        child.print('x.joinmc.link => 127.0.0.1:25565 (minecraft-java)\n');
        await started;
        await expectAppError(h.playit.start(exe, 2000), 'BUSY');
    });
});

describe('PlayitProcess.stop', () => {
    async function running(h: ReturnType<typeof harness>): Promise<FakeChildProcess> {
        const started = h.playit.start(exe, 2000);
        const child = await spawned(h);
        child.print('x.joinmc.link => 127.0.0.1:25565 (minecraft-java)\n');
        await started;
        return child;
    }

    it('is a no-op when not running', async () => {
        const h = harness();
        await h.playit.stop();
        expect(h.exec.calls).toEqual([]);
    });

    it('uses taskkill /T /F on Windows and waits for the exit', async () => {
        const h = harness('win32');
        await running(h);
        await h.playit.stop();
        expect(h.exec.calls).toEqual([{ file: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }]);
        expect(h.playit.isRunning()).toBe(false);
    });

    it('falls back to kill() when taskkill fails', async () => {
        const h = harness('win32', { taskkillFails: true });
        const child = await running(h);
        await h.playit.stop();
        expect(child.signals).toEqual(['SIGKILL']);
        expect(h.playit.isRunning()).toBe(false);
    });

    it('sends SIGTERM, then SIGKILL when the agent ignores it', async () => {
        const h = harness('linux');
        const child = await running(h);
        child.killExitsOn = ['SIGKILL'];
        vi.useFakeTimers();
        const stopping = h.playit.stop();
        expect(h.playit.stop()).toBe(stopping);
        expect(child.signals).toEqual(['SIGTERM']);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
        await vi.advanceTimersByTimeAsync(2_000);
        await stopping;
        expect(h.playit.isRunning()).toBe(false);
    });

    it('keeps reading output after the address so the agent never blocks on a full pipe', async () => {
        const h = harness();
        const child = await running(h);
        child.print('a'.repeat(100_000));
        await until(() => child.stdout.readableLength === 0);
        expect(child.stdout.readableFlowing).toBe(true);
    });
});
