// A MIRROR of the main process's session: it holds what the main process last sent and never invents state.
// Buttons derive what they allow from it (see lib/sync.ts), so they cannot disagree with the main process.
// Events keep it current; resync() re-reads everything (at startup, and from the refresh button).
import { create } from 'zustand';
import type { QuitPrompt } from '../../shared/ipc';
import type {
    AppErrorInfo, ChangeBatch, ChangeKind, LockView, ServerId, SessionState, StepMessage, SyncReport, TransferSnapshot,
} from '../../shared/types';
import { invoke } from '../api';
import { applyChangeBatch, mergeChange } from '../lib/changes';
import { appendLines, mergeConsole } from '../lib/console';
import { mergeSteps } from '../lib/steps';

export const IDLE_SESSION: SessionState = {
    phase: 'idle',
    serverId: null,
    startedAt: null,
    address: null,
    players: [],
    javaRunning: false,
    error: null,
};

type ChangeOp = { type: 'batch'; batch: ChangeBatch } | { type: 'reset' };

/** Events that arrive while a resync request is in flight; they are replayed on top of its answer. */
interface ResyncBuffer {
    changeOps: ChangeOp[];
    lines: string[];
    steps: StepMessage[];
    sawState: boolean;
    sawTransfer: boolean;
}

export interface SessionStore {
    state: SessionState;
    /** The last SyncReport the main process sent (for whichever server it checked). */
    report: SyncReport | null;
    /** The server whose check this renderer asked for and is waiting on. */
    checkingId: ServerId | null;
    /** A check that failed before it could produce a report. */
    checkError: { serverId: ServerId; error: AppErrorInfo } | null;
    /** The newest lock view per server, from lock:update events and reports. */
    locks: Record<ServerId, LockView>;
    steps: StepMessage[];
    transfer: TransferSnapshot | null;
    changes: Map<string, ChangeKind>;
    console: string[];
    quitPrompt: QuitPrompt | null;
    quitting: boolean;

    applyState: (state: SessionState) => void;
    applyReport: (report: SyncReport) => void;
    applyLock: (serverId: ServerId, view: LockView) => void;
    applyStep: (step: StepMessage) => void;
    applyTransfer: (snapshot: TransferSnapshot) => void;
    applyChanges: (batch: ChangeBatch) => void;
    resetChanges: () => void;
    appendConsole: (lines: string[]) => void;
    setQuitPrompt: (prompt: QuitPrompt | null) => void;
    setQuitting: (quitting: boolean) => void;

    beginCheck: (serverId: ServerId) => void;
    endCheck: (serverId: ServerId, error: AppErrorInfo | null) => void;
    /** Runs session:preflight for a server; the report arrives as sync:report and in the answer. */
    preflight: (serverId: ServerId) => Promise<boolean>;
    resync: () => Promise<void>;
}

/** The report for `serverId`, or null when the last report is about another server. Returns stored references
 *  only, so it is safe as a zustand selector. */
export function reportFor(s: SessionStore, serverId: ServerId | null): SyncReport | null {
    return serverId !== null && s.report !== null && s.report.serverId === serverId ? s.report : null;
}

export function lockFor(s: SessionStore, serverId: ServerId | null): LockView | null {
    if (serverId === null) return null;
    return s.locks[serverId] ?? reportFor(s, serverId)?.lock ?? null;
}

export const useSessionStore = create<SessionStore>()((set, get) => {
    // Closure state of this store singleton, not shared React state.
    let buffer: ResyncBuffer | null = null;
    let resyncInFlight: Promise<void> | null = null;

    async function runResync(): Promise<void> {
        const [state, report, steps, transfer, changes, lines] = await Promise.all([
            invoke('session:get'),
            invoke('session:lastReport'),
            invoke('session:steps'),
            invoke('session:transfers'),
            invoke('session:changes'),
            invoke('session:console'),
        ]);
        const buffered = buffer ?? { changeOps: [], lines: [], steps: [], sawState: false, sawTransfer: false };
        buffer = null;

        const patch: Partial<SessionStore> = {};
        if (state.ok && !buffered.sawState) patch.state = state.value;
        if (report.ok && report.value && get().report === null) {
            patch.report = report.value;
            patch.locks = { ...get().locks, [report.value.serverId]: get().locks[report.value.serverId] ?? report.value.lock };
        }
        if (steps.ok) patch.steps = mergeSteps(steps.value, buffered.steps);
        if (transfer.ok && !buffered.sawTransfer) patch.transfer = transfer.value;
        if (changes.ok) {
            const map = new Map<string, ChangeKind>(changes.value);
            for (const op of buffered.changeOps) {
                if (op.type === 'reset') map.clear();
                else for (const [path, kind] of op.batch) mergeChange(map, path, kind);
            }
            patch.changes = map;
        }
        if (lines.ok) patch.console = mergeConsole(lines.value, buffered.lines);
        set(patch);

        for (const res of [state, report, steps, transfer, changes, lines]) {
            if (!res.ok && res.error.code !== 'NOT_SIGNED_IN') console.warn('[session] resync failed:', res.error.message, res.error.detail ?? '');
        }
    }

    return {
        state: IDLE_SESSION,
        report: null,
        checkingId: null,
        checkError: null,
        locks: {},
        steps: [],
        transfer: null,
        changes: new Map(),
        console: [],
        quitPrompt: null,
        quitting: false,

        applyState: (state) => {
            if (buffer) buffer.sawState = true;
            set({ state });
        },

        applyReport: (report) => set((s) => ({
            report,
            locks: { ...s.locks, [report.serverId]: report.lock },
            checkingId: s.checkingId === report.serverId ? null : s.checkingId,
            checkError: s.checkError?.serverId === report.serverId ? null : s.checkError,
        })),

        applyLock: (serverId, view) => set((s) => ({ locks: { ...s.locks, [serverId]: view } })),

        applyStep: (step) => {
            buffer?.steps.push(step);
            set((s) => ({ steps: mergeSteps(s.steps, [step]) }));
        },

        applyTransfer: (snapshot) => {
            if (buffer) buffer.sawTransfer = true;
            set({ transfer: snapshot });
        },

        applyChanges: (batch) => {
            buffer?.changeOps.push({ type: 'batch', batch });
            set((s) => ({ changes: applyChangeBatch(s.changes, batch) }));
        },

        resetChanges: () => {
            buffer?.changeOps.push({ type: 'reset' });
            set({ changes: new Map() });
        },

        appendConsole: (lines) => {
            if (buffer) for (const line of lines) buffer.lines.push(line);
            set((s) => ({ console: appendLines(s.console, lines) }));
        },

        setQuitPrompt: (prompt) => set({ quitPrompt: prompt }),
        setQuitting: (quitting) => set({ quitting }),

        beginCheck: (serverId) => set((s) => ({
            checkingId: serverId,
            checkError: s.checkError?.serverId === serverId ? null : s.checkError,
        })),

        endCheck: (serverId, error) => set((s) => ({
            checkingId: s.checkingId === serverId ? null : s.checkingId,
            checkError: error ? { serverId, error } : s.checkError?.serverId === serverId ? null : s.checkError,
        })),

        preflight: async (serverId) => {
            get().beginCheck(serverId);
            const res = await invoke('session:preflight', serverId);
            get().endCheck(serverId, res.ok ? null : res.error);
            // Normally the sync:report event already delivered it; applying it again is harmless.
            if (res.ok) get().applyReport(res.value);
            return res.ok;
        },

        resync: () => {
            if (resyncInFlight) return resyncInFlight;
            buffer = { changeOps: [], lines: [], steps: [], sawState: false, sawTransfer: false };
            resyncInFlight = runResync().finally(() => {
                buffer = null;
                resyncInFlight = null;
            });
            return resyncInFlight;
        },
    };
});
