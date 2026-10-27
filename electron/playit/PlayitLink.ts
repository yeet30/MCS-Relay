// Links this PC to the user's playit.gg account and keeps its Minecraft Java tunnel, so hosting needs no playit setup
// outside the app. Linking works like playit's own agent does it (the "claim" flow):
//   1. download playit's agent from its GitHub release, checked against the sha256 below;
//   2. make a random code and open https://playit.gg/claim/<code> in the browser, where the user signs in (or makes an
//      account) and approves; meanwhile ask /claim/setup every few seconds whether they did;
//   3. trade the code for the agent's secret key (/claim/exchange), kept encrypted like the Google sign-in, and run
//      the agent for a moment: playit.gg's page waits until the approved agent connects ("Please start the playit
//      program...") and only then says it is done;
//   4. while it runs (playit.gg refuses a tunnel for an agent it has not seen run: "AgentVersionTooOld"), make a
//      Minecraft Java tunnel to this PC (/tunnels/create) and read its address. A start points it at the server's port.
// A key playit.gg no longer accepts (the agent was deleted on playit.gg) makes the app forget the link, so the
// "Link playit.gg" button comes back instead of every start failing.
// The Google sign-in cannot be used for playit.gg: Google issues it to MCS-Relay only, so playit.gg's own page is the
// one step outside the app. See docs/public-address/public-address.pdf, section 8.
// No electron import: main.ts passes safeStorage, the browser and the notification in.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { PlayitLinkState, PlayitTunnel } from '../../shared/types';
import type { SafeStorageLike } from '../auth/GoogleAuth';
import { AppError, toAppError } from '../errors';
import { PlayitApi, PlayitRefusal, tunnelAddress } from './PlayitApi';
import type { FetchFn, PlayitTunnelInfo } from './PlayitApi';

/** The agent MCS-Relay runs: playitd.exe of playit's newest stable release (the Windows .exe of a release is
 *  playitd; checksum from GitHub's release page). Its installer sets it up as a Windows service, but the program also
 *  runs by itself with --secret, which is how MCS-Relay runs it: no service, no administrator. playit.gg refuses
 *  tunnels for agents it considers too old (0.16.2 was, in October 2026), so this pin needs updating now and then. */
export const AGENT: AgentRelease = {
    version: '1.0.10',
    url: 'https://github.com/playit-cloud/playit-agent/releases/download/v1.0.10/playit-windows-x86_64-signed.exe',
    sha256: '2dbdaad119844cbbc062cc9774b8b462afa5f1b4b7832a9fc5ef4676cae887cf',
    size: 4_822_072,
};

export interface AgentRelease {
    version: string;
    url: string;
    sha256: string;
    size: number;
}

const TUNNEL_NAME = 'MCS-Relay';
/** playit.gg's answers that mean this PC's key is dead: the agent or the account was deleted. */
const KEY_GONE = new Set(['InvalidAgentKey', 'NoLongerValid', 'AccountDoesNotExist', 'AgentNotFound']);
const LINK_GONE = 'This PC\'s playit.gg agent was deleted on playit.gg, so MCS-Relay removed the link. Link playit.gg again in Settings > Scripts.';
const LINK_FILE = 'link.json';

interface StoredLink {
    /** The agent's secret key: base64 of safeStorage's encryption, or the key itself when Windows offers none. */
    secret: string;
    encrypted: boolean;
    agentId: string;
    tunnelId: string | null;
    address: string | null;
}

export interface AgentProcess {
    run(executable: string, args: string[], settleMs: number, signal?: AbortSignal): Promise<void>;
    stop(): Promise<void>;
    isRunning(): boolean;
}

/** playitd's control pipe; its own name, so a playit.gg installed separately (\\.\pipe\playitd-system) is not disturbed. */
const AGENT_PIPE = '\\\\.\\pipe\\mcs-relay-playitd';
/** The agent's command line: its key and its own control pipe. It logs to stderr. */
export const agentArgs = (secret: string): string[] => ['--secret', secret, '--socket-path', AGENT_PIPE];
/** The agent counts as started once it kept running this long. */
export const AGENT_SETTLE_MS = 4_000;

export interface PlayitLinkDeps {
    /** <userData>/playit: the agent program and link.json. */
    dir: string;
    agentName: string;
    openExternal: (url: string) => Promise<void>;
    emit: (state: PlayitLinkState) => void;
    /** Linked while the user is in the browser: tell them everything is set and to come back to the app. */
    onLinked: (address: string | null) => void;
    safeStorage?: SafeStorageLike;
    fetchImpl?: FetchFn;
    /** Runs the agent right after the approval (the same PlayitProcess hosting uses; skipped while it is busy). */
    agentProcess?: AgentProcess;
    /** Tests download a stand-in. */
    agent?: AgentRelease;
    /** Tests make these short. */
    pollMs?: number;
    linkTimeoutMs?: number;
    tunnelWaitMs?: number;
    createTries?: number;
    createRetryMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('PLAYIT', 'Linking playit.gg was cancelled.'));
    const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    const onAbort = () => {
        clearTimeout(timer);
        reject(new AppError('PLAYIT', 'Linking playit.gg was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
});

export class PlayitLink {
    private readonly api: PlayitApi;
    private readonly fetchImpl: FetchFn;
    private readonly agent: AgentRelease;
    private stored: StoredLink | null;
    private state: PlayitLinkState;
    private linking: AbortController | null = null;
    private downloading: Promise<string> | null = null;
    private lastEmit = 0;

    constructor(private readonly d: PlayitLinkDeps) {
        this.fetchImpl = d.fetchImpl ?? ((url, init) => fetch(url, init));
        this.agent = d.agent ?? AGENT;
        this.api = new PlayitApi(this.fetchImpl);
        this.stored = this.read();
        this.state = { linked: this.stored !== null, address: this.stored?.address ?? null, linking: null, error: null, warning: null };
    }

    getState(): PlayitLinkState {
        return this.state;
    }

    isLinked(): boolean {
        return this.stored !== null;
    }

    agentPath(): string {
        return path.join(this.d.dir, `playit-${this.agent.version}.exe`);
    }

    /** The whole link, from download to key. Resolves when linked; the state tells the window how far it is. */
    async link(): Promise<void> {
        if (this.linking) throw new AppError('BUSY', 'playit.gg is already being linked. Finish it in your browser, or cancel it.');
        const controller = new AbortController();
        this.linking = controller;
        const signal = controller.signal;
        try {
            this.set({ error: null, linking: { step: 'download', done: 0, total: this.agent.size, url: null } });
            const executable = await this.ensureAgent((done, total) => this.progress(done, total));
            signal.throwIfAborted();

            const code = randomBytes(5).toString('hex');
            const url = `https://playit.gg/claim/${code}`;
            // The first call registers the code, so the page knows it when it opens.
            await this.api.claimSetup(code, this.versionText());
            this.set({ linking: { step: 'browser', done: 0, total: 0, url } });
            console.log('[playit] link: opened the approval page in the browser');
            await this.d.openExternal(url);
            await this.waitForApproval(code, signal);

            this.set({ linking: { step: 'finishing', done: 0, total: 0, url: null } });
            const secret = await this.api.claimExchange(code);
            const api = this.api.withSecret(secret);
            const run = await api.runData();
            console.log(`[playit] link: approved; agent ${run.agent_id}, account ${run.account_status}`);
            await api.renameAgent(run.agent_id, this.d.agentName).catch((err) => console.warn('[playit] could not name the agent:', toAppError(err).detail));
            this.stored = { ...this.protect(secret), agentId: run.agent_id, tunnelId: null, address: null };
            await this.write();
            const warning = ACCOUNT_STATUS[run.account_status] ?? null;
            const address = warning ? null : await this.firstRun(executable, secret, run.agent_id, signal);
            this.set({ linked: true, address, linking: null, warning });
            this.d.onLinked(address);
        } catch (err) {
            const cancelled = signal.aborted;
            const info = toAppError(err);
            console.warn(`[playit] link ${cancelled ? 'cancelled' : 'failed'}: ${info.message}${info.detail ? ` (${info.detail})` : ''}`);
            this.set({ linking: null, error: cancelled ? null : info });
            if (!cancelled) throw err;
        } finally {
            this.linking = null;
        }
    }

    /** Runs the new agent so playit.gg's page sees it connect, and makes the tunnel meanwhile (port 25565 until a server
     *  with another port starts). Problems here are not fatal: the next start tries again. */
    private async firstRun(executable: string, secret: string, agentId: string, signal: AbortSignal): Promise<string | null> {
        const agent = this.d.agentProcess;
        if (!agent || agent.isRunning()) return null;
        try {
            console.log('[playit] link: running the agent once so playit.gg sees it connect');
            await agent.run(executable, agentArgs(secret), AGENT_SETTLE_MS, signal);
            return (await this.ensureTunnel(this.api.withSecret(secret), agentId, 25565, signal)).address;
        } catch (err) {
            const info = toAppError(err);
            console.warn(`[playit] link: the first run did not finish (${info.message}); the next start tries again`);
            return null;
        } finally {
            await agent.stop();
        }
    }

    cancelLink(): void {
        this.linking?.abort();
    }

    /** Opens the approval page again (the browser tab was closed). */
    async reopen(): Promise<void> {
        const url = this.state.linking?.url;
        if (url) await this.d.openExternal(url);
    }

    /** Forgets the link on this PC and removes its tunnel from the account (the agent stays listed on playit.gg,
     *  where the user can delete it). */
    async unlink(): Promise<void> {
        const stored = this.stored;
        if (!stored) return;
        if (stored.tunnelId) {
            const secret = this.secret(stored);
            if (secret) {
                await this.api.withSecret(secret).deleteTunnel(stored.tunnelId)
                    .catch((err) => console.warn('[playit] could not delete the tunnel:', toAppError(err).message));
            }
        }
        this.stored = null;
        await fs.rm(path.join(this.d.dir, LINK_FILE), { force: true });
        console.log('[playit] unlinked');
        this.set({ linked: false, address: null, error: null, warning: null });
    }

    /** Asks playit.gg again whether this PC's agent may run (after the user deleted an agent, say). */
    async check(): Promise<void> {
        const stored = this.stored;
        const secret = stored && this.secret(stored);
        if (!secret) return;
        const run = await this.guard(() => this.api.withSecret(secret).runData());
        this.set({ warning: ACCOUNT_STATUS[run.account_status] ?? null });
    }

    /** What starting the agent needs: the program and its key, once playit.gg said the agent may run. */
    async prepare(): Promise<{ executable: string; secret: string }> {
        const stored = this.stored;
        if (!stored) throw new AppError('PLAYIT', 'playit.gg is not linked on this PC. Link it in Settings > Scripts.');
        const secret = this.secret(stored);
        if (!secret) throw new AppError('PLAYIT', 'This PC\'s playit.gg link could not be read. Link playit.gg again in Settings > Scripts.');
        const executable = await this.ensureAgent();
        const run = await this.guard(() => this.api.withSecret(secret).runData());
        const blocked = ACCOUNT_STATUS[run.account_status] ?? null;
        if (blocked !== this.state.warning) this.set({ warning: blocked });
        if (blocked) throw new AppError('PLAYIT', blocked, run.account_status);
        return { executable, secret };
    }

    /** With the agent running: its Minecraft Java tunnel, made if missing and pointed at `port`. */
    async openTunnel(port: number, signal?: AbortSignal): Promise<PlayitTunnel[]> {
        const stored = this.stored;
        const secret = stored && this.secret(stored);
        if (!stored || !secret) throw new AppError('PLAYIT', 'playit.gg is not linked on this PC. Link it in Settings > Scripts.');
        const { address } = await this.guard(() => this.ensureTunnel(this.api.withSecret(secret), stored.agentId, port, signal));
        if (address !== this.state.address) this.set({ address });
        return [{ address, type: 'minecraft-java', local: `127.0.0.1:${port}` }];
    }

    /** Runs a call with this PC's key; a key playit.gg no longer accepts makes the app forget the link. */
    private async guard<T>(call: () => Promise<T>): Promise<T> {
        try {
            return await call();
        } catch (err) {
            if (!(err instanceof PlayitRefusal) || !KEY_GONE.has(err.reason)) throw err;
            console.warn(`[playit] the key was refused (${err.reason}); forgetting the link`);
            this.stored = null;
            await fs.rm(path.join(this.d.dir, LINK_FILE), { force: true });
            const info = { code: 'PLAYIT' as const, message: LINK_GONE, detail: err.reason };
            this.set({ linked: false, address: null, warning: null, error: info });
            throw new AppError('PLAYIT', LINK_GONE, err.reason);
        }
    }

    /* ------------------------------------------------------------------ agent program */

    /** The agent program, downloaded once (checked against its sha256). */
    private ensureAgent(onProgress?: (done: number, total: number) => void): Promise<string> {
        const target = this.agentPath();
        if (existsSync(target)) return Promise.resolve(target);
        this.downloading ??= this.download(target, onProgress).finally(() => {
            this.downloading = null;
        });
        return this.downloading;
    }

    /** How the agent describes itself to playit.gg, as playit's own program does. */
    private versionText(): string {
        return `playit ${this.agent.version}`;
    }

    private async download(target: string, onProgress?: (done: number, total: number) => void): Promise<string> {
        await fs.mkdir(this.d.dir, { recursive: true });
        console.log(`[playit] downloading the agent ${this.agent.version} from GitHub`);
        let response: Response;
        try {
            response = await this.fetchImpl(this.agent.url);
        } catch (err) {
            throw new AppError('NETWORK', 'playit.gg\'s program could not be downloaded. Check your internet connection.', err instanceof Error ? err.message : String(err));
        }
        if (!response.ok || !response.body) throw new AppError('NETWORK', `GitHub answered ${response.status} for playit.gg's program. Try again later.`, this.agent.url);
        const part = `${target}.part`;
        const hash = createHash('sha256');
        let done = 0;
        const meter = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
                done += chunk.length;
                hash.update(chunk);
                onProgress?.(done, this.agent.size);
                callback(null, chunk);
            },
        });
        try {
            await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), meter, createWriteStream(part));
            if (hash.digest('hex') !== this.agent.sha256) {
                throw new AppError('CHECKSUM', 'The downloaded playit.gg program does not match the official one, so it was not used. Try again.');
            }
            await fs.rename(part, target);
        } catch (err) {
            await fs.rm(part, { force: true });
            if (err instanceof AppError) throw err;
            throw new AppError('NETWORK', 'The download of playit.gg\'s program was interrupted. Try again.', err instanceof Error ? err.message : String(err));
        }
        console.log('[playit] agent downloaded and checked');
        // Agents of earlier MCS-Relay builds are not used any more.
        for (const name of await fs.readdir(this.d.dir).catch(() => [])) {
            if (/^playit-.+\.exe$/.test(name) && path.join(this.d.dir, name) !== target) await fs.rm(path.join(this.d.dir, name), { force: true }).catch(() => undefined);
        }
        return target;
    }

    /* ------------------------------------------------------------------ linking */

    private async waitForApproval(code: string, signal: AbortSignal): Promise<void> {
        const pollMs = this.d.pollMs ?? 2_500;
        const endAt = Date.now() + (this.d.linkTimeoutMs ?? 20 * 60_000);
        let failures = 0;
        for (;;) {
            await sleep(pollMs, signal);
            if (Date.now() > endAt) throw new AppError('TIMEOUT', 'The playit.gg page was not approved in time. Try linking again.');
            let status;
            try {
                status = await this.api.claimSetup(code, this.versionText());
                failures = 0;
            } catch (err) {
                // A refusal ends it; a network hiccup is tried again a few times.
                if (err instanceof PlayitRefusal || ++failures >= 5) throw err;
                continue;
            }
            if (status === 'UserAccepted') return;
            if (status === 'UserRejected') throw new PlayitRefusal('UserRejected', 'The link was declined on playit.gg.');
        }
    }

    /* ------------------------------------------------------------------ tunnel */

    /** This PC's Minecraft Java tunnel, made if missing and pointed at `port`, once playit.gg gave it an address. */
    private async ensureTunnel(api: PlayitApi, agentId: string, port: number, signal?: AbortSignal): Promise<{ id: string; address: string }> {
        const list = await api.listTunnels(agentId);
        const mine = (t: PlayitTunnelInfo) => t.origin?.type === 'agent' && (t.origin.data as { agent_id?: string }).agent_id === agentId;
        let tunnel = list.tunnels.find((t) => t.id === this.stored?.tunnelId)
            ?? list.tunnels.find((t) => mine(t) && t.tunnel_type === 'minecraft-java');
        if (!tunnel) {
            console.log(`[playit] creating a Minecraft Java tunnel to port ${port}`);
            const id = await this.createTunnel(api, agentId, port, signal);
            await this.remember({ tunnelId: id });
            tunnel = await this.waitForAddress(api, agentId, id, signal);
        } else {
            if (tunnel.id !== this.stored?.tunnelId) await this.remember({ tunnelId: tunnel.id });
            const origin = tunnel.origin?.type === 'agent' ? (tunnel.origin.data as { local_port?: number | null }) : null;
            if (origin?.local_port !== port || tunnel.disabled_reason) {
                console.log(`[playit] pointing the tunnel at port ${port}`);
                await api.updateTunnel(tunnel.id, agentId, port);
            }
            if (tunnel.alloc?.status !== 'allocated') tunnel = await this.waitForAddress(api, agentId, tunnel.id, signal);
        }
        const address = tunnelAddress(tunnel);
        if (!address) throw new AppError('PLAYIT', 'playit.gg has not given the tunnel an address yet. Try again in a minute.');
        if (address !== this.stored?.address) {
            console.log(`[playit] tunnel address: ${address} (${JSON.stringify(tunnel.alloc)})`);
            await this.remember({ address });
        }
        return { id: tunnel.id, address };
    }

    /** The agent may not be registered with playit.gg yet right after it started ("AgentVersionTooOld"): a few tries. */
    private async createTunnel(api: PlayitApi, agentId: string, port: number, signal?: AbortSignal): Promise<string> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await api.createTunnel(agentId, TUNNEL_NAME, port);
            } catch (err) {
                if (!(err instanceof PlayitRefusal) || err.reason !== 'AgentVersionTooOld' || attempt >= (this.d.createTries ?? 5)) throw err;
                console.log(`[playit] playit.gg has not seen the agent yet (try ${attempt}); waiting`);
                await sleep(this.d.createRetryMs ?? 3_000, signal);
            }
        }
    }

    private async waitForAddress(api: PlayitApi, agentId: string, id: string, signal?: AbortSignal): Promise<PlayitTunnelInfo> {
        const endAt = Date.now() + (this.d.tunnelWaitMs ?? 30_000);
        for (;;) {
            const tunnel = (await api.listTunnels(agentId)).tunnels.find((t) => t.id === id);
            if (!tunnel) throw new AppError('PLAYIT', 'The playit.gg tunnel disappeared while it was being made. Try again.');
            if (tunnel.alloc?.status === 'allocated') return tunnel;
            if (tunnel.alloc?.status === 'disabled') {
                const reason = (tunnel.alloc as { data: { reason: string } }).data.reason;
                throw new AppError('PLAYIT', reason === 'over-port-limit'
                    ? 'Your playit.gg account has no free tunnels left. Delete one at playit.gg, then try again.'
                    : `playit.gg switched the tunnel off (${reason}).`, reason);
            }
            if (Date.now() > endAt) throw new AppError('TIMEOUT', 'playit.gg took too long to give the tunnel an address. Try again in a minute.');
            await sleep(1_500, signal);
        }
    }

    /* ------------------------------------------------------------------ storage */

    private protect(secret: string): Pick<StoredLink, 'secret' | 'encrypted'> {
        const safe = this.cipher();
        return safe ? { secret: safe.encryptString(secret).toString('base64'), encrypted: true } : { secret, encrypted: false };
    }

    private secret(stored: StoredLink): string | null {
        if (!stored.encrypted) return stored.secret;
        try {
            return this.cipher()?.decryptString(Buffer.from(stored.secret, 'base64')) ?? null;
        } catch (err) {
            console.warn('[playit] could not decrypt the link:', err instanceof Error ? err.message : String(err));
            return null;
        }
    }

    private cipher(): SafeStorageLike | null {
        try {
            return this.d.safeStorage?.isEncryptionAvailable() ? this.d.safeStorage : null;
        } catch {
            return null;
        }
    }

    private read(): StoredLink | null {
        const file = path.join(this.d.dir, LINK_FILE);
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredLink>;
            if (typeof raw.secret !== 'string' || typeof raw.agentId !== 'string') return null;
            return {
                secret: raw.secret, encrypted: raw.encrypted === true, agentId: raw.agentId,
                tunnelId: typeof raw.tunnelId === 'string' ? raw.tunnelId : null,
                address: typeof raw.address === 'string' ? raw.address : null,
            };
        } catch {
            return null;
        }
    }

    private async remember(patch: Partial<StoredLink>): Promise<void> {
        if (!this.stored) return;
        this.stored = { ...this.stored, ...patch };
        await this.write();
    }

    private async write(): Promise<void> {
        await fs.mkdir(this.d.dir, { recursive: true });
        const file = path.join(this.d.dir, LINK_FILE);
        await fs.writeFile(`${file}.tmp`, JSON.stringify(this.stored, null, 2));
        await fs.rename(`${file}.tmp`, file);
    }

    /* ------------------------------------------------------------------ state */

    private set(patch: Partial<PlayitLinkState>): void {
        this.state = { ...this.state, ...patch };
        this.d.emit(this.state);
    }

    private progress(done: number, total: number): void {
        const now = Date.now();
        if (done < total && now - this.lastEmit < 200) return;
        this.lastEmit = now;
        this.set({ linking: { step: 'download', done, total, url: null } });
    }
}

/** Account states that stop the agent from running, as playit.gg names them. */
const ACCOUNT_STATUS: Record<string, string> = {
    'email-not-verified': 'Your playit.gg account\'s email address is not verified yet. Open the email from playit.gg, then start again.',
    banned: 'playit.gg has banned this playit.gg account.',
    'account-delete-scheduled': 'This playit.gg account is about to be deleted. Link another account in Settings > Scripts.',
    'agent-disabled': 'This PC\'s playit.gg agent is switched off on playit.gg. Switch it on there, or link playit.gg again.',
    'agent-over-limit': 'Your playit.gg account has more agents than its plan allows, so playit.gg will not run this PC\'s. Delete one you no longer use at playit.gg (the one of playit.gg\'s own program, say), then try again.',
};
