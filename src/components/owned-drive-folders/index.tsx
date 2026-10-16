import './owned-drive-folders.css';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useConfirm } from '../../hooks/useConfirm';
import { createServer } from '../../stores/serverActions';
import { useServersStore } from '../../stores/serversStore';
import ServerSlot from '../server-slot';

const MAX_SLOTS = 3;

export default function OwnedDriveFolders() {
    const servers = useServersStore((s) => s.servers);
    const loading = useServersStore((s) => s.loading && !s.loaded);
    const { confirm, popup } = useConfirm();
    const [creating, setCreating] = useState(false);
    const owned = servers.filter((server) => server.kind === 'owned');

    async function handleCreate() {
        setCreating(true);
        await createServer(confirm);
        setCreating(false);
    }

    return (
        <div className='owned-drive-wrapper'>
            {popup}
            {owned.length === 0 && <h3>Start by creating your first server folder.</h3>}
            {loading
                ? (
                    <span id='loading-span'>
                        <Loader2 size={24} className='spinner' />
                        <h4>Loading servers...</h4>
                    </span>
                )
                : (
                    <ul id='servers-ul'>
                        {owned.map((server) => <li key={server.id}><ServerSlot server={server} /></li>)}
                        {Array.from({ length: Math.max(0, MAX_SLOTS - owned.length) }).map((_, index) => (
                            <li key={`ghost-${index}`}>
                                <span className='first-row'>
                                    <span className='list-text ghost'>+ Create New Server</span>
                                    <span>
                                        <button
                                            className='list-button'
                                            style={{ backgroundColor: 'rgb(10, 30, 10)' }}
                                            disabled={creating}
                                            onClick={handleCreate}
                                        >
                                            {creating && <Loader2 size={12} className='spinner' />}
                                            Create Server
                                        </button>
                                    </span>
                                </span>
                                <span className='second-row'>Empty slot</span>
                            </li>
                        ))}
                    </ul>
                )}
        </div>
    );
}
