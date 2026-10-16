// Turns job events into TransferSnapshots for the Transfers panel: totals, smoothed speeds, an ETA,
// and what each lane is doing. The UI computes nothing itself.
import type { LaneView, TransferFailure, TransferKind, TransferSnapshot } from '../../shared/types';

const SMOOTHING = 0.2;                  // speed = 0.8 * speed + 0.2 * sample
const GAIN_WINDOW_MS = 10_000;
const GAIN_THRESHOLD = 1.05;            // a new lane must add at least 5% bytes/s
const MAX_FAILURES = 100;               // snapshots go over IPC four times a second; filesFailed keeps the real count

type EntryState = 'queued' | 'active' | 'backoff' | 'done' | 'failed';

interface Entry {
    path: string;
    kind: TransferKind;
    size: number;
    bytesDone: number;
    state: EntryState;
    slot: number | null;                // index into slots; lane number = slot + 1
    retryAt: number | null;
}

export class ProgressReporter {
    private readonly now: () => number;
    private active = false;
    private label = '';
    private entries = new Map<string, Entry[]>();
    private slots: Array<Entry | null> = [];
    private laneLimit = 0;
    private filesTotal = 0;
    private filesDone = 0;
    private filesFailed = 0;
    private bytesTotal = 0;
    private doneBytes = 0;
    private failedBytes = 0;
    private movedBytes = 0;             // only grows, also counts bytes of attempts that were retried
    private bytesPerSec = 0;
    private filesPerSec = 0;
    private lastTickAt = 0;
    private lastTickMoved = 0;
    private lastTickFinished = 0;
    private laneAddedAt: number | null = null;
    private speedAtLaneAdd = 0;
    private failures: TransferFailure[] = [];

    constructor(opts: { now?: () => number } = {}) {
        this.now = opts.now ?? Date.now;
    }

    begin(label: string, jobs: Array<{ path: string; kind: TransferKind; size: number }>, laneLimit: number): void {
        this.active = true;
        this.label = label;
        this.entries = new Map();
        this.slots = [];
        this.laneLimit = laneLimit;
        this.filesTotal = 0;
        this.filesDone = 0;
        this.filesFailed = 0;
        this.bytesTotal = 0;
        this.doneBytes = 0;
        this.failedBytes = 0;
        this.movedBytes = 0;
        this.bytesPerSec = 0;
        this.filesPerSec = 0;
        this.lastTickAt = this.now();
        this.lastTickMoved = 0;
        this.lastTickFinished = 0;
        this.laneAddedAt = null;
        this.speedAtLaneAdd = 0;
        this.failures = [];
        for (const job of jobs) this.add(job.path, job.kind, job.size);
    }

    /** Returns the lane number (1-based) the job runs in: its own lane on a retry, else the lowest free one. */
    jobStarted(path: string): number {
        const entry = this.find(path, ['backoff', 'queued']) ?? this.find(path, ['active']) ?? this.add(path, 'download', 0);
        if (entry.slot === null) {
            let free = this.slots.indexOf(null);
            if (free === -1) free = this.slots.length;
            entry.slot = free;
            this.slots[free] = entry;
        }
        entry.state = 'active';
        entry.bytesDone = 0;
        entry.retryAt = null;
        return entry.slot + 1;
    }

    jobProgress(path: string, bytesDone: number): void {
        const entry = this.find(path, ['active']);
        if (!entry) return;
        const clamped = Math.min(Math.max(0, bytesDone), entry.size);
        if (clamped > entry.bytesDone) this.movedBytes += clamped - entry.bytesDone;
        entry.bytesDone = clamped;
    }

    /** The job failed and will be retried in retryInMs. It keeps its lane, like the limiter keeps its slot. */
    jobBackoff(path: string, retryInMs: number): void {
        const entry = this.find(path, ['active', 'queued']);
        if (!entry) return;
        entry.state = 'backoff';
        entry.bytesDone = 0;
        entry.retryAt = this.now() + Math.max(0, retryInMs);
    }

    jobDone(path: string): void {
        const entry = this.find(path, ['active', 'backoff', 'queued']) ?? this.add(path, 'download', 0);
        if (entry.size > entry.bytesDone) this.movedBytes += entry.size - entry.bytesDone;
        entry.bytesDone = entry.size;
        entry.state = 'done';
        this.release(entry);
        this.filesDone += 1;
        this.doneBytes += entry.size;
    }

    jobFailed(path: string, kind: TransferKind, message: string): void {
        const entry = this.find(path, ['active', 'backoff', 'queued']) ?? this.add(path, kind, 0);
        entry.state = 'failed';
        entry.bytesDone = 0;
        this.release(entry);
        this.filesFailed += 1;
        this.failedBytes += entry.size;
        if (this.failures.length < MAX_FAILURES) this.failures.push({ path, kind, message });
    }

    setLaneLimit(n: number): void {
        if (n > this.laneLimit) {
            this.laneAddedAt = this.now();
            this.speedAtLaneAdd = this.bytesPerSec;
        } else if (n < this.laneLimit) {
            // Fewer lanes (throttling) makes the old comparison meaningless.
            this.laneAddedAt = null;
        }
        this.laneLimit = n;
    }

    tick(): void {
        const now = this.now();
        const seconds = (now - this.lastTickAt) / 1000;
        if (seconds <= 0) return;
        const finished = this.filesDone + this.filesFailed;
        const bytesSample = (this.movedBytes - this.lastTickMoved) / seconds;
        const filesSample = (finished - this.lastTickFinished) / seconds;
        this.bytesPerSec = (1 - SMOOTHING) * this.bytesPerSec + SMOOTHING * bytesSample;
        this.filesPerSec = (1 - SMOOTHING) * this.filesPerSec + SMOOTHING * filesSample;
        this.lastTickAt = now;
        this.lastTickMoved = this.movedBytes;
        this.lastTickFinished = finished;
    }

    end(): void {
        this.active = false;
        this.slots = [];
    }

    snapshot(): TransferSnapshot {
        const now = this.now();
        const lanes: LaneView[] = [];
        let inLanes = 0;
        let inFlightBytes = 0;
        const laneCount = this.active ? Math.max(this.laneLimit, this.slots.length) : 0;
        for (let i = 0; i < laneCount; i++) {
            const entry = this.slots[i] ?? null;
            if (!entry) {
                lanes.push({ lane: i + 1, path: null, kind: null, bytesDone: 0, size: 0, state: 'idle', retryInMs: null });
                continue;
            }
            inLanes += 1;
            inFlightBytes += entry.bytesDone;
            const backoff = entry.state === 'backoff';
            lanes.push({
                lane: i + 1,
                path: entry.path,
                kind: entry.kind,
                bytesDone: entry.bytesDone,
                size: entry.size,
                state: backoff ? 'backoff' : 'active',
                retryInMs: backoff && entry.retryAt !== null ? Math.max(0, entry.retryAt - now) : null,
            });
        }
        const bytesDone = this.doneBytes + inFlightBytes;
        return {
            active: this.active,
            label: this.label,
            filesTotal: this.filesTotal,
            filesDone: this.filesDone,
            filesFailed: this.filesFailed,
            filesQueued: Math.max(0, this.filesTotal - this.filesDone - this.filesFailed - inLanes),
            bytesTotal: this.bytesTotal,
            bytesDone,
            bytesPerSec: this.bytesPerSec,
            filesPerSec: this.filesPerSec,
            etaSec: this.eta(bytesDone),
            laneLimit: this.laneLimit,
            lanes,
            failures: [...this.failures],
        };
    }

    /** Compares bytes/s now with bytes/s when the last lane was added, once that lane had 10 s to help. */
    speedGainCheck(): 'gain' | 'no-gain' | 'unknown' {
        if (this.laneAddedAt === null || this.now() - this.laneAddedAt < GAIN_WINDOW_MS) return 'unknown';
        if (this.speedAtLaneAdd <= 0) return this.bytesPerSec > 0 ? 'gain' : 'unknown';
        return this.bytesPerSec >= this.speedAtLaneAdd * GAIN_THRESHOLD ? 'gain' : 'no-gain';
    }

    /** Big files are limited by bandwidth, many small files by round trips: trust the slower estimate.
     *  A side without a measured speed yet is left out (one big file finishes no files for a long time). */
    private eta(bytesDone: number): number | null {
        if (!this.active) return null;
        const remainingFiles = this.filesTotal - this.filesDone - this.filesFailed;
        if (remainingFiles <= 0) return 0;
        const remainingBytes = Math.max(0, this.bytesTotal - bytesDone - this.failedBytes);
        const estimates: number[] = [];
        if (remainingBytes > 0 && this.bytesPerSec > 0) estimates.push(remainingBytes / this.bytesPerSec);
        if (this.filesPerSec > 0) estimates.push(remainingFiles / this.filesPerSec);
        if (estimates.length === 0) return null;
        return Math.ceil(Math.max(...estimates));
    }

    private add(path: string, kind: TransferKind, size: number): Entry {
        const entry: Entry = { path, kind, size: Math.max(0, size), bytesDone: 0, state: 'queued', slot: null, retryAt: null };
        const list = this.entries.get(path);
        if (list) list.push(entry);
        else this.entries.set(path, [entry]);
        this.filesTotal += 1;
        this.bytesTotal += entry.size;
        return entry;
    }

    /** Paths are unique in practice; with duplicates the first entry in a matching state is used. */
    private find(path: string, states: EntryState[]): Entry | undefined {
        const list = this.entries.get(path);
        if (!list) return undefined;
        for (const state of states) {
            const match = list.find((e) => e.state === state);
            if (match) return match;
        }
        return undefined;
    }

    private release(entry: Entry): void {
        if (entry.slot !== null && this.slots[entry.slot] === entry) this.slots[entry.slot] = null;
        entry.slot = null;
        entry.retryAt = null;
        while (this.slots.length > 0 && this.slots[this.slots.length - 1] === null) this.slots.pop();
    }
}
