import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayitLinkState } from '../../shared/types';
import type { SafeStorageLike } from '../auth/GoogleAuth';
import { PLAYIT_API, tunnelAddress } from './PlayitApi';
import type { FetchFn, PlayitTunnelInfo } from './PlayitApi';
import { PlayitLink } from './PlayitLink';
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
function fakePlayit(o: { approveAfter?: number; reject?: boolean; accountStatus?: string; agentBytes?: Buffer } = {}) {
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
        const authorised = auth === `Agent-Key ${SECRET}`;
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
                return ok({ agent_id: 'agent-1', account_status: o.accountStatus ?? 'ready' });
            case '/agents/rename':
                return ok(null);
            case '/tunnels/list':
                // A new tunnel gets its address by the next look.
                tunnels = tunnels.map((t) => (t.alloc.status === 'pending'
                    ? { ...t, alloc: { status: 'allocated', data: { assigned_domain: `t${t.id}.ply.gg`, assigned_srv: `t${t.id}.joinmc.link`, port_start: 41000 } } }
                    : t));
                return ok({ tunnels, tcp_alloc: { allowed: 4, claimed: tunnels.length } });
            case '/tunnels/create': {
                created += 1;
                const origin = body.origin as { data: { agent_id: string; local_port: number } };
                tunnels.push({
                    id: String(created), name: body.name as string, tunnel_type: body.tunnel_type as string, port_type: 'tcp',
                    alloc: { status: 'pending' }, disabled_reason: null,
                    origin: { type: 'agent', data: { agent_id: origin.data.agent_id, local_ip: '127.0.0.1', local_port: origin.data.local_port } },
                });
                return ok({ id: String(created) });
            }
            case '/tunnels/update':
                tunnels = tunnels.map((t) => (t.id === body.tunnel_id
                    ? { ...t, origin: { type: 'agent', data: { agent_id: 'agent-1', local_ip: '127.0.0.1', local_port: body.local_port as number } } }
                    : t));
                return ok(null);
            case '/tunnels/delete':
                tunnels = tunnels.filter((t) => t.id !== body.tunnel_id);
                return ok(null);
            default:
                return fail('NotFound');
        }
    };
    return { calls, fetchImpl, tunnels: () => tunnels, routes: () => calls.map((c) => c.route) };
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

function setup(playit = fakePlayit(), dir?: string) {
    const folder = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-playit-'));
    if (!dir) dirs.push(folder);
    const states: PlayitLinkState[] = [];
    const opened: string[] = [];
    const onLinked = vi.fn();
    const link = new PlayitLink({
        dir: folder, agentName: 'MCS-Relay (TEST-PC)', fetchImpl: playit.fetchImpl, safeStorage: fakeSafe, agent: AGENT,
        openExternal: async (url) => void opened.push(url),
        emit: (state) => void states.push(state),
        onLinked, pollMs: 1, linkTimeoutMs: 5_000, tunnelWaitMs: 5_000,
    });
    return { link, playit, folder, states, opened, onLinked };
}

describe('PlayitLink.link', () => {
    it('downloads the agent, waits for the approval in the browser, keeps the key encrypted and makes the tunnel', async () => {
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
        expect(t.playit.tunnels()).toHaveLength(1);
        expect(t.playit.tunnels()[0]).toMatchObject({ tunnel_type: 'minecraft-java', origin: { data: { local_port: 25565 } } });

        expect(t.link.getState()).toEqual({ linked: true, address: 't1.joinmc.link', linking: null, error: null });
        expect(t.onLinked).toHaveBeenCalledWith('t1.joinmc.link');
        expect(t.states.map((s) => s.linking?.step ?? null)).toEqual(expect.arrayContaining(['download', 'browser', 'finishing']));
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
    it('is still linked after a restart, and points the tunnel at the server\'s port for a start', async () => {
        const first = setup();
        await first.link.link();
        const again = setup(first.playit, first.folder);
        expect(again.link.isLinked()).toBe(true);
        expect(again.link.getState().address).toBe('t1.joinmc.link');

        const prepared = await again.link.prepare(25570);
        expect(prepared).toEqual({
            executable: path.join(first.folder, 'playit-0.16.2.exe'),
            secret: SECRET,
            tunnels: [{ address: 't1.joinmc.link', type: 'minecraft-java', local: '127.0.0.1:25570' }],
        });
        expect(first.playit.tunnels()).toHaveLength(1);              // the same tunnel, not a new one
        expect(first.playit.tunnels()[0].origin).toMatchObject({ data: { local_port: 25570 } });
    });

    it('makes the tunnel at the start when linking could not', async () => {
        const t = setup();
        await t.link.link();
        fs.writeFileSync(path.join(t.folder, 'link.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(t.folder, 'link.json'), 'utf8')), tunnelId: 'gone', address: null }));
        await t.playit.fetchImpl(`${PLAYIT_API}/tunnels/delete`, { method: 'POST', body: JSON.stringify({ tunnel_id: '1' }) });
        const again = setup(t.playit, t.folder);
        const prepared = await again.link.prepare(25565);
        expect(prepared.tunnels[0].address).toBe('t2.joinmc.link');
    });

    it('stops a start when the playit.gg account cannot run the agent', async () => {
        const t = setup(fakePlayit({ accountStatus: 'email-not-verified' }));
        await t.link.link();
        await expect(t.link.prepare(25565)).rejects.toThrow(/not verified/);
    });

    it('unlinking deletes the tunnel and forgets the key', async () => {
        const t = setup();
        await t.link.link();
        await t.link.unlink();
        expect(t.playit.tunnels()).toEqual([]);
        expect(fs.existsSync(path.join(t.folder, 'link.json'))).toBe(false);
        expect(t.link.getState()).toMatchObject({ linked: false, address: null });
        await expect(t.link.prepare(25565)).rejects.toThrow(/not linked/);
    });
});

describe('PlayitRunner', () => {
    const proc = () => ({ start: vi.fn(async () => [{ address: 'own.joinmc.link', type: 'minecraft-java', local: '127.0.0.1:25565' }]), run: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) });

    it('runs the linked agent with its key and returns the tunnel from playit.gg', async () => {
        const link = { isLinked: () => true, prepare: vi.fn(async () => ({ executable: 'C:/p/playit.exe', secret: SECRET, tunnels: [{ address: 'x.joinmc.link', type: 'minecraft-java', local: '127.0.0.1:25565' }] })) };
        const p = proc();
        const runner = new PlayitRunner(link, p);
        expect(runner.enabled({ usePlayitgg: true, playitggPath: '' })).toBe(true);
        expect(runner.enabled({ usePlayitgg: false, playitggPath: '' })).toBe(false);
        const tunnels = await runner.start({ serverPath: '', settings: { playitggPath: '' }, timeoutMs: 1000 });
        expect(link.prepare).toHaveBeenCalledWith(25565, undefined);
        expect(p.run).toHaveBeenCalledWith('C:/p/playit.exe', ['--secret', SECRET, '-s', 'start'], expect.any(Number), undefined);
        expect(p.start).not.toHaveBeenCalled();
        expect(tunnels[0].address).toBe('x.joinmc.link');
    });

    it('without a link, starts the program chosen by hand', async () => {
        const link = { isLinked: () => false, prepare: vi.fn() };
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
    const tunnel = (data: { assigned_domain: string; assigned_srv: string | null; port_start: number }): PlayitTunnelInfo => ({
        id: '1', name: null, tunnel_type: 'minecraft-java', port_type: 'tcp', origin: null, disabled_reason: null, alloc: { status: 'allocated', data },
    });

    it('uses the Minecraft name when playit.gg made one, else the domain with its port', () => {
        expect(tunnelAddress(tunnel({ assigned_domain: 'a.ply.gg', assigned_srv: 'a.joinmc.link', port_start: 4 }))).toBe('a.joinmc.link');
        expect(tunnelAddress(tunnel({ assigned_domain: 'a.ply.gg', assigned_srv: '_minecraft._tcp.a.joinmc.link', port_start: 4 }))).toBe('a.joinmc.link');
        expect(tunnelAddress(tunnel({ assigned_domain: 'a.ply.gg', assigned_srv: null, port_start: 41234 }))).toBe('a.ply.gg:41234');
    });
});
