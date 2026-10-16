// Grouping of changed / planned paths by folder, and the renderer's copy of the session's change map.
import type { ChangeBatch, ChangeKind } from '../../shared/types';

/** The folder a path is listed under: its first two directory segments ("world/region/"), or "" for top-level files. */
export function folderKey(path: string): string {
    const parts = path.split('/').filter((part) => part.length > 0);
    const dirs = parts.slice(0, -1).slice(0, 2);
    return dirs.length > 0 ? `${dirs.join('/')}/` : '';
}

export function folderLabel(key: string): string {
    return key === '' ? 'Top-level files' : key;
}

export interface PathGroup {
    key: string;
    paths: string[];
}

function byCountThenKey(a: { key: string; count: number }, b: { key: string; count: number }): number {
    return b.count - a.count || a.key.localeCompare(b.key);
}

/** Groups paths by folderKey(); biggest groups first, paths sorted inside each group. */
export function groupPaths(paths: readonly string[]): PathGroup[] {
    const groups = new Map<string, string[]>();
    for (const path of paths) {
        const key = folderKey(path);
        const list = groups.get(key);
        if (list) list.push(path);
        else groups.set(key, [path]);
    }
    return [...groups.entries()]
        .map(([key, list]) => ({ key, count: list.length, paths: [...list].sort() }))
        .sort(byCountThenKey)
        .map(({ key, paths: sorted }) => ({ key, paths: sorted }));
}

export interface ChangeGroup {
    key: string;
    added: number;
    changed: number;
    removed: number;
    total: number;
    items: Array<[path: string, kind: ChangeKind]>;
}

/** Groups the session's changes by folderKey() with a count per kind; biggest groups first. */
export function groupChanges(changes: ReadonlyMap<string, ChangeKind>): ChangeGroup[] {
    const groups = new Map<string, ChangeGroup>();
    for (const [path, kind] of changes) {
        const key = folderKey(path);
        let group = groups.get(key);
        if (!group) {
            group = { key, added: 0, changed: 0, removed: 0, total: 0, items: [] };
            groups.set(key, group);
        }
        group[kind]++;
        group.total++;
        group.items.push([path, kind]);
    }
    const list = [...groups.values()];
    for (const group of list) group.items.sort((a, b) => a[0].localeCompare(b[0]));
    return list.sort((a, b) => byCountThenKey({ key: a.key, count: a.total }, { key: b.key, count: b.total }));
}

export function countKinds(changes: ReadonlyMap<string, ChangeKind>): Record<ChangeKind, number> {
    const counts: Record<ChangeKind, number> = { added: 0, changed: 0, removed: 0 };
    for (const kind of changes.values()) counts[kind]++;
    return counts;
}

/** Records one change the way the main process's ChangeTracker does: a file that was added and then changed
 *  stays "added"; added and then removed disappears; removed and then added again counts as "changed".
 *  Replaying the same event twice gives the same result, which the resync relies on. */
export function mergeChange(map: Map<string, ChangeKind>, path: string, kind: ChangeKind): void {
    const previous = map.get(path);
    if (previous === 'added') {
        if (kind === 'removed') map.delete(path);
        return;
    }
    if (previous === 'removed' && kind !== 'removed') {
        map.set(path, 'changed');
        return;
    }
    if (previous === 'changed' && kind === 'added') return;
    map.set(path, kind);
}

/** A new map with the batch applied (zustand needs a new reference to notify subscribers). */
export function applyChangeBatch(current: ReadonlyMap<string, ChangeKind>, batch: ChangeBatch): Map<string, ChangeKind> {
    const next = new Map(current);
    for (const [path, kind] of batch) mergeChange(next, path, kind);
    return next;
}
