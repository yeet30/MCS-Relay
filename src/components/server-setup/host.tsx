import { useServersStore } from '../../stores/serversStore';
import { useUiStore } from '../../stores/uiStore';
import Modal from '../modal';
import ServerSetup from '.';

/** Opens "Download a server" wherever it was asked for: right after a new server's folder is chosen, or from the
 *  server folder menu. */
export default function ServerSetupHost() {
    const setupId = useUiStore((s) => s.setupId);
    const server = useServersStore((s) => s.servers.find((x) => x.id === setupId) ?? null);
    const close = () => useUiStore.getState().openServerSetup(null);

    return (
        <Modal
            isOpen={server !== null}
            onClose={close}
            width={540}
            height={470}
            items={server ? [{ title: 'Download a server', content: <ServerSetup serverId={server.id} serverName={server.name} onDone={close} /> }] : []}
        />
    );
}
