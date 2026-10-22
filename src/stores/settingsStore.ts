// App-wide and per-server settings. The main process validates and stores them; this is the last known copy.
import { create } from 'zustand';
import type { AppSettings, ServerId, ServerSettings } from '../../shared/types';
import { request } from './request';

type AppSettingsPatch = Partial<Omit<AppSettings, 'joinedServerIds'>>;
type ServerSettingsPatch = Partial<Omit<ServerSettings, 'localPath'>>;

interface SettingsStore {
    settings: AppSettings | null;
    servers: Record<ServerId, ServerSettings>;

    load: () => Promise<AppSettings | null>;
    update: (patch: AppSettingsPatch) => Promise<boolean>;
    loadServer: (serverId: ServerId) => Promise<ServerSettings | null>;
    updateServer: (serverId: ServerId, patch: ServerSettingsPatch) => Promise<boolean>;
    choosePlayitPath: () => Promise<string | null>;
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
    settings: null,
    servers: {},

    load: async () => {
        const res = await request('settings:get');
        if (!res.ok) return null;
        set({ settings: res.value });
        return res.value;
    },

    update: async (patch) => {
        const res = await request('settings:set', patch);
        if (!res.ok) return false;
        set({ settings: res.value });
        return true;
    },

    loadServer: async (serverId) => {
        const res = await request('settings:getServer', serverId);
        if (!res.ok) return null;
        set((s) => ({ servers: { ...s.servers, [serverId]: res.value } }));
        return res.value;
    },

    updateServer: async (serverId, patch) => {
        const res = await request('settings:setServer', serverId, patch);
        if (!res.ok) return false;
        set((s) => ({ servers: { ...s.servers, [serverId]: res.value } }));
        return true;
    },

    choosePlayitPath: async () => {
        const res = await request('settings:choosePlayitPath');
        if (!res.ok || res.value === null) return null;
        const playitggPath = res.value;
        set((s) => (s.settings ? { settings: { ...s.settings, playitggPath } } : {}));
        return playitggPath;
    },
}));
