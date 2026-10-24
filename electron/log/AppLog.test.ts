import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AppLog, LOG_FILE, OLD_LOG_FILE, redact } from './AppLog';

let folder: string;

beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-log-'));
});

afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
});

const read = (name: string) => fs.readFileSync(path.join(folder, name), 'utf8');

describe('AppLog', () => {
    test('writes timestamped lines and indents the rest of a multi-line message', () => {
        const log = new AppLog(folder, () => new Date('2026-10-24T18:00:00Z'));
        log.write('info', 'hello');
        log.write('error', 'Error: boom\n    at here');
        expect(read(LOG_FILE)).toBe('2026-10-24T18:00:00.000Z INFO  hello\n2026-10-24T18:00:00.000Z ERROR Error: boom\n        at here\n');
    });

    test('starts mcs-relay.old.log when the file gets too big, and tail reads across both', () => {
        const log = new AppLog(folder, () => new Date('2026-10-24T18:00:00Z'), 200);
        for (let i = 0; i < 6; i++) log.write('info', `line ${i} ${'x'.repeat(40)}`);
        expect(fs.existsSync(path.join(folder, OLD_LOG_FILE))).toBe(true);
        const all = log.tail(10_000);
        expect(all.indexOf('line 0')).toBeLessThan(all.indexOf('line 5'));
        const end = log.tail(120);
        expect(end).toContain('line 5');
        expect(end).not.toContain('line 0');
        expect(end.startsWith('2026-')).toBe(true);           // whole lines only
    });

    test('copies console output into the log without swallowing it', () => {
        const log = new AppLog(folder);
        const original = vi.fn();
        const fake = { log: original, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        log.captureConsole(fake);
        fake.warn('[sync] %d files', 3, { a: 1 });
        expect(fake.warn).not.toBe(original);
        expect(read(LOG_FILE)).toContain('WARN  [sync] 3 files { a: 1 }');
    });

    test('hides sign-in secrets', () => {
        expect(redact('Authorization: Bearer ya29.a0Abc-123_x')).toBe('Authorization: Bearer [hidden]');
        expect(redact('token ya29.a0Abc-123_x expired')).toBe('token ya29.[hidden] expired');
        expect(redact('{"refresh_token":"1//0gAbcdefghijklmnopqrstuv","x":1}')).toBe('{"refresh_token":"[hidden]","x":1}');
        expect(redact('http://127.0.0.1:5000/?code=4/0AbcDef&scope=x')).toBe('http://127.0.0.1:5000/?code=[hidden]&scope=x');
        expect(redact('GOCSPX-abc_DEF-123')).toBe('GOCSPX-[hidden]');
    });
});
