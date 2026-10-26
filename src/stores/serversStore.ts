// The servers I own or joined, and which one is selected.
import { create } from 'zustand';
import type { ServerId, ServerMember, ServerSummary } from '../../shared/types';
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
    /** Servers being deleted or left: kept here, not in the card, so reopening Servers still shows it and the
     *  button stays off. For a deletion, how many of the other members' files went back to them so far. */
    leaving: Record<ServerId, { done: number; total: number } | null>;
    setLeaving: (serverId: ServerId, progress: { done: number; total: number } | null | undefined) => void;
    /** A server whose folder is being chosen (the picker is open) or checked (its files are read). */
    pathBusy: { serverId: ServerId; step: 'choosing' | 'checking' } | null;

    load: () => Promise<boolean>;
    /** Shows a newly chosen folder at once, without listing every server from Drive again. */
    setLocalPath: (serverId: ServerId, localPath: string) => void;
    /** Shows a new name at once, without listing every server from Drive again. */
    setName: (serverId: ServerId, name: string) => void;
    /** Adds a server that was just created or joined (the main process answered with it), without listing every
     *  server from Drive again; when nothing is selected yet, it is selected. */
    add: (server: ServerSummary) => void;
    /** Takes a deleted or left server off the list (the main process forgot it already); when it was selected, the
     *  first server left is selected instead. */
    remove: (serverId: ServerId) => void;
    /** A member added (or given another role) or removed, without listing every server on Drive again. */
    putMember: (serverId: ServerId, member: ServerMember) => void;
    dropMember: (serverId: ServerId, permissionId: string) => void;
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

/** Servers deleted or left in this window: a list asked for before that finished (and answered after it) must not
 *  bring one back. */
const removed = new Set<ServerId>();

export const useServersStore = create<ServersStore>()((set, get) => ({
    servers: [],
    loading: false,
    loaded: false,
    error: null,
    selectedId: null,
    pathBusy: null,
    leaving: {},

    load: async () => {
        set({ loading: true });
        const res = await request('servers:list');
        if (!res.ok) {
            set({ loading: false, error: res.error.message });
            return false;
        }
        set({ servers: res.value.filter((server) => !removed.has(server.id)), loading: false, loaded: true, error: null });
        return true;
    },

    setLeaving: (serverId, progress) => set((s) => {
        const leaving = { ...s.leaving };
        if (progress === undefined) delete leaving[serverId];
        else leaving[serverId] = progress;
        return { leaving };
    }),

    setLocalPath: (serverId, localPath) => set((s) => ({
        servers: s.servers.map((server) => (server.id === serverId ? { ...server, localPath } : server)),
    })),

    setName: (serverId, name) => set((s) => ({
        servers: s.servers.map((server) => (server.id === serverId ? { ...server, name } : server)),
    })),

    remove: (serverId) => {
        removed.add(serverId);
        const servers = get().servers.filter((server) => server.id !== serverId);
        set({ servers });
        if (get().selectedId === serverId) void get().select(servers[0]?.id ?? null);
    },

    putMember: (serverId, member) => set((s) => ({
        servers: s.servers.map((server) => (server.id !== serverId ? server : {
            ...server,
            members: [...server.members.filter((m) => m.permissionId !== member.permissionId && m.email !== member.email), member],
        })),
    })),

    dropMember: (serverId, permissionId) => set((s) => ({
        servers: s.servers.map((server) => (server.id !== serverId ? server
            : { ...server, members: server.members.filter((m) => m.permissionId !== permissionId) })),
    })),

    add: (server) => {
        removed.delete(server.id);
        set((s) => ({ servers: [...s.servers.filter((other) => other.id !== server.id), server], loaded: true }));
        // Checking the new server (Drive requests) runs in the background, so nothing waits for it.
        if (get().selectedId === null && !isSessionBusy(useSessionStore.getState().state.phase)) void get().select(server.id);
    },

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

    reset: () => set({ servers: [], loading: false, loaded: false, error: null, selectedId: null, pathBusy: null, leaving: {} }),
}));
