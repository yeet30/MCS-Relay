import './owned-drive-folders.css';
import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { useConfirm } from '../../hooks/useConfirm';
import { createServer } from '../../stores/serverActions';
import { useServersStore } from '../../stores/serversStore';
import ServerSlot from '../server-slot';

const MAX_SLOTS = 3;

/** The servers in my own Google Drive, and the free slots for new ones. */
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

    if (loading) {
        return <p className='folders-loading'><Loader2 size={16} className='spinner' /> Loading servers…</p>;
    }
    return (
        <div className='folders-tab'>
            {popup}
            <p className='folders-intro'>
                Servers kept in your Google Drive. You can own up to {MAX_SLOTS}; {owned.length === 0 ? 'start by creating one.' : `${owned.length} of ${MAX_SLOTS} used.`}
            </p>
            {owned.map((server) => <ServerSlot key={server.id} server={server} />)}
            {Array.from({ length: Math.max(0, MAX_SLOTS - owned.length) }).map((_, index) => (
                <button key={`free-${index}`} className='empty-slot' disabled={creating} onClick={handleCreate}>
                    {creating && index === 0 ? <Loader2 size={16} className='spinner' /> : <Plus size={16} />}
                    <span>Create a server</span>
                    <small>Free slot</small>
                </button>
            ))}
        </div>
    );
}
