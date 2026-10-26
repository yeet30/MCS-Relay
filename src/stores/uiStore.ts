// Requests to open a window that another component owns: Servers lives in the settings menu, the create wizard and
// the tour on the main page, but each can be asked for from elsewhere.
import { create } from 'zustand';

interface UiStore {
    /** Servers was asked to open (the settings menu opens it and clears this). */
    driveFoldersRequested: boolean;
    openDriveFolders: () => void;
    clearDriveFoldersRequest: () => void;
    /** The "create a server" wizard is open. */
    creating: boolean;
    openCreate: (open: boolean) => void;
    /** The tour that shows where servers are managed, after an account's first server. */
    touring: boolean;
    openTour: (open: boolean) => void;
}

export const useUiStore = create<UiStore>()((set) => ({
    driveFoldersRequested: false,
    openDriveFolders: () => set({ driveFoldersRequested: true }),
    clearDriveFoldersRequest: () => set({ driveFoldersRequested: false }),
    creating: false,
    openCreate: (creating) => set({ creating }),
    touring: false,
    openTour: (touring) => set({ touring }),
}));
