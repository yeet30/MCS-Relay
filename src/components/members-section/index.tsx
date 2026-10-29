import './members-section.css';
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Clock, RotateCcw } from 'lucide-react';
import { invoke } from '../../api';
import { nameHue } from '../../lib/avatar';
import { formatUptime } from '../../lib/format';
import { describeServerChanges, isSessionBusy, livePresence } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { useServersStore } from '../../stores/serversStore';
import { lockFor, useSessionStore } from '../../stores/sessionStore';

/** Players and uptime of the selected server, whoever hosts it, plus a refresh button. */
export default function MembersSection() {
    const selectedId = useServersStore((s) => s.selectedId);
    const session = useSessionStore((s) => s.state);
    const lock = useSessionStore((s) => lockFor(s, selectedId));
    const presence = livePresence(session, selectedId, lock);
    const [maxPlayers, setMaxPlayers] = useState<number | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const [spinning, setSpinning] = useState(false);
    const online = presence !== null;

    useEffect(() => {
        if (!online || !selectedId) {
            setMaxPlayers(null);
            return undefined;
        }
        let cancelled = false;
        void invoke('servers:info', selectedId).then((res) => {
            if (!cancelled) setMaxPlayers(res.ok ? res.value.maxPlayers : null);
        });
        return () => {
            cancelled = true;
        };
    }, [online, selectedId]);

    useEffect(() => {
        if (!presence?.startedAt) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [presence?.startedAt]);

    /** Lists the servers on Google Drive again (shared with you, deleted, renamed), re-checks the selected one,
     *  and says what changed. */
    async function handleRefresh() {
        setSpinning(true);
        const before = useServersStore.getState().servers.map(({ id, name }) => ({ id, name }));
        await useSessionStore.getState().resync();
        const busy = isSessionBusy(useSessionStore.getState().state.phase);
        await useServersStore.getState().reload({ recheck: !busy });
        const { servers, error } = useServersStore.getState();
        if (!error) useNoticeStore.getState().info(describeServerChanges(before, servers));
        setSpinning(false);
    }

    const startedAt = presence?.startedAt ? Date.parse(presence.startedAt) : NaN;
    const uptime = Number.isNaN(startedAt) ? null : Math.max(0, Math.floor((now - startedAt) / 1000));

    return (
        <section className='members-section'>
            <button
                className='refresh-button'
                title='Check Google Drive again: servers shared with you, deleted or renamed, and the files of the selected server'
                onClick={handleRefresh}
                disabled={spinning}
            >
                <RotateCcw className={`refresh-svg ${spinning ? 'spin' : ''}`} size={20} />
            </button>
            {presence && (
                <div className='members-div'>
                    <div className='members-head'>
                        <span className='members-label'><span className='live-dot' />Online</span>
                        <span className='members-count' title='Players online, out of the most the server allows'>
                            {presence.players.length}{maxPlayers !== null && <small>/{maxPlayers}</small>}
                        </span>
                    </div>
                    {presence.players.length === 0
                        ? <span className='members-empty'>Nobody has joined yet.</span>
                        : (
                            <ul className='player-list'>
                                {presence.players.map((player) => (
                                    <li className='player-name' key={player} title={player}>
                                        <span className='player-avatar' style={{ '--hue': nameHue(player) } as CSSProperties}>{player.charAt(0).toUpperCase()}</span>
                                        <span className='player-text'>{player}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    {uptime !== null && (
                        <span className='uptime-span' title='How long the server has been running'>
                            <Clock size={13} /> {formatUptime(uptime)}
                        </span>
                    )}
                </div>
            )}
        </section>
    );
}
