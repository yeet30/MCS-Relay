// Shows what changed in the server folder while a session runs. Display only: the upload does
// its own scan, so a missed event here never loses data (Part 2, section 8).
import path from 'node:path';
import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import type { ChangeBatch, ChangeKind } from '../../shared/types';
import { toPosix } from '../../shared/paths';

export interface ChangeTrackerDeps {
    emit: (batch: ChangeBatch) => void;
    reset: () => void;
    flushMs?: number;
}

export class ChangeTracker {
    private watcher: FSWatcher | null = null;
    private readonly changes = new Map<string, ChangeKind>();
    private pending: ChangeBatch = [];
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly d: ChangeTrackerDeps) {}

    async start(root: string, isIgnored: (rel: string) => boolean): Promise<void> {
        await this.stop();
        const watcher = watch(root, {
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
            ignored: (abs: string) => {
                const rel = toPosix(path.relative(root, abs));
                return rel !== '' && !rel.startsWith('..') && isIgnored(rel);
            },
        });
        this.watcher = watcher;
        const record = (kind: ChangeKind) => (abs: string) => this.record(toPosix(path.relative(root, abs)), kind);
        watcher.on('add', record('added'));
        watcher.on('change', record('changed'));
        watcher.on('unlink', record('removed'));
        watcher.on('error', (err) => console.warn('[changes] watcher error:', err));
        await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    }

    async stop(): Promise<void> {
        const watcher = this.watcher;
        this.watcher = null;
        if (watcher) await watcher.close();
        this.flush();
    }

    clear(): void {
        this.changes.clear();
        this.pending = [];
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.d.reset();
    }

    all(): ChangeBatch {
        return [...this.changes];
    }

    /** Same rule as mergeChange() in src/lib/changes.ts, which replays these events in the renderer:
     *  added then changed stays "added", added then removed disappears, removed then added is "changed". */
    private record(rel: string, kind: ChangeKind): void {
        if (!rel || rel.startsWith('..')) return;
        const previous = this.changes.get(rel);
        if (previous === 'added') {
            if (kind === 'removed') this.changes.delete(rel);
        } else if (previous === 'removed' && kind !== 'removed') {
            this.changes.set(rel, 'changed');
        } else if (!(previous === 'changed' && kind === 'added')) {
            this.changes.set(rel, kind);
        }
        this.pending.push([rel, kind]);
        if (!this.timer) this.timer = setTimeout(() => this.flush(), this.d.flushMs ?? 500);
    }

    private flush(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.pending.length === 0) return;
        // Raw events in order: the renderer replays them with the same rule.
        const batch = this.pending;
        this.pending = [];
        this.d.emit(batch);
    }
}
