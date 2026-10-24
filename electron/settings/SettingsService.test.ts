import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_JAVA_FLAGS, TERMS_VERSION } from '../../shared/types';
import type { AppSettings } from '../../shared/types';
import { AppError } from '../errors';
import { AppData } from '../store/appData';
import { SettingsService } from './SettingsService';
import type { Dialogs } from './SettingsService';

let root: string;
let appData: AppData;
let dialogs: { [K in keyof Dialogs]: ReturnType<typeof vi.fn> } & Dialogs;
let settings: SettingsService;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-settings-'));
    appData = new AppData(path.join(root, 'userData'));
    dialogs = {
        chooseFolder: vi.fn(async () => null),
        chooseFile: vi.fn(async () => null),
        openPath: vi.fn(async () => undefined),
    };
    settings = new SettingsService({ appData, dialogs, platform: 'win32' });
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function expectInvalid(run: () => unknown): void {
    try {
        run();
    } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID');
        return;
    }
    throw new Error('expected an INVALID AppError');
}

describe('app settings', () => {
    test('set merges, persists and returns the new settings', () => {
        const playit = path.join(root, 'playit.exe');
        const result = settings.set({ usePlayitgg: true, playitggPath: ` ${playit} `, selectedServerId: 'srv1' });
        expect(result).toMatchObject({ usePlayitgg: true, playitggPath: playit, selectedServerId: 'srv1', launchServer: true });
        expect(new SettingsService({ appData, dialogs }).get()).toEqual(result);
        expect(settings.set({ selectedServerId: null }).selectedServerId).toBeNull();
    });

    test('rejects values of the wrong type', () => {
        expectInvalid(() => settings.set({ usePlayitgg: 'yes' as unknown as boolean }));
        expectInvalid(() => settings.set({ launchServer: 1 as unknown as boolean }));
        expectInvalid(() => settings.set({ playitggPath: 'relative/playit.exe' }));
        expectInvalid(() => settings.set({ selectedServerId: '../x' }));
        expectInvalid(() => settings.set(null as unknown as Partial<AppSettings>));
        expect(settings.get().usePlayitgg).toBe(false);
    });

    test('the theme starts light, keeps a valid choice and refuses unknown ones', () => {
        expect(settings.get().theme).toBe('light');
        expect(settings.set({ theme: 'mint' }).theme).toBe('mint');
        expect(new SettingsService({ appData, dialogs, platform: 'win32' }).get().theme).toBe('mint');
        expectInvalid(() => settings.set({ theme: 'neon' as unknown as AppSettings['theme'] }));
    });

    test('the terms start unagreed and only a version that exists can be agreed to', () => {
        expect(settings.get().termsAccepted).toBe(0);
        expect(settings.set({ termsAccepted: TERMS_VERSION }).termsAccepted).toBe(TERMS_VERSION);
        expectInvalid(() => settings.set({ termsAccepted: TERMS_VERSION + 1 }));
        expectInvalid(() => settings.set({ termsAccepted: -1 }));
        expectInvalid(() => settings.set({ termsAccepted: true as unknown as number }));
        expect(settings.get().termsAccepted).toBe(TERMS_VERSION);
    });

    test('joinedServerIds cannot be replaced through set', () => {
        settings.addJoined('a');
        settings.set({ joinedServerIds: [] } as unknown as Partial<AppSettings>);
        expect(settings.get().joinedServerIds).toEqual(['a']);
    });

    test('addJoined and removeJoined keep the list unique', () => {
        settings.addJoined('a');
        settings.addJoined('b');
        settings.addJoined('a');
        expect(settings.get().joinedServerIds).toEqual(['a', 'b']);
        settings.removeJoined('a');
        settings.removeJoined('missing');
        expect(settings.get().joinedServerIds).toEqual(['b']);
        expectInvalid(() => settings.addJoined('a/b'));
    });
});

describe('server settings', () => {
    test('defaults, then a valid change', () => {
        expect(settings.getServer('s1')).toEqual({ localPath: null, javaFlags: DEFAULT_JAVA_FLAGS });
        const updated = settings.setServer('s1', { javaFlags: { minRAM: 1024, maxRAM: 8192, customFlags: ' -XX:+UseG1GC ' } });
        expect(updated.javaFlags).toEqual({ minRAM: 1024, maxRAM: 8192, customFlags: '-XX:+UseG1GC' });
        expect(settings.getServer('s1')).toEqual(updated);
    });

    test('a partial javaFlags patch keeps the other fields', () => {
        settings.setServer('s1', { javaFlags: { minRAM: 1024, maxRAM: 8192, customFlags: '-Dx=1' } });
        expect(settings.setServer('s1', { javaFlags: { maxRAM: 4096 } }).javaFlags).toEqual({ minRAM: 1024, maxRAM: 4096, customFlags: '-Dx=1' });
    });

    test('memory must be whole MB in range with min <= max', () => {
        expectInvalid(() => settings.setServer('s1', { javaFlags: { minRAM: 4096, maxRAM: 2048 } }));
        expectInvalid(() => settings.setServer('s1', { javaFlags: { minRAM: 128 } }));
        expectInvalid(() => settings.setServer('s1', { javaFlags: { maxRAM: 70000 } }));
        expectInvalid(() => settings.setServer('s1', { javaFlags: { maxRAM: 4096.5 } }));
        expectInvalid(() => settings.setServer('s1', { javaFlags: { maxRAM: '4096' as unknown as number } }));
        expectInvalid(() => settings.setServer('s1', { javaFlags: { customFlags: '-Xss1M\n-Dbad' } }));
        expect(settings.getServer('s1').javaFlags).toEqual(DEFAULT_JAVA_FLAGS);
    });

    test('the boundaries are allowed', () => {
        expect(settings.setServer('s1', { javaFlags: { minRAM: 256, maxRAM: 65536 } }).javaFlags).toMatchObject({ minRAM: 256, maxRAM: 65536 });
    });

    test('setServer does not touch the local path', () => {
        const folder = path.join(root, 'mc');
        settings.setLocalPath('s1', folder);
        settings.setServer('s1', { localPath: null, javaFlags: { minRAM: 512 } } as unknown as Parameters<SettingsService['setServer']>[1]);
        expect(settings.getServer('s1').localPath).toBe(folder);
    });

    test('a Java program is stored, cleared again, and never taken from the server folder', () => {
        const folder = path.join(root, 'mc');
        settings.setLocalPath('s1', folder);
        const java = path.join(root, 'jdk-21', 'bin', 'java.exe');
        expect(settings.setServer('s1', { javaPath: java }).javaPath).toBe(java);
        expect(settings.getServer('s1').javaFlags).toEqual(DEFAULT_JAVA_FLAGS);
        expect(settings.setServer('s1', { javaPath: null })).toEqual({ localPath: folder, javaFlags: DEFAULT_JAVA_FLAGS });
        expectInvalid(() => settings.setServer('s1', { javaPath: path.join(folder, 'jre', 'bin', 'java.exe') }));
        expectInvalid(() => settings.setServer('s1', { javaPath: path.join(root, 'tools', 'evil.exe') }));
        expectInvalid(() => settings.setServer('s1', { javaPath: 'java.exe' }));
    });
});

describe('local paths', () => {
    test('stores an absolute path and clears it', () => {
        const folder = path.join(root, 'mc');
        settings.setLocalPath('s1', folder);
        expect(settings.getServer('s1').localPath).toBe(folder);
        settings.setLocalPath('s1', null);
        expect(settings.getServer('s1').localPath).toBeNull();
    });

    test('rejects relative paths', () => {
        expectInvalid(() => settings.setLocalPath('s1', 'mc'));
        expectInvalid(() => settings.setLocalPath('s1', '   '));
    });

    test('two servers cannot share a folder or nest inside each other', () => {
        const a = path.join(root, 'servers', 'A');
        settings.setLocalPath('s1', a);
        expectInvalid(() => settings.setLocalPath('s2', a));
        expectInvalid(() => settings.setLocalPath('s2', a.toUpperCase()));         // win32: case-insensitive
        expectInvalid(() => settings.setLocalPath('s2', path.join(a, 'world')));
        expectInvalid(() => settings.setLocalPath('s2', path.join(root, 'servers')));
        settings.setLocalPath('s2', path.join(root, 'servers', 'A2'));
        settings.setLocalPath('s1', path.join(a, 'sub'));                          // moving its own folder is fine
        expect(settings.getServer('s2').localPath).toBe(path.join(root, 'servers', 'A2'));
    });
});

describe('playit.gg path', () => {
    test('picks the program without storing it (the Scripts panel saves it)', async () => {
        const exe = path.join(root, 'playit.exe');
        dialogs.chooseFile.mockResolvedValueOnce(exe);
        await expect(settings.pickPlayitPath()).resolves.toBe(exe);
        expect(settings.get().playitggPath).toBe('');
        expect(dialogs.chooseFile).toHaveBeenCalledWith('Choose the playit.gg program', [{ name: 'Programs', extensions: ['exe'] }]);
    });

    test('cancel picks nothing', async () => {
        await expect(settings.pickPlayitPath()).resolves.toBeNull();
        expect(settings.get().playitggPath).toBe('');
    });

    test('no extension filter outside Windows', async () => {
        const linux = new SettingsService({ appData, dialogs, platform: 'linux' });
        await linux.pickPlayitPath();
        expect(dialogs.chooseFile).toHaveBeenCalledWith('Choose the playit.gg program', undefined);
    });
});
