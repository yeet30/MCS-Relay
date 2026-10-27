// The few calls MCS-Relay makes to playit.gg's API (api.playit.gg), the same ones playit's own agent makes.
// The API is not documented for other apps: the request and answer shapes come from the client in playit's
// open-source agent (github.com/playit-cloud/playit-agent, packages/api_client/src/api.rs). auto-mcs, another
// Minecraft server manager, makes the same tunnel calls (github.com/macarooni-man/auto-mcs, source/core/tools/playit.py).
// Every call is a POST with a JSON body; the answer is {status: "success"|"fail"|"error", data}.
import { AppError } from '../errors';

export const PLAYIT_API = 'https://api.playit.gg';

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export type ClaimStatus = 'WaitingForUserVisit' | 'WaitingForUser' | 'UserAccepted' | 'UserRejected';

/** What the account says about this agent (only the parts MCS-Relay reads). */
export interface AgentRunData {
    agent_id: string;
    /** "ready", or why the agent cannot run: "email-not-verified", "banned", "agent-disabled", ... */
    account_status: string;
}

export interface PlayitTunnelInfo {
    id: string;
    name: string | null;
    tunnel_type: string | null;
    port_type: string;
    alloc: { status: 'pending' } | { status: 'disabled'; data: { reason: string } } | {
        status: 'allocated';
        data: { assigned_domain: string; assigned_srv: string | null; port_start: number };
    };
    origin: { type: 'agent'; data: { agent_id: string; local_ip: string; local_port: number | null } } | { type: string; data: unknown } | null;
    disabled_reason: string | null;
}

export interface TunnelList {
    tunnels: PlayitTunnelInfo[];
    tcp_alloc: { allowed: number; claimed: number };
}

type Answer<T> = { status: 'success'; data: T } | { status: 'fail'; data: unknown } | { status: 'error'; data: unknown };

/** A refusal from the API: `reason` is its name for it ("UserRejected", "RequiresVerifiedAccount", ...). */
export class PlayitRefusal extends AppError {
    constructor(readonly reason: string, message: string) {
        super('PLAYIT', message, reason);
    }
}

/** The name playit gives the reason, from a "fail" ("CodeExpired") or an "error" ({type, message}) answer. */
function reasonOf(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object') {
        const d = data as { type?: unknown; message?: unknown };
        if (typeof d.message === 'string') return d.message;
        if (d.message && typeof d.message === 'object') return JSON.stringify(d.message);
        if (typeof d.type === 'string') return d.type;
    }
    return JSON.stringify(data);
}

const REASONS: Record<string, string> = {
    InvalidAgentKey: 'playit.gg no longer accepts this PC\'s link. Link playit.gg again in Settings > Scripts.',
    NoLongerValid: 'playit.gg no longer accepts this PC\'s link. Link playit.gg again in Settings > Scripts.',
    EmailMustBeVerified: 'Your playit.gg account\'s email address is not verified yet. Open the email from playit.gg, then try again.',
    RequiresVerifiedAccount: 'Your playit.gg account\'s email address is not verified yet. Open the email from playit.gg, then try again.',
    RequiresPlayitPremium: 'playit.gg says this needs playit.gg Premium.',
    AgentVersionTooOld: 'playit.gg no longer accepts the agent version MCS-Relay uses. Update MCS-Relay.',
    UserRejected: 'The link was declined on playit.gg.',
    CodeExpired: 'The playit.gg link page expired. Try linking again.',
    CodeNotFound: 'The playit.gg link page expired. Try linking again.',
};

export class PlayitApi {
    constructor(private readonly fetchImpl: FetchFn, private readonly secret: string | null = null, private readonly base = PLAYIT_API) {}

    withSecret(secret: string): PlayitApi {
        return new PlayitApi(this.fetchImpl, secret, this.base);
    }

    /** Registers the link code (on the first call) and says whether the user approved it on playit.gg yet. */
    claimSetup(code: string, version: string): Promise<ClaimStatus> {
        return this.call('/claim/setup', { code, agent_type: 'self-managed', version });
    }

    /** After approval: the agent's secret key. */
    async claimExchange(code: string): Promise<string> {
        return (await this.call<{ secret_key: string }>('/claim/exchange', { code })).secret_key;
    }

    runData(): Promise<AgentRunData> {
        return this.call('/agents/rundata', {});
    }

    renameAgent(agentId: string, name: string): Promise<unknown> {
        return this.call('/agents/rename', { agent_id: agentId, name });
    }

    listTunnels(agentId: string): Promise<TunnelList> {
        return this.call('/tunnels/list', { tunnel_id: null, agent_id: agentId });
    }

    /** A Minecraft Java tunnel to this PC's port; its id. */
    async createTunnel(agentId: string, name: string, localPort: number): Promise<string> {
        const created = await this.call<{ id: string }>('/tunnels/create', {
            name,
            tunnel_type: 'minecraft-java',
            port_type: 'tcp',
            port_count: 1,
            origin: { type: 'agent', data: { agent_id: agentId, local_ip: '127.0.0.1', local_port: localPort } },
            enabled: true,
            alloc: null,
            firewall_id: null,
            proxy_protocol: null,
        });
        return created.id;
    }

    updateTunnel(tunnelId: string, agentId: string, localPort: number): Promise<unknown> {
        return this.call('/tunnels/update', { tunnel_id: tunnelId, local_ip: '127.0.0.1', local_port: localPort, agent_id: agentId, enabled: true });
    }

    deleteTunnel(tunnelId: string): Promise<unknown> {
        return this.call('/tunnels/delete', { tunnel_id: tunnelId });
    }

    private async call<T>(route: string, body: unknown): Promise<T> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.secret) headers.Authorization = `Agent-Key ${this.secret}`;
        let response: Response;
        try {
            response = await this.fetchImpl(`${this.base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
        } catch (err) {
            throw new AppError('NETWORK', 'playit.gg could not be reached. Check your internet connection.', err instanceof Error ? err.message : String(err));
        }
        let answer: Answer<T>;
        try {
            answer = (await response.json()) as Answer<T>;
        } catch {
            throw new AppError('PLAYIT', `playit.gg answered ${response.status} without the usual details. Try again later.`, route);
        }
        if (answer.status === 'success') return answer.data;
        const reason = reasonOf(answer.data);
        throw new PlayitRefusal(reason, REASONS[reason] ?? `playit.gg refused this (${reason}).`);
    }
}

/** The address friends type: the Minecraft name (an SRV record, no port needed), else the domain with its port. */
export function tunnelAddress(tunnel: PlayitTunnelInfo): string | null {
    if (tunnel.alloc?.status !== 'allocated') return null;
    const a = tunnel.alloc.data;
    const srv = a.assigned_srv?.replace(/^_minecraft\._tcp\./, '');
    return srv || `${a.assigned_domain}:${a.port_start}`;
}
