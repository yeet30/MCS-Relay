import { Loader2 } from 'lucide-react';
import { useConfirm } from '../../hooks/useConfirm';
import { useServersStore } from '../../stores/serversStore';
import JoinServer from '../join-server';
import PermissionInformation from '../permission-information';
import ServerSlot from '../server-slot';
import '../owned-drive-folders/owned-drive-folders.css';

/** Servers others shared with me, and the box to join another one. */
export default function JoinedDriveFolders() {
    const servers = useServersStore((s) => s.servers);
    const loading = useServersStore((s) => s.loading && !s.loaded);
    const { confirm, popup } = useConfirm();
    const joined = servers.filter((server) => server.kind === 'joined');

    if (loading) {
        return <p className='folders-loading'><Loader2 size={16} className='spinner' /> Loading servers…</p>;
    }
    return (
        <div className='folders-tab'>
            {popup}
            <PermissionInformation />
            <p className='folders-intro'>
                {joined.length === 0 ? 'Servers your friends share with you show up here.' : 'Servers your friends share with you.'}
            </p>
            {joined.map((server) => <ServerSlot key={server.id} server={server} />)}
            <JoinServer confirm={confirm} />
        </div>
    );
}
