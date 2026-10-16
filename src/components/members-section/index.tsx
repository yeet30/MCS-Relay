import './members-section.css';
import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { invoke } from '../../api';
import { formatUptime } from '../../lib/format';
import { isSessionBusy, livePresence } from '../../lib/sync';
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

    async function handleRefresh() {
        setSpinning(true);
        await useSessionStore.getState().resync();
        const busy = isSessionBusy(useSessionStore.getState().state.phase);
        await useServersStore.getState().reload({ recheck: !busy });
        setSpinning(false);
    }

    const startedAt = presence?.startedAt ? Date.parse(presence.startedAt) : NaN;
    const uptime = Number.isNaN(startedAt) ? null : Math.max(0, Math.floor((now - startedAt) / 1000));

    return (
        <section className='members-section'>
            <button className='refresh-button' title='Check again' onClick={handleRefresh} disabled={spinning}>
                <RotateCcw className={`refresh-svg ${spinning ? 'spin' : ''}`} size={24} />
            </button>
            {presence && (
                <div className='members-div'>
                    <h3>Online Players: <span>{presence.players.length}{maxPlayers !== null ? `/${maxPlayers}` : ''}</span></h3>
                    {presence.players.map((player) => <span className='player-name' key={player}>{player}</span>)}
                    {uptime !== null && <span className='uptime-span'>Uptime: {formatUptime(uptime)}</span>}
                </div>
            )}
        </section>
    );
}
