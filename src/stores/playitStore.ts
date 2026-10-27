// playit.gg linked through the app, as the main process reports it (playit:state).
import { create } from 'zustand';
import type { PlayitLinkState } from '../../shared/types';
import { invoke } from '../api';
import { request } from './request';
import { useSettingsStore } from './settingsStore';

interface PlayitStore {
    state: PlayitLinkState | null;
    apply: (state: PlayitLinkState) => void;
    load: () => Promise<void>;
    /** true once linked. A failure shows in the state's error, so it is not also a toast. */
    link: () => Promise<boolean>;
    cancel: () => Promise<void>;
    /** Asks playit.gg again whether this PC's agent may run (quietly: the state shows the answer). */
    check: () => Promise<void>;
    reopen: () => Promise<void>;
    unlink: () => Promise<boolean>;
}

export const usePlayitStore = create<PlayitStore>()((set, get) => ({
    state: null,
    apply: (state) => set({ state }),
    load: async () => {
        const res = await invoke('playit:state');
        if (res.ok) set({ state: res.value });
    },
    link: async () => {
        const res = await invoke('playit:link');
        await get().load();
        const linked = res.ok && get().state?.linked === true;
        if (linked) await useSettingsStore.getState().load();
        return linked;
    },
    cancel: async () => {
        await invoke('playit:cancelLink');
    },
    check: async () => {
        await invoke('playit:check');
    },
    reopen: async () => {
        await request('playit:reopen');
    },
    unlink: async () => (await request('playit:unlink')).ok,
}));
