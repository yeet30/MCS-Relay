// Three-way planning: base (what this PC and the cloud last agreed on), local (the folder now) and
// remote (the cloud manifest now). Pure functions, no I/O. An undefined md5 means "no such file".
import type { ConflictChoice, Snapshot, SyncPlan, SyncStatus } from '../../shared/types';

export type PlannedStatus = Exclude<SyncStatus, 'new-server' | 'unfinished-upload' | 'no-local-path' | 'error'>;

export function emptyPlan(): SyncPlan {
    return { upload: [], download: [], deleteRemote: [], deleteLocal: [], conflicts: [] };
}

/**
 *   local vs base       remote vs base             plan
 *   same                same                       nothing
 *   changed or added    same                       upload
 *   deleted             same                       deleteRemote
 *   same                changed or added           download
 *   same                deleted                    deleteLocal
 *   changed             changed to the same bytes  nothing
 *   changed             changed differently        conflict
 * "changed" includes deleted, so a delete on one side and an edit on the other is a conflict.
 */
export function planSync(base: Snapshot, local: Snapshot, remote: Snapshot): SyncPlan {
    const plan = emptyPlan();
    for (const path of unionOfKeys(base, local, remote)) {
        const b = base.get(path)?.md5;
        const l = local.get(path)?.md5;
        const r = remote.get(path)?.md5;

        if (l === r) continue;                      // untouched, or both sides made the same change
        if (l !== b && r !== b) {
            plan.conflicts.push(path);
        } else if (l !== b) {
            (l === undefined ? plan.deleteRemote : plan.upload).push(path);
        } else {
            (r === undefined ? plan.deleteLocal : plan.download).push(path);
        }
    }
    return sortPlan(plan);
}

/** What an upload session sends: everything that changed locally since the base. */
export function planUpload(base: Snapshot, local: Snapshot): Pick<SyncPlan, 'upload' | 'deleteRemote'> {
    const upload: string[] = [];
    const deleteRemote: string[] = [];
    for (const path of unionOfKeys(base, local)) {
        const b = base.get(path)?.md5;
        const l = local.get(path)?.md5;
        if (l === b) continue;
        (l === undefined ? deleteRemote : upload).push(path);
    }
    return { upload: sorted(upload), deleteRemote: sorted(deleteRemote) };
}

/** "Keep the cloud version": make the local folder an exact copy of the cloud, whatever the base says. */
export function planMirrorRemote(local: Snapshot, remote: Snapshot): Pick<SyncPlan, 'download' | 'deleteLocal'> {
    const download: string[] = [];
    const deleteLocal: string[] = [];
    for (const path of unionOfKeys(local, remote)) {
        const l = local.get(path)?.md5;
        const r = remote.get(path)?.md5;
        if (l === r) continue;
        (r === undefined ? deleteLocal : download).push(path);
    }
    return { download: sorted(download), deleteLocal: sorted(deleteLocal) };
}

export function deriveStatus(plan: SyncPlan): PlannedStatus {
    const outgoing = plan.upload.length > 0 || plan.deleteRemote.length > 0;
    const incoming = plan.download.length > 0 || plan.deleteLocal.length > 0;
    if (plan.conflicts.length > 0 || (outgoing && incoming)) return 'diverged';
    if (outgoing) return 'local-changes';
    if (incoming) return 'cloud-newer';
    return 'in-sync';
}

/** Combining both sides is only safe when no single file was changed on both. */
export function allowedChoices(plan: SyncPlan): ConflictChoice[] {
    if (deriveStatus(plan) !== 'diverged') return [];
    return plan.conflicts.length > 0 ? ['keep-cloud', 'keep-local'] : ['combine', 'keep-cloud', 'keep-local'];
}

/** Total size of `paths` according to `snap`; paths missing from it count as 0. */
export function sumBytes(paths: string[], snap: Snapshot): number {
    let total = 0;
    for (const path of paths) total += snap.get(path)?.size ?? 0;
    return total;
}

function unionOfKeys(...snapshots: Snapshot[]): Set<string> {
    const paths = new Set<string>();
    for (const snap of snapshots) {
        for (const path of snap.keys()) paths.add(path);
    }
    return paths;
}

// Code-unit order, not localeCompare: the same on every PC whatever its language settings.
function sorted(paths: string[]): string[] {
    return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sortPlan(plan: SyncPlan): SyncPlan {
    sorted(plan.upload);
    sorted(plan.download);
    sorted(plan.deleteRemote);
    sorted(plan.deleteLocal);
    sorted(plan.conflicts);
    return plan;
}
