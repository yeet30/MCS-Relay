import { expect, test } from 'vitest';
import { appendLines, classifyLine, mergeConsole } from './console';

test('classifyLine', () => {
    expect(classifyLine('[12:00:00 WARN]: Can\'t keep up! [WARN]')).toBe('warn');
    expect(classifyLine('[12:00:00 ERROR]: java.lang.Exception: boom')).toBe('error');
    expect(classifyLine('[12:00:00 INFO]: Done (3.2s)! For help, type "help"')).toBe('success');
    expect(classifyLine('[System] Server stopped')).toBe('system');
    expect(classifyLine('[12:00:00 INFO]: Preparing spawn area')).toBe('info');
});

test('appendLines keeps the newest lines', () => {
    expect(appendLines(['a', 'b'], ['c', 'd'], 3)).toEqual(['b', 'c', 'd']);
    expect(appendLines([], ['a'], 3)).toEqual(['a']);
});

test('mergeConsole does not repeat lines the snapshot already has', () => {
    expect(mergeConsole(['a', 'b', 'c'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
});

test('mergeConsole appends lines that arrived after the snapshot was taken', () => {
    expect(mergeConsole(['a', 'b'], ['c'])).toEqual(['a', 'b', 'c']);
    expect(mergeConsole([], ['x'])).toEqual(['x']);
});

test('mergeConsole caps the result', () => {
    expect(mergeConsole(['a', 'b', 'c'], ['d'], 2)).toEqual(['c', 'd']);
});
