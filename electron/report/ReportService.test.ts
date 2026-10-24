import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppError } from '../errors';
import { REPORTS_FOLDER, ReportService } from './ReportService';

const STEVE = { name: 'Steve', email: 'steve@example.com', picture: '' };

function setup(opts: { inbox?: string; folders?: Array<{ id: string }> } = {}) {
    const drive = {
        findFolders: vi.fn(async () => opts.folders ?? []),
        createFolder: vi.fn(async () => ({ id: 'reports', name: REPORTS_FOLDER, mimeType: 'folder' })),
        createFile: vi.fn(async () => ({ id: 'file1', md5Checksum: '', size: 0 })),
        addPermission: vi.fn(async () => ({ id: 'p1', emailAddress: 'inbox@example.com', displayName: '', role: 'reader' })),
    };
    const save = vi.fn(async (): Promise<string | null> => null);
    const reports = new ReportService({
        log: { tail: () => '2026-10-24T18:00:00.000Z INFO  [session] started\n' },
        drive: drive as never,
        me: vi.fn(async () => STEVE),
        about: () => ['MCS-Relay 1.0.1', 'Session: idle'],
        chooseSaveFile: save,
        inbox: opts.inbox ?? 'inbox@example.com',
        now: () => new Date(2026, 9, 24, 18, 5, 9),
    });
    return { reports, drive, save };
}

let tmp: string | null = null;
afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
});

describe('ReportService', () => {
    test('a report holds the description, the PC and, when asked, the log', () => {
        const { reports } = setup();
        const text = reports.compose('  The upload stopped at 40%.  ', true, STEVE);
        expect(text).toContain('From: Steve <steve@example.com>');
        expect(text).toContain('What happened\n-------------\nThe upload stopped at 40%.\n');
        expect(text).toContain('MCS-Relay 1.0.1\nSession: idle');
        expect(text).toContain('[session] started');
        expect(reports.compose('x', false, null)).not.toContain('App log');
        expect(reports.compose('x', false, null)).toContain('From: not signed in');
    });

    test('sending saves the file in the reports folder and shares it with the inbox', async () => {
        const { reports, drive } = setup();
        await reports.send('It crashed when I pressed Stop.', true);
        expect(drive.createFolder).toHaveBeenCalledWith(REPORTS_FOLDER, 'root');
        expect(drive.createFile).toHaveBeenCalledWith('MCS-Relay problem report 2026-10-24 18-05-09.txt', 'reports', expect.objectContaining({ kind: 'bytes' }));
        expect(drive.addPermission).toHaveBeenCalledWith('file1', 'inbox@example.com', 'reader', expect.stringContaining('It crashed when I pressed Stop.'));
    });

    test('an existing reports folder is used, and a long description is cut short in the email only', async () => {
        const { reports, drive } = setup({ folders: [{ id: 'old' }] });
        await reports.send('a'.repeat(2000), false);
        expect(drive.createFolder).not.toHaveBeenCalled();
        expect((drive.createFile.mock.calls[0] as unknown[])[1]).toBe('old');
        const message = (drive.addPermission.mock.calls[0] as unknown[])[3] as string;
        expect(message.length).toBeLessThan(1000);
    });

    test('without an inbox nothing is sent', async () => {
        const { reports, drive } = setup({ inbox: '' });
        await expect(reports.send('x', true)).rejects.toBeInstanceOf(AppError);
        expect(drive.createFile).not.toHaveBeenCalled();
    });

    test('saving writes the report where the user chose, or nothing when cancelled', async () => {
        const { reports, save } = setup();
        expect(await reports.save('x', true)).toBeNull();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-report-'));
        const target = path.join(tmp, 'report.txt');
        save.mockResolvedValueOnce(target);
        expect(await reports.save('Java was not found.', false)).toBe(target);
        expect(fs.readFileSync(target, 'utf8')).toContain('Java was not found.');
    });
});
