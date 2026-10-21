// The servers I own or joined, and which one is selected.
import { create } from 'zustand';
import type { ServerId, ServerSummary } from '../../shared/types';
import { invoke } from '../api';
import { isSessionBusy } from '../lib/sync';
import { useNoticeStore } from './noticeStore';
import { request } from './request';
import { useSessionStore } from './sessionStore';

interface ServersStore {
    servers: ServerSummary[];
    loading: boolean;
    loaded: boolean;
    error: string | null;
    selectedId: ServerId | null;
    /** A server whose folder is being chosen (the picker is open) or checked (its files are read). */
    pathBusy: { serverId: ServerId; step: 'choosing' | 'checking' } | null;

    load: () => Promise<boolean>;
    /** Shows a newly chosen folder at once, without listing every server from Drive again. */
    setLocalPath: (serverId: ServerId, localPath: string) => void;
    /** Selects a server: the main process remembers it, checks it (sync:report) and watches its lock. */
    select: (serverId: ServerId | null) => Promise<void>;
    /** After the first load: the server of a running session, else the remembered one, else the first. */
    selectInitial: (remembered: ServerId | null) => Promise<void>;
    /** Reloads the list after a change and keeps the selection valid. `prefer` selects that server (when the
     *  session allows it); `recheck` re-runs the check of the selected server (its local folder changed). */
    reload: (opts?: { prefer?: ServerId | null; recheck?: boolean }) => Promise<void>;
    reset: () => void;
}

export function selectSelectedServer(s: ServersStore): ServerSummary | null {
    return s.servers.find((server) => server.id === s.selectedId) ?? null;
}

export const useServersStore = create<ServersStore>()((set, get) => ({
    servers: [],
    loading: false,
    loaded: false,
    error: null,
    selectedId: null,
    pathBusy: null,

    load: async () => {
        set({ loading: true });
        const res = await request('servers:list');
        if (!res.ok) {
            set({ loading: false, error: res.error.message });
            return false;
        }
        set({ servers: res.value, loading: false, loaded: true, error: null });
        return true;
    },

    setLocalPath: (serverId, localPath) => set((s) => ({
        servers: s.servers.map((server) => (server.id === serverId ? { ...server, localPath } : server)),
    })),

    select: async (serverId) => {
        set({ selectedId: serverId });
        if (serverId !== null) useSessionStore.getState().beginCheck(serverId);
        const res = await invoke('servers:select', serverId);
        if (serverId !== null) useSessionStore.getState().endCheck(serverId, res.ok ? null : res.error);
        else if (!res.ok && res.error.code !== 'NOT_SIGNED_IN') useNoticeStore.getState().error(res.error);
    },

    selectInitial: async (remembered) => {
        const { servers } = get();
        const has = (id: ServerId | null): id is ServerId => id !== null && servers.some((s) => s.id === id);
        const session = useSessionStore.getState().state;
        const sessionServer = isSessionBusy(session.phase) || session.phase === 'failed' ? session.serverId : null;
        const pick = has(sessionServer) ? sessionServer : has(remembered) ? remembered : servers[0]?.id ?? null;
        await get().select(pick);
    },

    reload: async (opts = {}) => {
        const prefer = opts.prefer ?? null;
        if (!(await get().load())) return;
        const { servers, selectedId } = get();
        const busy = isSessionBusy(useSessionStore.getState().state.phase);
        if (prefer && prefer !== selectedId && !busy && servers.some((s) => s.id === prefer)) {
            await get().select(prefer);
            return;
        }
        if (selectedId !== null && servers.some((s) => s.id === selectedId)) {
            if (opts.recheck && !busy) await useSessionStore.getState().preflight(selectedId);
            return;
        }
        await get().select(servers[0]?.id ?? null);
    },

    reset: () => set({ servers: [], loading: false, loaded: false, error: null, selectedId: null, pathBusy: null }),
}));
