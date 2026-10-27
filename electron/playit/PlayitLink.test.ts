import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayitLinkState } from '../../shared/types';
import type { SafeStorageLike } from '../auth/GoogleAuth';
import { PLAYIT_API, tunnelAddress, tunnelLocalPort } from './PlayitApi';
import type { FetchFn, PlayitTunnelInfo } from './PlayitApi';
import { PlayitLink, agentArgs } from './PlayitLink';
import type { AgentRelease } from './PlayitLink';
import { PlayitRunner } from './PlayitRunner';

const AGENT_BYTES = Buffer.from('a stand-in for playit.exe');
const AGENT: AgentRelease = {
    version: '0.16.2',
    url: 'https://github.example/playit.exe',
    sha256: createHash('sha256').update(AGENT_BYTES).digest('hex'),
    size: AGENT_BYTES.length,
};
const SECRET = 'agent-secret-123';

const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }));
const fail = (data: unknown) => new Response(JSON.stringify({ status: 'fail', data }));

/** playit.gg in memory: the claim flow, the agent's run data and its tunnels. */
function fakePlayit(o: { approveAfter?: number; reject?: boolean; accountStatus?: string; agentBytes?: Buffer; unseenFor?: number } = {}) {
    let unseen = o.unseenFor ?? 0;
    let accountStatus = o.accountStatus ?? 'ready';
    let revoked = false;
    const calls: Array<{ route: string; body: Record<string, unknown>; auth: string | undefined }> = [];
    const polls = new Map<string, number>();
    let tunnels: PlayitTunnelInfo[] = [];
    let created = 0;
    const fetchImpl: FetchFn = async (url, init) => {
        if (url === AGENT.url) return new Response(new Uint8Array(o.agentBytes ?? AGENT_BYTES));
        const route = url.slice(PLAYIT_API.length);
        const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        const auth = init?.headers?.Authorization;
        calls.push({ route, body, auth });
        const authorised = auth === `Agent-Key ${SECRET}` && !revoked;
        switch (route) {
            case '/claim/setup': {
                const n = (polls.get(body.code as string) ?? 0) + 1;
                polls.set(body.code as string, n);
                if (n <= (o.approveAfter ?? 2)) return ok(n === 1 ? 'WaitingForUserVisit' : 'WaitingForUser');
                return ok(o.reject ? 'UserRejected' : 'UserAccepted');
            }
            case '/claim/exchange':
                return ok({ secret_key: SECRET });
            case '/agents/rundata':
                if (!authorised) return new Response(JSON.stringify({ status: 'error', data: { type: 'auth', message: 'InvalidAgentKey' } }));
                return ok({ agent_id: 'agent-1', account_status: accountStatus });
            case '/agents/rename':
                return ok(null);
            case '/v1/tunnels/list':
                // A new tunnel gets its address by the next look.
                tunnels = tunnels.map((t) => (t.connect_addresses.length === 0
                    ? { ...t, offline_reasons: null, connect_addresses: [{ type: 'addr4', value: { address: '147.185.221.1:41000' } }, { type: 'auto', value: { address: `t${t.id}.joinmc.link` } }] }
                    : t));
                return ok({ tunnels });
            case '/v1/tunnels/create': {
                // An agent playit.gg has not registered yet.
                if (unseen > 0) {
                    unseen -= 1;
                    return fail('AgentVersionTooOld');
                }
                created += 1;
                const origin = body.origin as { type: string; data: { agent_id: string; config: { fields: Array<{ name: string; value: string }> } } };
                const ports = body.ports as { type: string; details: string };
                tunnels.push({
                    id: String(created), name: body.name as string, tunnel_type: ports.details, user_enabled: true,
                    offline_reasons: ['PublicAllocationPending'], connect_addresses: [],
                    origin: { type: 'agent', details: { agent_id: origin.data.agent_id, config_data: origin.data.config } },
                });
                return ok({ id: String(created) });
            }
            case '/v1/tunnels/config': {
                const config = body.new_config as { fields: Array<{ name: string; value: string }> };
                tunnels = tunnels.map((t) => (t.id === body.tunnel_id
                    ? { ...t, origin: { type: 'agent', details: { agent_id: 'agent-1', config_data: config } } }
                    : t));
                return ok(null);
            }
            case '/tunnels/delete':
                tunnels = tunnels.filter((t) => t.id !== body.tunnel_id);
                return ok(null);
            default:
                return fail('NotFound');
        }
    };
    return {
        calls, fetchImpl, tunnels: () => tunnels, routes: () => calls.map((c) => c.route),
        setAccountStatus: (status: string) => void (accountStatus = status),
        /** The agent was deleted on playit.gg. */
        revoke: () => void (revoked = true),
    };
}

const fakeSafe: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => b.toString().slice(4),
};

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The agent program: running or not. */
function fakeAgent() {
    let running = false;
    return {
        run: vi.fn(async () => void (running = true)),
        stop: vi.fn(async () => void (running = false)),
        isRunning: () => running,
    };
}

function setup(playit = fakePlayit(), dir?: string, agentProcess = fakeAgent()) {
    const folder = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-playit-'));
    if (!dir) dirs.push(folder);
    const states: PlayitLinkState[] = [];
    const opened: string[] = [];
    const onLinked = vi.fn();
    const link = new PlayitLink({
        dir: folder, agentName: 'MCS-Relay (TEST-PC)', fetchImpl: playit.fetchImpl, safeStorage: fakeSafe, agent: AGENT,
        openExternal: async (url) => void opened.push(url),
        emit: (state) => void states.push(state),
        onLinked, pollMs: 1, linkTimeoutMs: 5_000, tunnelWaitMs: 5_000, createRetryMs: 1, pageCatchUpMs: 1, agentProcess,
    });
    return { link, playit, folder, states, opened, onLinked, agentProcess };
}

describe('PlayitLink.link', () => {
    it('downloads the agent, waits for the approval, keeps the key encrypted, and runs the agent once to make the tunnel', async () => {
        const t = setup();
        await t.link.link();

        expect(fs.readFileSync(path.join(t.folder, 'playit-0.16.2.exe'))).toEqual(AGENT_BYTES);
        expect(t.opened).toHaveLength(1);
        expect(t.opened[0]).toMatch(/^https:\/\/playit\.gg\/claim\/[0-9a-f]{10}$/);
        const code = t.opened[0].split('/').pop();
        expect(t.playit.calls.filter((c) => c.route === '/claim/setup').every((c) => c.body.code === code && c.body.agent_type === 'self-managed')).toBe(true);
        expect(t.playit.routes()).toContain('/claim/exchange');

        // The key is not stored as it is.
        const stored = fs.readFileSync(path.join(t.folder, 'link.json'), 'utf8');
        expect(stored).not.toContain(SECRET);
        expect(JSON.parse(stored)).toMatchObject({ encrypted: true, agentId: 'agent-1', tunnelId: '1', address: 't1.joinmc.link' });
        expect(t.playit.calls.find((c) => c.route === '/agents/rename')?.body).toEqual({ agent_id: 'agent-1', name: 'MCS-Relay (TEST-PC)' });

        // playit.gg's page waits for the approved agent to connect, and makes no tunnel for an agent it has not seen
        // run: the agent runs first, the tunnel comes after, then the agent stops until a server is hosted.
        expect(t.agentProcess.run).toHaveBeenCalledWith(path.join(t.folder, 'playit-0.16.2.exe'), agentArgs(SECRET), expect.any(Number), expect.anything());
        const created = t.playit.calls.findIndex((c) => c.route === '/v1/tunnels/create');
        expect(created).toBeGreaterThan(-1);
        expect(t.agentProcess.run.mock.invocationCallOrder[0]).toBeLessThan(t.agentProcess.stop.mock.invocationCallOrder[0]);
        expect(t.agentProcess.isRunning()).toBe(false);
        expect(t.link.getState()).toEqual({ linked: true, address: 't1.joinmc.link', linking: null, error: null, warning: null });
        expect(t.onLinked).toHaveBeenCalledWith('t1.joinmc.link');
        expect(t.states.map((s) => s.linking?.step ?? null)).toEqual(expect.arrayContaining(['download', 'browser', 'finishing']));
    });

    it('links an account with too many agents, and says so', async () => {
        const t = setup(fakePlayit({ accountStatus: 'agent-over-limit' }));
        await t.link.link();
        expect(t.link.getState()).toMatchObject({ linked: true, warning: expect.stringMatching(/more agents than its plan allows/) });
        expect(t.agentProcess.run).not.toHaveBeenCalled();         // playit.gg would not run it
    });

    it('still links when the first run of the agent fails; the next start makes the tunnel', async () => {
        const agent = fakeAgent();
        agent.run.mockRejectedValueOnce(new Error('playit.gg stopped right after it started'));
        const t = setup(fakePlayit(), undefined, agent);
        await t.link.link();
        expect(t.link.getState()).toMatchObject({ linked: true, address: null, error: null });
        expect(agent.stop).toHaveBeenCalled();
        expect(t.playit.routes()).not.toContain('/v1/tunnels/create');
    });

    it('does not run a second agent while one is running for a hosted server', async () => {
        const agent = fakeAgent();
        await agent.run();
        agent.run.mockClear();
        const t = setup(fakePlayit(), undefined, agent);
        await t.link.link();
        expect(agent.run).not.toHaveBeenCalled();
        expect(agent.stop).not.toHaveBeenCalled();
        expect(t.link.getState()).toMatchObject({ linked: true, address: null });
    });

    it('does not use an agent that does not match the official one', async () => {
        const t = setup(fakePlayit({ agentBytes: Buffer.from('something else') }));
        await expect(t.link.link()).rejects.toMatchObject({ code: 'CHECKSUM' });
        expect(fs.existsSync(path.join(t.folder, 'playit-0.16.2.exe'))).toBe(false);
        expect(t.opened).toEqual([]);
        expect(t.link.getState()).toMatchObject({ linked: false, linking: null, error: { code: 'CHECKSUM' } });
    });

    it('ends without a link when the user declines on playit.gg', async () => {
        const t = setup(fakePlayit({ reject: true }));
        await expect(t.link.link()).rejects.toThrow('declined');
        expect(t.link.isLinked()).toBe(false);
        expect(t.link.getState().error?.message).toMatch(/declined/);
        expect(t.onLinked).not.toHaveBeenCalled();
    });

    it('can be cancelled while it waits for the browser', async () => {
        const t = setup(fakePlayit({ approveAfter: 1_000_000 }));
        const linking = t.link.link();
        await vi.waitFor(() => expect(t.link.getState().linking?.step).toBe('browser'));
        t.link.cancelLink();
        await expect(linking).resolves.toBeUndefined();
        expect(t.link.getState()).toMatchObject({ linked: false, linking: null, error: null });
    });

    it('opens the approval page again on request', async () => {
        const t = setup(fakePlayit({ approveAfter: 1_000_000 }));
        const linking = t.link.link();
        await vi.waitFor(() => expect(t.opened).toHaveLength(1));
        await t.link.reopen();
        expect(t.opened).toEqual([t.opened[0], t.opened[0]]);
        t.link.cancelLink();
        await linking;
    });
});

describe('PlayitLink after linking', () => {
    it('is still linked after a restart; with the agent running, it makes the tunnel and points it at the server\'s port', async () => {
        const first = setup();
        await first.link.link();
        const again = setup(first.playit, first.folder);
        expect(again.link.isLinked()).toBe(true);

        expect(await again.link.prepare()).toEqual({ executable: path.join(first.folder, 'playit-0.16.2.exe'), secret: SECRET });
        expect(await again.link.openTunnel(25565)).toEqual([{ address: 't1.joinmc.link', type: 'minecraft-java', local: '127.0.0.1:25565' }]);
        expect(again.link.getState().address).toBe('t1.joinmc.link');

        // Another server with another port: the same tunnel, pointed elsewhere.
        await again.link.openTunnel(25570);
        expect(first.playit.tunnels()).toHaveLength(1);
        expect(tunnelLocalPort(first.playit.tunnels()[0])).toBe(25570);
        expect(first.playit.tunnels()[0].origin).toMatchObject({ details: { config_data: { fields: [{ name: 'local_ip', value: '127.0.0.1' }, { name: 'local_port', value: '25570' }] } } });
        expect(JSON.parse(fs.readFileSync(path.join(first.folder, 'link.json'), 'utf8'))).toMatchObject({ tunnelId: '1', address: 't1.joinmc.link' });
    });

    it('waits for playit.gg to register a just-started agent before giving up on the tunnel', async () => {
        const t = setup(fakePlayit({ unseenFor: 2 }));
        await t.link.link();
        expect(t.link.getState().address).toBe('t1.joinmc.link');
        expect(t.playit.routes().filter((r) => r === '/v1/tunnels/create')).toHaveLength(3);
    });

    it('repairs a tunnel made without an agent config, so playit\'s agent knows where to send players', async () => {
        const t = setup();
        await t.link.link();
        const made = t.playit.tunnels()[0];
        if (made.origin.type === 'agent') made.origin.details.config_data.fields = [];   // as the older API made them
        await t.link.openTunnel(25565);
        expect(t.playit.routes()).toContain('/v1/tunnels/config');
        expect(tunnelLocalPort(t.playit.tunnels()[0])).toBe(25565);
    });

    it('makes a new tunnel when its tunnel was deleted on playit.gg', async () => {
        const t = setup();
        await t.link.link();
        await t.link.openTunnel(25565);
        await t.playit.fetchImpl(`${PLAYIT_API}/tunnels/delete`, { method: 'POST', body: JSON.stringify({ tunnel_id: '1' }) });
        expect((await t.link.openTunnel(25565))[0].address).toBe('t2.joinmc.link');
    });

    it('does not start an agent playit.gg will not run, and checks again on request', async () => {
        const t = setup();
        await t.link.link();
        t.playit.setAccountStatus('agent-over-limit');
        await expect(t.link.prepare()).rejects.toMatchObject({ code: 'PLAYIT', detail: 'agent-over-limit' });
        expect(t.link.getState().warning).toMatch(/more agents/);

        t.playit.setAccountStatus('ready');                      // the user deleted an agent on playit.gg
        await t.link.check();
        expect(t.link.getState().warning).toBeNull();
        await expect(t.link.prepare()).resolves.toMatchObject({ secret: SECRET });
    });

    it('forgets the link when the agent was deleted on playit.gg, so it can be linked again', async () => {
        const t = setup();
        await t.link.link();
        t.playit.revoke();
        await expect(t.link.prepare()).rejects.toThrow(/deleted on playit\.gg/);
        expect(t.link.isLinked()).toBe(false);
        expect(fs.existsSync(path.join(t.folder, 'link.json'))).toBe(false);
        expect(t.link.getState()).toMatchObject({ linked: false, address: null, error: { message: expect.stringMatching(/Link playit\.gg again/) } });
        expect(setup(t.playit, t.folder).link.isLinked()).toBe(false);
    });

    it('unlinking deletes the tunnel and forgets the key', async () => {
        const t = setup();
        await t.link.link();
        await t.link.openTunnel(25565);
        await t.link.unlink();
        expect(t.playit.tunnels()).toEqual([]);
        expect(fs.existsSync(path.join(t.folder, 'link.json'))).toBe(false);
        expect(t.link.getState()).toMatchObject({ linked: false, address: null });
        await expect(t.link.prepare()).rejects.toThrow(/not linked/);
    });
});

describe('PlayitRunner', () => {
    const TUNNEL = { address: 'x.joinmc.link', type: 'minecraft-java', local: '127.0.0.1:25565' };
    const proc = () => ({ start: vi.fn(async () => [{ address: 'own.joinmc.link', type: 'minecraft-java', local: '127.0.0.1:25565' }]), run: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) });
    const linked = () => ({
        isLinked: () => true,
        prepare: vi.fn(async () => ({ executable: 'C:/p/playit.exe', secret: SECRET })),
        openTunnel: vi.fn(async () => [TUNNEL]),
    });

    it('runs the linked agent with its key, then makes the tunnel', async () => {
        const link = linked();
        const p = proc();
        const runner = new PlayitRunner(link, p);
        expect(runner.enabled({ usePlayitgg: true, playitggPath: '' })).toBe(true);
        expect(runner.enabled({ usePlayitgg: false, playitggPath: '' })).toBe(false);
        const tunnels = await runner.start({ serverPath: '', settings: { playitggPath: '' }, timeoutMs: 1000 });
        expect(p.run).toHaveBeenCalledWith('C:/p/playit.exe', agentArgs(SECRET), expect.any(Number), undefined);
        expect(link.openTunnel).toHaveBeenCalledWith(25565, undefined);
        expect(p.run.mock.invocationCallOrder[0]).toBeLessThan(link.openTunnel.mock.invocationCallOrder[0]);
        expect(p.start).not.toHaveBeenCalled();
        expect(tunnels).toEqual([TUNNEL]);
    });

    it('stops the agent when the tunnel cannot be made', async () => {
        const link = linked();
        link.openTunnel.mockRejectedValueOnce(new Error('no tunnel'));
        const p = proc();
        await expect(new PlayitRunner(link, p).start({ serverPath: '', settings: { playitggPath: '' }, timeoutMs: 1000 })).rejects.toThrow('no tunnel');
        expect(p.stop).toHaveBeenCalled();
    });

    it('without a link, starts the program chosen by hand', async () => {
        const link = { isLinked: () => false, prepare: vi.fn(), openTunnel: vi.fn() };
        const p = proc();
        const runner = new PlayitRunner(link, p);
        expect(runner.enabled({ usePlayitgg: true, playitggPath: '' })).toBe(false);
        expect(runner.enabled({ usePlayitgg: true, playitggPath: 'C:/own/playit.exe' })).toBe(true);
        await runner.start({ serverPath: '', settings: { playitggPath: 'C:/own/playit.exe' }, timeoutMs: 1000 });
        expect(p.start).toHaveBeenCalledWith('C:/own/playit.exe', 1000, undefined, undefined);
        expect(link.prepare).not.toHaveBeenCalled();
    });
});

describe('tunnelAddress', () => {
    const tunnel = (connect: Array<[string, string]>, fields: Array<{ name: string; value: string }> = []): PlayitTunnelInfo => ({
        id: '1', name: null, tunnel_type: 'minecraft-java', user_enabled: true, offline_reasons: null,
        origin: { type: 'agent', details: { agent_id: 'a', config_data: { fields } } },
        connect_addresses: connect.map(([type, address]) => ({ type, value: { address } })),
    });

    it('prefers a custom domain, then playit.gg\'s name, then the IP and port', () => {
        expect(tunnelAddress(tunnel([['addr4', '1.2.3.4:5'], ['auto', 'a.joinmc.link'], ['domain', 'play.example.com']]))).toBe('play.example.com');
        expect(tunnelAddress(tunnel([['addr4', '1.2.3.4:5'], ['auto', 'a.joinmc.link']]))).toBe('a.joinmc.link');
        expect(tunnelAddress(tunnel([['addr4', '1.2.3.4:5']]))).toBe('1.2.3.4:5');
        expect(tunnelAddress(tunnel([]))).toBeNull();
    });

    it('reads the local port of the agent config; a tunnel made the old way has none', () => {
        expect(tunnelLocalPort(tunnel([], [{ name: 'local_ip', value: '127.0.0.1' }, { name: 'local_port', value: '25570' }]))).toBe(25570);
        expect(tunnelLocalPort(tunnel([]))).toBeNull();
    });
});
