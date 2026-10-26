import './select-server.css';
import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import type { ServerSummary } from '../../../shared/types';
import { hostingMessage, isSessionBusy } from '../../lib/sync';
import { useAuthStore } from '../../stores/authStore';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { lockFor, useSessionStore } from '../../stores/sessionStore';

type Group = ServerSummary['kind'];

/** The server picker. Once there are servers joined from friends, a switch beside it chooses between mine and the
 *  joined ones, and the list shows only that group: a joined server is never mistaken for one of mine. */
export default function SelectServer() {
    const servers = useServersStore((s) => s.servers);
    const selected = useServersStore(selectSelectedServer);
    const select = useServersStore((s) => s.select);
    const myEmail = useAuthStore((s) => s.user?.email ?? null);
    const busy = useSessionStore((s) => isSessionBusy(s.state.phase));
    const checking = useSessionStore((s) => s.checkingId !== null && s.checkingId === selected?.id);
    const lock = useSessionStore((s) => lockFor(s, selected?.id ?? null));
    const lanAddress = useSessionStore((s) => (s.state.serverId === selected?.id ? s.state.lanAddress : null));
    const [isListOpen, setIsListOpen] = useState(false);

    if (servers.length === 0) return null;

    const owned = servers.filter((s) => s.kind === 'owned');
    const joined = servers.filter((s) => s.kind === 'joined');
    const group: Group = selected?.kind ?? (owned.length > 0 ? 'owned' : 'joined');
    const shown = group === 'owned' ? owned : joined;
    const locked = busy || checking;
    const why = busy ? 'Finish the current session before switching servers' : checking ? 'Checking the server first' : null;

    function handlePick(serverId: string) {
        setIsListOpen(false);
        if (serverId !== selected?.id) void select(serverId);
    }

    /** The other group: its first server becomes the selected one. */
    function showGroup(next: Group) {
        if (next === group) return;
        const first = (next === 'owned' ? owned : joined)[0];
        setIsListOpen(false);
        if (first) void select(first.id);
    }

    return (
        <div className='select-server-wrapper'>
            {joined.length > 0 && (
                <div className='server-groups' role='radiogroup' aria-label='Which servers'>
                    {([['owned', 'Yours', owned.length], ['joined', 'Joined', joined.length]] as const).map(([value, label, count]) => (
                        <button
                            key={value}
                            role='radio'
                            aria-checked={group === value}
                            className={group === value ? 'selected' : ''}
                            disabled={locked || count === 0}
                            title={why ?? (count === 0 ? 'You have no servers of your own yet' : value === 'owned' ? 'Servers in your Google Drive' : 'Servers your friends shared with you')}
                            onClick={() => showGroup(value)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            )}
            <span className='server-picker'>
                <button
                    className={`select-button ${isListOpen ? 'open' : ''}`}
                    onClick={() => setIsListOpen(!isListOpen)}
                    disabled={locked}
                    title={why ?? 'Choose a server'}
                >
                    <span className='button-title'>
                        {checking ? <p><Loader2 size={12} className='spinner' /> Checking</p> : selected?.name ?? 'Select a server'}
                    </span>
                    <Play size={12} className={`server-arrow ${isListOpen ? 'open' : ''}`} fill='currentColor' />
                </button>
                <div className={`server-drawer ${isListOpen ? 'open' : ''}`} aria-hidden={!isListOpen}>
                    {shown.map((server) => (
                        <button
                            key={server.id}
                            className={`server-item ${server.id === selected?.id ? 'current' : ''}`}
                            tabIndex={isListOpen ? 0 : -1}
                            onClick={() => handlePick(server.id)}
                        >
                            <span className='item-text'>{server.name}</span>
                        </button>
                    ))}
                </div>
            </span>
            <h4>{!selected ? '' : checking ? 'if the server is being hosted…' : hostingMessage(lock, myEmail, lanAddress)}</h4>
        </div>
    );
}
