import { expect, test } from 'vitest';
import type { StepMessage } from '../../shared/types';
import { latestSteps, mergeSteps } from './steps';

function step(message: string, importance: StepMessage['importance'], at: string, status: StepMessage['status'] = 'loading'): StepMessage {
    return { message, importance, at, status };
}

test('latestSteps shows only a minor step that belongs to the latest major one', () => {
    const steps = [
        step('Downloading', 'major', '1'),
        step('world/level.dat', 'minor', '2'),
        step('Starting the server', 'major', '3'),
    ];
    expect(latestSteps(steps)).toEqual({ major: steps[2], minor: null });
    const more = [...steps, step('Loading libraries', 'minor', '4')];
    expect(latestSteps(more)).toEqual({ major: steps[2], minor: more[3] });
    expect(latestSteps([])).toEqual({ major: null, minor: null });
});

test('mergeSteps skips duplicates and keeps the newest', () => {
    const a = step('A', 'major', '1');
    const b = step('B', 'minor', '2');
    const c = step('C', 'major', '3');
    expect(mergeSteps([a, b], [b, c])).toEqual([a, b, c]);
    expect(mergeSteps([a, b], [c], 2)).toEqual([b, c]);
});

test('mergeSteps keeps a step whose status changed', () => {
    const loading = step('Uploading', 'major', '1', 'loading');
    const done = step('Uploading', 'major', '1', 'done');
    expect(mergeSteps([loading], [done])).toEqual([loading, done]);
});
