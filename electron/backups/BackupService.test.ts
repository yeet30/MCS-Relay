import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { APP_PROPS } from '../../shared/types';
import type { BackupProgress } from '../../shared/types';
import { AppError } from '../errors';
import { BACKUPS_FOLDER, BackupService, cleanBackupName, findWorlds, parseBackupFileName } from './BackupService';

let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-backups-'));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

const read = (rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(root, ...rel.split('/')));

function setup(opts: { busy?: boolean; unfinished?: boolean } = {}) {
    let clock = new Date(2026, 9, 24, 18, 30, 5);
    const cloud: Array<{ id: string; name: string; size: number; md5Checksum: string; content: Buffer; appProperties: Record<string, string> }> = [];
    const drive = {
        listChildren: vi.fn(async (_folder: string, filter?: { name?: string }) => cloud
            .filter((f) => !filter?.name || f.name === filter.name)
            .map((f) => ({
                id: f.id, name: f.name, mimeType: 'application/zip', size: f.size, md5Checksum: f.md5Checksum,
                appProperties: f.appProperties, owners: [{ emailAddress: 'alex@example.com', displayName: 'Alex' }],
                capabilities: { canTrash: false },
            }))),
        createFile: vi.fn(async (name: string, _parent: string, source: { kind: string; path?: string }, _opts: unknown, appProperties: Record<string, string>) => {
            const content = fs.readFileSync(source.path ?? '');
            cloud.push({ id: `c${cloud.length + 1}`, name, size: content.length, md5Checksum: createHash('md5').update(content).digest('hex'), content, appProperties });
            return { id: `c${cloud.length}`, md5Checksum: '', size: content.length };
        }),
        download: vi.fn(async (id: string, dest: string) => {
            const file = cloud.find((f) => f.id === id)!;
            fs.writeFileSync(dest, file.content);
            return { md5: createHash('md5').update(file.content).digest('hex'), size: file.content.length };
        }),
        trash: vi.fn(async () => undefined),
    };
    const resume = vi.fn();
    const session = {
        pauseSavingFor: vi.fn(async (): Promise<(() => void) | null> => null),
        isBusy: vi.fn(() => opts.busy ?? false),
    };
    const progress: Array<BackupProgress | null> = [];
    const backups = new BackupService({
        settings: { getServer: () => ({ localPath: root, javaFlags: { minRAM: 1024, maxRAM: 2048, customFlags: '' } }) },
        drive: drive as never,
        launcher: { findSubfolder: vi.fn(async () => 'backups-folder'), ensureSubfolder: vi.fn(async () => 'backups-folder') },
        session,
        hasUnfinishedUpload: () => opts.unfinished ?? false,
        me: async () => ({ name: 'Steve', email: 'steve@example.com', picture: '' }),
        emit: (p) => progress.push(p),
        appVersion: '1.0.1',
        now: () => clock,
    });
    const later = (seconds: number) => {
        clock = new Date(clock.getTime() + seconds * 1000);
    };
    return { backups, drive, session, resume, progress, cloud, later };
}

describe('names and worlds', () => {
    test('names keep what Windows allows, and file names give the name and time back', () => {
        expect(cleanBackupName('  Before the end: fight?  ')).toBe('Before the end- fight-');
        expect(cleanBackupName('...')).toBe('Backup');
        expect(cleanBackupName('x'.repeat(100))).toHaveLength(40);
        expect(parseBackupFileName('2026-10-24_18-30-05 Before the end fight.zip')).toEqual({
            name: 'Before the end fight', createdAt: new Date(2026, 9, 24, 18, 30, 5),
        });
        expect(parseBackupFileName('notes.zip')).toBeNull();
        expect(parseBackupFileName('2026-10-24_18-30-05 a/../b.zip')).toBeNull();
    });

    test('the worlds follow level-name and include the Nether and End folders that exist', async () => {
        put('world/level.dat', 'w');
        expect(await findWorlds(root)).toEqual(['world']);
        put('server.properties', 'motd=x\r\nlevel-name=Survival\r\n');
        put('Survival/level.dat', 's');
        put('Survival_nether/DIM-1/region/r.0.0.mca', 'n');
        expect(await findWorlds(root)).toEqual(['Survival', 'Survival_nether']);
    });
});

describe('BackupService', () => {
    test('a backup zips the world, leaves session.lock out and shows up in the list', async () => {
        const { backups, progress } = setup();
        put('world/level.dat', 'level');
        put('world/region/r.0.0.mca', 'region');
        put('world/session.lock', 'locked');
        put('server.jar', 'not part of a backup');
        const info = await backups.create('srv', 'Before the end fight', false);
        expect(info).toMatchObject({ fileName: '2026-10-24_18-30-05 Before the end fight.zip', name: 'Before the end fight', local: true, cloud: null });
        expect(exists(`${BACKUPS_FOLDER}/${info.fileName}`)).toBe(true);
        expect(progress.at(-1)).toBeNull();
        const list = await backups.list('srv');
        expect(list.backups.map((b) => b.fileName)).toEqual([info.fileName]);
        expect(list.cloudError).toBeNull();
    });

    test('a server running on this PC holds its saves during the backup', async () => {
        const { backups, session } = setup();
        put('world/level.dat', 'level');
        const resume = vi.fn();
        session.pauseSavingFor.mockResolvedValueOnce(resume);
        await backups.create('srv', 'x', false);
        expect(session.pauseSavingFor).toHaveBeenCalledWith('srv');
        expect(resume).toHaveBeenCalledTimes(1);
    });

    test('restoring brings the world back as it was, after backing up the current one', async () => {
        const { backups, later } = setup();
        put('world/level.dat', 'old level');
        put('world/region/r.0.0.mca', 'old region');
        const backup = await backups.create('srv', 'Old', false);
        later(60);
        put('world/level.dat', 'new level');
        put('world/region/r.5.5.mca', 'new chunks');
        await backups.restore('srv', backup.fileName);
        expect(read('world/level.dat')).toBe('old level');
        expect(read('world/region/r.0.0.mca')).toBe('old region');
        expect(exists('world/region/r.5.5.mca')).toBe(false);
        const names = (await backups.list('srv')).backups.map((b) => b.name);
        expect(names).toEqual(['Before restoring Old', 'Old']);
    });

    test('restoring waits for the server to stop and for an unfinished upload', async () => {
        put('world/level.dat', 'level');
        const made = await setup().backups.create('srv', 'x', false);
        const busy = await setup({ busy: true }).backups.restore('srv', made.fileName).catch((e: unknown) => e);
        expect((busy as AppError).code).toBe('BUSY');
        const unfinished = await setup({ unfinished: true }).backups.restore('srv', made.fileName).catch((e: unknown) => e);
        expect((unfinished as AppError).code).toBe('UNFINISHED_UPLOAD');
        expect(read('world/level.dat')).toBe('level');
    });

    test('a file that is not a backup is not restored', async () => {
        const { backups } = setup();
        put(`${BACKUPS_FOLDER}/2026-10-24_18-30-05 Fake.zip`, 'not a zip');
        const err = await backups.restore('srv', '2026-10-24_18-30-05 Fake.zip').catch((e: unknown) => e);
        expect((err as AppError).code).toBe('INVALID');
        const outside = await backups.restore('srv', '../server.jar').catch((e: unknown) => e);
        expect((outside as AppError).code).toBe('INVALID');
    });

    test('uploading puts the backup in the cloud once, and the list shows it in both places', async () => {
        const { backups, drive, cloud } = setup();
        put('world/level.dat', 'level');
        const info = await backups.create('srv', 'Shared', true);
        expect(info.cloud).toMatchObject({ id: 'c1', by: 'you' });
        expect(cloud[0].appProperties[APP_PROPS.backupAt]).toBe(info.createdAt);
        await backups.upload('srv', info.fileName);
        expect(drive.createFile).toHaveBeenCalledTimes(1);
        const [listed] = (await backups.list('srv')).backups;
        expect(listed).toMatchObject({ local: true, cloud: { id: 'c1', by: 'Alex', canDelete: false } });
    });

    test('a cloud backup downloads next to the others and can then be restored', async () => {
        const { backups, cloud } = setup();
        put('world/level.dat', 'from the cloud');
        const info = await backups.create('srv', 'Shared', true);
        fs.rmSync(path.join(root, BACKUPS_FOLDER), { recursive: true });
        put('world/level.dat', 'changed');
        expect((await backups.list('srv')).backups[0]).toMatchObject({ local: false, cloud: { id: 'c1' } });
        await backups.download('srv', cloud[0].id);
        expect((await backups.list('srv')).backups[0]).toMatchObject({ fileName: info.fileName, local: true });
        await backups.restore('srv', info.fileName);
        expect(read('world/level.dat')).toBe('from the cloud');
    });

    test('a cloud listing that fails still lists the backups on this PC', async () => {
        const { backups, drive } = setup();
        put('world/level.dat', 'level');
        await backups.create('srv', 'x', false);
        drive.listChildren.mockRejectedValueOnce(new AppError('NETWORK', 'No connection.'));
        const list = await backups.list('srv');
        expect(list.backups).toHaveLength(1);
        expect(list.cloudError).toBe('No connection.');
    });

    test('a second backup with the same name in the same second gets its own file', async () => {
        const { backups } = setup();
        put('world/level.dat', 'level');
        const first = await backups.create('srv', 'Same', false);
        const second = await backups.create('srv', 'Same', false);
        expect(second.fileName).not.toBe(first.fileName);
        expect(second.name).toBe('Same (2)');
        expect((await backups.list('srv')).backups).toHaveLength(2);
    });

    test('one backup task at a time', async () => {
        const { backups } = setup();
        put('world/level.dat', 'level');
        const first = backups.create('srv', 'a', false);
        const second = await backups.create('srv', 'b', false).catch((e: unknown) => e);
        expect((second as AppError).code).toBe('BUSY');
        await first;
        expect(backups.isBusy()).toBe(false);
    });

    test('there is nothing to back up before the server made a world', async () => {
        const err = await setup().backups.create('srv', 'x', false).catch((e: unknown) => e);
        expect((err as AppError).code).toBe('INVALID');
    });
});

describe('the automatic backup', () => {
    const auto = (rel: string) => path.join(root, BACKUPS_FOLDER, 'auto', ...rel.split('/'));

    test('an unchanged file is not copied again', async () => {
        const { backups } = setup();
        put('world/level.dat', 'same');
        await backups.autoBackup('srv');
        fs.writeFileSync(auto('world/level.dat'), 'xxxx');        // same size, and the time is set back below
        const t = fs.statSync(path.join(root, 'world', 'level.dat')).mtime;
        fs.utimesSync(auto('world/level.dat'), t, t);
        await backups.autoBackup('srv');
        expect(fs.readFileSync(auto('world/level.dat'), 'utf8')).toBe('xxxx');
    });

    test('the first run copies the world, later runs only what changed, and gone files go', async () => {
        const { backups, session } = setup();
        put('world/level.dat', 'one');
        put('world/region/r.0.0.mca', 'region');
        put('world/session.lock', 'locked');
        await backups.autoBackup('srv');
        expect(fs.readFileSync(auto('world/level.dat'), 'utf8')).toBe('one');
        expect(fs.existsSync(auto('world/session.lock'))).toBe(false);
        expect(session.pauseSavingFor).toHaveBeenCalledWith('srv');

        put('world/level.dat', 'two!');
        put('world/region/r.1.1.mca', 'new');
        fs.rmSync(path.join(root, 'world', 'region', 'r.0.0.mca'));
        await backups.autoBackup('srv');
        expect(fs.readFileSync(auto('world/level.dat'), 'utf8')).toBe('two!');
        expect(fs.existsSync(auto('world/region/r.1.1.mca'))).toBe(true);
        expect(fs.existsSync(auto('world/region/r.0.0.mca'))).toBe(false);

        const list = await backups.list('srv');
        expect(list.auto?.size).toBe('two!'.length + 'new'.length);
        expect(list.backups).toEqual([]);              // the copy is not listed as a zip backup
    });

    test('restoring it brings the world back, after backing up the current one', async () => {
        const { backups } = setup();
        put('world/level.dat', 'saved');
        await backups.autoBackup('srv');
        put('world/level.dat', 'broken');
        put('world/region/r.9.9.mca', 'griefed');
        await backups.restoreAuto('srv');
        expect(read('world/level.dat')).toBe('saved');
        expect(exists('world/region/r.9.9.mca')).toBe(false);
        expect((await backups.list('srv')).backups.map((b) => b.name)).toEqual(['Before restoring the automatic backup']);
    });

    test('without one, there is nothing to restore', async () => {
        put('world/level.dat', 'x');
        const err = await setup().backups.restoreAuto('srv').catch((e: unknown) => e);
        expect((err as AppError).code).toBe('NOT_FOUND');
    });
});
