import { describe, expect, it } from 'vitest';
import type { TransferSnapshot } from '../../shared/types';
import { ProgressReporter } from './progress';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

function inLanes(s: TransferSnapshot): number {
    return s.lanes.filter((l) => l.path !== null).length;
}

function expectConsistent(s: TransferSnapshot): void {
    expect(s.filesDone + s.filesFailed + s.filesQueued + inLanes(s)).toBe(s.filesTotal);
    expect(s.bytesDone).toBeLessThanOrEqual(s.bytesTotal);
}

const JOBS = [
    { path: 'a', kind: 'download' as const, size: 1000 },
    { path: 'b', kind: 'download' as const, size: 1000 },
    { path: 'c', kind: 'download' as const, size: 1000 },
];

describe('ProgressReporter', () => {
    it('starts empty and inactive', () => {
        const s = new ProgressReporter({}).snapshot();
        expect(s.active).toBe(false);
        expect(s.filesTotal).toBe(0);
        expect(s.lanes).toEqual([]);
        expect(s.etaSec).toBeNull();
    });

    it('smooths speeds with an EWMA per tick (0.8 old + 0.2 sample)', () => {
        const c = clock();
        const p = new ProgressReporter({ now: c.now });
        p.begin('Downloading', JOBS, 2);
        p.jobStarted('a');
        p.jobProgress('a', 500);
        c.advance(1000);
        p.tick();
        expect(p.snapshot().bytesPerSec).toBeCloseTo(100);          // 0.2 * 500 B/s
        p.jobProgress('a', 1000);
        c.advance(1000);
        p.tick();
        expect(p.snapshot().bytesPerSec).toBeCloseTo(180);          // 0.8 * 100 + 0.2 * 500
        p.jobDone('a');
        c.advance(500);
        p.tick();
        const s = p.snapshot();
        expect(s.bytesPerSec).toBeCloseTo(144);                     // nothing moved in this tick
        expect(s.filesPerSec).toBeCloseTo(0.4);                     // 0.2 * (1 file / 0.5 s)
    });

    it('counts bytes of a retried attempt toward speed but not toward progress', () => {
        const c = clock();
        const p = new ProgressReporter({ now: c.now });
        p.begin('Uploading', JOBS, 2);
        p.jobStarted('a');
        p.jobProgress('a', 800);
        p.jobBackoff('a', 2000);
        expect(p.snapshot().bytesDone).toBe(0);
        c.advance(1000);
        p.tick();
        expect(p.snapshot().bytesPerSec).toBeCloseTo(160);
    });

    it('ETA is the slower of the bytes and files estimates', () => {
        const c = clock();
        const p = new ProgressReporter({ now: c.now });
        // Few big files: bytes are the bottleneck.
        p.begin('Downloading', [
            { path: 'a', kind: 'download', size: 100 },
            { path: 'b', kind: 'download', size: 10_000 },
            { path: 'c', kind: 'download', size: 10_000 },
        ], 2);
        p.jobStarted('a');
        p.jobDone('a');                                              // 100 bytes, 1 file
        c.advance(1000);
        p.tick();                                                    // bytes 20 B/s, files 0.2 files/s
        let s = p.snapshot();
        expect(s.bytesPerSec).toBeCloseTo(20);
        expect(s.filesPerSec).toBeCloseTo(0.2);
        // bytes: 20000 / 20 = 1000 s; files: 2 / 0.2 = 10 s
        expect(s.etaSec).toBe(1000);

        // Many tiny files: round trips are the bottleneck.
        p.begin('Uploading', Array.from({ length: 101 }, (_, i) => ({ path: `f${i}`, kind: 'upload' as const, size: 10 })), 2);
        p.jobStarted('f0');
        p.jobProgress('f0', 10);
        p.jobDone('f0');
        c.advance(1000);
        p.tick();
        s = p.snapshot();
        expect(s.etaSec).toBe(500);                                  // bytes: 1000 / 2 B/s; files: 100 / 0.2 files/s
        // The next tick moves bytes but finishes no file: files/s drops and becomes the slower estimate.
        p.jobStarted('f1');
        p.jobProgress('f1', 10);
        c.advance(1000);
        p.tick();                                                    // bytes 0.8*2+0.2*10 = 3.6, files 0.16
        s = p.snapshot();
        const byBytes = (1010 - 20) / 3.6;
        const byFiles = 100 / 0.16;
        expect(byFiles).toBeGreaterThan(byBytes);
        expect(s.etaSec).toBe(Math.ceil(byFiles));
    });

    it('ETA is null until a speed is known, 0 when everything finished, null when inactive', () => {
        const c = clock();
        const p = new ProgressReporter({ now: c.now });
        p.begin('Downloading', JOBS, 2);
        expect(p.snapshot().etaSec).toBeNull();
        p.jobStarted('a');
        c.advance(1000);
        p.tick();
        expect(p.snapshot().etaSec).toBeNull();                      // nothing moved yet
        for (const job of JOBS) {
            p.jobStarted(job.path);
            p.jobDone(job.path);
        }
        expect(p.snapshot().etaSec).toBe(0);
        p.end();
        expect(p.snapshot().etaSec).toBeNull();
    });

    it('gives each job the lowest free lane and keeps the lane during a backoff', () => {
        const c = clock();
        const p = new ProgressReporter({ now: c.now });
        p.begin('Downloading', JOBS, 3);
        expect(p.jobStarted('a')).toBe(1);
        expect(p.jobStarted('b')).toBe(2);
        p.jobDone('a');
        expect(p.jobStarted('c')).toBe(1);                           // lane 1 was free again

        p.jobBackoff('b', 3000);
        c.advance(1000);
        let s = p.snapshot();
        expect(s.lanes).toHaveLength(3);
        expect(s.lanes[1]).toMatchObject({ lane: 2, path: 'b', state: 'backoff', retryInMs: 2000 });
        expect(s.lanes[2]).toMatchObject({ lane: 3, path: null, state: 'idle' });
        expect(p.jobStarted('b')).toBe(2);                           // the retry keeps its lane
        s = p.snapshot();
        expect(s.lanes[1]).toMatchObject({ path: 'b', state: 'active', retryInMs: null });
        expectConsistent(s);
    });

    it('shows lanes above a lowered limit until their jobs finish', () => {
        const p = new ProgressReporter({});
        p.begin('Downloading', JOBS, 3);
        p.jobStarted('a');
        p.jobStarted('b');
        p.jobStarted('c');
        p.setLaneLimit(1);
        expect(p.snapshot().lanes.map((l) => l.path)).toEqual(['a', 'b', 'c']);
        p.jobDone('c');
        p.jobDone('b');
        expect(p.snapshot().lanes.map((l) => l.path)).toEqual(['a']);
        expect(p.snapshot().laneLimit).toBe(1);
    });

    it('keeps the numbers consistent through done, failed and retried jobs', () => {
        const p = new ProgressReporter({});
        p.begin('Uploading', JOBS, 2);
        expectConsistent(p.snapshot());
        p.jobStarted('a');
        p.jobProgress('a', 400);
        p.jobStarted('b');
        let s = p.snapshot();
        expect(s.bytesDone).toBe(400);
        expect(s.filesQueued).toBe(1);
        expectConsistent(s);
        p.jobDone('a');
        p.jobBackoff('b', 10);
        p.jobStarted('b');
        p.jobFailed('b', 'download', 'connection reset');
        p.jobStarted('c');
        p.jobProgress('c', 5000);                                    // clamped to the size
        s = p.snapshot();
        expect(s.bytesDone).toBe(2000);
        expectConsistent(s);
        p.jobDone('c');
        p.end();
        s = p.snapshot();
        expect(s).toMatchObject({
            active: false, filesTotal: 3, filesDone: 2, filesFailed: 1, filesQueued: 0,
            bytesTotal: 3000, bytesDone: 2000, lanes: [],
            failures: [{ path: 'b', kind: 'download', message: 'connection reset' }],
        });
    });

    it('speedGainCheck compares bytes/s 10 s after a lane was added (5% threshold)', () => {
        const c = clock();
        const p = new ProgressReporter({ now: c.now });
        p.begin('Downloading', [{ path: 'big', kind: 'download', size: 1e9 }], 4);
        p.jobStarted('big');
        let moved = 0;
        const run = (seconds: number, bytesPerSec: number): void => {
            for (let i = 0; i < seconds * 4; i++) {
                moved += bytesPerSec / 4;
                p.jobProgress('big', moved);
                c.advance(250);
                p.tick();
            }
        };
        expect(p.speedGainCheck()).toBe('unknown');                  // no lane added yet
        run(20, 1_000_000);
        p.setLaneLimit(5);
        run(5, 2_000_000);
        expect(p.speedGainCheck()).toBe('unknown');                  // window not over
        run(5, 2_000_000);
        expect(p.speedGainCheck()).toBe('gain');

        p.setLaneLimit(6);
        run(10, 2_000_000);
        expect(p.speedGainCheck()).toBe('no-gain');

        p.setLaneLimit(3);                                           // a decrease invalidates the comparison
        run(10, 2_000_000);
        expect(p.speedGainCheck()).toBe('unknown');
    });
});
