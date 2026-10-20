// How the sync engine tells whoever runs it (the session) how far it is. See electron/session/progress.ts.
import type { ProgressStageKey } from '../../shared/types';

export interface ProgressSink {
    /** Makes the stage the current one; its log line shows `message`. */
    enter(key: ProgressStageKey, message: string): void;
    /** The stage's size in units (one per file or folder, 1 for a single action), once it is known. */
    setTotal(key: ProgressStageKey, units: number): void;
    /** Progress inside the stage's current step: `done` of `of`, shown as `message`. */
    report(key: ProgressStageKey, done: number, of: number, message: string): void;
    /** `units` finished for good (a run of transfers ended); the live part of the stage starts again at 0. */
    settle(key: ProgressStageKey, units: number): void;
    complete(key: ProgressStageKey, message?: string): void;
    skip(key: ProgressStageKey): void;
}

export const NO_PROGRESS: ProgressSink = {
    enter: () => undefined,
    setTotal: () => undefined,
    report: () => undefined,
    settle: () => undefined,
    complete: () => undefined,
    skip: () => undefined,
};
