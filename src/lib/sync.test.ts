import { describe, expect, test } from 'vitest';
import type { LockContent, LockView, SessionState, SyncPlan, SyncReport, TransferSnapshot } from '../../shared/types';
import {
    cancelMode, cancelQuestion, canStart, cleanupLines, continueAction, describeReport, hostingMessage, isSessionBusy, livePresence,
    manualSyncBlockers, planHasFiles, powerMode, repairBlocker, startBlocker, transferFraction,
} from './sync';

const NOW = new Date(2026, 9, 14, 20, 0).getTime();

function emptyPlan(): SyncPlan {
    return { upload: [], download: [], deleteRemote: [], deleteLocal: [], conflicts: [] };
}

function lockContent(patch: Partial<LockContent> = {}): LockContent {
    return {
        format: 2, sessionId: 's1', host: { name: 'Alex', email: 'alex@example.com' }, phase: 'running',
        leaseSeconds: 45, baseRevision: 42, startedAt: null, address: null, players: [], ...patch,
    };
}

const FREE: LockView = { state: 'free', lock: null };

function held(patch: Partial<LockContent> = {}, ageSeconds = 5): LockView {
    return { state: 'held', lock: lockContent(patch), ageSeconds };
}

function stale(patch: Partial<LockContent> = {}, ageSeconds = 600): LockView {
    return { state: 'stale', lock: lockContent(patch), ageSeconds };
}

function report(patch: Partial<SyncReport> = {}): SyncReport {
    return {
        serverId: 'srv', status: 'in-sync', firstSyncOnThisPc: false, baseRevision: 42, remoteRevision: 42,
        remoteAuthor: { name: 'Steve', email: 'steve@example.com' }, remoteCreatedAt: new Date(2026, 9, 13, 21, 40).toISOString(),
        plan: emptyPlan(), downloadBytes: 0, uploadBytes: 0, allowedChoices: [], pendingChoice: null,
        cleanup: { mine: 0, others: [] }, lock: FREE, checkedAt: new Date(NOW).toISOString(), ...patch,
    };
}

function session(patch: Partial<SessionState> = {}): SessionState {
    return { phase: 'idle', serverId: null, startedAt: null, address: null, players: [], javaRunning: false, error: null, ...patch };
}

describe('the "can start" decision', () => {
    test('idle, in sync and free: Start is allowed', () => {
        expect(canStart(session(), 'srv', report(), FREE)).toBe(true);
        expect(powerMode(session(), 'srv', report(), FREE)).toEqual({ kind: 'start', enabled: true, reason: null });
    });

    test('local changes, cloud newer and new servers can start', () => {
        for (const status of ['local-changes', 'cloud-newer', 'new-server'] as const) {
            expect(canStart(session(), 'srv', report({ status }), FREE)).toBe(true);
        }
    });

    test('no report yet, or a report for another server, blocks Start', () => {
        expect(canStart(session(), 'srv', null, FREE)).toBe(false);
        expect(canStart(session(), 'srv', report({ serverId: 'other' }), FREE)).toBe(false);
        expect(canStart(session(), null, report(), FREE)).toBe(false);
    });

    test('unfinished upload, missing folder and errors block Start', () => {
        expect(canStart(session(), 'srv', report({ status: 'unfinished-upload' }), FREE)).toBe(false);
        expect(canStart(session(), 'srv', report({ status: 'no-local-path' }), FREE)).toBe(false);
        expect(startBlocker(report({ status: 'error', error: 'Drive is down.' }), FREE)).toBe('Drive is down.');
    });

    test('diverged needs a pending choice', () => {
        expect(canStart(session(), 'srv', report({ status: 'diverged' }), FREE)).toBe(false);
        expect(canStart(session(), 'srv', report({ status: 'diverged', pendingChoice: 'keep-cloud' }), FREE)).toBe(true);
    });

    test('the lock must be free, or stale without an upload', () => {
        expect(startBlocker(report(), held())).toBe('Alex is hosting the server.');
        expect(canStart(session(), 'srv', report(), stale({ phase: 'running' }))).toBe(true);
        expect(canStart(session(), 'srv', report(), stale({ phase: 'uploading' }))).toBe(false);
    });

    test('the freshest lock view wins over the one inside the report', () => {
        expect(canStart(session(), 'srv', report({ lock: held() }), FREE)).toBe(true);
        expect(canStart(session(), 'srv', report({ lock: FREE }), held())).toBe(false);
        expect(canStart(session(), 'srv', report({ lock: held() }), null)).toBe(false);
    });

    test('anything but idle never offers Start', () => {
        expect(powerMode(session({ phase: 'running', serverId: 'srv' }), 'srv', report(), FREE)).toEqual({ kind: 'stop' });
        expect(powerMode(session({ phase: 'downloading', serverId: 'srv' }), 'srv', report(), FREE)).toEqual({ kind: 'busy', label: 'Downloading the world…' });
        const error = { code: 'JAVA' as const, message: 'Java is not installed.' };
        expect(powerMode(session({ phase: 'failed', serverId: 'srv', error }), 'srv', report(), FREE)).toEqual({ kind: 'failed', error });
        expect(powerMode(session({ phase: 'upload-pending', serverId: 'srv', error }), 'srv', report(), FREE)).toEqual({ kind: 'upload-pending', error });
    });
});

test('isSessionBusy', () => {
    expect(isSessionBusy('idle')).toBe(false);
    expect(isSessionBusy('failed')).toBe(false);
    expect(isSessionBusy('running')).toBe(true);
    expect(isSessionBusy('upload-pending')).toBe(true);
});

describe('livePresence', () => {
    test('from my own session when I host', () => {
        const mine = session({ phase: 'running', serverId: 'srv', players: ['Steve'], startedAt: 'T', address: 'x.joinmc.link' });
        expect(livePresence(mine, 'srv', held({ players: ['old'] }))).toEqual({ players: ['Steve'], startedAt: 'T', address: 'x.joinmc.link' });
        expect(livePresence(session({ phase: 'launching', serverId: 'srv' }), 'srv', held())).toBeNull();
    });

    test('from the lock when someone else hosts', () => {
        const view = held({ players: ['Alex'], startedAt: 'S', address: 'a.joinmc.link' });
        expect(livePresence(session(), 'srv', view)).toEqual({ players: ['Alex'], startedAt: 'S', address: 'a.joinmc.link' });
        expect(livePresence(session(), 'srv', held({ phase: 'downloading' }))).toBeNull();
        expect(livePresence(session(), 'srv', stale())).toBeNull();
        expect(livePresence(session(), 'srv', FREE)).toBeNull();
    });
});

describe('hostingMessage', () => {
    test('free and running', () => {
        expect(hostingMessage(FREE, 'me@example.com')).toBe('is not being hosted right now.');
        expect(hostingMessage(null, null)).toBe('is not being hosted right now.');
        expect(hostingMessage(held({ address: 'a.joinmc.link' }), 'me@example.com')).toBe('is currently hosted by Alex at:');
        expect(hostingMessage(held(), 'me@example.com')).toBe('is currently hosted by Alex.');
    });

    test('me, here or on another PC', () => {
        expect(hostingMessage({ state: 'mine', lock: lockContent(), ageSeconds: 1 }, 'alex@example.com')).toBe('is currently hosted by you.');
        expect(hostingMessage(held(), 'alex@example.com')).toBe('is currently hosted by you on another PC.');
    });

    test('transitions and stale locks', () => {
        expect(hostingMessage(held({ phase: 'uploading' }), null)).toBe('is being uploaded by Alex.');
        expect(hostingMessage(stale({ phase: 'uploading' }), null)).toBe('has an unfinished upload from Alex.');
        expect(hostingMessage(stale({ phase: 'running' }, 180), null)).toBe('was last used by Alex, whose app stopped responding 3 min ago.');
    });
});

describe('describeReport', () => {
    const ctx = { myEmail: 'me@example.com', nameFor: (email: string) => (email === 'alex@example.com' ? 'Alex' : email), now: NOW };

    test('in sync', () => {
        expect(describeReport(report(), ctx)).toEqual({
            tone: 'good', pill: 'In sync', title: 'Up to date',
            body: 'Your copy matches revision 42, uploaded by Steve yesterday at 21:40.',
        });
    });

    test('local changes name the files', () => {
        const plan = { ...emptyPlan(), upload: ['server.properties', 'ops.json', 'world/data/raids.dat'] };
        const copy = describeReport(report({ status: 'local-changes', plan }), ctx);
        expect(copy.title).toBe('3 changes aren\'t in the cloud yet');
        expect(copy.body).toBe('ops.json, server.properties and world/data/raids.dat changed after your last sync. They\'ll be uploaded when your next session ends.');
    });

    test('cloud newer says who played and how much is downloaded', () => {
        const plan = { ...emptyPlan(), download: Array.from({ length: 312 }, (_, i) => `world/region/r.${i}.mca`) };
        const copy = describeReport(report({
            status: 'cloud-newer', plan, remoteRevision: 43, downloadBytes: 180 * 1024 * 1024,
            remoteAuthor: { name: 'Alex', email: 'alex@example.com' }, remoteCreatedAt: new Date(2026, 9, 14, 18, 5).toISOString(),
        }), ctx);
        expect(copy.title).toBe('Alex played after you');
        expect(copy.body).toBe('Revision 43, today at 18:05. 312 files (180 MB) will be downloaded when you start.');
    });

    test('first sync on this PC uses first-sync wording', () => {
        const plan = { ...emptyPlan(), download: ['a', 'b'] };
        const copy = describeReport(report({ status: 'cloud-newer', firstSyncOnThisPc: true, plan, downloadBytes: 2048 }), ctx);
        expect(copy.title).toBe('First sync on this PC');
        expect(copy.body).toBe('2 files (2.0 KB) will be downloaded into this folder when you start.');
        const diverged = describeReport(report({ status: 'diverged', firstSyncOnThisPc: true }), ctx);
        expect(diverged.title).toBe('This folder differs from the cloud');
    });

    test('diverged explains the choice and shows a pending one', () => {
        const plan = { ...emptyPlan(), upload: ['a'], download: ['b'] };
        const open = describeReport(report({ status: 'diverged', plan, remoteRevision: 43, remoteAuthor: { name: 'Alex', email: 'alex@example.com' } }), ctx);
        expect(open.tone).toBe('warn');
        expect(open.body).toBe('Alex\'s session (revision 43) and your edits since revision 42 touch the same world. Pick the version to keep. No single file changed on both sides, so you can also combine them.');
        const chosen = describeReport(report({ status: 'diverged', plan, pendingChoice: 'keep-cloud' }), ctx);
        expect(chosen.body).toContain('You chose the cloud version.');
    });

    test('unfinished upload names the host', () => {
        const lock = stale({ phase: 'uploading', host: { name: 'Steve', email: 'steve@example.com' } }, 60);
        const copy = describeReport(report({ status: 'unfinished-upload', lock }), ctx);
        expect(copy.title).toBe('Steve\'s last upload didn\'t finish');
        expect(copy.body).toBe('It stopped halfway today at 19:59, so the cloud is a mix of old and new files. Ask Steve to open Drive Launcher; it will finish the upload on its own.');
    });

    test('new server, missing folder and errors', () => {
        expect(describeReport(report({ status: 'new-server', plan: { ...emptyPlan(), upload: ['a'] }, uploadBytes: 100 }), ctx).body)
            .toBe('This folder becomes the first version: 1 file (100 B) will be uploaded when your first session ends. The first upload takes much longer than later ones, because every folder and file has to be created on Google Drive.');
        expect(describeReport(report({ status: 'no-local-path' }), ctx).title).toBe('Choose a folder on this PC');
        expect(describeReport(report({ status: 'error', error: 'Offline.' }), ctx).body).toBe('Offline.');
    });
});

test('cleanupLines', () => {
    const nameFor = (email: string) => (email === 'alex@example.com' ? 'Alex' : email);
    expect(cleanupLines({ mine: 0, others: [] }, nameFor)).toEqual([]);
    expect(cleanupLines({ mine: 2, others: [{ ownerEmail: 'alex@example.com', count: 3 }, { ownerEmail: 'x@example.com', count: 1 }] }, nameFor)).toEqual([
        '3 deleted files are waiting for Alex to open Drive Launcher.',
        '1 deleted file is waiting for x@example.com to open Drive Launcher.',
        'Cleaning up 2 of your old files.',
    ]);
});

test('planHasFiles', () => {
    expect(planHasFiles(report())).toBe(false);
    expect(planHasFiles(report({ plan: { ...emptyPlan(), conflicts: ['x'] } }))).toBe(true);
});

test('transferFraction uses bytes, or files when nothing has a size', () => {
    const base: TransferSnapshot = {
        active: true, label: 'Uploading', filesTotal: 10, filesDone: 5, filesFailed: 0, filesQueued: 5, bytesTotal: 0, bytesDone: 0,
        bytesPerSec: 0, filesPerSec: 0, etaSec: null, laneLimit: 4, lanes: [], failures: [],
    };
    expect(transferFraction(base)).toBe(0.5);
    expect(transferFraction({ ...base, bytesTotal: 400, bytesDone: 100 })).toBe(0.25);
    expect(transferFraction({ ...base, filesTotal: 0, filesDone: 0 })).toBe(0);
});

describe('cancel, pause and continue', () => {
    test('a start or download is cancelled, an upload paused, and nothing else can be stopped', () => {
        for (const phase of ['checking', 'claiming', 'downloading', 'launching'] as const) expect(cancelMode(phase)).toBe('cancel');
        expect(cancelMode('uploading')).toBe('pause');
        for (const phase of ['idle', 'running', 'stopping', 'releasing', 'failed', 'upload-pending'] as const) expect(cancelMode(phase)).toBeNull();
    });

    test('the question says what happens to the files and the server', () => {
        expect(cancelQuestion('stop', 'uploading')).toMatchObject({ confirmText: 'Pause upload', message: expect.stringContaining('stays reserved for you') });
        expect(cancelQuestion('repair', 'uploading').confirmText).toBe('Pause repair');
        expect(cancelQuestion('start', 'downloading').message).toContain('only downloads the rest');
        expect(cancelQuestion('down', 'downloading').confirmText).toBe('Cancel download');
    });

    test('Continue runs the same thing again; an upload that sent nothing continues as "upload my changes"', () => {
        expect(continueAction('start')).toBe('start');
        expect(continueAction('down')).toBe('down');
        expect(continueAction('repair')).toBe('repair');
        expect(continueAction('stop')).toBe('up');
        expect(continueAction(null)).toBeNull();
    });
});

describe('repairBlocker', () => {
    const unfinished = (patch: Partial<SyncReport> = {}) => report({ status: 'unfinished-upload', lock: stale({ phase: 'uploading' }), ...patch });

    test('allows a repair only from a PC at the last saved version', () => {
        expect(repairBlocker(unfinished())).toBeNull();
        expect(repairBlocker(unfinished({ baseRevision: 41 }))).toMatch(/has revision 41, but the last saved version is revision 42/);
        expect(repairBlocker(unfinished({ baseRevision: null }))).toMatch(/never synced/);
        expect(repairBlocker(unfinished({ remoteRevision: null, baseRevision: null }))).toMatch(/no saved version/);
        expect(repairBlocker(report())).toMatch(/no unfinished upload/);
    });
});

describe('an unfinished upload of this PC', () => {
    const leftover: LockView = { state: 'stale', lock: lockContent({ phase: 'uploading' }), ageSeconds: 5, leftByThisPc: true };

    test('does not block Start, which finishes it first', () => {
        expect(startBlocker(report({ lock: leftover }), null)).toBeNull();
        expect(startBlocker(report({ lock: stale({ phase: 'uploading' }), unfinishedHere: true }), null)).toBeNull();
        expect(startBlocker(report({ lock: stale({ phase: 'uploading' }) }), null)).toBe('Alex\'s upload did not finish.');
    });

    test('is named as this PC\'s, not another PC\'s', () => {
        expect(hostingMessage(leftover, 'alex@example.com')).toBe('has an unfinished upload from this PC.');
        expect(hostingMessage({ ...leftover, lock: lockContent({ phase: 'running' }) }, 'alex@example.com'))
            .toBe('was still reserved by this PC when Drive Launcher closed.');
    });

    test('the card says how to finish it', () => {
        const ctx = { myEmail: 'me@example.com', nameFor: (email: string) => email, now: NOW };
        expect(describeReport(report({ status: 'new-server', unfinishedHere: true }), ctx))
            .toMatchObject({ tone: 'warn', pill: 'Unfinished upload', title: 'Your last upload didn\'t finish' });
    });
});

describe('manualSyncBlockers', () => {
    test('offers only the transfer that would do something', () => {
        expect(manualSyncBlockers(report())).toEqual({ down: 'Already up to date', up: 'Nothing changed on this PC' });
        expect(manualSyncBlockers(report({ status: 'cloud-newer' }))).toEqual({ down: null, up: 'Download the newer version first' });
        expect(manualSyncBlockers(report({ status: 'local-changes' }))).toEqual({ down: 'Nothing new in the cloud', up: null });
        expect(manualSyncBlockers(report({ status: 'diverged', pendingChoice: 'keep-cloud' })).down).toBeNull();
        expect(manualSyncBlockers(report({ unfinishedHere: true })).up).toBeNull();
        expect(manualSyncBlockers(null)).toEqual({ down: null, up: null });
    });
});
