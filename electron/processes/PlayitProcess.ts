// Runs the playit.gg agent and reads the tunnel address ("name.joinmc.link") from its output.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AppError } from '../errors';
import { abortError, defaultExecFile, killProcessTree, stripAnsi } from './MinecraftProcess';
import type { ExecFileFn } from './MinecraftProcess';

export interface PlayitProcessDeps {
    spawnImpl?: typeof spawn;
    // Not in the spec's list; optional so tests can fake taskkill and the platform.
    execFileImpl?: ExecFileFn;
    platform?: NodeJS.Platform;
}

const ADDRESS_RE = /([a-zA-Z0-9.-]+\.joinmc\.link)\s*=>/;
// A fresh agent that was never linked to an account prints a claim link and waits for it forever.
const CLAIM_RE = /https?:\/\/playit\.gg\/claim\/[A-Za-z0-9_-]+/;
const BUFFER_CHARS = 16 * 1024;
const TAIL_LINES = 20;
const EXIT_WAIT_MS = 5_000;

export class PlayitProcess {
    private readonly spawnImpl: typeof spawn;
    private readonly execFileImpl: ExecFileFn;
    private readonly platform: NodeJS.Platform;

    private child: ChildProcess | null = null;
    private exitPromise: Promise<number | null> = Promise.resolve(null);
    private stopping: Promise<void> | null = null;
    private stopRequested = false;
    private output = '';                          // raw recent output; escape codes can be split across chunks

    constructor(deps: PlayitProcessDeps = {}) {
        this.spawnImpl = deps.spawnImpl ?? spawn;
        this.execFileImpl = deps.execFileImpl ?? defaultExecFile;
        this.platform = deps.platform ?? process.platform;
    }

    /** Starts the agent and resolves with the "*.joinmc.link" address; AppError('PLAYIT'|'TIMEOUT') otherwise (kills it). */
    async start(executable: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
        if (this.child) throw new AppError('BUSY', 'playit.gg is already running.');
        if (signal?.aborted) throw abortError(signal);
        if (!executable || !existsSync(executable)) {
            throw new AppError('PLAYIT', 'The playit.gg program was not found. Choose it again in the settings.', executable);
        }

        let child: ChildProcess;
        try {
            child = this.spawnImpl(executable, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
            throw new AppError('PLAYIT', 'playit.gg could not be started.', err instanceof Error ? err.message : String(err));
        }
        console.log(`[playit] started ${executable} (pid ${child.pid ?? '?'})`);
        this.child = child;
        this.stopRequested = false;
        this.output = '';

        let spawnError: Error | null = null;
        let onText: () => void = () => undefined;
        // Output is always read, also after the address was found: a full pipe would block the agent.
        const onData = (chunk: Buffer | string) => {
            this.output = (this.output + chunk.toString()).slice(-BUFFER_CHARS);
            onText();
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        this.exitPromise = new Promise((resolve) => {
            let done = false;
            let closeFallback: ReturnType<typeof setTimeout> | null = null;
            const finish = (code: number | null) => {
                if (done) return;
                done = true;
                if (closeFallback) clearTimeout(closeFallback);
                if (this.child === child) this.child = null;
                if (!this.stopRequested) console.warn(`[playit] exited with code ${code}`);
                resolve(code);
            };
            child.on('error', (err) => {
                // Without a pid the program never started; otherwise a kill failed and it still runs.
                if (child.pid === undefined) {
                    spawnError = err;
                    finish(null);
                } else {
                    console.warn('[playit] process error:', err.message);
                }
            });
            // 'close' comes after the last output (for the error detail); the fallback covers a child
            // process of the agent that keeps the pipes open.
            child.on('exit', (code) => {
                closeFallback = setTimeout(() => finish(code), 1_000);
            });
            child.on('close', (code: number | null) => finish(code));
        });

        return new Promise<string>((resolve, reject) => {
            let settled = false;
            const settle = (): boolean => {
                if (settled) return false;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                onText = () => undefined;
                return true;
            };
            const failAfterStop = (err: Error) => {
                void this.stop().then(() => reject(err), () => reject(err));
            };
            const onAbort = () => {
                if (settle() && signal) failAfterStop(abortError(signal));
            };
            const timer = setTimeout(() => {
                if (!settle()) return;
                failAfterStop(new AppError(
                    'TIMEOUT',
                    `playit.gg did not report an address within ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.`,
                    this.tailText(),
                ));
            }, timeoutMs);
            onText = () => {
                const text = stripAnsi(this.output);
                const address = ADDRESS_RE.exec(text);
                if (address) {
                    if (settle()) {
                        console.log(`[playit] address ${address[1]}`);
                        resolve(address[1]);
                    }
                    return;
                }
                const claim = CLAIM_RE.exec(text);
                if (claim && settle()) {
                    failAfterStop(new AppError(
                        'PLAYIT',
                        'playit.gg is not linked to a playit.gg account on this PC yet. Run playit.gg once by itself, finish its setup, then try again.',
                        claim[0],
                    ));
                }
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            void this.exitPromise.then((code) => {
                if (!settle()) return;
                if (spawnError) reject(new AppError('PLAYIT', 'playit.gg could not be started.', spawnError.message));
                else if (this.stopRequested) reject(new AppError('PLAYIT', 'playit.gg was stopped before it reported an address.', this.tailText()));
                else reject(new AppError('PLAYIT', `playit.gg stopped before it reported an address (exit code ${code ?? 'none'}).`, this.tailText()));
            });
            // Output that arrived while the listeners were being set up.
            onText();
            if (signal?.aborted) onAbort();
        });
    }

    /** Windows: `taskkill /PID <pid> /T /F` awaited; else SIGTERM then SIGKILL. Never throws. */
    stop(): Promise<void> {
        if (!this.child) return Promise.resolve();
        if (!this.stopping) {
            this.stopping = this.kill(this.child).finally(() => {
                this.stopping = null;
            });
        }
        return this.stopping;
    }

    isRunning(): boolean {
        return this.child !== null;
    }

    private async kill(child: ChildProcess): Promise<void> {
        this.stopRequested = true;
        if (this.platform === 'win32') {
            await killProcessTree(child, this.platform, this.execFileImpl, '[playit]');
        } else {
            try {
                child.kill('SIGTERM');
            } catch (err) {
                console.warn('[playit] SIGTERM failed:', err);
            }
            if (!await this.waitForExit(EXIT_WAIT_MS)) await killProcessTree(child, this.platform, this.execFileImpl, '[playit]');
        }
        if (!await this.waitForExit(EXIT_WAIT_MS)) {
            // Nothing more can be done; forget it so the next session can start a new agent.
            console.error(`[playit] process ${child.pid ?? '?'} did not exit after being killed`);
            if (this.child === child) this.child = null;
        }
    }

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

    private tailText(): string {
        return stripAnsi(this.output)
            .split(/\r?\n|\r/)
            .map((l) => l.trimEnd())
            .filter(Boolean)
            .slice(-TAIL_LINES)
            .join('\n');
    }
}
