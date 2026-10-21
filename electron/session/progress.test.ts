import { afterEach, describe, expect, it } from 'vitest';
import type { SessionProgress, StepMessage, TransferSnapshot } from '../../shared/types';
import { OrchestrationProgress } from './progress';

interface Line { id: number; message: string; status: StepMessage['status'] }

function setup() {
    const emitted: SessionProgress[] = [];
    const lines: Line[] = [];
    let nextId = 1;
    const progress = new OrchestrationProgress({
        emit: (p) => void emitted.push(p),
        log: {
            open: (message) => {
                const id = nextId++;
                lines.push({ id, message, status: 'loading' });
                return id;
            },
            update: (id, message, status) => {
                const line = lines.find((l) => l.id === id)!;
                line.message = message;
                line.status = status;
            },
        },
        emitEveryMs: 0,
    });
    return { progress, emitted, lines, last: () => progress.snapshot() };
}

function transfer(patch: Partial<TransferSnapshot>): TransferSnapshot {
    return {
        active: true, label: 'Uploading files', filesTotal: 0, filesDone: 0, filesFailed: 0, filesQueued: 0, bytesTotal: 0,
        bytesDone: 0, bytesPerSec: 0, filesPerSec: 0, etaSec: null, laneLimit: 4, lanes: [], failures: [], ...patch,
    };
}

let current: OrchestrationProgress | null = null;
afterEach(() => current?.dispose());

describe('OrchestrationProgress', () => {
    it('counts every action as one unit across all stages', () => {
        const t = setup();
        current = t.progress;
        t.progress.begin('Stopping and uploading', [
            { key: 'stop-java', label: 'Stopping', total: 1 },
            { key: 'scan', label: 'Checking', total: 1 },
            { key: 'folders', label: 'Folders', total: 4 },
            { key: 'files', label: 'Files', total: 4 },
        ]);
        t.progress.enter('stop-java', 'Stopping the Minecraft server');
        t.progress.complete('stop-java', 'Stopped');
        expect(t.last().fraction).toBeCloseTo(1 / 10);
        t.progress.complete('scan');
        t.progress.enter('folders', 'Creating folders');
        t.progress.settle('folders', 2);
        expect(t.last().unitsDone).toBe(4);
        expect(t.last().fraction).toBeCloseTo(4 / 10);
    });

    it('moves a transfer stage with finished files and the share of files in lanes', () => {
        const t = setup();
        current = t.progress;
        t.progress.begin('Uploading', [{ key: 'files', label: 'Files', total: 10 }]);
        t.progress.enter('files', 'Uploading 10 files');
        t.progress.applyTransfer(transfer({
            filesTotal: 10, filesDone: 3, filesFailed: 1,
            lanes: [{ lane: 1, path: 'a', kind: 'upload', bytesDone: 50, size: 100, state: 'active', retryInMs: null, elapsedMs: 10 }],
        }));
        expect(t.last().fraction).toBeCloseTo(4.5 / 10);
        expect(t.last().message).toBe('Uploading files (4 of 10)');
    });

    it('never moves the bar backwards when an estimate turns out too small', () => {
        const t = setup();
        current = t.progress;
        t.progress.begin('Uploading', [
            { key: 'scan', label: 'Checking', total: 1 },
            { key: 'files', label: 'Files', total: 1 },
        ]);
        t.progress.complete('scan');
        expect(t.last().fraction).toBeCloseTo(0.5);
        t.progress.setTotal('files', 99);
        expect(t.last().fraction).toBeCloseTo(0.5);
        t.progress.settle('files', 99);
        expect(t.last().fraction).toBe(1);
    });

    it('turns every loading log line into done, or the running one into error on failure', () => {
        const t = setup();
        current = t.progress;
        t.progress.begin('Starting', [
            { key: 'check', label: 'Check', total: 1 },
            { key: 'download', label: 'Download', total: 3 },
        ]);
        t.progress.enter('check', 'Checking the server');
        t.progress.enter('download', 'Downloading 3 files');      // entering the next stage closes the previous line
        expect(t.lines).toEqual([
            { id: 1, message: 'Checking the server', status: 'done' },
            { id: 2, message: 'Downloading 3 files', status: 'loading' },
        ]);
        t.progress.finish('failed', '2 files could not be downloaded');
        expect(t.lines[1]).toEqual({ id: 2, message: '2 files could not be downloaded', status: 'error' });
        expect(t.last()).toMatchObject({ active: false, outcome: 'failed' });
    });

    it('a finished run is complete even if some planned stages never ran', () => {
        const t = setup();
        current = t.progress;
        t.progress.begin('Uploading', [
            { key: 'scan', label: 'Checking', total: 1 },
            { key: 'files', label: 'Files', total: 5 },
        ]);
        t.progress.complete('scan');
        t.progress.skip('files');
        t.progress.finish('done');
        expect(t.last()).toMatchObject({ fraction: 1, outcome: 'done' });
        expect(t.last().stages.map((s) => s.state)).toEqual(['done', 'skipped']);
    });
});

describe('OrchestrationProgress: a cancelled run', () => {
    it('marks the running stage as cancelled, not failed, and remembers what Continue has to do', () => {
        const t = setup();
        current = t.progress;
        t.progress.begin('Starting the server', [
            { key: 'check', label: 'Checking', total: 1 },
            { key: 'download', label: 'Downloading', total: 10 },
        ], { kind: 'start', serverId: 's1' });
        t.progress.enter('check', 'Checking');
        t.progress.complete('check', 'Checked');
        t.progress.enter('download', 'Downloading 10 files');
        t.progress.settle('download', 4);
        t.progress.finish('cancelled', 'The start was cancelled');
        const last = t.last();
        expect(last).toMatchObject({ active: false, outcome: 'cancelled', kind: 'start', serverId: 's1', message: 'The start was cancelled' });
        expect(last.stages.map((s) => s.state)).toEqual(['done', 'cancelled']);
        expect(last.fraction).toBeCloseTo(5 / 11);
        expect(t.lines.map((l) => l.status)).toEqual(['done', 'cancelled']);
    });
});
