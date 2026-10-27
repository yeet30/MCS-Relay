import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JavaFlags } from '../../shared/types';
import { FakeChildProcess, fakeExecFile, fakeSpawn, until } from '../../test/fakes/FakeChildProcess';
import { AppError } from '../errors';
import { chooseServerJar, compareVersions, MinecraftProcess, parsePlayerList, splitArgs, stripAnsi } from './MinecraftProcess';

const FLAGS: JavaFlags = { minRAM: 2048, maxRAM: 4096, customFlags: '' };
const DONE = '[12:00:05] [Server thread/INFO]: Done (4.215s)! For help, type "help"\n';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mdh-mc-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
    const err: unknown = await promise.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
}

function catchError(fn: () => unknown): unknown {
    try {
        fn();
    } catch (err) {
        return err;
    }
    return null;
}

/* ------------------------------------------------------------------ parsing */

describe('splitArgs', () => {
    it('keeps quoted spaces and removes the quotes, also inside an argument', () => {
        expect(splitArgs('-XX:+UseG1GC  -Dname="hello world" \'-Dx=a b\' @"my args.txt"')).toEqual([
            '-XX:+UseG1GC', '-Dname=hello world', '-Dx=a b', '@my args.txt',
        ]);
    });

    it('keeps a quote without a partner and backslashes as they are', () => {
        expect(splitArgs('-Dmotd=Bob\'s C:\\Java\\bin')).toEqual(['-Dmotd=Bob\'s', 'C:\\Java\\bin']);
        expect(splitArgs('   ')).toEqual([]);
        expect(splitArgs('a "" b')).toEqual(['a', '', 'b']);
    });
});

describe('stripAnsi', () => {
    it('removes colours, cursor codes and window titles', () => {
        expect(stripAnsi('\x1b[32mHello\x1b[0m \x1b[?25l\x1b[2Kworld\x1b]0;title\x07!')).toBe('Hello world!');
    });
});

describe('parsePlayerList', () => {
    it('parses the modern reply', () => {
        expect(parsePlayerList('[12:00:00] [Server thread/INFO]: There are 2 of a max of 20 players online: Steve, Alex')).toEqual({
            count: 2, max: 20, players: ['Steve', 'Alex'], namesOnNextLine: false,
        });
        expect(parsePlayerList('[12:00:00] [Server thread/INFO]: There are 0 of a max of 10 players online:')?.players).toEqual([]);
    });

    it('parses the old two-line reply', () => {
        expect(parsePlayerList('[12:00:00 INFO]: There are 1/20 players online:')).toEqual({ count: 1, max: 20, players: [], namesOnNextLine: true });
    });

    it('ignores chat messages that quote a reply', () => {
        expect(parsePlayerList('[12:00:00] [Server thread/INFO]: <Bob> There are 9 of a max of 9 players online: Fake')).toBeNull();
        expect(parsePlayerList('[12:00:00] [Server thread/INFO]: Steve joined the game')).toBeNull();
    });
});

/* ------------------------------------------------------------------ launch arguments */

describe('buildLaunchArgs', () => {
    it('uses the one jar with memory and custom flags', async () => {
        await writeFile(path.join(dir, 'server.jar'), '');
        await mkdir(path.join(dir, 'plugins.jar'));            // a folder, not a jar
        const flags: JavaFlags = { minRAM: 1024, maxRAM: 3072, customFlags: '-XX:+UseG1GC -Dmotd="a b"' };
        expect(MinecraftProcess.buildLaunchArgs(dir, flags, 'win32')).toEqual([
            '-Xmx3072M', '-Xms1024M', '-XX:+UseG1GC', '-Dmotd=a b', '-jar', 'server.jar', 'nogui',
        ]);
    });

    it('fails without a jar or with several jars', async () => {
        expect((catchError(() => MinecraftProcess.buildLaunchArgs(dir, FLAGS, 'win32')) as AppError).code).toBe('JAVA');
        await writeFile(path.join(dir, 'spigot.jar'), '');
        await writeFile(path.join(dir, 'other.JAR'), '');
        const err = catchError(() => MinecraftProcess.buildLaunchArgs(dir, FLAGS, 'win32')) as AppError;
        expect(err.code).toBe('JAVA');
        expect(err.message).toContain('other.JAR');
    });

    it('fails when the folder does not exist', () => {
        expect((catchError(() => MinecraftProcess.buildLaunchArgs(path.join(dir, 'nope'), FLAGS)) as AppError).code).toBe('NO_LOCAL_PATH');
    });

    it('starts Forge and NeoForge from their newest args file for this platform, without run.bat', async () => {
        await writeFile(path.join(dir, 'run.bat'), 'java @user_jvm_args.txt @libraries/x/win_args.txt %*\r\n');
        for (const version of ['1.20.1-47.2.0', '1.20.1-47.10.1']) {
            const folder = path.join(dir, 'libraries', 'net', 'minecraftforge', 'forge', version);
            await mkdir(folder, { recursive: true });
            await writeFile(path.join(folder, 'win_args.txt'), '');
            await writeFile(path.join(folder, 'unix_args.txt'), '');
        }
        await writeFile(path.join(dir, 'forge-1.20.1-47.10.1-installer.jar'), '');
        expect(MinecraftProcess.buildLaunchArgs(dir, FLAGS, 'win32')).toEqual([
            '-Xmx4096M', '-Xms2048M', '@libraries/net/minecraftforge/forge/1.20.1-47.10.1/win_args.txt', 'nogui',
        ]);
        expect(MinecraftProcess.buildLaunchArgs(dir, FLAGS, 'linux')[2]).toBe('@libraries/net/minecraftforge/forge/1.20.1-47.10.1/unix_args.txt');

        const neo = path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.72');
        await mkdir(neo, { recursive: true });
        await writeFile(path.join(neo, 'win_args.txt'), '');
        expect(MinecraftProcess.buildLaunchArgs(dir, FLAGS, 'win32')[2]).toBe('@libraries/net/neoforged/neoforge/21.1.72/win_args.txt');
    });

    it('uses "java" from PATH unless a Java program was chosen, and fails when that one is gone', async () => {
        await writeFile(path.join(dir, 'server.jar'), '');
        expect(MinecraftProcess.resolveLaunch(dir, FLAGS, 'win32').command).toBe('java');
        const javaExe = path.join(dir, 'jdk', 'bin', 'java.exe');
        await mkdir(path.dirname(javaExe), { recursive: true });
        await writeFile(javaExe, '');
        expect(MinecraftProcess.resolveLaunch(dir, FLAGS, 'win32', javaExe).command).toBe(javaExe);
        const err = catchError(() => MinecraftProcess.resolveLaunch(dir, FLAGS, 'win32', path.join(dir, 'missing', 'java.exe'))) as AppError;
        expect(err.code).toBe('JAVA');
    });
});

describe('chooseServerJar', () => {
    it('takes the only jar, leaving installers out', () => {
        expect(chooseServerJar(['paper-1.21.1-123.jar'])).toBe('paper-1.21.1-123.jar');
        expect(chooseServerJar(['forge-1.16.5-36.2.39-installer.jar', 'forge-1.16.5-36.2.39.jar'])).toBe('forge-1.16.5-36.2.39.jar');
    });

    it('picks the loader that starts the server over the vanilla jar it needs', () => {
        expect(chooseServerJar(['server.jar', 'fabric-server-launch.jar'])).toBe('fabric-server-launch.jar');
        expect(chooseServerJar(['fabric-server-mc.1.21.1-loader.0.16.5-launcher.1.0.1.jar', 'server.jar'])).toBe('fabric-server-mc.1.21.1-loader.0.16.5-launcher.1.0.1.jar');
        expect(chooseServerJar(['minecraft_server.1.16.5.jar', 'forge-1.16.5-36.2.39.jar'])).toBe('forge-1.16.5-36.2.39.jar');
        expect(chooseServerJar(['paper-1.21.1-123.jar', 'server.jar'])).toBe('server.jar');
    });

    it('asks for server.jar when the choice is not clear, and explains an empty folder', () => {
        const several = catchError(() => chooseServerJar(['a.jar', 'b.jar'])) as AppError;
        expect(several.code).toBe('JAVA');
        expect(several.message).toContain('server.jar');
        expect((catchError(() => chooseServerJar(['neoforge-21.1.72-installer.jar'])) as AppError).message).toContain('Install server');
    });

    it('compares versions number by number', () => {
        expect(compareVersions('1.20.1-47.10.1', '1.20.1-47.2.0')).toBeGreaterThan(0);
        expect(compareVersions('21.1.9', '21.1.72')).toBeLessThan(0);
    });
});

describe('readMaxPlayers', () => {
    it('reads max-players and returns null when missing', async () => {
        expect(MinecraftProcess.readMaxPlayers(dir)).toBeNull();
        await writeFile(path.join(dir, 'server.properties'), '#Minecraft server properties\r\nmax-players=12\r\nmotd=x\r\n');
        expect(MinecraftProcess.readMaxPlayers(dir)).toBe(12);
        await writeFile(path.join(dir, 'server.properties'), 'motd=x\n');
        expect(MinecraftProcess.readMaxPlayers(dir)).toBeNull();
    });
});

/* ------------------------------------------------------------------ running */

interface Harness {
    mc: MinecraftProcess;
    spawn: ReturnType<typeof fakeSpawn>;
    exec: ReturnType<typeof fakeExecFile>;
    output: string[][];
    players: string[][];
    exits: Array<{ code: number | null; expected: boolean }>;
    lines: () => string[];
}

function harness(opts: { platform?: NodeJS.Platform; playerPollMs?: number; javaMissing?: boolean } = {}): Harness {
    const spawn = fakeSpawn();
    const exec = fakeExecFile(() => spawn.calls.map((c) => c.child), { javaMissing: opts.javaMissing });
    const output: string[][] = [];
    const players: string[][] = [];
    const exits: Array<{ code: number | null; expected: boolean }> = [];
    const mc = new MinecraftProcess({
        onOutput: (lines) => output.push(lines),
        onPlayers: (p) => players.push(p),
        onExit: (code, expected) => exits.push({ code, expected }),
        spawnImpl: spawn.spawnImpl,
        execFileImpl: exec.execFileImpl,
        platform: opts.platform ?? 'win32',
        playerPollMs: opts.playerPollMs ?? 60_000,
    });
    return { mc, spawn, exec, output, players, exits, lines: () => output.flat() };
}

async function startReady(h: Harness, readyTimeoutMs = 2000): Promise<FakeChildProcess> {
    const started = h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs });
    await until(() => h.spawn.calls.length === 1);
    const child = h.spawn.calls[0].child;
    child.print('[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21\n');
    child.print(DONE);
    await started;
    return child;
}

describe('MinecraftProcess.start', () => {
    beforeEach(async () => {
        await writeFile(path.join(dir, 'server.jar'), '');
    });

    it('checks java, accepts the EULA, spawns java in the folder and resolves on "Done ("', async () => {
        const h = harness();
        await startReady(h);
        expect(h.exec.calls[0]).toEqual({ file: 'java', args: ['-version'] });
        const call = h.spawn.calls[0];
        expect(call.command).toBe('java');
        expect(call.args).toEqual(['-Xmx4096M', '-Xms2048M', '-jar', 'server.jar', 'nogui']);
        expect(call.options).toMatchObject({ cwd: dir, windowsHide: true });
        expect(await readFile(path.join(dir, 'eula.txt'), 'utf8')).toBe('eula=true\n');
        expect(h.mc.isRunning()).toBe(true);
        await until(() => h.lines().length === 2);
        expect(h.lines()[1]).toContain('Done (');
    });

    it('does not rewrite an accepted eula.txt, but fixes eula=false', async () => {
        const eula = path.join(dir, 'eula.txt');
        await writeFile(eula, '#By changing the setting below to TRUE you are indicating your agreement\r\neula=TRUE\r\n');
        const before = await stat(eula);
        const h = harness();
        const child = await startReady(h);
        expect(await readFile(eula, 'utf8')).toContain('#By changing');
        expect((await stat(eula)).mtimeMs).toBe(before.mtimeMs);
        child.exit(0);
        await until(() => !h.mc.isRunning());

        await writeFile(eula, '#comment\neula=false\n');
        const h2 = harness();
        await startReady(h2);
        expect(await readFile(eula, 'utf8')).toBe('eula=true\n');
    });

    it('fails with JAVA when java is not installed, without spawning', async () => {
        const h = harness({ javaMissing: true });
        const err = await expectAppError(h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 1000 }), 'JAVA');
        expect(err.message).toContain('Java was not found');
        expect(h.spawn.calls).toHaveLength(0);
        expect(h.mc.isRunning()).toBe(false);
    });

    it('says which Java the server needs when Java is too old for it', async () => {
        const h = harness();
        const started = h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 5000 });
        await until(() => h.spawn.calls.length === 1);
        const child = h.spawn.calls[0].child;
        child.print('java.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been compiled by a more recent version of the Java Runtime (class file version 69.0)\n', 'stderr');
        await new Promise((r) => setTimeout(r, 20));
        child.exit(1);
        const err = await expectAppError(started, 'JAVA');
        expect(err.message).toBe('This server needs Java 25, newer than the Java it started with.');
        expect(err.detail?.split('\n')[0]).toBe('needs-java:25');
    });

    it('rejects with the last 20 output lines when the server exits before "Done ("', async () => {
        const h = harness();
        const started = h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 5000 });
        await until(() => h.spawn.calls.length === 1);
        const child = h.spawn.calls[0].child;
        for (let i = 1; i <= 30; i++) child.print(`line ${i}\n`);
        child.print('**** FAILED TO BIND TO PORT!');                 // no newline: flushed at exit
        await until(() => h.lines().length >= 30);
        child.exit(1);
        const err = await expectAppError(started, 'JAVA');
        expect(err.message).toContain('exit code 1');
        expect(err.detail).toContain('FAILED TO BIND TO PORT');
        expect(err.detail).toContain('line 30');
        expect(err.detail).not.toContain('line 11\n');
        expect(err.detail?.split('\n').filter((l) => l.startsWith('line '))).toHaveLength(19);
        expect(h.exits).toEqual([{ code: 1, expected: false }]);
        expect(h.mc.isRunning()).toBe(false);
    });

    it('rejects with JAVA when the process cannot be spawned', async () => {
        const h = harness();
        const broken = new FakeChildProcess(null);
        h.spawn.next.child = broken;
        const started = h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 5000 });
        await until(() => h.spawn.calls.length === 1);
        broken.failToSpawn();
        const err = await expectAppError(started, 'JAVA');
        expect(err.detail).toContain('ENOENT');
    });

    it('kills the process tree with taskkill on a timeout (Windows)', async () => {
        const h = harness({ platform: 'win32' });
        const started = h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 100 });
        await until(() => h.spawn.calls.length === 1);
        h.spawn.calls[0].child.print('Loading libraries\n');
        const err = await expectAppError(started, 'TIMEOUT');
        expect(err.detail).toContain('Loading libraries');
        expect(h.exec.calls.find((c) => c.file === 'taskkill')?.args).toEqual(['/PID', '4242', '/T', '/F']);
        expect(h.exits).toEqual([{ code: 1, expected: true }]);
        expect(h.mc.isRunning()).toBe(false);
    });

    it('kills with SIGKILL on a timeout elsewhere', async () => {
        const h = harness({ platform: 'linux' });
        const started = h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 100 });
        await until(() => h.spawn.calls.length === 1);
        await expectAppError(started, 'TIMEOUT');
        expect(h.spawn.calls[0].child.signals).toEqual(['SIGKILL']);
        expect(h.exec.calls.some((c) => c.file === 'taskkill')).toBe(false);
    });

    it('kills the process and rejects when the signal aborts', async () => {
        const h = harness();
        const controller = new AbortController();
        const started = h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 5000, signal: controller.signal });
        await until(() => h.spawn.calls.length === 1);
        controller.abort();
        await expect(started).rejects.toMatchObject({ name: 'AbortError' });
        expect(h.mc.isRunning()).toBe(false);
        expect(h.exits[0].expected).toBe(true);
    });

    it('is not fooled by other lines that start with "Done"', async () => {
        const h = harness();
        let ready = false;
        const started = h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 2000 }).then(() => {
            ready = true;
        });
        await until(() => h.spawn.calls.length === 1);
        const child = h.spawn.calls[0].child;
        child.print('[12:00:01] [Server thread/INFO]: Done preparing level "world" (3.1s)\n[12:00:01] [Server thread/INFO]: Done (\n');
        await until(() => h.lines().length === 2);
        expect(ready).toBe(false);
        child.print('[12:00:02] [Server thread/INFO]: Done (4,215s)! For help, type "help"\n');
        await started;
        expect(ready).toBe(true);
    });

    it('does not spawn java when stopAndWait is called during the checks', async () => {
        const spawn = fakeSpawn();
        let releaseJavaCheck: () => void = () => undefined;
        const mc = new MinecraftProcess({
            onOutput: () => undefined, onPlayers: () => undefined, onExit: () => undefined,
            spawnImpl: spawn.spawnImpl,
            execFileImpl: () => new Promise((resolve) => {
                releaseJavaCheck = () => resolve({ stdout: '', stderr: 'openjdk version "21"' });
            }),
            platform: 'win32',
        });
        const started = mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 1000 });
        await new Promise((r) => setTimeout(r, 10));
        await mc.stopAndWait(1000);
        releaseJavaCheck();
        await expectAppError(started, 'JAVA');
        expect(spawn.calls).toHaveLength(0);
        expect(mc.isRunning()).toBe(false);
    });

    it('refuses a second start while running', async () => {
        const h = harness();
        await startReady(h);
        await expectAppError(h.mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 1000 }), 'BUSY');
    });
});

describe('MinecraftProcess output and commands', () => {
    beforeEach(async () => {
        await writeFile(path.join(dir, 'server.jar'), '');
    });

    it('batches lines, strips ANSI codes and handles CRLF and split chunks', async () => {
        const h = harness();
        const child = await startReady(h);
        await until(() => h.lines().length === 2);
        const batchesBefore = h.output.length;
        child.print('\x1b[33m[WARN]\x1b[0m one\r\ntw');
        child.print('o\r\n');
        child.print('three\n', 'stderr');
        await until(() => h.lines().length === 5);
        expect(h.lines().slice(2)).toEqual(['[WARN] one', 'two', 'three']);
        expect(h.output.length - batchesBefore).toBe(1);
    });

    it('writes commands to stdin, one line each, and refuses them when stopped', async () => {
        const h = harness();
        const child = await startReady(h);
        h.mc.send('say hi\nop Steve');
        h.mc.send('   ');
        await until(() => child.written.length === 1);
        expect(child.written).toEqual(['say hi op Steve\n']);
        child.exit(0);
        await until(() => !h.mc.isRunning());
        expect((catchError(() => h.mc.send('list')) as AppError).code).toBe('INVALID');
    });

    it('pauses saving for a backup until the server confirms it saved, then turns saving back on', async () => {
        const h = harness();
        const child = await startReady(h);
        let paused = false;
        const pausing = h.mc.pauseSaving(2000).then((resume) => {
            paused = true;
            return resume;
        });
        await until(() => child.written.includes('save-all flush\n'));
        expect(child.written.slice(-2)).toEqual(['save-off\n', 'save-all flush\n']);
        child.print('[12:01:00] [Server thread/INFO]: <Steve> Saved the game? no\n');
        child.print('[12:01:00] [Server thread/INFO]: Saving the game (this may take a moment!)\n');
        await new Promise((r) => setTimeout(r, 30));
        expect(paused).toBe(false);
        child.print('[12:01:01] [Server thread/INFO]: Saved the game\n');
        const resume = await pausing;
        resume();
        await until(() => child.written.includes('save-on\n'));
    });

    it('turns saving back on when the save is never confirmed', async () => {
        const h = harness();
        const child = await startReady(h);
        const err = await h.mc.pauseSaving(50).then(() => null, (e: unknown) => e);
        expect((err as AppError).code).toBe('TIMEOUT');
        expect(child.written).toContain('save-on\n');
    });

    it('polls "list", hides the replies and reports players', async () => {
        const h = harness({ playerPollMs: 40 });
        const child = await startReady(h);
        await until(() => child.written.includes('list\n'));
        child.print('[12:01:00] [Server thread/INFO]: There are 2 of a max of 20 players online: Steve, Alex\n');
        await until(() => h.players.length === 1);
        expect(h.players[0]).toEqual(['Steve', 'Alex']);

        // The old two-line reply: both lines hidden, names read from the second one.
        const polls = child.written.filter((w) => w === 'list\n').length;
        await until(() => child.written.filter((w) => w === 'list\n').length > polls);
        child.print('[12:01:20 INFO]: There are 1/20 players online:\n[12:01:20 INFO]: Steve\n');
        await until(() => h.players.length === 2);
        expect(h.players[1]).toEqual(['Steve']);

        child.print('[12:01:21] [Server thread/INFO]: visible\n');
        await until(() => h.lines().includes('[12:01:21] [Server thread/INFO]: visible'));
        expect(h.lines().some((l) => l.includes('players online') || l.endsWith(': Steve'))).toBe(false);

        // An unchanged list is not reported again.
        child.print('[12:01:40 INFO]: There are 1 of a max of 20 players online: Steve\n');
        await new Promise((r) => setTimeout(r, 150));
        expect(h.players).toHaveLength(2);

        child.exit(0);
        await until(() => h.exits.length === 1);
        expect(h.players[h.players.length - 1]).toEqual([]);
    });

    it('shows the reply to a "list" the user typed', async () => {
        const h = harness();
        const child = await startReady(h);
        h.mc.send('list');
        child.print('[12:01:00] [Server thread/INFO]: There are 1 of a max of 20 players online: Steve\n');
        await until(() => h.lines().some((l) => l.includes('players online')));
        expect(h.players).toEqual([['Steve']]);
    });
});

describe('MinecraftProcess.stopAndWait', () => {
    beforeEach(async () => {
        await writeFile(path.join(dir, 'server.jar'), '');
    });

    it('is a no-op when not running', async () => {
        const h = harness();
        await h.mc.stopAndWait(10);
        expect(h.exits).toEqual([]);
    });

    it('sends "stop" and waits for the exit', async () => {
        const h = harness();
        const child = await startReady(h);
        child.onWrite = (text) => {
            if (text === 'stop\n') setTimeout(() => {
                child.print('[12:02:00] [Server thread/INFO]: Saving chunks for level\n');
                child.exit(0);
            }, 50);
        };
        const stopping = h.mc.stopAndWait(5000);
        expect(h.mc.stopAndWait(5000)).toBe(stopping);              // a second call shares the first
        await stopping;
        expect(child.written).toContain('stop\n');
        expect(h.mc.isRunning()).toBe(false);
        expect(h.exits).toEqual([{ code: 0, expected: true }]);
        expect(h.lines()).toContain('[12:02:00] [Server thread/INFO]: Saving chunks for level');
        expect(h.exec.calls.some((c) => c.file === 'taskkill')).toBe(false);
    });

    it('kills the process tree after the timeout (Windows)', async () => {
        const h = harness({ platform: 'win32' });
        const child = await startReady(h);
        await h.mc.stopAndWait(50);
        expect(child.written).toContain('stop\n');
        expect(h.exec.calls.find((c) => c.file === 'taskkill')?.args).toEqual(['/PID', '4242', '/T', '/F']);
        expect(h.exits).toEqual([{ code: 1, expected: true }]);
    });

    it('falls back to kill() when taskkill fails', async () => {
        const spawn = fakeSpawn();
        const exec = fakeExecFile(() => spawn.calls.map((c) => c.child), { taskkillFails: true });
        const mc = new MinecraftProcess({
            onOutput: () => undefined, onPlayers: () => undefined, onExit: () => undefined,
            spawnImpl: spawn.spawnImpl, execFileImpl: exec.execFileImpl, platform: 'win32',
        });
        const started = mc.start({ serverPath: dir, javaFlags: FLAGS, readyTimeoutMs: 2000 });
        await until(() => spawn.calls.length === 1);
        spawn.calls[0].child.print(DONE);
        await started;
        await mc.stopAndWait(30);
        expect(spawn.calls[0].child.signals).toEqual(['SIGKILL']);
        expect(mc.isRunning()).toBe(false);
    });

    it('uses SIGKILL after the timeout elsewhere', async () => {
        const h = harness({ platform: 'linux' });
        const child = await startReady(h);
        await h.mc.stopAndWait(50);
        expect(child.signals).toEqual(['SIGKILL']);
        expect(h.exits).toEqual([{ code: null, expected: true }]);
    });

    it('reports an exit it did not ask for as unexpected', async () => {
        const h = harness();
        const child = await startReady(h);
        child.exit(137);
        await until(() => h.exits.length === 1);
        expect(h.exits).toEqual([{ code: 137, expected: false }]);
    });
});
