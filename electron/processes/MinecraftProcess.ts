// Runs the Minecraft server (Java) as a child process: launch arguments, the "Done (" readiness
// check, console output, the player list and a stop that waits for the process to really exit.
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import type { JavaFlags } from '../../shared/types';
import { NEEDS_JAVA_PREFIX } from '../../shared/types';
import { AppError } from '../errors';

/** Runs a program to completion; rejects when it cannot start or exits with a non-zero code. */
export type ExecFileFn = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>;

export const defaultExecFile: ExecFileFn = (file, args, opts) => new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: opts.timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve({ stdout, stderr });
    });
});

export interface MinecraftProcessDeps {
    onOutput: (lines: string[]) => void;          // console lines, without the hidden "list" replies
    onPlayers: (players: string[]) => void;
    onExit: (code: number | null, expected: boolean) => void;   // expected = we asked it to stop
    spawnImpl?: typeof spawn;
    playerPollMs?: number;                        // 20000
    // Not in the spec's list; optional so tests can fake `java -version` / taskkill and the platform.
    execFileImpl?: ExecFileFn;
    platform?: NodeJS.Platform;
}

const OUTPUT_FLUSH_MS = 100;
const TAIL_LINES = 20;
const KILL_WAIT_MS = 10_000;
const CLOSE_FALLBACK_MS = 2_000;
const JAVA_CHECK_TIMEOUT_MS = 20_000;
const MAX_PARTIAL_LINE = 64 * 1024;

/* ------------------------------------------------------------------ helpers (also used by PlayitProcess) */

// CSI sequences (colours, cursor movement, "?25l"), OSC sequences (window titles) and two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

/** The Java a server needs, from Java's own complaint that it is too old: "compiled by a more recent version of the
 *  Java Runtime (class file version 65.0)". Class file version 52 is Java 8, and every Java adds one. */
export function javaNeededFromOutput(text: string): number | null {
    const m = /class file version (\d+)/.exec(text);
    if (!m) return null;
    const major = Number(m[1]) - 44;
    return major >= 8 && major < 100 ? major : null;
}

export function stripAnsi(text: string): string {
    return text.replace(ANSI_RE, '');
}

/** Splits a command line into arguments. Quoted parts keep their spaces and lose the quotes, also in the
 *  middle of an argument (`@"my args.txt"` -> `@my args.txt`). A quote without a partner is kept as a
 *  normal character. Backslashes are not escapes: they are path separators on Windows. */
export function splitArgs(text: string, quotes = '"\''): string[] {
    const args: string[] = [];
    let current = '';
    let inToken = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t') {
            if (inToken) args.push(current);
            current = '';
            inToken = false;
            i++;
            continue;
        }
        if (quotes.includes(ch)) {
            const end = text.indexOf(ch, i + 1);
            if (end !== -1) {
                current += text.slice(i + 1, end);
                inToken = true;
                i = end + 1;
                continue;
            }
        }
        current += ch;
        inToken = true;
        i++;
    }
    if (inToken) args.push(current);
    return args;
}

/** Where Forge (1.17 and later) and NeoForge keep the Java arguments that start them; their run.bat only passes
 *  this file to Java. NeoForge for 1.20.1 still used the forge name. */
const ARGS_FILE_DIRS = ['libraries/net/minecraftforge/forge', 'libraries/net/neoforged/neoforge', 'libraries/net/neoforged/forge'];

/** Root jars that start the server when there are several, most specific first. Fabric's launcher needs the
 *  vanilla server.jar next to it, and Forge before 1.17 the vanilla minecraft_server jar. */
const STARTER_JARS = [
    /^fabric-server-launch\.jar$/i,
    /^fabric-server-mc\..+-launcher\..+\.jar$/i,
    /^quilt-server-launch\.jar$/i,
    /^forge-.+\.jar$/i,
    /^server\.jar$/i,
];

/** "1.20.1-47.2.0" before "1.20.1-47.10.1": the numbers in a version compared one by one. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(/\D+/).filter(Boolean).map(Number);
    const pb = b.split(/\D+/).filter(Boolean).map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? -1) - (pb[i] ?? -1);
        if (diff !== 0) return diff;
    }
    return a.localeCompare(b);
}

function subfolders(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
        return [];
    }
}

/** The Forge or NeoForge argument file of the newest installed version, relative to the server folder (with "/",
 *  which Java accepts on Windows too); null when neither is installed. */
export function findArgsFile(serverPath: string, platform: NodeJS.Platform): string | null {
    const name = platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    const found: Array<{ version: string; file: string }> = [];
    for (const dir of ARGS_FILE_DIRS) {
        for (const version of subfolders(path.join(serverPath, dir))) {
            if (existsSync(path.join(serverPath, dir, version, name))) found.push({ version, file: `${dir}/${version}/${name}` });
        }
    }
    found.sort((a, b) => compareVersions(b.version, a.version));
    return found[0]?.file ?? null;
}

/** The jar that starts the server, from the .jar files in the server folder (not its subfolders). */
export function chooseServerJar(jars: string[]): string {
    const candidates = jars.filter((jar) => !/installer/i.test(jar)).sort();
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
        throw new AppError('JAVA', 'No server .jar file was found in the server folder. For Forge or NeoForge, run their installer with "Install server" in this folder first.');
    }
    for (const pattern of STARTER_JARS) {
        const matches = candidates.filter((jar) => pattern.test(jar));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) break;
    }
    throw new AppError('JAVA', `The server folder has several .jar files (${candidates.join(', ')}), and it is not clear which one starts the server. Rename that one to server.jar, or move the others out of the folder.`);
}

export interface PlayerList {
    count: number;
    max: number;
    players: string[];
    namesOnNextLine: boolean;                     // old servers print "There are 1/20 players online:" and the names below
}

const LIST_RE = /^There are (\d+)(?: of a max(?:imum)? of |\/)(\d+) players online[:.]?[ \t]*(.*)$/;

/** Parses the reply to "list". Only the message part of the log line counts, so a chat message that
 *  quotes the reply cannot change the player list. */
export function parsePlayerList(line: string): PlayerList | null {
    const m = LIST_RE.exec(messageOf(line));
    if (!m) return null;
    const count = Number(m[1]);
    const players = splitNames(m[3]);
    return { count, max: Number(m[2]), players, namesOnNextLine: count > 0 && players.length === 0 };
}

function splitNames(text: string): string[] {
    return text.split(',').map((n) => n.trim()).filter(Boolean);
}

/** The message part of a log line: "[12:00:00] [Server thread/INFO]: Steve" -> "Steve". The FIRST "]: "
 *  ends the log prefix; a later one belongs to the message. */
function messageOf(line: string): string {
    const i = line.indexOf(']: ');
    return i === -1 ? line.trim() : line.slice(i + 3).trim();
}

// 'Done (4.215s)! For help, type "help"' (the decimal comma depends on the locale).
const READY_RE = /Done \(\d/;
const JOIN_LEAVE_RE = /: \S+ (joined|left) the game$/;

export function abortError(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) return reason;
    const err = new Error('The operation was cancelled.');
    err.name = 'AbortError';
    return err;
}

/** Ends a process and everything it started. Windows needs taskkill for the children; elsewhere SIGKILL. */
export async function killProcessTree(child: ChildProcess, platform: NodeJS.Platform, execFileImpl: ExecFileFn, logPrefix: string): Promise<void> {
    if (platform === 'win32' && child.pid !== undefined) {
        try {
            await execFileImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 15_000 });
            return;
        } catch (err) {
            // Exit code 128 means the process is already gone; anything else falls back to a plain kill.
            console.warn(`${logPrefix} taskkill failed, falling back to kill():`, err instanceof Error ? err.message : err);
        }
    }
    try {
        child.kill('SIGKILL');
    } catch (err) {
        console.warn(`${logPrefix} kill failed:`, err);
    }
}

/** Calls onLine for every complete line of a stream (UTF-8 safe across chunks, CRLF and lone CR handled). */
function readLines(stream: Readable | null, onLine: (line: string) => void): () => void {
    if (!stream) return () => undefined;
    const decoder = new StringDecoder('utf8');
    let rest = '';
    const emit = (raw: string) => {
        // A lone CR rewrites the line in a terminal, so only the text after the last one is what was meant.
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        onLine(line.slice(line.lastIndexOf('\r') + 1));
    };
    stream.on('data', (chunk: Buffer | string) => {
        const text = rest + (typeof chunk === 'string' ? chunk : decoder.write(chunk));
        const parts = text.split('\n');
        rest = parts.pop() ?? '';
        for (const part of parts) emit(part);
        if (rest.length > MAX_PARTIAL_LINE) {
            emit(rest);
            rest = '';
        }
    });
    stream.on('error', (err) => console.warn('[minecraft] output stream error:', err.message));
    return () => {
        const tail = rest + decoder.end();
        rest = '';
        if (tail) emit(tail);
    };
}

/* ------------------------------------------------------------------ the process */

export class MinecraftProcess {
    private readonly spawnImpl: typeof spawn;
    private readonly execFileImpl: ExecFileFn;
    private readonly platform: NodeJS.Platform;
    private readonly playerPollMs: number;

    private child: ChildProcess | null = null;
    private launching = false;
    private launchCancelled = false;
    private expectedExit = false;
    private exitPromise: Promise<number | null> = Promise.resolve(null);
    private finishRun: (code: number | null) => void = () => undefined;
    private stopping: Promise<void> | null = null;
    private spawnError: Error | null = null;

    private pendingOutput: string[] = [];
    private tail: string[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private soonPollTimer: ReturnType<typeof setTimeout> | null = null;
    private onReadyLine: (() => void) | null = null;

    private players: string[] = [];
    private repliesToHide = 0;
    private namesLine: { hide: boolean } | null = null;
    private readonly lineWatchers = new Set<(line: string) => void>();

    constructor(private readonly deps: MinecraftProcessDeps) {
        this.spawnImpl = deps.spawnImpl ?? spawn;
        this.execFileImpl = deps.execFileImpl ?? defaultExecFile;
        this.platform = deps.platform ?? process.platform;
        this.playerPollMs = deps.playerPollMs ?? 20_000;
    }

    /** Resolves when the server prints "Done (". Rejects with AppError('JAVA' | 'TIMEOUT') if it exits first or times out (then kills it). */
    /** `acceptEula`: the user accepted the Minecraft EULA in the app, so eula.txt may be written for them. */
    /** `javaPath`: the Java program chosen for this server on this PC; null uses "java" from PATH. */
    async start(opts: {
        serverPath: string; javaFlags: JavaFlags; javaPath?: string | null; readyTimeoutMs: number; signal?: AbortSignal; acceptEula?: boolean;
    }): Promise<void> {
        if (this.child || this.launching) throw new AppError('BUSY', 'The Minecraft server is already running.');
        const { serverPath, javaFlags, readyTimeoutMs, signal } = opts;
        this.launching = true;
        this.launchCancelled = false;
        // Checked after every await: stopAndWait() during the checks must keep Java from being spawned.
        const checkCancelled = () => {
            if (signal?.aborted) throw abortError(signal);
            if (this.launchCancelled) throw new AppError('JAVA', 'The Minecraft server was stopped before it finished starting.');
        };
        try {
            checkCancelled();
            const { command, args } = MinecraftProcess.resolveLaunch(serverPath, javaFlags, this.platform, opts.javaPath ?? null);
            await this.checkJava(command);
            checkCancelled();
            await ensureEula(serverPath, opts.acceptEula ?? true);
            checkCancelled();
            console.log(`[minecraft] starting in ${serverPath}: ${command} ${args.join(' ')}`);
            let child: ChildProcess;
            try {
                child = this.spawnImpl(command, args, { cwd: serverPath, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            } catch (err) {
                throw new AppError('JAVA', 'Java could not be started.', err instanceof Error ? err.message : String(err));
            }
            this.attach(child);
        } finally {
            this.launching = false;
        }
        await this.waitUntilReady(readyTimeoutMs, signal);
        this.startPlayerPolling();
    }

    /** Makes the world files hold still for a backup: "save-off", then "save-all flush" and its "Saved the game".
     *  Returns the function that turns saving back on ("save-on"). */
    async pauseSaving(timeoutMs = 60_000): Promise<() => void> {
        if (!this.child) throw new AppError('INVALID', 'The Minecraft server is not running.');
        const saved = this.waitForMessage(/^Saved the (game|world)/, timeoutMs);
        this.send('save-off');
        this.send('save-all flush');
        const resume = () => {
            if (this.child) this.writeStdin('save-on\n');
        };
        try {
            await saved;
        } catch (err) {
            resume();
            throw err;
        }
        return resume;
    }

    isRunning(): boolean {
        return this.child !== null;
    }

    send(command: string): void {
        if (!this.child) throw new AppError('INVALID', 'The Minecraft server is not running.');
        // One command per call: a pasted newline must not smuggle in a second command.
        const line = command.replace(/[\r\n]+/g, ' ').trim();
        if (!line) return;
        if (!this.writeStdin(`${line}\n`)) throw new AppError('INVALID', 'The Minecraft server is not accepting commands.');
    }

    /** Sends "stop", waits for the process to exit; after timeoutMs kills the process tree. No-op when not running. */
    stopAndWait(timeoutMs = 60_000): Promise<void> {
        if (!this.child) {
            if (this.launching) this.launchCancelled = true;
            return Promise.resolve();
        }
        if (!this.stopping) {
            this.stopping = this.stopGracefully(timeoutMs).finally(() => {
                this.stopping = null;
            });
        }
        return this.stopping;
    }

    static readMaxPlayers(serverPath: string): number | null {
        let text: string;
        try {
            text = readFileSync(path.join(serverPath, 'server.properties'), 'utf8');
        } catch {
            return null;
        }
        const m = /^[ \t]*max-players[ \t]*[=:][ \t]*(\d+)[ \t]*\r?$/m.exec(text);
        return m ? Number(m[1]) : null;
    }

    /** java arguments: memory flags, custom flags, then what starts the server (`@<Forge or NeoForge args file>` or
     *  `-jar <server jar>`), then nogui. */
    static buildLaunchArgs(serverPath: string, javaFlags: JavaFlags, platform: NodeJS.Platform = process.platform): string[] {
        return MinecraftProcess.resolveLaunch(serverPath, javaFlags, platform).args;
    }

    /** buildLaunchArgs plus the java program: the one chosen for this server on this PC, or "java" from PATH. */
    static resolveLaunch(serverPath: string, javaFlags: JavaFlags, platform: NodeJS.Platform = process.platform, javaPath: string | null = null): { command: string; args: string[] } {
        if (!existsSync(serverPath)) throw new AppError('NO_LOCAL_PATH', 'The server folder does not exist on this PC.', serverPath);
        if (javaPath && !existsSync(javaPath)) {
            throw new AppError('JAVA', 'The Java program chosen for this server is not on this PC anymore. Choose it again in Settings > Server settings.', javaPath);
        }
        const argsFile = findArgsFile(serverPath, platform);
        const launch = argsFile
            ? [`@${argsFile}`]
            : ['-jar', chooseServerJar(readdirSync(serverPath, { withFileTypes: true })
                .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar'))
                .map((e) => e.name))];
        const args = [`-Xmx${javaFlags.maxRAM}M`, `-Xms${javaFlags.minRAM}M`, ...splitArgs(javaFlags.customFlags), ...launch];
        if (!args.some((a) => a.toLowerCase() === 'nogui' || a.toLowerCase() === '--nogui')) args.push('nogui');
        return { command: javaPath ?? 'java', args };
    }

    /* -------------------------------------------------------------- internals */

    private async checkJava(command: string): Promise<void> {
        try {
            const { stderr, stdout } = await this.execFileImpl(command, ['-version'], { timeoutMs: JAVA_CHECK_TIMEOUT_MS });
            const version = (stderr || stdout).split(/\r?\n/)[0]?.trim();
            if (version) console.log(`[minecraft] ${version}`);
        } catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
            const detail = err instanceof Error ? err.message : String(err);
            if (code === 'ENOENT') {
                throw new AppError('JAVA', 'Java was not found. Install Java (the version your Minecraft server needs) and try again.', detail);
            }
            throw new AppError('JAVA', `Java is installed but "${command} -version" failed.`, detail);
        }
    }

    private attach(child: ChildProcess): void {
        this.child = child;
        this.expectedExit = false;
        this.spawnError = null;
        this.tail = [];
        this.players = [];
        this.repliesToHide = 0;
        this.namesLine = null;
        this.exitPromise = new Promise((resolve) => {
            this.finishRun = resolve;
        });

        const endStdout = readLines(child.stdout, (line) => this.handleLine(line));
        const endStderr = readLines(child.stderr, (line) => this.handleLine(line));
        child.stdin?.on('error', (err) => console.warn('[minecraft] stdin error:', err.message));

        let finished = false;
        let closeFallback: ReturnType<typeof setTimeout> | null = null;
        const finish = (code: number | null) => {
            if (finished) return;
            finished = true;
            if (closeFallback) clearTimeout(closeFallback);
            endStdout();
            endStderr();
            this.onExited(code);
        };
        child.on('error', (err) => {
            // Without a pid the process never started; otherwise this is a failed kill and it still runs.
            if (child.pid === undefined) {
                this.spawnError = err;
                finish(null);
            } else {
                console.warn('[minecraft] process error:', err.message);
            }
        });
        // 'close' waits for the output pipes, so no line is lost; the fallback covers a grandchild
        // process that keeps a pipe open after Java itself has exited.
        child.on('exit', (code) => {
            closeFallback = setTimeout(() => finish(code), CLOSE_FALLBACK_MS);
        });
        child.on('close', (code: number | null) => finish(code));
    }

    private onExited(code: number | null): void {
        const expected = this.expectedExit;
        this.stopPlayerPolling();
        this.flushOutput();
        this.child = null;
        console.log(`[minecraft] exited with code ${code} (${expected ? 'expected' : 'unexpected'})`);
        if (this.players.length > 0) this.setPlayers([]);
        this.finishRun(code);
        try {
            this.deps.onExit(code, expected);
        } catch (err) {
            console.error('[minecraft] onExit handler failed:', err);
        }
    }

    private handleLine(raw: string): void {
        const line = stripAnsi(raw);
        if (this.namesLine) {
            const { hide } = this.namesLine;
            this.namesLine = null;
            this.setPlayers(splitNames(messageOf(line)));
            if (hide) return;
        } else {
            const list = parsePlayerList(line);
            if (list) {
                const hide = this.repliesToHide > 0;
                if (hide) this.repliesToHide--;
                if (list.namesOnNextLine) this.namesLine = { hide };
                else this.setPlayers(list.players);
                if (hide) return;
            }
        }
        this.tail.push(line);
        if (this.tail.length > TAIL_LINES) this.tail.shift();
        this.pendingOutput.push(line);
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushOutput(), OUTPUT_FLUSH_MS);
        if (this.onReadyLine && READY_RE.test(line)) this.onReadyLine();
        if (this.pollTimer && JOIN_LEAVE_RE.test(line)) this.pollSoon();
        for (const watch of [...this.lineWatchers]) watch(line);
    }

    private flushOutput(): void {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (this.pendingOutput.length === 0) return;
        const lines = this.pendingOutput;
        this.pendingOutput = [];
        try {
            this.deps.onOutput(lines);
        } catch (err) {
            console.error('[minecraft] onOutput handler failed:', err);
        }
    }

    private setPlayers(players: string[]): void {
        if (players.length === this.players.length && players.every((p, i) => p === this.players[i])) return;
        this.players = players;
        try {
            this.deps.onPlayers([...players]);
        } catch (err) {
            console.error('[minecraft] onPlayers handler failed:', err);
        }
    }

    /** Resolves on the next console line whose message matches; rejects after timeoutMs. */
    private waitForMessage(pattern: RegExp, timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.lineWatchers.delete(watch);
                reject(new AppError('TIMEOUT', 'The Minecraft server did not confirm that it saved the world.'));
            }, timeoutMs);
            const watch = (line: string) => {
                if (!pattern.test(messageOf(line))) return;
                clearTimeout(timer);
                this.lineWatchers.delete(watch);
                resolve();
            };
            this.lineWatchers.add(watch);
        });
    }

    private waitUntilReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const settle = (): boolean => {
                if (settled) return false;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                this.onReadyLine = null;
                return true;
            };
            const failAfterKill = (err: Error) => {
                void this.forceStop().then(() => reject(err), () => reject(err));
            };
            const onAbort = () => {
                if (settle() && signal) failAfterKill(abortError(signal));
            };
            const timer = setTimeout(() => {
                if (!settle()) return;
                failAfterKill(new AppError(
                    'TIMEOUT',
                    `The Minecraft server did not finish starting within ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.`,
                    this.tailText(),
                ));
            }, timeoutMs);
            this.onReadyLine = () => {
                if (settle()) resolve();
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            void this.exitPromise.then((code) => {
                if (settle()) reject(this.earlyExitError(code));
            });
            if (signal?.aborted) onAbort();
        });
    }

    private earlyExitError(code: number | null): AppError {
        if (this.spawnError) return new AppError('JAVA', 'Java could not be started.', this.spawnError.message);
        if (this.expectedExit) return new AppError('JAVA', 'The Minecraft server was stopped before it finished starting.', this.tailText());
        const needed = javaNeededFromOutput(this.tailText());
        if (needed !== null) {
            return new AppError(
                'JAVA',
                `This server needs Java ${needed}, newer than the Java it started with.`,
                `${NEEDS_JAVA_PREFIX}${needed}\nExit code ${code ?? 'none'}. Last output:\n${this.tailText()}`,
            );
        }
        return new AppError(
            'JAVA',
            `The Minecraft server stopped while starting (exit code ${code ?? 'none'}). The console shows why.`,
            `Exit code ${code ?? 'none'}. Last output:\n${this.tailText()}`,
        );
    }

    private tailText(): string {
        return this.tail.join('\n');
    }

    private async stopGracefully(timeoutMs: number): Promise<void> {
        const child = this.child;
        if (!child) return;
        this.expectedExit = true;
        this.stopPlayerPolling();
        if (this.writeStdin('stop\n') && await this.waitForExit(timeoutMs)) return;
        console.warn(`[minecraft] did not stop within ${timeoutMs} ms, killing process ${child.pid ?? '?'}`);
        await killProcessTree(child, this.platform, this.execFileImpl, '[minecraft]');
        if (await this.waitForExit(KILL_WAIT_MS)) return;
        throw new AppError('JAVA', 'The Minecraft server could not be stopped.', `Process ${child.pid ?? '?'} is still running after being killed.`);
    }

    /** Kills without asking (start timeout or abort) and waits a bounded time for the exit. */
    private async forceStop(): Promise<void> {
        const child = this.child;
        if (!child) return;
        this.expectedExit = true;
        this.stopPlayerPolling();
        await killProcessTree(child, this.platform, this.execFileImpl, '[minecraft]');
        if (!await this.waitForExit(KILL_WAIT_MS)) console.error(`[minecraft] process ${child.pid ?? '?'} survived the kill`);
    }

    /** true when the process exited within ms. */
    private waitForExit(ms: number): Promise<boolean> {
        if (!this.child) return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), ms);
            void this.exitPromise.then(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    private writeStdin(text: string): boolean {
        const stdin = this.child?.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) return false;
        stdin.write(text);
        return true;
    }

    private startPlayerPolling(): void {
        if (!this.child || this.pollTimer) return;
        this.pollTimer = setInterval(() => this.pollPlayers(), this.playerPollMs);
    }

    private stopPlayerPolling(): void {
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.soonPollTimer) clearTimeout(this.soonPollTimer);
        this.pollTimer = null;
        this.soonPollTimer = null;
    }

    /** A join or leave message: refresh the list now instead of at the next poll. */
    private pollSoon(): void {
        if (this.soonPollTimer) return;
        this.soonPollTimer = setTimeout(() => {
            this.soonPollTimer = null;
            this.pollPlayers();
        }, 1000);
    }

    private pollPlayers(): void {
        if (!this.child || this.expectedExit) return;
        // Only replies to our own polls are hidden; a "list" typed by the user still shows its answer.
        // The cap keeps a server that never answers from hiding the user's replies forever.
        if (this.writeStdin('list\n')) this.repliesToHide = Math.min(this.repliesToHide + 1, 2);
    }
}

/** Writes eula=true for a user who accepted the EULA in the app, only when needed so the file does not show
 *  up as a change every session. Without that acceptance Java is not started. */
async function ensureEula(serverPath: string, accepted: boolean): Promise<void> {
    const file = path.join(serverPath, 'eula.txt');
    try {
        if (/^[ \t]*eula[ \t]*=[ \t]*true[ \t]*\r?$/im.test(await readFile(file, 'utf8'))) return;
    } catch (err) {
        if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT')) throw err;
    }
    if (!accepted) throw new AppError('JAVA', 'The Minecraft EULA has not been accepted, so the server was not started.');
    await writeFile(file, 'eula=true\n');
}
