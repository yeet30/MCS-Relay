// The app's own update, as the main process reports it (app:update).
import { create } from 'zustand';
import type { UpdateState } from '../../shared/types';
import { invoke } from '../api';
import { request } from './request';

interface UpdateStore {
    state: UpdateState | null;
    apply: (state: UpdateState) => void;
    load: () => Promise<void>;
    check: () => Promise<void>;
    /** Quits, installs and starts again; refused (with a notice) while a session is busy. */
    install: () => Promise<void>;
}

export const useUpdateStore = create<UpdateStore>()((set) => ({
    state: null,
    apply: (state) => set({ state }),
    load: async () => {
        const res = await invoke('app:updateState');
        if (res.ok) set({ state: res.value });
    },
    check: async () => {
        const res = await request('app:checkForUpdates');
        if (res.ok) set({ state: res.value });
    },
    install: async () => {
        await request('app:installUpdate');
    },
}));
