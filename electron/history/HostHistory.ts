// Who hosted a server, when and for how long: <server folder>/.launcher/history.json, shared with every member like
// the lock. Only the member holding the lock writes it, so two writers never meet:
//   - the host adds its session when the Minecraft server stops (or crashed);
//   - a session that never stopped (the app or the PC went off while hosting) is added by whoever reserves the server
//     next, from the stale lock it takes over: its host, its start, and its last renewal as the end.
// Each entry carries the lock's session id, so a session is never added twice. The newest MAX_SESSIONS are kept.
import type { HostedSession, LockContent } from '../../shared/types';
import type { LauncherFiles } from '../sync/launcherFiles';

const FILE = 'history.json';
const MAX_SESSIONS = 300;

interface HistoryFile {
    format: 1;
    sessions: HostedSession[];
}

export interface HostHistoryDeps {
    launcher: Pick<LauncherFiles, 'readText' | 'writeText'>;
}

function isSession(raw: unknown): raw is HostedSession {
    const s = raw as Partial<HostedSession> | null;
    return !!s && typeof s.id === 'string' && typeof s.startedAt === 'string' && typeof s.endedAt === 'string'
        && typeof s.host?.name === 'string' && Array.isArray(s.players)
        && (s.ended === 'stopped' || s.ended === 'crashed' || s.ended === 'unexpected');
}

export class HostHistory {
    /** One write at a time per server: a stop and a takeover never run together, but two quick stops could. */
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly d: HostHistoryDeps) {}

    /** The server's sessions, newest first. A missing or unreadable file is an empty history. */
    async list(serverId: string): Promise<HostedSession[]> {
        const file = await this.d.launcher.readText(serverId, FILE);
        return this.parse(file?.text ?? null).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }

    /** Adds a session, unless one with its id is already there. */
    add(serverId: string, session: HostedSession): Promise<void> {
        const run = (this.queues.get(serverId) ?? Promise.resolve()).then(async () => {
            const file = await this.d.launcher.readText(serverId, FILE);
            const sessions = this.parse(file?.text ?? null);
            if (sessions.some((s) => s.id === session.id)) return;
            sessions.push({ ...session, players: [...new Set(session.players)] });
            sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
            const kept: HistoryFile = { format: 1, sessions: sessions.slice(-MAX_SESSIONS) };
            await this.d.launcher.writeText(serverId, FILE, `${JSON.stringify(kept)}\n`);
            console.log(`[history] ${serverId}: ${session.host.name} hosted from ${session.startedAt} to ${session.endedAt} (${session.ended})`);
        });
        const settled = run.catch(() => undefined);
        this.queues.set(serverId, settled);
        void settled.then(() => {
            if (this.queues.get(serverId) === settled) this.queues.delete(serverId);
        });
        return run;
    }

    /** A session whose host never stopped it, from the stale lock taken over: it ended at the lock's last renewal. */
    addUnstopped(serverId: string, lock: LockContent, endedAt: string): Promise<void> {
        if (!lock.startedAt) return Promise.resolve();
        return this.add(serverId, {
            id: lock.sessionId, host: lock.host, startedAt: lock.startedAt, endedAt, players: lock.players,
            // Stopped and saving when it was left: the server itself had stopped.
            ended: lock.phase === 'running' ? 'unexpected' : 'stopped',
        });
    }

    private parse(text: string | null): HostedSession[] {
        if (!text) return [];
        try {
            const raw = JSON.parse(text) as Partial<HistoryFile>;
            return Array.isArray(raw.sessions) ? raw.sessions.filter(isSession) : [];
        } catch {
            return [];
        }
    }
}
