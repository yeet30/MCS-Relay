// Requests to open a window that another component owns: Drive Folders lives in the settings menu, but a new
// server is named there right after it is created, wherever "Create" was pressed.
import { create } from 'zustand';
import type { ServerId } from '../../shared/types';

interface UiStore {
    /** Drive Folders was asked to open (the settings menu opens it and clears this). */
    driveFoldersRequested: boolean;
    /** The server whose name field should open for editing, as if its pen button was pressed. */
    renameId: ServerId | null;
    openDriveFolders: (renameId?: ServerId | null) => void;
    clearDriveFoldersRequest: () => void;
    /** The server card calls this when it started the rename; true when it was asked to. */
    takeRename: (serverId: ServerId) => boolean;
    /** The server whose "Download a server" window should open (ServerSetupHost owns it). */
    setupId: ServerId | null;
    openServerSetup: (serverId: ServerId | null) => void;
}

export const useUiStore = create<UiStore>()((set, get) => ({
    driveFoldersRequested: false,
    renameId: null,
    openDriveFolders: (renameId = null) => set({ driveFoldersRequested: true, renameId }),
    clearDriveFoldersRequest: () => set({ driveFoldersRequested: false }),
    setupId: null,
    openServerSetup: (serverId) => set({ setupId: serverId }),
    takeRename: (serverId) => {
        if (get().renameId !== serverId) return false;
        set({ renameId: null });
        return true;
    },
}));
