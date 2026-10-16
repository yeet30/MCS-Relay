// Step history helpers for the startup progress line and its "detailed progress" list.
import type { StepMessage } from '../../shared/types';

export const MAX_STEPS = 50;

function stepKey(step: StepMessage): string {
    return `${step.at}|${step.importance}|${step.status}|${step.message}`;
}

/** Adds `incoming` after `current`, skipping steps already present (a resync can return steps that also arrived
 *  as events), and keeps the newest `max`. */
export function mergeSteps(current: readonly StepMessage[], incoming: readonly StepMessage[], max = MAX_STEPS): StepMessage[] {
    const seen = new Set(current.map(stepKey));
    const next = [...current];
    for (const step of incoming) {
        const key = stepKey(step);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(step);
    }
    return next.length > max ? next.slice(next.length - max) : next;
}

/** The latest major step, and the latest minor step that came after it (an older minor step belongs to an
 *  earlier stage and would be misleading under a new heading). */
export function latestSteps(steps: readonly StepMessage[]): { major: StepMessage | null; minor: StepMessage | null } {
    let major: StepMessage | null = null;
    let minor: StepMessage | null = null;
    for (const step of steps) {
        if (step.importance === 'major') {
            major = step;
            minor = null;
        } else {
            minor = step;
        }
    }
    return { major, minor };
}
