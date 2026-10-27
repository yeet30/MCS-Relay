import './whitelist-panel.css';
import { useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import type { WhitelistPlayer } from '../../../shared/types';
import { invoke } from '../../api';
import { useNoticeStore } from '../../stores/noticeStore';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';

/** Settings > Server settings > Whitelist (shown while the whitelist is on): who may join the selected server. */
export default function WhitelistPanel() {
    const server = useServersStore(selectSelectedServer);
    const live = useSessionStore((s) => s.state.phase === 'running' && s.state.serverId === server?.id && s.state.javaRunning);
    const [players, setPlayers] = useState<WhitelistPlayer[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [busy, setBusy] = useState<string | null>(null);         // what is being added or removed
    const serverId = server?.id ?? null;

    useEffect(() => {
        setPlayers(null);
        setLoadError(null);
        if (!serverId) return;
        void invoke('servers:whitelist', serverId).then((res) => {
            if (res.ok) setPlayers(res.value);
            else setLoadError(res.error.message);
        });
    }, [serverId]);

    async function add() {
        const wanted = name.trim();
        if (!serverId || !wanted) return;
        setBusy(wanted);
        const res = await invoke('servers:whitelistAdd', serverId, wanted);
        setBusy(null);
        if (!res.ok) {
            useNoticeStore.getState().error(res.error);
            return;
        }
        setPlayers(res.value);
        setName('');
    }

    async function remove(player: WhitelistPlayer) {
        if (!serverId) return;
        setBusy(player.uuid);
        const res = await invoke('servers:whitelistRemove', serverId, player.uuid);
        setBusy(null);
        if (res.ok) setPlayers(res.value);
        else useNoticeStore.getState().error(res.error);
    }

    if (!server) return <p className='wl-note'>Select a server first.</p>;
    if (loadError) return <p className='wl-note'>{loadError}</p>;
    if (!players) return <p className='wl-note'><Loader2 size={14} className='spinner' /> Loading…</p>;

    return (
        <div className='wl-wrapper'>
            <p className='wl-intro'>
                Only these players can join <b>{server.name}</b>.{' '}
                {live ? 'Changes apply right away.' : 'Changes apply the next time the server starts, and your next session shares them.'}
            </p>
            <form className='wl-add' onSubmit={(e) => { e.preventDefault(); void add(); }}>
                <input
                    value={name}
                    placeholder='Minecraft name'
                    maxLength={16}
                    spellCheck={false}
                    onChange={(e) => setName(e.target.value)}
                />
                <button type='submit' className='text-button primary' disabled={!name.trim() || busy !== null}>
                    {busy !== null && busy === name.trim() ? <Loader2 size={13} className='spinner' /> : <Plus size={13} />} Add
                </button>
            </form>
            {players.length === 0
                ? <p className='wl-note'>Nobody is on the whitelist yet, so nobody can join. Add yourself and your friends.</p>
                : (
                    <ul className='wl-list'>
                        {players.map((p) => (
                            <li key={p.uuid}>
                                <span className='wl-name'>{p.name}</span>
                                <button className='wl-remove' title={`Remove ${p.name}`} disabled={busy !== null} onClick={() => void remove(p)}>
                                    {busy === p.uuid ? <Loader2 size={13} className='spinner' /> : <X size={14} />}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            <p className='wl-foot'>Names are looked up at Mojang, as Minecraft does, to find each player&apos;s account.</p>
        </div>
    );
}
