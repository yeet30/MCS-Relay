// What the UI derives from the session phase, the SyncReport and the lock view. Pure, so the decisions
// (can I start? what does the card say?) are tested without React or Electron.
import type {
    AppErrorInfo, ConflictChoice, LockPhase, LockView, PendingCleanup, ServerId, SessionPhase, SessionState,
    SyncReport, SyncStatus, TransferSnapshot,
} from '../../shared/types';
import { formatAgo, formatBytes, formatCount, formatWhen, listNames, plural } from './format';

/* ------------------------------------------------------------------ phases */

const BUSY_LABELS: Record<Exclude<SessionPhase, 'idle' | 'running' | 'failed' | 'upload-pending'>, string> = {
    checking: 'Checking for changes…',
    claiming: 'Reserving the server…',
    downloading: 'Downloading the world…',
    launching: 'Starting the server…',
    stopping: 'Saving the world…',
    uploading: 'Uploading the world…',
    releasing: 'Releasing the server…',
};

/** The session is doing something that blocks switching servers or changing what is selected. */
export function isSessionBusy(phase: SessionPhase): boolean {
    return phase !== 'idle' && phase !== 'failed';
}

/** I am hosting `serverId` from this PC (any phase between Start and the end of the upload). */
export function isMySession(session: SessionState, serverId: ServerId | null): boolean {
    return serverId !== null && session.serverId === serverId && session.phase !== 'idle';
}

const LOCK_PHASE_WORDS: Record<LockPhase, string> = {
    free: 'not hosting',
    claiming: 'reserving the server',
    downloading: 'downloading the world',
    launching: 'starting the server',
    running: 'hosting the server',
    stopping: 'stopping the server',
    uploading: 'uploading the world',
    releasing: 'releasing the server',
};

export function lockPhaseWords(phase: LockPhase): string {
    return LOCK_PHASE_WORDS[phase];
}

/* ------------------------------------------------------------------ the power button */

export type PowerMode =
    | { kind: 'start'; enabled: boolean; reason: string | null }
    | { kind: 'stop' }
    | { kind: 'busy'; label: string }
    | { kind: 'failed'; error: AppErrorInfo | null }
    | { kind: 'upload-pending'; error: AppErrorInfo | null };

/** Why Start is not allowed for this report and lock, or null when it is. */
export function startBlocker(report: SyncReport | null, lock: LockView | null): string | null {
    if (!report) return 'Checking the server first…';
    switch (report.status) {
        case 'unfinished-upload':
            return 'The last upload did not finish yet.';
        case 'no-local-path':
            return 'Choose a folder for this server first.';
        case 'error':
            return report.error ?? 'The server could not be checked.';
        case 'diverged':
            if (!report.pendingChoice) return 'Pick which version to keep first.';
            break;
        default:
            break;
    }
    const view = lock ?? report.lock;
    if (view.state === 'held') return `${view.lock.host.name} is ${lockPhaseWords(view.lock.phase)}.`;
    if (view.state === 'stale' && view.lock.phase === 'uploading') return `${view.lock.host.name}'s upload did not finish.`;
    // 'free', 'stale' (not uploading: the holder vanished) and 'mine' (left over from this PC) can be claimed.
    return null;
}

export function powerMode(
    session: SessionState,
    serverId: ServerId | null,
    report: SyncReport | null,
    lock: LockView | null,
): PowerMode {
    switch (session.phase) {
        case 'running':
            return { kind: 'stop' };
        case 'failed':
            return { kind: 'failed', error: session.error };
        case 'upload-pending':
            return { kind: 'upload-pending', error: session.error };
        case 'idle': {
            if (serverId === null) return { kind: 'start', enabled: false, reason: 'Select a server first.' };
            const relevant = report !== null && report.serverId === serverId ? report : null;
            const reason = startBlocker(relevant, lock);
            return { kind: 'start', enabled: reason === null, reason };
        }
        default:
            return { kind: 'busy', label: BUSY_LABELS[session.phase] };
    }
}

export function canStart(session: SessionState, serverId: ServerId | null, report: SyncReport | null, lock: LockView | null): boolean {
    const mode = powerMode(session, serverId, report, lock);
    return mode.kind === 'start' && mode.enabled;
}

/* ------------------------------------------------------------------ who is playing */

export interface Presence {
    players: string[];
    startedAt: string | null;
    address: string | null;
}

/** Players, start time and address of the running server: from my session when I host it, otherwise from the
 *  lock its host keeps up to date. null when nobody is running it. */
export function livePresence(session: SessionState, serverId: ServerId | null, lock: LockView | null): Presence | null {
    if (serverId === null) return null;
    if (isMySession(session, serverId)) {
        if (session.phase !== 'running') return null;
        return { players: session.players, startedAt: session.startedAt, address: session.address };
    }
    if (!lock || lock.state === 'free' || lock.state === 'stale') return null;
    if (lock.lock.phase !== 'running') return null;
    return { players: lock.lock.players, startedAt: lock.lock.startedAt, address: lock.lock.address };
}

/** The line next to the server picker: "<server> is currently hosted by Alex at:". */
export function hostingMessage(view: LockView | null, myEmail: string | null): string {
    if (!view || view.state === 'free') return 'is not being hosted right now.';
    const { host, phase, address } = view.lock;
    const isMe = myEmail !== null && host.email === myEmail;
    const who = view.state === 'mine' ? 'you' : isMe ? 'you on another PC' : host.name;
    if (view.state === 'stale') {
        if (phase === 'uploading') return `has an unfinished upload from ${who}.`;
        return `was last used by ${who}, whose app stopped responding ${formatAgo(view.ageSeconds)} ago.`;
    }
    switch (phase) {
        case 'running':
            return `is currently hosted by ${who}${address ? ' at:' : '.'}`;
        case 'claiming':
            return `is being reserved by ${who}.`;
        case 'downloading':
            return `is being downloaded by ${who}.`;
        case 'launching':
            return `is being started by ${who}.`;
        case 'stopping':
            return `is being stopped by ${who}.`;
        case 'uploading':
            return `is being uploaded by ${who}.`;
        case 'releasing':
            return `is being released by ${who}.`;
        default:
            return 'is not being hosted right now.';
    }
}

/* ------------------------------------------------------------------ the sync status card */

export type Tone = 'good' | 'info' | 'warn' | 'bad';

export interface CardCopy {
    tone: Tone;
    pill: string;
    title: string;
    body: string;
}

export interface CopyContext {
    myEmail: string | null;
    /** A member's display name for an email (falls back to the email). */
    nameFor: (email: string) => string;
    now: number;
}

const PILLS: Record<SyncStatus, { tone: Tone; pill: string }> = {
    'in-sync': { tone: 'good', pill: 'In sync' },
    'local-changes': { tone: 'info', pill: 'Local changes' },
    'cloud-newer': { tone: 'info', pill: 'Cloud is newer' },
    diverged: { tone: 'warn', pill: 'Both changed' },
    'new-server': { tone: 'info', pill: 'New server' },
    'unfinished-upload': { tone: 'bad', pill: 'Unfinished upload' },
    'no-local-path': { tone: 'warn', pill: 'No folder' },
    error: { tone: 'bad', pill: 'Error' },
};

export const CHOICE_LABELS: Record<ConflictChoice, string> = {
    'keep-cloud': 'Keep cloud version',
    'keep-local': 'Keep my version',
    combine: 'Combine both',
};

/** The wording used on the first sync on this PC, where "your version" is just whatever is in the folder. */
export const FIRST_SYNC_CHOICE_LABELS: Record<ConflictChoice, string> = {
    'keep-cloud': 'Use the cloud version (recommended)',
    'keep-local': 'Upload this folder',
    combine: 'Combine both',
};

const CHOICE_OUTCOMES: Record<ConflictChoice, string> = {
    'keep-cloud': 'You chose the cloud version. Your differing files were copied to the backups folder; press Start to download the cloud version.',
    'keep-local': 'You chose your version. It replaces the cloud version when your next session ends.',
    combine: 'You chose to combine both. Their changes are downloaded when you start, yours are uploaded when the session ends.',
};

function authorName(report: SyncReport, ctx: CopyContext): string {
    const author = report.remoteAuthor;
    if (!author) return 'someone';
    if (ctx.myEmail !== null && author.email === ctx.myEmail) return 'you';
    return author.name || ctx.nameFor(author.email);
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function changedNames(report: SyncReport): string {
    const names = [...report.plan.upload, ...report.plan.deleteRemote].sort();
    const verb = report.plan.deleteRemote.length === 0
        ? 'changed'
        : report.plan.upload.length === 0 ? (names.length === 1 ? 'was deleted' : 'were deleted') : 'changed or were deleted';
    return `${listNames(names)} ${verb}`;
}

function lockHost(report: SyncReport): { name: string; email: string } | null {
    return report.lock.state === 'free' ? (report.lock.lock?.host ?? null) : report.lock.lock.host;
}

/** When the stale lock was last written, i.e. roughly when the upload stopped. */
function stoppedAt(report: SyncReport): string | null {
    if (report.lock.state === 'free') return null;
    const checked = Date.parse(report.checkedAt);
    if (Number.isNaN(checked)) return null;
    return new Date(checked - report.lock.ageSeconds * 1000).toISOString();
}

export function describeReport(report: SyncReport, ctx: CopyContext): CardCopy {
    const { tone, pill } = PILLS[report.status];
    const plan = report.plan;
    const revision = report.remoteRevision;
    const when = formatWhen(report.remoteCreatedAt, ctx.now);
    const author = authorName(report, ctx);

    switch (report.status) {
        case 'in-sync':
            return {
                tone, pill, title: 'Up to date',
                body: revision === null
                    ? 'Your copy matches the cloud.'
                    : report.firstSyncOnThisPc
                        ? `This folder already matches revision ${revision} in the cloud.`
                        : `Your copy matches revision ${revision}, uploaded by ${author} ${when}.`,
            };
        case 'local-changes': {
            const count = plan.upload.length + plan.deleteRemote.length;
            const size = report.uploadBytes > 0 ? ` (${formatBytes(report.uploadBytes)})` : '';
            return {
                tone, pill,
                title: count === 1 ? '1 change isn\'t in the cloud yet' : `${formatCount(count)} changes aren't in the cloud yet`,
                body: report.firstSyncOnThisPc
                    ? `This folder has files the cloud doesn't have${size}. They'll be uploaded when your next session ends.`
                    // File names keep their case, even at the start of the sentence.
                    : `${changedNames(report)} after your last sync${size}. They'll be uploaded when your next session ends.`,
            };
        }
        case 'cloud-newer': {
            const download = `${plural(plan.download.length, 'file')} (${formatBytes(report.downloadBytes)}) will be downloaded`;
            const removals = plan.deleteLocal.length > 0
                ? ` ${plural(plan.deleteLocal.length, 'file')} deleted in the cloud will be removed from this PC.`
                : '';
            const what = plan.download.length > 0 ? `${download} when you start.` : 'Nothing needs downloading.';
            if (report.firstSyncOnThisPc) {
                return {
                    tone, pill, title: 'First sync on this PC',
                    body: plan.download.length > 0
                        ? `${download} into this folder when you start.${removals}`
                        : `${what}${removals}`,
                };
            }
            return {
                tone, pill,
                title: author === 'you' ? 'You played on another PC' : `${author} played after you`,
                body: `Revision ${revision ?? '?'}, ${when}. ${what}${removals}`,
            };
        }
        case 'diverged': {
            const conflicts = plan.conflicts.length;
            const conflictLine = conflicts > 0
                ? ` ${plural(conflicts, 'file')} changed on both sides.`
                : ' No single file changed on both sides, so you can also combine them.';
            const chosen = report.pendingChoice ? ` ${CHOICE_OUTCOMES[report.pendingChoice]}` : '';
            if (report.firstSyncOnThisPc) {
                return {
                    tone, pill, title: 'This folder differs from the cloud',
                    body: report.pendingChoice
                        ? CHOICE_OUTCOMES[report.pendingChoice]
                        : 'This PC has never synced this server and its folder has files that differ from the cloud. Use the cloud version (recommended) or upload this folder? Files replaced on this PC are copied to backups first.',
                };
            }
            const theirs = author === 'you' ? 'Your session on another PC' : `${capitalize(author)}'s session`;
            const since = report.baseRevision !== null ? ` since revision ${report.baseRevision}` : '';
            return {
                tone, pill, title: 'Your copy and the cloud both changed',
                body: report.pendingChoice
                    ? chosen.trim()
                    : `${theirs} (revision ${revision ?? '?'}) and your edits${since} touch the same world. Pick the version to keep.${conflictLine}`,
            };
        }
        case 'new-server': {
            const count = plan.upload.length;
            return {
                tone, pill, title: 'Nothing in the cloud yet',
                body: count > 0
                    ? `This folder becomes the first version: ${plural(count, 'file')} (${formatBytes(report.uploadBytes)}) will be uploaded when your first session ends.`
                    : 'This folder is empty. Put your server files in it and press Start; they are uploaded when the session ends.',
            };
        }
        case 'unfinished-upload': {
            const host = lockHost(report);
            const stopped = formatWhen(stoppedAt(report), ctx.now);
            const mine = host !== null && ctx.myEmail !== null && host.email === ctx.myEmail;
            const name = host ? host.name || ctx.nameFor(host.email) : 'Someone';
            return {
                tone, pill,
                title: mine ? 'Your last upload didn\'t finish' : `${name}'s last upload didn't finish`,
                body: mine
                    ? `It stopped halfway ${stopped}, so the cloud is a mix of old and new files. Drive Launcher finishes it on its own the next time it starts on the PC you played on.`
                    : `It stopped halfway ${stopped}, so the cloud is a mix of old and new files. Ask ${name} to open Drive Launcher; it will finish the upload on its own.`,
            };
        }
        case 'no-local-path':
            return {
                tone, pill, title: 'Choose a folder on this PC',
                body: 'Pick where this server\'s files live on this PC. The world is downloaded there when you start.',
            };
        case 'error':
        default:
            return {
                tone, pill, title: 'Couldn\'t check the server',
                body: report.error ?? 'Something went wrong while comparing your folder with the cloud.',
            };
    }
}

/** "3 deleted files are waiting for Alex to open Drive Launcher", "Cleaning up 2 of your old files". */
export function cleanupLines(cleanup: PendingCleanup, nameFor: (email: string) => string): string[] {
    const lines: string[] = [];
    for (const other of cleanup.others) {
        if (other.count <= 0) continue;
        const files = other.count === 1 ? '1 deleted file is' : `${formatCount(other.count)} deleted files are`;
        lines.push(`${files} waiting for ${nameFor(other.ownerEmail)} to open Drive Launcher.`);
    }
    if (cleanup.mine > 0) lines.push(`Cleaning up ${formatCount(cleanup.mine)} of your old ${cleanup.mine === 1 ? 'file' : 'files'}.`);
    return lines;
}

/** True when the report lists any file to show in "Show files". */
export function planHasFiles(report: SyncReport): boolean {
    const plan = report.plan;
    return plan.upload.length + plan.download.length + plan.deleteRemote.length + plan.deleteLocal.length + plan.conflicts.length > 0;
}

/* ------------------------------------------------------------------ transfers */

/** Overall progress 0..1: by bytes when there are bytes to move, else by files (deletions have no size). */
export function transferFraction(snapshot: TransferSnapshot): number {
    if (snapshot.bytesTotal > 0) return clamp01(snapshot.bytesDone / snapshot.bytesTotal);
    if (snapshot.filesTotal > 0) return clamp01((snapshot.filesDone + snapshot.filesFailed) / snapshot.filesTotal);
    return 0;
}

export function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}
