// Multi-step server actions shared by several components (the empty-state buttons and the Drive Folders lists).
import type { ServerId, ServerSummary } from '../../shared/types';
import type { ConfirmOptions } from '../hooks/useConfirm';
import { isSessionBusy } from '../lib/sync';
import { useNoticeStore } from './noticeStore';
import { request } from './request';
import { useServersStore } from './serversStore';
import { useSessionStore } from './sessionStore';
import { useUiStore } from './uiStore';

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

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

/** Right after a new server is named: what its folder on this PC is for (new players may not know what a
 *  server folder holds), then the folder picker. */
export async function askForServerFolder(server: ServerSummary, confirm: ConfirmFn): Promise<void> {
    const choose = await confirm({
        message: `Next, choose the folder for "${server.name}" on this PC.\n\n`
            + 'The Minecraft server runs from this folder, so it needs the server program: the server .jar (from '
            + 'minecraft.net, or a Paper or Fabric jar). For Forge or NeoForge, run their installer with "Install server" '
            + 'in this folder. The world and settings are made there when the server first starts.\n\n'
            + 'Have a server already? Choose its folder; the world is uploaded the first time you host. Starting fresh? '
            + 'Put the server .jar in a new, empty folder and choose that.',
        confirmText: 'Choose folder',
        cancelText: 'Later',
        link: { label: 'Download the Minecraft server (minecraft.net)', url: 'https://www.minecraft.net/en-us/download/server' },
    });
    const path = choose ? await chooseLocalPath(server.id) : null;
    if (!path) useNoticeStore.getState().info(`You can choose the folder for "${server.name}" later in Settings > Drive Folders.`);
}

/** Creates a server folder in my Drive, then opens Drive Folders with its name ready to edit: the place where the
 *  server is managed later, so the user meets it right away. Once it is named, its folder on this PC is asked for
 *  there too (see askForServerFolder). */
export async function createServer(confirm: ConfirmFn): Promise<ServerSummary | null> {
    const accepted = await confirm({
        message: 'This creates a new server folder inside "Minecraft Shared Servers" in your Google Drive. You can own up to 3 servers.\n\nThe first upload of a server takes much longer than later ones, because every folder and file has to be created on Google Drive.\n\nDon\'t change the files in a server folder by hand while someone is hosting it.',
        confirmText: 'Create',
        cancelText: 'Cancel',
    });
    if (!accepted) return null;
    const res = await request('servers:create');
    if (!res.ok) return null;
    useServersStore.getState().add(res.value);
    useUiStore.getState().openDriveFolders(res.value.id);
    return res.value;
}

/** Joins a server shared with me (a folder ID or a Drive link), then offers to choose its local folder. */
export async function joinServer(idOrLink: string, confirm: ConfirmFn): Promise<ServerSummary | null> {
    const res = await request('servers:join', idOrLink.trim());
    if (!res.ok) return null;
    useServersStore.getState().add(res.value);
    await offerLocalPath(res.value, confirm, `You joined "${res.value.name}".`);
    return res.value;
}
