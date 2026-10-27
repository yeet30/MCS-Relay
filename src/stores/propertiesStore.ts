// Each server's server.properties as last read or saved on this PC; Server settings shows its Whitelist tab while
// "white-list" is on.
import { create } from 'zustand';
import type { ServerPropertiesInfo } from '../../shared/types';
import { invoke } from '../api';

interface PropertiesStore {
    byServer: Record<string, ServerPropertiesInfo>;
    load: (serverId: string) => Promise<void>;
    set: (serverId: string, info: ServerPropertiesInfo) => void;
}

export const usePropertiesStore = create<PropertiesStore>()((set) => ({
    byServer: {},
    load: async (serverId) => {
        const res = await invoke('servers:properties', serverId);
        if (res.ok) set((s) => ({ byServer: { ...s.byServer, [serverId]: res.value } }));
    },
    set: (serverId, info) => set((s) => ({ byServer: { ...s.byServer, [serverId]: info } })),
}));

/** The whitelist is on in the server's saved server.properties (Minecraft's default: off). */
export const selectWhitelistOn = (serverId: string | null) => (s: PropertiesStore): boolean =>
    serverId !== null && s.byServer[serverId]?.values['white-list'] === 'true';
