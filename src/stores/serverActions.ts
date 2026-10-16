// Multi-step server actions shared by several components (the empty-state buttons and the Drive Folders lists).
import type { ServerId, ServerSummary } from '../../shared/types';
import { useNoticeStore } from './noticeStore';
import { request } from './request';
import { useServersStore } from './serversStore';

export type ConfirmFn = (options: { message: string; confirmText?: string; cancelText?: string }) => Promise<boolean>;

/** Opens the folder picker for a server's local copy, then refreshes the list and re-checks the server. */
export async function chooseLocalPath(serverId: ServerId): Promise<string | null> {
    const res = await request('servers:chooseLocalPath', serverId);
    if (!res.ok || res.value === null) return null;
    await useServersStore.getState().reload({ recheck: true });
    return res.value;
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
        message: 'This creates a new server folder inside "Minecraft Shared Servers" in your Google Drive. You can own up to 3 servers.\n\nDon\'t change the files in a server folder by hand while someone is hosting it.',
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
