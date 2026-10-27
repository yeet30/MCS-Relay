// The few calls MCS-Relay makes to playit.gg's API (api.playit.gg), the same ones playit's own agent makes.
// The API is not documented for other apps: the request and answer shapes come from the client in playit's
// open-source agent (github.com/playit-cloud/playit-agent, packages/api_client/src/api.rs). auto-mcs, another
// Minecraft server manager, makes the same tunnel calls (github.com/macarooni-man/auto-mcs, source/core/tools/playit.py).
// Every call is a POST with a JSON body; the answer is {status: "success"|"fail"|"error", data}.
// Tunnels use the "v1" calls: playit's 1.0 agent sends a tunnel's connections to the local_ip and local_port of the
// tunnel's agent config, which only those calls set (a tunnel made with the older /tunnels/create has none, and the
// agent then drops its connections).
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

export interface ConfigField {
    name: string;
    value: string;
}

/** A tunnel of the account, as /v1/tunnels/list describes it (the parts MCS-Relay reads). */
export interface PlayitTunnelInfo {
    id: string;
    name: string | null;
    tunnel_type: string | null;
    user_enabled: boolean;
    /** Why it is not online: "PublicAllocationPending" while its address is being made, "AgentOverLimit", ... */
    offline_reasons: string[] | null;
    origin:
        | { type: 'agent'; details: { agent_id: string; config_data: { fields: ConfigField[] } } }
        | { type: 'not-set'; details: unknown };
    /** How players reach it: "auto" (the playit.gg name), "domain" (a custom one), "addr4" (ip:port), ... */
    connect_addresses: Array<{ type: string; value: { address?: unknown } }>;
}

/** The agent config of a tunnel to this PC's port. */
const localConfig = (port: number): { fields: ConfigField[] } => ({
    fields: [{ name: 'local_ip', value: '127.0.0.1' }, { name: 'local_port', value: String(port) }],
});

type Answer<T> = { status: 'success'; data: T } | { status: 'fail'; data: unknown } | { status: 'error'; data: unknown };

/** A refusal from the API: `reason` is its name for it ("UserRejected", "RequiresVerifiedAccount", ...). */
export class PlayitRefusal extends AppError {
    constructor(readonly reason: string, message: string) {
        super('PLAYIT', message, reason);
    }
}

/** The name playit gives the reason, from a "fail" ("CodeExpired", or {error: "NothingToUpdate"}) or an "error"
 *  ({type, message}) answer. */
function reasonOf(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object') {
        const d = data as { type?: unknown; message?: unknown; error?: unknown };
        if (typeof d.error === 'string') return d.error;
        if (typeof d.message === 'string') return d.message;
        if (d.message && typeof d.message === 'object') return JSON.stringify(d.message);
        if (typeof d.type === 'string') return d.type;
    }
    return JSON.stringify(data);
}

const REASONS: Record<string, string> = {
    InvalidAgentKey: 'playit.gg no longer accepts this PC\'s link. Link playit.gg again in Settings > Server settings.',
    NoLongerValid: 'playit.gg no longer accepts this PC\'s link. Link playit.gg again in Settings > Server settings.',
    EmailMustBeVerified: 'Your playit.gg account\'s email address is not verified yet. Open the email from playit.gg, then try again.',
    RequiresVerifiedAccount: 'Your playit.gg account\'s email address is not verified yet. Open the email from playit.gg, then try again.',
    RequiresPlayitPremium: 'playit.gg says this needs playit.gg Premium.',
    AgentVersionTooOld: 'playit.gg refused the playit.gg agent built into this MCS-Relay as too old.',
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

    /** Every tunnel of the account. */
    async listTunnels(): Promise<PlayitTunnelInfo[]> {
        return (await this.call<{ tunnels: PlayitTunnelInfo[] }>('/v1/tunnels/list', {})).tunnels;
    }

    /** A Minecraft Java tunnel to this PC's port; its id. */
    async createTunnel(agentId: string, name: string, localPort: number): Promise<string> {
        const created = await this.call<{ id: string }>('/v1/tunnels/create', {
            ports: { type: 'tunnel-type', details: 'minecraft-java' },
            origin: { type: 'agent', data: { agent_id: agentId, config: localConfig(localPort) } },
            enabled: true,
            alloc: null,
            name,
            firewall_id: null,
        });
        return created.id;
    }

    /** Points the tunnel at another port on this PC. */
    async configureTunnel(tunnelId: string, localPort: number): Promise<void> {
        try {
            await this.call('/v1/tunnels/config', { tunnel_id: tunnelId, new_agent_id: null, new_config: localConfig(localPort) });
        } catch (err) {
            if (!(err instanceof PlayitRefusal) || err.reason !== 'NothingToUpdate') throw err;
        }
    }

    enableTunnel(tunnelId: string): Promise<unknown> {
        return this.call('/tunnels/enable', { tunnel_id: tunnelId, enabled: true });
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

/** The address friends type: a custom domain, else playit.gg's name for the tunnel (with an SRV record, so no port is
 *  needed), else its IP and port; null while playit.gg is still making it. */
export function tunnelAddress(tunnel: PlayitTunnelInfo): string | null {
    for (const kind of ['domain', 'auto', 'addr4']) {
        const found = tunnel.connect_addresses?.find((a) => a.type === kind && typeof a.value?.address === 'string');
        if (found) return found.value.address as string;
    }
    return null;
}

/** The port on this PC the tunnel's agent config sends players to; null when it has none. */
export function tunnelLocalPort(tunnel: PlayitTunnelInfo): number | null {
    if (tunnel.origin.type !== 'agent') return null;
    const field = (tunnel.origin.details as { config_data?: { fields?: ConfigField[] } }).config_data?.fields?.find((f) => f.name === 'local_port');
    return field ? Number(field.value) : null;
}
