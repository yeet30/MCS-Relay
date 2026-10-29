import './history-drawer.css';
import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronRight, History, Loader2, RotateCcw, X } from 'lucide-react';
import type { HostedSession } from '../../../shared/types';
import { invoke } from '../../api';
import { nameHue } from '../../lib/avatar';
import { formatWhen, plural } from '../../lib/format';
import { livePresence } from '../../lib/sync';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { lockFor, useSessionStore } from '../../stores/sessionStore';

/** "45 s", "12 min", "1 h 05 min", "26 h". */
function formatLength(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s`;
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h >= 24 || m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

const length = (s: { startedAt: string; endedAt: string }) => Date.parse(s.endedAt) - Date.parse(s.startedAt);

const ENDED: Record<HostedSession['ended'], string | null> = {
    stopped: null,
    crashed: 'The Minecraft server crashed',
    unexpected: 'MCS-Relay or the PC closed while hosting; it ended about here',
};

/** A tab on the left edge of the window that slides out the selected server's hosting history: who hosted it, when,
 *  for how long and who played. The session running now is on top. */
export default function HistoryDrawer() {
    const server = useServersStore(selectSelectedServer);
    const session = useSessionStore((s) => s.state);
    const lock = useSessionStore((s) => lockFor(s, server?.id ?? null));
    const [open, setOpen] = useState(false);
    const [sessions, setSessions] = useState<HostedSession[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const serverId = server?.id ?? null;

    const load = useCallback(async () => {
        if (!serverId) return;
        setLoading(true);
        setError(null);
        const res = await invoke('servers:history', serverId);
        setLoading(false);
        if (res.ok) setSessions(res.value);
        else setError(res.error.message);
    }, [serverId]);

    // Read when opened, and again when a session ends while it is open (the new line arrives with it).
    const phase = session.phase;
    useEffect(() => {
        if (open) void load();
    }, [open, load, phase]);

    useEffect(() => {
        setSessions(null);
    }, [serverId]);

    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            clearInterval(timer);
        };
    }, [open]);

    if (!server) return null;

    const presence = livePresence(session, server.id, lock);
    const live = presence?.startedAt && lock && lock.state !== 'free' ? { host: lock.lock.host.name, startedAt: presence.startedAt, players: presence.players } : null;
    const list = sessions ?? [];
    const total = list.reduce((sum, s) => sum + Math.max(0, length(s)), 0);
    const hosts = new Set(list.map((s) => s.host.email || s.host.name)).size;

    return (
        <>
            <button className={`history-tab ${open ? 'hidden' : ''}`} onClick={() => setOpen(true)} title='Hosting history: who hosted this server, when and for how long'>
                <span className='history-tab-label'><History size={15} /> History</span>
                <ChevronRight size={16} className='history-tab-arrow' />
            </button>
            <div className={`history-backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)} aria-hidden />
            <aside className={`history-drawer ${open ? 'open' : ''}`} aria-label='Hosting history' aria-hidden={!open}>
                <header className='history-head'>
                    <span className='history-title'>
                        <b>Hosting history</b>
                        <small title={server.name}>{server.name}</small>
                    </span>
                    <button className='history-icon-button' title='Check again' onClick={() => void load()} disabled={loading} tabIndex={open ? 0 : -1}>
                        {loading ? <Loader2 size={15} className='spinner' /> : <RotateCcw size={15} />}
                    </button>
                    <button className='history-icon-button' title='Close' onClick={() => setOpen(false)} tabIndex={open ? 0 : -1}>
                        <X size={16} />
                    </button>
                </header>

                {list.length > 0 && (
                    <div className='history-summary'>
                        <span><b>{list.length}</b> {list.length === 1 ? 'session' : 'sessions'}</span>
                        <span><b>{formatLength(total)}</b> hosted</span>
                        <span><b>{hosts}</b> {hosts === 1 ? 'host' : 'hosts'}</span>
                    </div>
                )}

                <div className='history-body'>
                    {error && <p className='history-note'>{error}</p>}
                    {!error && sessions === null && <p className='history-note'><Loader2 size={14} className='spinner' /> Loading…</p>}
                    {!error && sessions !== null && list.length === 0 && !live && (
                        <p className='history-note'>No sessions yet. Each time someone hosts this server and stops it, it shows up here.</p>
                    )}
                    {(list.length > 0 || live) && (
                        <table className='history-table'>
                            <thead>
                                <tr>
                                    <th>Host</th>
                                    <th>Started</th>
                                    <th className='num'>Length</th>
                                    <th className='num'>Players</th>
                                </tr>
                            </thead>
                            <tbody>
                                {live && (
                                    <tr className='live'>
                                        <td><Host name={live.host} /></td>
                                        <td><span className='history-live'><span className='live-dot' />Hosting now</span></td>
                                        <td className='num'>{formatLength(now - Date.parse(live.startedAt))}</td>
                                        <td className='num' title={live.players.join(', ')}>{live.players.length}</td>
                                    </tr>
                                )}
                                {list.map((s) => (
                                    <tr key={s.id}>
                                        <td><Host name={s.host.name} /></td>
                                        <td title={new Date(s.startedAt).toLocaleString()}>{capitalise(formatWhen(s.startedAt, now))}</td>
                                        <td className='num'>
                                            {formatLength(length(s))}
                                            {ENDED[s.ended] && <span className={`history-ended ${s.ended}`} title={ENDED[s.ended]!}>{s.ended === 'crashed' ? 'crashed' : 'not stopped'}</span>}
                                        </td>
                                        <td className='num' title={s.players.length ? s.players.join(', ') : 'Nobody joined'}>{s.players.length}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
                {list.length > 0 && <p className='history-foot'>{plural(list.length, 'session')} kept, the newest first. Hover a number of players to see who played.</p>}
            </aside>
        </>
    );
}

function Host({ name }: { name: string }) {
    return (
        <span className='history-host' title={name}>
            <span className='history-avatar' style={{ '--hue': nameHue(name) } as CSSProperties}>{name.charAt(0).toUpperCase()}</span>
            <span className='history-host-name'>{name}</span>
        </span>
    );
}

/** "Today at 18:05", "On 3 Oct at 09:15". */
function capitalise(text: string): string {
    const shown = text.startsWith('on ') ? text.slice(3) : text;
    return shown.charAt(0).toUpperCase() + shown.slice(1);
}
