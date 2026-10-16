// Toasts: short messages that replace the old alert() calls.
import { create } from 'zustand';
import type { AppErrorInfo } from '../../shared/types';

export type NoticeKind = 'error' | 'info' | 'success';

export interface Notice {
    id: number;
    kind: NoticeKind;
    message: string;
    detail?: string;
}

const MAX_NOTICES = 4;

interface NoticeStore {
    notices: Notice[];
    nextId: number;
    push: (kind: NoticeKind, message: string, detail?: string) => void;
    info: (message: string) => void;
    success: (message: string) => void;
    error: (error: AppErrorInfo | string) => void;
    dismiss: (id: number) => void;
}

export const useNoticeStore = create<NoticeStore>()((set, get) => ({
    notices: [],
    nextId: 1,

    push: (kind, message, detail) => {
        // The same message twice in a row (e.g. a retried request) is shown once.
        if (get().notices.some((n) => n.kind === kind && n.message === message)) return;
        set((s) => ({
            nextId: s.nextId + 1,
            notices: [...s.notices, { id: s.nextId, kind, message, detail }].slice(-MAX_NOTICES),
        }));
    },
    info: (message) => get().push('info', message),
    success: (message) => get().push('success', message),
    error: (error) => {
        if (typeof error === 'string') get().push('error', error);
        else get().push('error', error.message, error.detail);
    },
    dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
