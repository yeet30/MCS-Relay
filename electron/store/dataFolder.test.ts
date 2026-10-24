import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_FOLDER, PREVIOUS_DATA_FOLDER, resolveDataFolder } from './dataFolder';

let appData: string;

beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-relay-appdata-'));
});

afterEach(() => {
    fs.rmSync(appData, { recursive: true, force: true });
});

describe('resolveDataFolder', () => {
    it('moves the folder of earlier builds, with everything in it, to mcs-relay once', () => {
        const previous = path.join(appData, PREVIOUS_DATA_FOLDER);
        fs.mkdirSync(path.join(previous, 'servers'), { recursive: true });
        fs.writeFileSync(path.join(previous, 'settings.json'), '{}');
        const folder = resolveDataFolder(appData);
        expect(folder).toBe(path.join(appData, DATA_FOLDER));
        expect(fs.existsSync(path.join(folder, 'settings.json'))).toBe(true);
        expect(fs.existsSync(path.join(folder, 'servers'))).toBe(true);
        expect(fs.existsSync(previous)).toBe(false);
    });

    it('uses mcs-relay as it is once it exists, and on a new PC', () => {
        expect(resolveDataFolder(appData)).toBe(path.join(appData, DATA_FOLDER));
        fs.mkdirSync(path.join(appData, DATA_FOLDER));
        fs.mkdirSync(path.join(appData, PREVIOUS_DATA_FOLDER));
        expect(resolveDataFolder(appData)).toBe(path.join(appData, DATA_FOLDER));
        expect(fs.existsSync(path.join(appData, PREVIOUS_DATA_FOLDER))).toBe(true);
    });

    it('keeps using the old folder when it cannot be moved yet', () => {
        const busy = {
            existsSync: (p: fs.PathLike) => String(p).endsWith(PREVIOUS_DATA_FOLDER),
            renameSync: () => {
                throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
            },
        };
        expect(resolveDataFolder(appData, busy)).toBe(path.join(appData, PREVIOUS_DATA_FOLDER));
    });
});
