import './joined-drive-folders.css';
import { Loader2 } from 'lucide-react';
import { useConfirm } from '../../hooks/useConfirm';
import { useServersStore } from '../../stores/serversStore';
import JoinServer from '../join-server';
import PermissionInformation from '../permission-information';
import ServerSlot from '../server-slot';

export default function JoinedDriveFolders() {
    const servers = useServersStore((s) => s.servers);
    const loading = useServersStore((s) => s.loading && !s.loaded);
    const { confirm, popup } = useConfirm();

    return (
        <div className='joined-drive-folder'>
            {popup}
            <PermissionInformation />
            {loading
                ? (
                    <span id='loading-span'>
                        <Loader2 size={24} className='spinner' />
                        <h4>Loading servers...</h4>
                    </span>
                )
                : (
                    <ul id='servers-ul'>
                        {servers.filter((server) => server.kind === 'joined').map((server) => (
                            <li key={server.id}><ServerSlot server={server} /></li>
                        ))}
                        <li><JoinServer confirm={confirm} /></li>
                    </ul>
                )}
        </div>
    );
}
