import { expect, test } from 'vitest';
import type { StepMessage } from '../../shared/types';
import { mergeSteps } from './steps';

function step(id: number, message: string, status: StepMessage['status'] = 'loading'): StepMessage {
    return { id, message, importance: 'major', at: String(id), status };
}

test('a finished task replaces its loading line in place', () => {
    const loading = step(1, 'Uploading files (3 of 10)');
    const other = step(2, 'Retrying the upload', 'done');
    const done = step(1, 'Uploaded 10 files', 'done');
    expect(mergeSteps([loading, other], [done])).toEqual([done, other]);
});

test('new ids are appended, duplicates change nothing, and only the newest are kept', () => {
    const a = step(1, 'A', 'done');
    const b = step(2, 'B', 'done');
    const c = step(3, 'C', 'done');
    expect(mergeSteps([a, b], [b, c])).toEqual([a, b, c]);
    expect(mergeSteps([a, b], [c], 2)).toEqual([b, c]);
});
