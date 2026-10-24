// The backup task the main process is running (backups:progress), for the Backups panel.
import { create } from 'zustand';
import type { BackupProgress } from '../../shared/types';

interface BackupStore {
    progress: BackupProgress | null;
    apply: (progress: BackupProgress | null) => void;
}

export const useBackupStore = create<BackupStore>()((set) => ({
    progress: null,
    apply: (progress) => set({ progress }),
}));
