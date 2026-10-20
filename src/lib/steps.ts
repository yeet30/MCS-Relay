// The progress log's lines. A task keeps its id while it runs, so its line is replaced in place when it
// finishes: a "loading" line turns into "done" or "error" instead of a second line appearing.
import type { StepMessage } from '../../shared/types';

export const MAX_STEPS = 100;

/** Applies `incoming` to `current`: a known id replaces its line where it stands, a new id is added at the end.
 *  Applying the same step twice (a resync answer and an event) changes nothing. Keeps the newest `max`. */
export function mergeSteps(current: readonly StepMessage[], incoming: readonly StepMessage[], max = MAX_STEPS): StepMessage[] {
    const next = [...current];
    const index = new Map(next.map((step, i) => [step.id, i]));
    for (const step of incoming) {
        const at = index.get(step.id);
        if (at !== undefined) {
            next[at] = step;
        } else {
            index.set(step.id, next.length);
            next.push(step);
        }
    }
    return next.length > max ? next.slice(next.length - max) : next;
}
