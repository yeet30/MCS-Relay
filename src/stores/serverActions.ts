// Multi-step server actions shared by several components (the empty-state buttons and the Drive Folders lists).
import type { ServerId, ServerSummary } from '../../shared/types';
import { isSessionBusy } from '../lib/sync';
import { useNoticeStore } from './noticeStore';
import { request } from './request';
import { useServersStore } from './serversStore';
import { useSessionStore } from './sessionStore';

export type ConfirmFn = (options: { message: string; confirmText?: string; cancelText?: string }) => Promise<boolean>;

/** Asks for the server's folder on this PC. The new path shows at once; the check of the files in it (a while
 *  for a big world) follows, and its progress shows on the status card and in Drive Folders. */
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
    if (!path) notices.info(`You can choose the folder for "${server.name}" later in Settings > Drive Folders.`);
}

/** Creates a server folder in my Drive, then offers to choose its local folder. */
export async function createServer(confirm: ConfirmFn): Promise<ServerSummary | null> {
    const accepted = await confirm({
        message: 'This creates a new server folder inside "Minecraft Shared Servers" in your Google Drive. You can own up to 3 servers.\n\nThe first upload of a server takes much longer than later ones, because every folder and file has to be created on Google Drive.\n\nDon\'t change the files in a server folder by hand while someone is hosting it.',
        confirmText: 'Create',
        cancelText: 'Cancel',
    });
    if (!accepted) return null;
    const res = await request('servers:create');
    if (!res.ok) return null;
    const hadSelection = useServersStore.getState().selectedId !== null;
    await useServersStore.getState().reload({ prefer: hadSelection ? null : res.value.id });
    await offerLocalPath(res.value, confirm, `"${res.value.name}" was created.`);
    return res.value;
}

/** Joins a server shared with me (a folder ID or a Drive link), then offers to choose its local folder. */
export async function joinServer(idOrLink: string, confirm: ConfirmFn): Promise<ServerSummary | null> {
    const res = await request('servers:join', idOrLink.trim());
    if (!res.ok) return null;
    const hadSelection = useServersStore.getState().selectedId !== null;
    await useServersStore.getState().reload({ prefer: hadSelection ? null : res.value.id });
    await offerLocalPath(res.value, confirm, `You joined "${res.value.name}".`);
    return res.value;
}
