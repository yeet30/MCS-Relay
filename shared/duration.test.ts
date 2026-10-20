import { expect, test } from 'vitest';
import { durationBetween, formatDuration } from './duration';

test('formatDuration reads like a person would say it', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(48_400)).toBe('48 s');
    expect(formatDuration(60_000)).toBe('1 min');
    expect(formatDuration(192_000)).toBe('3 min 12 s');
    expect(formatDuration(3_900_000)).toBe('1 h 5 min');
    expect(formatDuration(7_200_000)).toBe('2 h');
    expect(formatDuration(Number.NaN)).toBe('0 s');
});

test('durationBetween needs both ends', () => {
    expect(durationBetween('2026-10-21T10:00:00.000Z', '2026-10-21T10:00:30.000Z')).toBe(30_000);
    expect(durationBetween('2026-10-21T10:00:00.000Z', undefined)).toBeNull();
    expect(durationBetween(null, '2026-10-21T10:00:00.000Z')).toBeNull();
});
