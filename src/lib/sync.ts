// What the UI derives from the session phase, the SyncReport and the lock view. Pure, so the decisions
// (can I start? what does the card say?) are tested without React or Electron.
import type {
    AppErrorInfo, ConflictChoice, LockPhase, LockView, LogoState, PendingCleanup, RunKind, ServerId, SessionPhase,
    SessionState, SyncReport, SyncStatus, TransferSnapshot,
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
    // This PC's own unfinished upload does not block: Start finishes it first.
    if (view.state === 'stale' && view.lock.phase === 'uploading' && !view.leftByThisPc && !report.unfinishedHere) {
        return `${view.lock.host.name}'s upload did not finish.`;
    }
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

/* ------------------------------------------------------------------ cancel, pause and continue */

/** What the button on the progress card does now: a start or a download is cancelled, an upload is paused.
 *  null while nothing can be stopped (the server runs, Java saves the world, the server is being released). */
export function cancelMode(phase: SessionPhase): 'cancel' | 'pause' | null {
    if (phase === 'uploading') return 'pause';
    if (phase === 'checking' || phase === 'claiming' || phase === 'downloading' || phase === 'launching') return 'cancel';
    return null;
}

export interface Question {
    message: string;
    confirmText: string;
    cancelText: string;
}

/** Runs that finish an upload of this PC: stopping them keeps what was sent, so they pause. */
const PAUSING_KINDS = new Set<RunKind>(['stop', 'retry', 'resume']);

/** The stop button of the progress card, shown for the whole run: Pause for an upload, Cancel otherwise, and
 *  why it does not work at the moment (null when it does). */
export function stopControl(kind: RunKind | null, phase: SessionPhase): { label: 'Pause' | 'Cancel'; reason: string | null } {
    // Pressed while Java saves the world, it is acted on once the server has stopped: no upload starts.
    if (phase === 'stopping' && kind === 'stop') return { label: 'Pause', reason: null };
    const mode = cancelMode(phase);
    const pauses = mode === 'pause' || (kind !== null && PAUSING_KINDS.has(kind)) || (mode === null && (kind === 'up' || kind === 'repair'));
    const label = pauses ? 'Pause' : 'Cancel';
    if (mode !== null) return { label, reason: null };
    switch (phase) {
        case 'stopping':
            return { label, reason: 'The Minecraft server is saving the world first. You can pause as soon as the upload starts.' };
        case 'releasing':
            return { label, reason: 'Almost done: the server is being released for the others.' };
        default:
            return { label, reason: 'Not possible at this moment.' };
    }
}

/** "Cancel upload…" (for good) sits next to Pause while an upload of this PC runs; it works when Pause does. */
export function abandonControl(kind: RunKind | null, phase: SessionPhase): { show: boolean; reason: string | null } {
    const show = kind === 'stop' || kind === 'retry' || kind === 'resume' || (kind === 'up' && phase === 'uploading');
    return { show, reason: show ? stopControl(kind, phase).reason : null };
}

function sameEmail(a: string, b: string | null): boolean {
    return b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function changesSent(sent: number, planned: number | null): string {
    return planned !== null ? `${formatCount(sent)} of ${formatCount(planned)} changes` : plural(sent, 'change');
}

/** The red box on the status card while the cloud's last revision comes from a cancelled upload. */
export function incompleteWarning(report: SyncReport, ctx: CopyContext): { title: string; body: string } | null {
    const inc = report.remoteIncomplete;
    if (!inc) return null;
    const mine = sameEmail(inc.by.email, ctx.myEmail);
    const when = formatWhen(inc.at, ctx.now);
    const amount = changesSent(inc.sent, inc.planned);
    return {
        title: `Revision ${report.remoteRevision ?? '?'} is incomplete`,
        body: mine
            ? `You cancelled your upload ${when} after ${amount} reached the cloud. Whoever plays it now gets a mix of your session and the one before; your next upload sends the rest and makes it complete.`
            : `${inc.by.name || ctx.nameFor(inc.by.email)} cancelled their upload ${when} after ${amount} reached the cloud, so it mixes their session with the one before. It may have broken or regenerated chunks, lost or duplicated items, or players in old places.`,
    };
}

/** Asked before starting a revision saved from a cancelled upload. null when there is nothing to ask: the uploader's
 *  own PC still has the whole session, plays that, and its next upload completes the cloud. */
export function incompleteStartQuestion(report: SyncReport | null, myEmail: string | null): Question | null {
    const inc = report?.remoteIncomplete;
    if (!report || !inc) return null;
    const mine = sameEmail(inc.by.email, myEmail);
    if (mine && report.status === 'local-changes' && report.baseRevision === report.remoteRevision) return null;
    const who = mine ? 'you' : inc.by.name || inc.by.email;
    const instead = mine
        ? 'If the PC you uploaded from still has your session, start it there instead: its next upload makes the version complete.'
        : `If ${who} can still finish their upload, wait for that instead: it makes the version complete.`;
    return {
        message: `Start an incomplete version?\n\nRevision ${report.remoteRevision ?? '?'} was saved from an upload ${who} cancelled half way (${changesSent(inc.sent, inc.planned)} reached the cloud), so the world mixes two sessions. It may have broken or regenerated chunks, lost or duplicated items, or players in old places. Whatever happens in it is kept.\n\n${instead}`,
        confirmText: 'Start anyway',
        cancelText: 'Don\'t start',
    };
}

/** Asked before cancelling or pausing, so the user knows what happens to their files and to the server. */
export function cancelQuestion(kind: RunKind | null, phase: SessionPhase): Question {
    const cancelText = 'Keep going';
    if (phase === 'stopping') {
        return {
            message: 'Pause before the upload starts?\n\nThe Minecraft server is saving the world first. Once it has stopped, nothing is uploaded and the server stays reserved for you. Press "Continue upload" when you are ready to send your changes.',
            confirmText: 'Pause upload',
            cancelText,
        };
    }
    if (stopControl(kind, phase).label === 'Pause') {
        const what = kind === 'repair' ? 'repair' : 'upload';
        return {
            message: `Pause the ${what}?\n\nWhat is already uploaded stays on Google Drive, and the server stays reserved for you: nobody else can start it until the ${what} is finished.\n\nUse this to switch to another network, for example. Press "Continue ${what}" when you are ready. If you close MCS-Relay meanwhile, it continues the next time you open it.`,
            confirmText: `Pause ${what}`,
            cancelText,
        };
    }
    switch (kind) {
        case 'down':
            return {
                message: 'Cancel the download?\n\nThe server is freed for the others. Files that already arrived stay in your folder, so downloading again only fetches the rest.',
                confirmText: 'Cancel download', cancelText,
            };
        case 'up':
            return {
                message: 'Cancel the upload?\n\nNothing has been sent yet, so the cloud stays as it is. Your changes stay on this PC.',
                confirmText: 'Cancel upload', cancelText,
            };
        case 'repair':
            return { message: 'Cancel the repair?\n\nNothing has been changed in the cloud yet.', confirmText: 'Cancel repair', cancelText };
        default:
            return {
                message: 'Cancel the start?\n\nThe server is freed for the others. Files that were already downloaded stay in your folder, so the next start only downloads the rest.',
                confirmText: 'Cancel start', cancelText,
            };
    }
}

/** After a run was cancelled and the session is idle again: what Continue runs. An upload cancelled before
 *  anything was sent continues as "Upload my changes". */
export function continueAction(kind: RunKind | null): 'start' | 'down' | 'up' | 'repair' | null {
    switch (kind) {
        case 'start':
        case 'down':
        case 'repair':
            return kind;
        case 'stop':
        case 'retry':
        case 'resume':
        case 'up':
            return 'up';
        default:
            return null;
    }
}

/** Why "Download latest" and "Upload my changes" would do nothing right now (null when they would). The main
 *  process checks again; this only spares a click that ends in an error. */
export function manualSyncBlockers(report: SyncReport | null): { down: string | null; up: string | null } {
    if (!report) return { down: null, up: null };
    if (report.unfinishedHere) return { down: 'Finish your unfinished upload first', up: null };
    switch (report.status) {
        case 'in-sync':
            return { down: 'Already up to date', up: 'Nothing changed on this PC' };
        case 'new-server':
            return { down: 'Nothing in the cloud yet', up: null };
        case 'cloud-newer':
            return { down: null, up: 'Download the newer version first' };
        case 'local-changes':
            return { down: 'Nothing new in the cloud', up: null };
        case 'diverged':
            return { down: report.pendingChoice ? null : 'Choose which version to keep first', up: 'Choose which version to keep first' };
        case 'unfinished-upload':
            return { down: 'The last upload did not finish', up: 'The last upload did not finish' };
        case 'no-local-path':
            return { down: 'Choose a folder first', up: 'Choose a folder first' };
        default:
            return { down: null, up: null };
    }
}

/** Why this PC cannot repair the server, or null when it can. The main process checks the same rules. */
export function repairBlocker(report: SyncReport): string | null {
    if (report.status !== 'unfinished-upload') return 'There is no unfinished upload to repair.';
    if (report.remoteRevision === null) return 'The cloud has no saved version yet, so there is nothing to repair it to.';
    if (report.baseRevision === null) {
        return `This PC has never synced this server, so it does not have revision ${report.remoteRevision}, the last saved version.`;
    }
    if (report.baseRevision !== report.remoteRevision) {
        return `This PC has revision ${report.baseRevision}, but the last saved version is revision ${report.remoteRevision}. Only a PC that has revision ${report.remoteRevision} can repair it.`;
    }
    return null;
}

/* ------------------------------------------------------------------ checking Google Drive again */

/** What the reload button found: servers that appeared (shared with you), disappeared (deleted, or you were
 *  removed) or were renamed since the last listing. */
export function describeServerChanges(
    before: ReadonlyArray<{ id: ServerId; name: string }>, after: ReadonlyArray<{ id: ServerId; name: string }>,
): string {
    const old = new Map(before.map((s) => [s.id, s.name]));
    const now = new Map(after.map((s) => [s.id, s.name]));
    const added = after.filter((s) => !old.has(s.id)).map((s) => s.name);
    const removed = before.filter((s) => !now.has(s.id)).map((s) => s.name);
    const renamed = after.filter((s) => old.has(s.id) && old.get(s.id) !== s.name).map((s) => `${old.get(s.id)} is now ${s.name}`);
    const parts: string[] = [];
    if (added.length > 0) parts.push(`new: ${listNames(added)}`);
    if (removed.length > 0) parts.push(`gone: ${listNames(removed)}`);
    if (renamed.length > 0) parts.push(renamed.join(', '));
    if (parts.length === 0) return 'Checked Google Drive: your servers have not changed.';
    const text = parts.join('; ');
    return `Checked Google Drive. ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
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

/** The comparator in the title bar, the taskbar and the tray (see LogoState). */
export function logoState(session: SessionState, serverId: ServerId | null, lock: LockView | null): LogoState {
    if (livePresence(session, serverId, lock) === null) return 'off';
    return isMySession(session, serverId) ? 'here' : 'elsewhere';
}

/** The line next to the server picker: "<server> is currently hosted by Alex at:". */
export function hostingMessage(view: LockView | null, myEmail: string | null): string {
    if (!view || view.state === 'free') return 'is not being hosted right now.';
    const { host, phase, address } = view.lock;
    const isMe = myEmail !== null && host.email === myEmail;
    const who = view.state === 'mine' ? 'you' : view.leftByThisPc ? 'this PC' : isMe ? 'you on another PC' : host.name;
    if (view.state === 'stale') {
        if (phase === 'uploading') return `has an unfinished upload from ${who}.`;
        if (view.leftByThisPc) return 'was still reserved by this PC when MCS-Relay closed.';
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

/** Shown wherever a first upload is about to happen or is running. */
export const FIRST_UPLOAD_HINT = 'The first upload takes much longer than later ones, because every folder and file has to be created on Google Drive.';

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
export function stoppedAt(report: SyncReport): string | null {
    if (report.lock.state === 'free') return null;
    const checked = Date.parse(report.checkedAt);
    if (Number.isNaN(checked)) return null;
    return new Date(checked - report.lock.ageSeconds * 1000).toISOString();
}

export function describeReport(report: SyncReport, ctx: CopyContext): CardCopy {
    if (report.unfinishedHere && report.status !== 'no-local-path' && report.status !== 'error' && report.status !== 'unfinished-upload') {
        return {
            tone: 'warn', pill: 'Unfinished upload', title: 'Your last upload didn\'t finish',
            body: 'It stopped before everything was sent, for example because MCS-Relay was closed. Press Start or "Upload my changes" to finish it; until then nobody else can start this server.',
        };
    }
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
                    ? `This folder becomes the first version: ${plural(count, 'file')} (${formatBytes(report.uploadBytes)}) will be uploaded when your first session ends. ${FIRST_UPLOAD_HINT}`
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
                    ? `It stopped halfway ${stopped}, so the cloud is a mix of old and new files. MCS-Relay finishes it on its own the next time it starts on the PC you played on.`
                    : `It stopped halfway ${stopped}, so the cloud is a mix of old and new files. Ask ${name} to open MCS-Relay; it will finish the upload on its own.`,
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

/** "3 deleted files are waiting for Alex to open MCS-Relay", "Cleaning up 2 of your old files". */
export function cleanupLines(cleanup: PendingCleanup, nameFor: (email: string) => string): string[] {
    const lines: string[] = [];
    for (const other of cleanup.others) {
        if (other.count <= 0) continue;
        const files = other.count === 1 ? '1 deleted file is' : `${formatCount(other.count)} deleted files are`;
        lines.push(`${files} waiting for ${nameFor(other.ownerEmail)} to open MCS-Relay.`);
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
