// Multi-step server actions shared by several components (the empty-state buttons and the Servers lists).
import type { ServerId, ServerSummary } from '../../shared/types';
import type { ConfirmOptions } from '../hooks/useConfirm';
import { isSessionBusy } from '../lib/sync';
import { useNoticeStore } from './noticeStore';
import { request } from './request';
import { useServersStore } from './serversStore';
import { useSessionStore } from './sessionStore';

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

/** Asks for the server's folder on this PC. The new path shows at once; the check of the files in it (a while
 *  for a big world) follows, and its progress shows on the status card and in Servers. */
export async function chooseLocalPath(serverId: ServerId): Promise<string | null> {
    useServersStore.setState({ pathBusy: { serverId, step: 'choosing' } });
    try {
        const res = await request('servers:chooseLocalPath', serverId);
        if (!res.ok || res.value === null) return null;
        const servers = useServersStore.getState();
        servers.setLocalPath(serverId, res.value);
        if (servers.selectedId === serverId && !isSessionBusy(useSessionStore.getState().state.phase)) {
            useServersStore.setState({ pathBusy: { serverId, step: 'checking' } });
            await useSessionStore.getState().preflight(serverId);
        }
        return res.value;
    } finally {
        useServersStore.setState({ pathBusy: null });
    }
}

async function offerLocalPath(server: ServerSummary, confirm: ConfirmFn, what: string): Promise<void> {
    const notices = useNoticeStore.getState();
    const choose = await confirm({
        message: `${what}\n\nNow choose the folder on this PC where "${server.name}" lives. The world is downloaded to it before every session and uploaded from it afterwards.`,
        confirmText: 'Choose folder',
        cancelText: 'Later',
    });
    const path = choose ? await chooseLocalPath(server.id) : null;
    if (!path) notices.info(`You can choose the folder for "${server.name}" later in Settings > Servers.`);
}

/** Joins a server shared with me (a folder ID or a Drive link), then offers to choose its local folder. */
export async function joinServer(idOrLink: string, confirm: ConfirmFn): Promise<ServerSummary | null> {
    const res = await request('servers:join', idOrLink.trim());
    if (!res.ok) return null;
    useServersStore.getState().add(res.value);
    await offerLocalPath(res.value, confirm, `You joined "${res.value.name}".`);
    return res.value;
}
