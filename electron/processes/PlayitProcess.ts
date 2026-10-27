// Runs the playit.gg agent and reads its tunnels ("name.joinmc.link", a voice chat port, ...) from its output.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { PlayitTunnel } from '../../shared/types';
import { AppError } from '../errors';
import { abortError, defaultExecFile, killProcessTree, stripAnsi } from './MinecraftProcess';
import type { ExecFileFn } from './MinecraftProcess';

export interface PlayitProcessDeps {
    spawnImpl?: typeof spawn;
    // Not in the spec's list; optional so tests can fake taskkill and the platform.
    execFileImpl?: ExecFileFn;
    platform?: NodeJS.Platform;
}

// The agent redraws a screen every few seconds; each one lists the tunnels as "<address> => <local> (<type>)",
// a plain port tunnel as "(proto: Udp, port count: 1)" and a switched-off one as "(disabled)".
const SCREEN_START_RE = /^playit \(v/;
const TUNNEL_RE = /^(\S+)\s*=>\s*(\S+)(?:\s+\((.+)\))?$/;
const PROTO_RE = /^proto:\s*(\w+)/;
const PROTOCOLS: Record<string, string> = { tcp: 'tcp', udp: 'udp', both: 'tcp+udp' };
const NO_TUNNELS_RE = /Add tunnels here:\s*(https?:\/\/\S+)/;
/** After the first tunnels appear, how long to wait for the rest of the screen (output can arrive in pieces). */
const SETTLE_MS = 300;
// A fresh agent that was never linked to an account prints a claim link and waits for it forever.
const CLAIM_RE = /https?:\/\/playit\.gg\/claim\/[A-Za-z0-9_-]+/;
const BUFFER_CHARS = 16 * 1024;
const TAIL_LINES = 20;
const EXIT_WAIT_MS = 5_000;
/** How long all of the in-app agent's log reaches the app log (players connecting included); after that, only its
 *  warnings and errors, and never more than AGENT_LOG_LINES lines in all. */
const AGENT_LOG_ALL_MS = 120_000;
const AGENT_LOG_LINES = 400;

export interface PlayitScreen {
    tunnels: PlayitTunnel[];
    disabled: number;
    /** Shown instead of tunnels when the agent has none: where to add one. */
    addUrl: string | null;
}

/** The tunnels on the newest screen the agent drew (escape codes already removed). Disabled tunnels are counted,
 *  not listed. */
export function parsePlayitScreen(text: string): PlayitScreen {
    const lines = text.split(/\r?\n|\r/).map((line) => line.trim());
    let start = 0;
    lines.forEach((line, index) => {
        if (SCREEN_START_RE.test(line)) start = index;
    });
    const screen: PlayitScreen = { tunnels: [], disabled: 0, addUrl: null };
    for (const line of lines.slice(start)) {
        const add = NO_TUNNELS_RE.exec(line);
        if (add) screen.addUrl = add[1];
        const match = TUNNEL_RE.exec(line);
        if (!match) continue;
        const [, address, local, kind] = match;
        if (kind === 'disabled') {
            screen.disabled += 1;
            continue;
        }
        const proto = kind ? PROTO_RE.exec(kind) : null;
        const type = proto ? PROTOCOLS[proto[1].toLowerCase()] ?? proto[1].toLowerCase()
            : kind ?? (address.endsWith('.joinmc.link') ? 'minecraft-java' : 'tcp');
        if (!screen.tunnels.some((t) => t.address === address)) screen.tunnels.push({ address, type, local });
    }
    return screen;
}

const sameTunnels = (a: PlayitTunnel[], b: PlayitTunnel[]): boolean => JSON.stringify(a) === JSON.stringify(b);

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

    /** Starts the agent and resolves with its tunnels once it lists at least one; AppError('PLAYIT'|'TIMEOUT')
     *  otherwise (kills it). `onTunnels` hears about later changes (a tunnel added or removed while it runs). */
    async start(executable: string, timeoutMs: number, signal?: AbortSignal, onTunnels?: (tunnels: PlayitTunnel[]) => void): Promise<PlayitTunnel[]> {
        if (this.child) throw new AppError('BUSY', 'playit.gg is already running.');
        if (signal?.aborted) throw abortError(signal);
        if (!executable || !existsSync(executable)) {
            throw new AppError('PLAYIT', 'The playit.gg program you chose was not found: it may have been uninstalled or moved. Link playit.gg in Settings > Server settings instead.', executable);
        }

        let onText: () => void = () => undefined;
        let reported: PlayitTunnel[] | null = null;
        // After the start: tell the session when the list changes.
        const followTunnels = () => {
            if (!reported || !onTunnels) return;
            const { tunnels } = parsePlayitScreen(stripAnsi(this.output));
            if (tunnels.length === 0 || sameTunnels(tunnels, reported)) return;
            reported = tunnels;
            console.log(`[playit] tunnels now: ${tunnels.map((t) => `${t.address} (${t.type})`).join(', ')}`);
            onTunnels(tunnels);
        };
        const launched = this.launch(executable, [], () => {
            onText();
            followTunnels();
        });

        return new Promise<PlayitTunnel[]>((resolve, reject) => {
            let settled = false;
            let settling: ReturnType<typeof setTimeout> | null = null;
            const settle = (): boolean => {
                if (settled) return false;
                settled = true;
                clearTimeout(timer);
                if (settling) clearTimeout(settling);
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
                    `playit.gg did not list a tunnel within ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.`,
                    this.tailText(),
                ));
            }, timeoutMs);
            onText = () => {
                const text = stripAnsi(this.output);
                const screen = parsePlayitScreen(text);
                if (screen.tunnels.length > 0) {
                    // The rest of the list may still be on its way: wait until the output is quiet for a moment.
                    if (settling) clearTimeout(settling);
                    settling = setTimeout(() => {
                        const { tunnels } = parsePlayitScreen(stripAnsi(this.output));
                        if (!settle()) return;
                        console.log(`[playit] tunnels: ${tunnels.map((t) => `${t.address} (${t.type})`).join(', ')}`);
                        reported = tunnels;
                        resolve(tunnels);
                    }, SETTLE_MS);
                    return;
                }
                if (screen.addUrl && settle()) {
                    failAfterStop(new AppError(
                        'PLAYIT',
                        'Your playit.gg agent has no tunnels yet. Add a "Minecraft Java" tunnel to it on playit.gg, then start again.',
                        screen.addUrl,
                    ));
                    return;
                }
                if (screen.disabled > 0 && settle()) {
                    failAfterStop(new AppError('PLAYIT', 'All of your playit.gg tunnels are disabled. Turn one on at playit.gg, then start again.', text.slice(-2000)));
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
                const spawnError = launched.spawnError();
                if (spawnError) reject(new AppError('PLAYIT', 'playit.gg could not be started.', spawnError.message));
                else if (this.stopRequested) reject(new AppError('PLAYIT', 'playit.gg was stopped before it listed its tunnels.', this.tailText()));
                else reject(new AppError('PLAYIT', `playit.gg stopped before it listed its tunnels (exit code ${code ?? 'none'}).`, this.tailText()));
            });
            // Output that arrived while the listeners were being set up.
            onText();
            if (signal?.aborted) onAbort();
        });
    }

    /** Starts the agent of a link made in the app: it gets its key on the command line and logs instead of drawing
     *  a screen, and its tunnel comes from playit.gg's API (PlayitLink). Resolves once it kept running for
     *  `settleMs`; AppError('PLAYIT') when it stops before that. */
    async run(executable: string, args: string[], settleMs: number, signal?: AbortSignal): Promise<void> {
        if (this.child) throw new AppError('BUSY', 'playit.gg is already running.');
        if (signal?.aborted) throw abortError(signal);
        let partial = '';
        let logged = 0;
        const startedAt = Date.now();
        const launched = this.launch(executable, args, (chunk) => {
            // Its log goes into the app's log: everything at first, and after that warnings and errors only.
            const lines = (partial + chunk).split(/\r?\n/);
            partial = lines.pop() ?? '';
            for (const raw of lines) {
                const line = stripAnsi(raw).trim();
                const early = Date.now() - startedAt < AGENT_LOG_ALL_MS;
                if (!line || logged >= AGENT_LOG_LINES || (!early && !/warn|error|fail/i.test(line))) continue;
                logged += 1;
                console.log(`[playit] agent: ${line}`);
            }
        });
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const settle = (): boolean => {
                if (settled) return false;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                return true;
            };
            const timer = setTimeout(() => {
                if (settle()) resolve();
            }, settleMs);
            const onAbort = () => {
                if (!settle() || !signal) return;
                const err = abortError(signal);
                void this.stop().then(() => reject(err), () => reject(err));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            void this.exitPromise.then((code) => {
                if (!settle()) return;
                const spawnError = launched.spawnError();
                if (spawnError) reject(new AppError('PLAYIT', 'playit.gg could not be started.', spawnError.message));
                else reject(new AppError('PLAYIT', `playit.gg stopped right after it started (exit code ${code ?? 'none'}).`, this.tailText()));
            });
            if (signal?.aborted) onAbort();
        });
    }

    /** Spawns the agent and keeps reading its output (a full pipe would block it); `onData` hears every piece. */
    private launch(executable: string, args: string[], onData: (chunk: string) => void): { spawnError: () => Error | null } {
        let child: ChildProcess;
        try {
            child = this.spawnImpl(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
            throw new AppError('PLAYIT', 'playit.gg could not be started.', err instanceof Error ? err.message : String(err));
        }
        console.log(`[playit] started ${executable} (pid ${child.pid ?? '?'})`);
        this.child = child;
        this.stopRequested = false;
        this.output = '';

        let spawnError: Error | null = null;
        const read = (chunk: Buffer | string) => {
            const text = chunk.toString();
            this.output = (this.output + text).slice(-BUFFER_CHARS);
            onData(text);
        };
        child.stdout?.on('data', read);
        child.stderr?.on('data', read);
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
        return { spawnError: () => spawnError };
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
