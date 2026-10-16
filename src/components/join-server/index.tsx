import './join-server.css';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ConfirmFn } from '../../stores/serverActions';
import { joinServer } from '../../stores/serverActions';
import { useServersStore } from '../../stores/serversStore';

/** Joins a server from the folder ID or Drive link in the invitation email. */
export default function JoinServer({ confirm, onJoined }: { confirm: ConfirmFn; onJoined?: () => void }) {
    const hasServers = useServersStore((s) => s.servers.length > 0);
    const [idOrLink, setIdOrLink] = useState('');
    const [joining, setJoining] = useState(false);

    async function handleJoin() {
        setJoining(true);
        const joined = await joinServer(idOrLink, confirm);
        setJoining(false);
        if (!joined) return;
        setIdOrLink('');
        onJoined?.();
    }

    return (
        <div className='join-server-wrapper'>
            {!hasServers && <h3>Paste the link or ID from your invitation email to join a server.</h3>}
            <div className='rows'>
                <span className='first-row'>
                    <span className='list-text'>
                        <input
                            type='text'
                            id='join-input'
                            placeholder='Paste the link or ID here.'
                            value={idOrLink}
                            onChange={(e) => setIdOrLink(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && idOrLink.trim()) void handleJoin();
                            }}
                        />
                    </span>
                    <span>
                        <button
                            className='list-button'
                            style={{ backgroundColor: 'rgb(10, 30, 10)' }}
                            disabled={joining || idOrLink.trim() === ''}
                            onClick={handleJoin}
                        >
                            {joining && <Loader2 size={12} className='spinner' />}
                            Join
                        </button>
                    </span>
                </span>
                <span className='second-row'>+ Join New Server</span>
            </div>
        </div>
    );
}
