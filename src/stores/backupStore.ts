// The backup task (backups:progress) and the server download (installer:progress) the main process is running.
import { create } from 'zustand';
import type { BackupProgress, InstallProgress } from '../../shared/types';

interface BackupStore {
    progress: BackupProgress | null;
    apply: (progress: BackupProgress | null) => void;
    install: InstallProgress | null;
    applyInstall: (progress: InstallProgress | null) => void;
}

export const useBackupStore = create<BackupStore>()((set) => ({
    progress: null,
    apply: (progress) => set({ progress }),
    install: null,
    applyInstall: (install) => set({ install }),
}));
