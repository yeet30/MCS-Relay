import './select-server.css';
import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import type { ServerSummary } from '../../../shared/types';
import { hostingMessage, isSessionBusy } from '../../lib/sync';
import { useAuthStore } from '../../stores/authStore';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { lockFor, useSessionStore } from '../../stores/sessionStore';

function Group({ title, servers, onPick }: { title: string; servers: ServerSummary[]; onPick: (id: string) => void }) {
    if (servers.length === 0) return null;
    return (
        <>
            <span className={title.toLowerCase()}>
                <span className='server-type'>{title}</span>
            </span>
            {servers.map((server) => (
                <span className='server-item' key={server.id} onClick={() => onPick(server.id)}>
                    <span className='item-text'>{server.name}</span>
                </span>
            ))}
        </>
    );
}

export default function SelectServer() {
    const servers = useServersStore((s) => s.servers);
    const selected = useServersStore(selectSelectedServer);
    const select = useServersStore((s) => s.select);
    const myEmail = useAuthStore((s) => s.user?.email ?? null);
    const busy = useSessionStore((s) => isSessionBusy(s.state.phase));
    const checking = useSessionStore((s) => s.checkingId !== null && s.checkingId === selected?.id);
    const lock = useSessionStore((s) => lockFor(s, selected?.id ?? null));
    const [isListOpen, setIsListOpen] = useState(false);

    if (servers.length === 0) return null;

    function handlePick(serverId: string) {
        setIsListOpen(false);
        if (serverId !== selected?.id) void select(serverId);
    }

    return (
        <div className='select-server-wrapper'>
            <span>
                <button
                    className={`select-button ${isListOpen ? 'open' : ''}`}
                    onClick={() => setIsListOpen(!isListOpen)}
                    disabled={busy}
                    title={busy ? 'Finish the current session before switching servers' : 'Choose a server'}
                >
                    <span className='button-title'>
                        {checking ? <p><Loader2 size={12} className='spinner' /> Checking</p> : selected?.name ?? 'Select a server'}
                    </span>
                    <Play size={12} className={`server-arrow ${isListOpen ? 'open' : ''}`} fill='currentColor' />
                </button>
                <div className={`server-drawer ${isListOpen ? 'open' : ''}`}>
                    <Group title='Owned' servers={servers.filter((s) => s.kind === 'owned')} onPick={handlePick} />
                    <Group title='Joined' servers={servers.filter((s) => s.kind === 'joined')} onPick={handlePick} />
                </div>
            </span>
            <h4>{!selected ? '' : checking ? 'if the server is being hosted…' : hostingMessage(lock, myEmail)}</h4>
        </div>
    );
}
