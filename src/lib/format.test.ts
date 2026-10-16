import { describe, expect, test } from 'vitest';
import {
    formatAgo, formatBytes, formatBytesPair, formatCount, formatEta, formatSpeed, formatUptime, formatWhen, listNames, plural,
} from './format';

describe('formatBytes', () => {
    test('small sizes are shown in bytes', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(-5)).toBe('0 B');
        expect(formatBytes(Number.NaN)).toBe('0 B');
    });

    test('one decimal below 100, none above', () => {
        expect(formatBytes(41 * 1024)).toBe('41.0 KB');
        expect(formatBytes(7 * 1024 * 1024)).toBe('7.0 MB');
        expect(formatBytes(180 * 1024 * 1024)).toBe('180 MB');
        expect(formatBytes(1.4 * 1024 ** 3)).toBe('1.4 GB');
    });

    test('a value that rounds up to 1024 moves to the next unit', () => {
        expect(formatBytes(1024 * 1024 - 10)).toBe('1.0 MB');
        expect(formatBytes(1023.6)).toBe('1.0 KB');
    });
});

describe('formatBytesPair', () => {
    test('uses the unit of the total for both values', () => {
        expect(formatBytesPair(3.1 * 1024 * 1024, 7 * 1024 * 1024)).toBe('3.1 / 7.0 MB');
        expect(formatBytesPair(412 * 1024 * 1024, 700 * 1024 * 1024, ' of ')).toBe('412 of 700 MB');
        expect(formatBytesPair(0, 0)).toBe('0 / 0 B');
    });
});

test('formatSpeed', () => {
    expect(formatSpeed(4.1 * 1024 * 1024)).toBe('4.1 MB/s');
});

describe('formatEta', () => {
    test('unknown estimates', () => {
        expect(formatEta(null)).toBe('estimating time left…');
        expect(formatEta(Number.POSITIVE_INFINITY)).toBe('estimating time left…');
    });

    test('seconds, minutes and hours', () => {
        expect(formatEta(0.5)).toBe('almost done');
        expect(formatEta(40)).toBe('about 40 s left');
        expect(formatEta(70)).toBe('about 1 min 10 s left');
        expect(formatEta(72)).toBe('about 1 min 10 s left');
        expect(formatEta(119)).toBe('about 2 min left');
        expect(formatEta(3599)).toBe('about 1 h left');
        expect(formatEta(2 * 3600 + 5 * 60)).toBe('about 2 h 5 min left');
        expect(formatEta(2 * 3600 + 59.8 * 60)).toBe('about 3 h left');
    });
});

test('formatUptime', () => {
    expect(formatUptime(0)).toBe('00:00');
    expect(formatUptime(309)).toBe('05:09');
    expect(formatUptime(3723)).toBe('1:02:03');
    expect(formatUptime(-3)).toBe('00:00');
});

test('formatAgo', () => {
    expect(formatAgo(45)).toBe('45 s');
    expect(formatAgo(180)).toBe('3 min');
    expect(formatAgo(7300)).toBe('2 h');
    expect(formatAgo(86400)).toBe('1 day');
    expect(formatAgo(3 * 86400)).toBe('3 days');
});

describe('formatWhen', () => {
    const now = new Date(2026, 9, 14, 20, 0).getTime();

    test('today and yesterday', () => {
        expect(formatWhen(new Date(2026, 9, 14, 18, 5).toISOString(), now)).toBe('today at 18:05');
        expect(formatWhen(new Date(2026, 9, 13, 21, 40).toISOString(), now)).toBe('yesterday at 21:40');
    });

    test('older dates, with the year only when it differs', () => {
        expect(formatWhen(new Date(2026, 9, 3, 9, 15).toISOString(), now)).toBe('on 3 Oct at 09:15');
        expect(formatWhen(new Date(2025, 0, 2, 9, 15).toISOString(), now)).toBe('on 2 Jan 2025 at 09:15');
    });

    test('missing or broken times', () => {
        expect(formatWhen(null, now)).toBe('at an unknown time');
        expect(formatWhen('not a date', now)).toBe('at an unknown time');
    });
});

test('counts and plurals', () => {
    expect(formatCount(1204)).toBe('1,204');
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(2310, 'file')).toBe('2,310 files');
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
});

test('listNames', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['a'])).toBe('a');
    expect(listNames(['a', 'b'])).toBe('a and b');
    expect(listNames(['server.properties', 'ops.json', 'world/data/raids.dat'])).toBe('server.properties, ops.json and world/data/raids.dat');
    expect(listNames(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
});
