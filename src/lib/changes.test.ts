import { describe, expect, test } from 'vitest';
import type { ChangeKind } from '../../shared/types';
import { applyChangeBatch, countKinds, folderKey, folderLabel, groupChanges, groupPaths, mergeChange } from './changes';

describe('folderKey', () => {
    test('uses at most the first two folders', () => {
        expect(folderKey('world/region/r.0.0.mca')).toBe('world/region/');
        expect(folderKey('world/DIM-1/region/r.0.0.mca')).toBe('world/DIM-1/');
        expect(folderKey('world/level.dat')).toBe('world/');
    });

    test('top-level files share one group', () => {
        expect(folderKey('server.properties')).toBe('');
        expect(folderLabel('')).toBe('Top-level files');
        expect(folderLabel('world/')).toBe('world/');
    });
});

test('groupPaths puts the biggest folders first and sorts paths inside', () => {
    const groups = groupPaths([
        'world/region/r.1.0.mca',
        'ops.json',
        'world/region/r.0.0.mca',
        'world/level.dat',
        'server.properties',
        'world/region/r.0.1.mca',
    ]);
    expect(groups).toEqual([
        { key: 'world/region/', paths: ['world/region/r.0.0.mca', 'world/region/r.0.1.mca', 'world/region/r.1.0.mca'] },
        { key: '', paths: ['ops.json', 'server.properties'] },
        { key: 'world/', paths: ['world/level.dat'] },
    ]);
});

test('groupChanges counts each kind per folder', () => {
    const changes = new Map<string, ChangeKind>([
        ['world/region/r.0.0.mca', 'changed'],
        ['world/region/r.5.0.mca', 'added'],
        ['world/entities/r.0.0.mca', 'changed'],
        ['world/region/r.9.9.mca', 'removed'],
    ]);
    const groups = groupChanges(changes);
    expect(groups.map((g) => [g.key, g.added, g.changed, g.removed, g.total])).toEqual([
        ['world/region/', 1, 1, 1, 3],
        ['world/entities/', 0, 1, 0, 1],
    ]);
    expect(groups[0].items[0]).toEqual(['world/region/r.0.0.mca', 'changed']);
    expect(countKinds(changes)).toEqual({ added: 1, changed: 2, removed: 1 });
});

describe('mergeChange', () => {
    function run(...kinds: ChangeKind[]): ChangeKind | undefined {
        const map = new Map<string, ChangeKind>();
        for (const kind of kinds) mergeChange(map, 'a.txt', kind);
        return map.get('a.txt');
    }

    test('added then changed stays added', () => {
        expect(run('added', 'changed')).toBe('added');
    });

    test('added then removed disappears', () => {
        expect(run('added', 'removed')).toBeUndefined();
    });

    test('removed then added again is a change', () => {
        expect(run('removed', 'added')).toBe('changed');
    });

    test('changed then removed is removed', () => {
        expect(run('changed', 'removed')).toBe('removed');
    });

    test('replaying the same event is harmless', () => {
        expect(run('changed', 'changed')).toBe('changed');
        expect(run('added', 'added')).toBe('added');
        expect(run('removed', 'removed')).toBe('removed');
    });
});

test('applyChangeBatch returns a new map and leaves the old one alone', () => {
    const before = new Map<string, ChangeKind>([['a', 'added']]);
    const after = applyChangeBatch(before, [['a', 'removed'], ['b', 'changed']]);
    expect(after).not.toBe(before);
    expect([...before]).toEqual([['a', 'added']]);
    expect([...after]).toEqual([['b', 'changed']]);
});
