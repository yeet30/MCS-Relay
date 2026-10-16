import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeBatch } from '../../shared/types';
import { compileRules } from '../../shared/paths';
import { ChangeTracker } from './changeTracker';

let root: string;
let batches: ChangeBatch[];
let resets: number;
let tracker: ChangeTracker;

async function until(check: () => boolean, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'mdh-changes-'));
    batches = [];
    resets = 0;
    tracker = new ChangeTracker({ emit: (b) => batches.push(b), reset: () => (resets += 1), flushMs: 50 });
});

afterEach(async () => {
    await tracker.stop();
    await rm(root, { recursive: true, force: true });
});

describe('ChangeTracker', () => {
    it('reports new and changed files, ignores what the rules ignore, and does not report the initial scan', async () => {
        await writeFile(path.join(root, 'existing.txt'), 'x');
        await tracker.start(root, compileRules(['logs/']));
        await mkdir(path.join(root, 'world'));
        await writeFile(path.join(root, 'world', 'level.dat'), 'a');
        await mkdir(path.join(root, 'logs'));
        await writeFile(path.join(root, 'logs', 'latest.log'), 'x');
        await writeFile(path.join(root, 'existing.txt'), 'changed');
        await until(() => tracker.all().length === 2);
        await tracker.stop();
        expect(new Map(tracker.all())).toEqual(new Map([['world/level.dat', 'added'], ['existing.txt', 'changed']]));
        expect(batches.flat().some(([p]) => p.startsWith('logs/'))).toBe(false);
    }, 20000);

    it('keeps the map after stop and empties it on clear', async () => {
        await tracker.start(root, () => false);
        await writeFile(path.join(root, 'a.txt'), 'a');
        await until(() => tracker.all().length === 1);
        await tracker.stop();
        expect(tracker.all()).toEqual([['a.txt', 'added']]);
        tracker.clear();
        expect(tracker.all()).toEqual([]);
        expect(resets).toBe(1);
    }, 20000);
});
