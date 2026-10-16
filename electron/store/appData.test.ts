import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_JAVA_FLAGS } from '../../shared/types';
import type { BaseSnapshot } from '../../shared/types';
import { AppError } from '../errors';
import { AppData, DEFAULT_SETTINGS } from './appData';
import type { UploadJournal } from './appData';

let root: string;
let appData: AppData;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-appdata-'));
    appData = new AppData(root, () => new Date(2026, 9, 15, 13, 5, 9));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, content: string) => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
};
const exists = (rel: string) => fs.existsSync(path.join(root, ...rel.split('/')));

function base(serverId: string, revision = 3): BaseSnapshot {
    return {
        format: 2, serverId, revision,
        files: { 'world/level.dat': { size: 10, md5: 'abc', driveId: 'd1', mtimeMs: 1234.5 } },
        folders: { world: 'f1' },
    };
}

describe('app settings', () => {
    test('defaults when the file is missing', () => {
        expect(appData.readSettings()).toEqual(DEFAULT_SETTINGS);
    });

    test('round trip, atomic write leaves no tmp file', () => {
        const s = { ...DEFAULT_SETTINGS, selectedServerId: 'abc', playitggPath: 'C:/playit.exe', usePlayitgg: true, joinedServerIds: ['x1', 'x2'] };
        appData.writeSettings(s);
        expect(appData.readSettings()).toEqual(s);
        expect(exists('settings.json.tmp')).toBe(false);
    });

    test('corrupt JSON falls back to defaults and keeps a .corrupt copy', () => {
        write('settings.json', '{ "launchServer": fal');
        expect(appData.readSettings()).toEqual(DEFAULT_SETTINGS);
        expect(exists('settings.json.corrupt')).toBe(true);
        expect(fs.readFileSync(path.join(root, 'settings.json.corrupt'), 'utf8')).toBe('{ "launchServer": fal');
    });

    test('fields with the wrong type fall back one by one', () => {
        write('settings.json', JSON.stringify({ launchServer: false, usePlayitgg: 'yes', joinedServerIds: ['ok', 5, '../evil', 'ok'] }));
        expect(appData.readSettings()).toEqual({ ...DEFAULT_SETTINGS, launchServer: false, joinedServerIds: ['ok'] });
    });

    test('a UTF-8 BOM is tolerated', () => {
        write('settings.json', `\uFEFF${JSON.stringify({ launchServer: false })}`);
        expect(appData.readSettings().launchServer).toBe(false);
    });
});

describe('server files', () => {
    test('server settings default and round trip', () => {
        expect(appData.readServerSettings('s1')).toEqual({ localPath: null, javaFlags: DEFAULT_JAVA_FLAGS });
        appData.writeServerSettings('s1', { localPath: 'C:/mc', javaFlags: { minRAM: 1024, maxRAM: 8192, customFlags: '-XX:+UseG1GC' } });
        expect(appData.readServerSettings('s1')).toEqual({ localPath: 'C:/mc', javaFlags: { minRAM: 1024, maxRAM: 8192, customFlags: '-XX:+UseG1GC' } });
    });

    test('stored Java flags are clamped on read', () => {
        write('servers/s1/settings.json', JSON.stringify({ localPath: '', javaFlags: { minRAM: 9000, maxRAM: 100000.4 } }));
        expect(appData.readServerSettings('s1')).toEqual({ localPath: null, javaFlags: { minRAM: 9000, maxRAM: 65536, customFlags: '' } });
    });

    test('ids that could leave the servers folder are refused', () => {
        expect(() => appData.readServerSettings('../x')).toThrow(AppError);
        expect(() => appData.writeBase('a/b', base('a/b'))).toThrow(AppError);
        expect(() => appData.removeServer('..')).toThrow(AppError);
    });

    test('base round trip and validation', () => {
        expect(appData.readBase('s1')).toBeNull();
        appData.writeBase('s1', base('s1'));
        expect(appData.readBase('s1')).toEqual(base('s1'));
        expect(() => appData.writeBase('s2', base('s1'))).toThrow(AppError);
    });

    test('a base without folders gets an empty map', () => {
        const withoutFolders: Partial<BaseSnapshot> = base('s1');
        delete withoutFolders.folders;
        write('servers/s1/base.json', JSON.stringify(withoutFolders));
        expect(appData.readBase('s1')?.folders).toEqual({});
    });

    test('an invalid base is moved aside and treated as missing', () => {
        write('servers/s1/base.json', JSON.stringify({ ...base('s1'), files: { a: { size: 'big' } } }));
        expect(appData.readBase('s1')).toBeNull();
        expect(exists('servers/s1/base.json')).toBe(false);
        expect(exists('servers/s1/base.json.corrupt')).toBe(true);
    });

    test('a base for another server is not used', () => {
        write('servers/s1/base.json', JSON.stringify(base('s2')));
        expect(appData.readBase('s1')).toBeNull();
    });

    test('journal round trip, listing and delete', () => {
        const j: UploadJournal = { format: 1, serverId: 's1', startedAt: '2026-10-15T12:00:00.000Z', baseRevision: 4, sessionId: 'sess' };
        expect(appData.readJournal('s1')).toBeNull();
        appData.writeJournal('s1', j);
        appData.writeServerSettings('s2', { localPath: null, javaFlags: DEFAULT_JAVA_FLAGS });
        write('servers/s3/journal.json', '{broken');
        expect(appData.readJournal('s1')).toEqual(j);
        expect(appData.serversWithJournal()).toEqual(['s1']);
        appData.deleteJournal('s1');
        appData.deleteJournal('s1');
        expect(appData.serversWithJournal()).toEqual([]);
    });

    test('removeServer keeps backups', () => {
        appData.writeServerSettings('s1', { localPath: 'C:/mc', javaFlags: DEFAULT_JAVA_FLAGS });
        appData.writeBase('s1', base('s1'));
        const backup = appData.backupDir('s1', 'keep-cloud');
        fs.writeFileSync(path.join(backup, 'ops.json'), '[]');
        appData.removeServer('s1');
        expect(exists('servers/s1/settings.json')).toBe(false);
        expect(exists('servers/s1/base.json')).toBe(false);
        expect(fs.existsSync(path.join(backup, 'ops.json'))).toBe(true);
        expect(appData.readServerSettings('s1').localPath).toBeNull();
    });

    test('removeServer deletes the folder when there are no backups, and tolerates a missing one', () => {
        appData.writeBase('s1', base('s1'));
        appData.removeServer('s1');
        expect(exists('servers/s1')).toBe(false);
        expect(() => appData.removeServer('never-existed')).not.toThrow();
    });

    test('backupDir names folders by local time and label, never reusing one', () => {
        const first = appData.backupDir('s1', 'keep cloud!');
        const second = appData.backupDir('s1', 'keep cloud!');
        expect(path.basename(first)).toBe('2026-10-15_13-05-09-keep-cloud');
        expect(path.basename(second)).toBe('2026-10-15_13-05-09-keep-cloud-2');
        expect(fs.statSync(first).isDirectory()).toBe(true);
        expect(path.dirname(first)).toBe(path.join(root, 'servers', 's1', 'backups'));
    });
});

describe('legacy import', () => {
    const currentBranchStore = (localPath: string) => ({
        paths: { srvA: localPath, srvB: 'D:\\Games\\B' },
        joinedServerIds: ['srvB', 'srvC'],
        localVariables: {
            selectedIndex: 1,
            playitggPath: 'C:\\Tools\\playit.exe',
            watcherBlacklist: [
                'manifest.json', 'lock.json', 'world\\data\\DistantHorizons.sqlite', 'bluemap', 'world\\data\\DistantHorizons.sqlite',
                '  ', '../outside', `${localPath}\\config\\big.cfg`, 'Z:\\elsewhere\\file.txt',
            ],
            allocatedRAM: { MIN: 1024, MAX: 6144 },
            checklist: { download: true, upload: true, serverConsole: false, playitgg: true },
        },
    });

    test('imports the current branch format (allocatedRAM, watcherBlacklist)', () => {
        const local = path.join(root, 'mc-A');
        fs.mkdirSync(path.join(local, 'bluemap'), { recursive: true });
        write('localStore.json', JSON.stringify(currentBranchStore(local), null, 4));

        appData.migrateLegacy();

        expect(appData.readSettings()).toEqual({
            selectedServerId: null,
            playitggPath: 'C:\\Tools\\playit.exe',
            usePlayitgg: true,
            launchServer: false,
            joinedServerIds: ['srvB', 'srvC'],
        });
        const flags = { minRAM: 1024, maxRAM: 6144, customFlags: '' };
        expect(appData.readServerSettings('srvA')).toEqual({ localPath: local, javaFlags: flags });
        expect(appData.readServerSettings('srvB')).toEqual({ localPath: 'D:\\Games\\B', javaFlags: flags });
        expect(appData.readServerSettings('srvC')).toEqual({ localPath: null, javaFlags: flags });
        expect(exists('localStore.json')).toBe(false);
        expect(exists('localStore.migrated.json')).toBe(true);

        expect(appData.legacyBlacklist()).toEqual(['world/data/DistantHorizons.sqlite', 'bluemap/', 'config/big.cfg']);
    });

    test('imports the old main format (javaFlags with custom flags)', () => {
        write('localStore.json', JSON.stringify({
            paths: { srvA: 'C:\\mc' },
            joinedServerIds: [],
            localVariables: {
                selectedIndex: 0,
                playitggPath: '',
                javaFlags: { minRAM: 3072, maxRAM: 2048, customFlags: ' -XX:+UseG1GC ' },
                checklist: { download: true, upload: true, serverConsole: true, playitgg: true },
            },
        }));
        appData.migrateLegacy();
        // playit.gg was "on" without a path in the old defaults, which blocked every start (F41).
        expect(appData.readSettings()).toMatchObject({ usePlayitgg: false, launchServer: true, playitggPath: '' });
        expect(appData.readServerSettings('srvA')).toEqual({ localPath: 'C:\\mc', javaFlags: { minRAM: 2048, maxRAM: 2048, customFlags: '-XX:+UseG1GC' } });
        expect(appData.legacyBlacklist()).toEqual([]);
    });

    test('runs once and merges with existing settings', () => {
        appData.writeSettings({ ...DEFAULT_SETTINGS, joinedServerIds: ['srvZ'] });
        write('localStore.json', JSON.stringify(currentBranchStore('C:\\mc')));
        appData.migrateLegacy();
        appData.writeSettings({ ...appData.readSettings(), launchServer: true });
        appData.migrateLegacy();
        expect(appData.readSettings()).toMatchObject({ launchServer: true, joinedServerIds: ['srvZ', 'srvB', 'srvC'] });
    });

    test('nothing to do without a legacy file', () => {
        appData.migrateLegacy();
        expect(exists('settings.json')).toBe(false);
        expect(appData.legacyBlacklist()).toEqual([]);
    });

    test('a corrupt legacy file is moved aside', () => {
        write('localStore.json', '{"paths": ');
        appData.migrateLegacy();
        expect(exists('localStore.json')).toBe(false);
        expect(exists('localStore.json.corrupt')).toBe(true);
        expect(appData.readSettings()).toEqual(DEFAULT_SETTINGS);
    });

    test('the blacklist is readable before the migration ran', () => {
        write('localStore.json', JSON.stringify({ localVariables: { watcherBlacklist: ['logs/', 'cache\\'] } }));
        expect(appData.legacyBlacklist()).toEqual(['logs/', 'cache/']);
    });
});
