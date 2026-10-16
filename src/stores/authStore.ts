// Who is signed in. The main process owns the tokens; this store mirrors auth:status.
import { create } from 'zustand';
import type { AuthStatus, Result } from '../../shared/ipc';
import type { UserInfo } from '../../shared/types';
import { invoke } from '../api';
import { request } from './request';

export type AuthPhase = 'unknown' | 'signed-in' | 'signed-out';

interface AuthStore {
    phase: AuthPhase;
    user: UserInfo | null;
    /** false only for tokens from the old two-step login that lack the full Drive scope. */
    collaborationEnabled: boolean;
    /** Set when a NOT_SIGNED_IN error ended a session; shown on the login page. */
    signedOutReason: string | null;

    apply: (status: AuthStatus) => void;
    markSignedOut: (reason: string | null) => void;
    refresh: () => Promise<AuthStatus | null>;
    /** Errors are returned, not toasted: the login page shows them inline. */
    login: () => Promise<Result<AuthStatus>>;
    enableCollaboration: () => Promise<boolean>;
    logout: () => Promise<boolean>;
}

export const useAuthStore = create<AuthStore>()((set, get) => ({
    phase: 'unknown',
    user: null,
    collaborationEnabled: true,
    signedOutReason: null,

    apply: (status) => {
        if (status.loggedIn) {
            set({ phase: 'signed-in', user: status.user, collaborationEnabled: status.collaborationEnabled, signedOutReason: null });
        } else {
            set({ phase: 'signed-out', user: null, collaborationEnabled: status.collaborationEnabled });
        }
    },

    markSignedOut: (reason) => set((s) => ({
        phase: 'signed-out',
        user: null,
        // Only a session that was actually running can "expire"; errors before sign-in are not news.
        signedOutReason: s.phase === 'signed-in' ? reason : s.signedOutReason,
    })),

    refresh: async () => {
        const res = await request('auth:status');
        if (!res.ok) return null;
        get().apply(res.value);
        return res.value;
    },

    login: async () => {
        const res = await invoke('auth:login');
        if (res.ok) get().apply(res.value);
        return res;
    },

    enableCollaboration: async () => {
        const res = await request('auth:enableCollaboration');
        if (!res.ok) return false;
        get().apply(res.value);
        return res.value.collaborationEnabled;
    },

    logout: async () => {
        const res = await request('auth:logout');
        if (!res.ok) return false;
        set({ phase: 'signed-out', user: null, signedOutReason: null });
        return true;
    },
}));
