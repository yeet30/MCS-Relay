// A fake ChildProcess for tests: stdout/stderr are PassThrough streams the test writes into, stdin
// records what the code under test wrote, and exit() / kill() emit 'exit' then 'close' like Node does.
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ExecFileFn } from '../../electron/processes/MinecraftProcess';

export class FakeChildProcess extends EventEmitter {
    readonly pid: number | undefined;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin: Writable;
    readonly written: string[] = [];
    readonly signals: string[] = [];
    exited = false;
    exitCode: number | null = null;
    /** Called for every stdin write, e.g. to exit when the code sends "stop". */
    onWrite: ((text: string) => void) | null = null;
    /** Signals that end the process when kill() sends them. */
    killExitsOn: string[] = ['SIGKILL', 'SIGTERM'];

    /** null = a process that never started (no pid). */
    constructor(pid: number | null = 4242) {
        super();
        this.pid = pid ?? undefined;
        this.stdin = new Writable({
            write: (chunk: Buffer, _encoding, callback) => {
                const text = chunk.toString('utf8');
                this.written.push(text);
                this.onWrite?.(text);
                callback();
            },
        });
    }

    print(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
        this[stream].write(text);
    }

    exit(code: number | null): void {
        if (this.exited) return;
        this.exited = true;
        this.exitCode = code;
        this.emit('exit', code, null);
        this.stdout.end();
        this.stderr.end();
        // Like Node: 'close' only after the output streams are drained.
        setImmediate(() => this.emit('close', code, null));
    }

    /** A spawn that failed (ENOENT): no pid, 'error', then 'close'. */
    failToSpawn(message = 'spawn java ENOENT'): void {
        this.exited = true;
        this.emit('error', Object.assign(new Error(message), { code: 'ENOENT' }));
        this.stdout.end();
        this.stderr.end();
        setImmediate(() => this.emit('close', -4058, null));
    }

    kill(signal: string = 'SIGTERM'): boolean {
        this.signals.push(signal);
        if (this.killExitsOn.includes(signal)) this.exit(null);
        return true;
    }

    asChild(): ChildProcess {
        return this as unknown as ChildProcess;
    }
}

export interface SpawnCall {
    command: string;
    args: string[];
    options: Record<string, unknown>;
    child: FakeChildProcess;
}

/** A spawn replacement; `next` decides the child for the next call (default: a new FakeChildProcess). */
export function fakeSpawn(): { spawnImpl: typeof spawn; calls: SpawnCall[]; next: { child: FakeChildProcess | null } } {
    const calls: SpawnCall[] = [];
    const next: { child: FakeChildProcess | null } = { child: null };
    const impl = (command: string, args: readonly string[], options: Record<string, unknown>) => {
        const child = next.child ?? new FakeChildProcess();
        next.child = null;
        calls.push({ command, args: [...args], options, child });
        return child.asChild();
    };
    return { spawnImpl: impl as unknown as typeof spawn, calls, next };
}

export interface ExecCall { file: string; args: string[] }

/** An execFile replacement: `java -version` succeeds unless `javaMissing`, taskkill ends the matching fake child. */
export function fakeExecFile(children: () => FakeChildProcess[], opts: { javaMissing?: boolean; taskkillFails?: boolean } = {}): { execFileImpl: ExecFileFn; calls: ExecCall[] } {
    const calls: ExecCall[] = [];
    const execFileImpl: ExecFileFn = async (file, args) => {
        calls.push({ file, args: [...args] });
        if (file === 'taskkill') {
            if (opts.taskkillFails) throw Object.assign(new Error('taskkill failed'), { code: 1 });
            const pid = Number(args[args.indexOf('/PID') + 1]);
            children().filter((c) => c.pid === pid).forEach((c) => c.exit(1));
            return { stdout: `SUCCESS: The process with PID ${pid} has been terminated.`, stderr: '' };
        }
        if (args[0] === '-version') {
            if (opts.javaMissing) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
            return { stdout: '', stderr: 'openjdk version "21.0.2" 2024-01-16\nOpenJDK Runtime Environment' };
        }
        throw new Error(`unexpected execFile ${file} ${args.join(' ')}`);
    };
    return { execFileImpl, calls };
}

/** Polls until the condition holds (real timers). */
export async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeoutMs) throw new Error('until(): condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
