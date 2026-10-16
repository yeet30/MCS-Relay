import { describe, expect, it } from 'vitest';
import type { Snapshot, SyncPlan } from '../../shared/types';
import {
    allowedChoices, deriveStatus, emptyPlan, planMirrorRemote, planSync, planUpload, sumBytes,
} from './planner';

/** { path: md5 } -> Snapshot; size is the md5's length so sumBytes has something to add. */
function snap(files: Record<string, string>): Snapshot {
    return new Map(Object.entries(files).map(([path, md5]) => [path, { md5, size: md5.length, mtimeMs: 0 }]));
}

function plan(patch: Partial<SyncPlan>): SyncPlan {
    return { ...emptyPlan(), ...patch };
}

describe('planSync: the decision table', () => {
    it('same / same -> nothing to do', () => {
        const base = snap({ 'level.dat': 'a' });
        expect(planSync(base, snap({ 'level.dat': 'a' }), snap({ 'level.dat': 'a' }))).toEqual(emptyPlan());
    });

    it('changed locally / same -> upload', () => {
        const base = snap({ 'level.dat': 'a' });
        expect(planSync(base, snap({ 'level.dat': 'b' }), snap({ 'level.dat': 'a' }))).toEqual(plan({ upload: ['level.dat'] }));
    });

    it('added locally / absent in cloud -> upload', () => {
        expect(planSync(snap({}), snap({ 'new.txt': 'n' }), snap({}))).toEqual(plan({ upload: ['new.txt'] }));
    });

    it('deleted locally / same -> delete in the cloud', () => {
        const base = snap({ 'old.txt': 'a' });
        expect(planSync(base, snap({}), snap({ 'old.txt': 'a' }))).toEqual(plan({ deleteRemote: ['old.txt'] }));
    });

    it('same / changed in the cloud -> download', () => {
        const base = snap({ 'level.dat': 'a' });
        expect(planSync(base, snap({ 'level.dat': 'a' }), snap({ 'level.dat': 'b' }))).toEqual(plan({ download: ['level.dat'] }));
    });

    it('absent locally / added in the cloud -> download', () => {
        expect(planSync(snap({}), snap({}), snap({ 'new.txt': 'n' }))).toEqual(plan({ download: ['new.txt'] }));
    });

    it('same / deleted in the cloud -> delete locally', () => {
        const base = snap({ 'old.txt': 'a' });
        expect(planSync(base, snap({ 'old.txt': 'a' }), snap({}))).toEqual(plan({ deleteLocal: ['old.txt'] }));
    });

    it('changed / changed to the same bytes -> nothing to do', () => {
        const base = snap({ 'ops.json': 'a' });
        expect(planSync(base, snap({ 'ops.json': 'b' }), snap({ 'ops.json': 'b' }))).toEqual(emptyPlan());
    });

    it('added on both sides with the same bytes -> nothing to do', () => {
        expect(planSync(snap({}), snap({ 'x': 'same' }), snap({ 'x': 'same' }))).toEqual(emptyPlan());
    });

    it('deleted on both sides -> nothing to do', () => {
        expect(planSync(snap({ 'x': 'a' }), snap({}), snap({}))).toEqual(emptyPlan());
    });

    it('changed / changed differently -> conflict', () => {
        const base = snap({ 'ops.json': 'a' });
        expect(planSync(base, snap({ 'ops.json': 'b' }), snap({ 'ops.json': 'c' }))).toEqual(plan({ conflicts: ['ops.json'] }));
    });

    it('added on both sides with different bytes -> conflict', () => {
        expect(planSync(snap({}), snap({ 'x': 'l' }), snap({ 'x': 'r' }))).toEqual(plan({ conflicts: ['x'] }));
    });

    it('changed locally / deleted in the cloud -> conflict', () => {
        expect(planSync(snap({ 'x': 'a' }), snap({ 'x': 'b' }), snap({}))).toEqual(plan({ conflicts: ['x'] }));
    });

    it('deleted locally / changed in the cloud -> conflict', () => {
        expect(planSync(snap({ 'x': 'a' }), snap({}), snap({ 'x': 'c' }))).toEqual(plan({ conflicts: ['x'] }));
    });

    it('handles many files at once, each by its own row', () => {
        const base = snap({ same: 'a', up: 'a', delR: 'a', down: 'a', delL: 'a', conflict: 'a' });
        const local = snap({ same: 'a', up: 'b', down: 'a', delL: 'a', conflict: 'b', addL: 'n' });
        const remote = snap({ same: 'a', up: 'a', delR: 'a', down: 'c', conflict: 'c', addR: 'm' });
        expect(planSync(base, local, remote)).toEqual({
            upload: ['addL', 'up'],
            download: ['addR', 'down'],
            deleteRemote: ['delR'],
            deleteLocal: ['delL'],
            conflicts: ['conflict'],
        });
    });

    it('sorts every list ascending by code unit, whatever the input order', () => {
        const paths = ['world/region/r.1.0.mca', 'Zeta.txt', 'a.txt', 'world/level.dat', 'B.txt', 'world/region/r.0.0.mca'];
        const local = snap(Object.fromEntries(paths.map((p) => [p, 'x'])));
        const reversed = snap(Object.fromEntries([...paths].reverse().map((p) => [p, 'x'])));
        const expected = ['B.txt', 'Zeta.txt', 'a.txt', 'world/level.dat', 'world/region/r.0.0.mca', 'world/region/r.1.0.mca'];
        expect(planSync(snap({}), local, snap({})).upload).toEqual(expected);
        expect(planSync(snap({}), reversed, snap({})).upload).toEqual(expected);
        expect(planSync(snap({}), snap({}), reversed).download).toEqual(expected);
        expect(planSync(reversed, snap({}), reversed).deleteRemote).toEqual(expected);
        expect(planSync(reversed, reversed, snap({})).deleteLocal).toEqual(expected);
        expect(planSync(snap({}), local, snap(Object.fromEntries(paths.map((p) => [p, 'y'])))).conflicts).toEqual(expected);
    });

    it('does not depend on mtime or size, only md5', () => {
        const base: Snapshot = new Map([['a', { md5: 'x', size: 1, mtimeMs: 1 }]]);
        const local: Snapshot = new Map([['a', { md5: 'x', size: 999, mtimeMs: 2 }]]);
        expect(planSync(base, local, base)).toEqual(emptyPlan());
    });
});

describe('planUpload', () => {
    it('uploads changed and added files and deletes removed ones, ignoring the cloud', () => {
        const base = snap({ same: 'a', changed: 'a', removed: 'a' });
        const local = snap({ same: 'a', changed: 'b', added: 'n' });
        expect(planUpload(base, local)).toEqual({ upload: ['added', 'changed'], deleteRemote: ['removed'] });
    });

    it('is empty when nothing changed', () => {
        expect(planUpload(snap({ a: '1' }), snap({ a: '1' }))).toEqual({ upload: [], deleteRemote: [] });
    });

    it('uploads everything when there is no base', () => {
        expect(planUpload(snap({}), snap({ z: '1', a: '2' }))).toEqual({ upload: ['a', 'z'], deleteRemote: [] });
    });
});

describe('planMirrorRemote (keep-cloud)', () => {
    it('downloads what differs or is missing and deletes what the cloud does not have', () => {
        const local = snap({ same: 'a', changed: 'mine', onlyLocal: 'x' });
        const remote = snap({ same: 'a', changed: 'theirs', onlyRemote: 'y' });
        expect(planMirrorRemote(local, remote)).toEqual({ download: ['changed', 'onlyRemote'], deleteLocal: ['onlyLocal'] });
    });

    it('is empty when the folder already equals the cloud', () => {
        expect(planMirrorRemote(snap({ a: '1' }), snap({ a: '1' }))).toEqual({ download: [], deleteLocal: [] });
    });

    it('sorts its lists', () => {
        expect(planMirrorRemote(snap({ z: '1', b: '1' }), snap({ y: '1', a: '1' }))).toEqual({ download: ['a', 'y'], deleteLocal: ['b', 'z'] });
    });
});

describe('deriveStatus', () => {
    it('in-sync when there is nothing to do', () => {
        expect(deriveStatus(emptyPlan())).toBe('in-sync');
    });

    it('local-changes when only uploads or remote deletions', () => {
        expect(deriveStatus(plan({ upload: ['a'] }))).toBe('local-changes');
        expect(deriveStatus(plan({ deleteRemote: ['a'] }))).toBe('local-changes');
        expect(deriveStatus(plan({ upload: ['a'], deleteRemote: ['b'] }))).toBe('local-changes');
    });

    it('cloud-newer when only downloads or local deletions', () => {
        expect(deriveStatus(plan({ download: ['a'] }))).toBe('cloud-newer');
        expect(deriveStatus(plan({ deleteLocal: ['a'] }))).toBe('cloud-newer');
        expect(deriveStatus(plan({ download: ['a'], deleteLocal: ['b'] }))).toBe('cloud-newer');
    });

    it('diverged when there are conflicts', () => {
        expect(deriveStatus(plan({ conflicts: ['a'] }))).toBe('diverged');
        expect(deriveStatus(plan({ conflicts: ['a'], upload: ['b'] }))).toBe('diverged');
    });

    it('diverged when both sides changed different files', () => {
        expect(deriveStatus(plan({ upload: ['a'], download: ['b'] }))).toBe('diverged');
        expect(deriveStatus(plan({ deleteRemote: ['a'], deleteLocal: ['b'] }))).toBe('diverged');
        expect(deriveStatus(plan({ upload: ['a'], deleteLocal: ['b'] }))).toBe('diverged');
        expect(deriveStatus(plan({ deleteRemote: ['a'], download: ['b'] }))).toBe('diverged');
    });
});

describe('allowedChoices', () => {
    it('offers combine only when no file changed on both sides', () => {
        expect(allowedChoices(plan({ upload: ['a'], download: ['b'] }))).toEqual(['combine', 'keep-cloud', 'keep-local']);
    });

    it('offers keep-cloud and keep-local when there are conflicts', () => {
        expect(allowedChoices(plan({ conflicts: ['a'] }))).toEqual(['keep-cloud', 'keep-local']);
        expect(allowedChoices(plan({ conflicts: ['a'], upload: ['b'], download: ['c'] }))).toEqual(['keep-cloud', 'keep-local']);
    });

    it('offers nothing when the status is not diverged', () => {
        expect(allowedChoices(emptyPlan())).toEqual([]);
        expect(allowedChoices(plan({ upload: ['a'] }))).toEqual([]);
        expect(allowedChoices(plan({ download: ['a'] }))).toEqual([]);
    });
});

describe('sumBytes and emptyPlan', () => {
    it('adds the sizes of the listed paths, missing paths count 0', () => {
        const s: Snapshot = new Map([['a', { md5: 'x', size: 10 }], ['b', { md5: 'y', size: 5 }]]);
        expect(sumBytes(['a', 'b', 'missing'], s)).toBe(15);
        expect(sumBytes([], s)).toBe(0);
    });

    it('emptyPlan returns a fresh object each time', () => {
        const first = emptyPlan();
        first.upload.push('x');
        expect(emptyPlan()).toEqual({ upload: [], download: [], deleteRemote: [], deleteLocal: [], conflicts: [] });
    });
});
