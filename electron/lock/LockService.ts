// Who may run a server right now, kept in <server folder>/.launcher/lock.json.
// The lock is a lease: the holder rewrites the file every renewEveryMs, and a lock whose modifiedTime is
// older than its leaseSeconds is stale. Age is measured with Google's clock only (modifiedTime against the
// Date header of the same response), so a PC with a wrong clock cannot misjudge it.
// Drive has no "write only if unchanged", so claim() writes, waits, reads back, and every renewal re-checks
// that the session id in the file is still ours. inspect() never writes.
import { createHash, randomUUID } from 'node:crypto';
import type { LockContent, LockPhase, LockView, PlayitTunnel, UserInfo } from '../../shared/types';
import { DriveError } from '../drive/types';
import type { DriveApi } from '../drive/types';
import { AppError } from '../errors';
import type { LauncherFiles } from '../sync/launcherFiles';

export interface LockServiceDeps {
    drive: DriveApi;
    launcher: LauncherFiles;
    me: () => Promise<UserInfo>;
    onLost: (serverId: string, reason: string) => void;
    sleep?: (ms: number) => Promise<void>;     // default real timer; tests pass a fake
    renewEveryMs?: number;                     // 15000
    leaseSeconds?: number;                     // 45
    claimSettleMs?: number;                    // 3000
    /** The session this PC holds per server, kept on disk, so a lock left behind by a crash of this app is
     *  recognised after a restart instead of looking like someone else's. */
    remember?: { read(serverId: string): string | null; write(serverId: string, sessionId: string | null): void };
    /** This PC wrote the lock (claimed, changed or released it): how it looks now. The idle poll does not run during
     *  a session, so without this nobody would learn that the server is now hosted here. */
    onChange?: (serverId: string, view: LockView) => void;
    /** A claim took over a stale lock of a session that was hosting (it never stopped): that lock, and roughly when it
     *  ended (its last renewal). Called once the claim holds the server. */
    onStaleTakeover?: (serverId: string, lock: LockContent, endedAt: string) => void;
}

export type LockPatch = Partial<Pick<LockContent, 'phase' | 'address' | 'players' | 'startedAt' | 'baseRevision' | 'tunnels'>>;

const LOCK_FILE = 'lock.json';
const LOST_REASON = 'Another member took over the server.';
const NOT_HOLDING = 'This PC no longer holds the server.';
// getMeta and readText are two requests; a write landing between them would pair new content with an old
// modifiedTime. The md5 of the text tells us whether they belong together.
const CONSISTENT_READ_ATTEMPTS = 3;

const PHASES: readonly LockPhase[] = [
    'free', 'claiming', 'downloading', 'launching', 'running', 'stopping', 'uploading', 'releasing',
];

const PHASE_TEXT: Record<LockPhase, string> = {
    free: 'using the server',
    claiming: 'starting the server',
    downloading: 'downloading the world',
    launching: 'starting the server',
    running: 'running the server',
    stopping: 'stopping the server',
    uploading: 'uploading the world',
    releasing: 'finishing a session',
};

/* ------------------------------------------------------------------ lock.json format */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is LockPhase {
    return typeof value === 'string' && (PHASES as readonly string[]).includes(value);
}

function invalidLock(detail: string): AppError {
    return new AppError('INVALID', 'The lock file on Google Drive is damaged.', detail);
}

/** Validates lock.json (format 2). Missing startedAt/address/players/tunnels default to null/null/[]/[].
 *  Throws AppError('INVALID') for anything else that is wrong. */
export function parseLock(text: string): LockContent {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw invalidLock('lock.json is not valid JSON');
    }
    if (!isRecord(raw)) throw invalidLock('lock.json is not an object');
    if (raw.format !== 2) throw invalidLock(`unsupported lock format ${String(raw.format)}`);
    const { sessionId, host, phase, leaseSeconds, baseRevision } = raw;
    if (typeof sessionId !== 'string') throw invalidLock('sessionId is missing');
    if (!isRecord(host) || typeof host.name !== 'string' || typeof host.email !== 'string') throw invalidLock('host is missing');
    if (!isPhase(phase)) throw invalidLock(`unknown phase ${String(phase)}`);
    if (typeof leaseSeconds !== 'number' || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0) throw invalidLock('leaseSeconds is invalid');
    if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 0) throw invalidLock('baseRevision is invalid');
    return {
        format: 2,
        sessionId,
        host: { name: host.name, email: host.email },
        phase,
        leaseSeconds,
        baseRevision,
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
        address: typeof raw.address === 'string' ? raw.address : null,
        players: Array.isArray(raw.players) ? raw.players.filter((p): p is string => typeof p === 'string') : [],
        tunnels: Array.isArray(raw.tunnels) ? raw.tunnels.filter(isTunnel).map(({ address, type, local }) => ({ address, type, local })) : [],
    };
}

function isTunnel(value: unknown): value is PlayitTunnel {
    return isRecord(value) && typeof value.address === 'string' && typeof value.type === 'string' && typeof value.local === 'string';
}

/** Stable key order, 2-space JSON. */
export function serializeLock(lock: LockContent): string {
    const ordered: LockContent = {
        format: 2,
        sessionId: lock.sessionId,
        host: { name: lock.host.name, email: lock.host.email },
        phase: lock.phase,
        leaseSeconds: lock.leaseSeconds,
        baseRevision: lock.baseRevision,
        startedAt: lock.startedAt,
        address: lock.address,
        players: [...lock.players],
        tunnels: lock.tunnels.map(({ address, type, local }) => ({ address, type, local })),
    };
    return JSON.stringify(ordered, null, 2);
}

function hostName(lock: LockContent): string {
    return lock.host.name || lock.host.email || 'Another member';
}

function sameEmail(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isNotFound(err: unknown): boolean {
    return err instanceof DriveError && err.status === 404;
}

function md5Hex(text: string): string {
    return createHash('md5').update(text, 'utf8').digest('hex');
}

function applyPatch(content: LockContent, patch: LockPatch): LockContent {
    const next: LockContent = { ...content, host: { ...content.host }, players: [...content.players], tunnels: [...content.tunnels] };
    if (patch.phase !== undefined) next.phase = patch.phase;
    if (patch.address !== undefined) next.address = patch.address;
    if (patch.players !== undefined) next.players = [...patch.players];
    if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
    if (patch.baseRevision !== undefined) next.baseRevision = patch.baseRevision;
    if (patch.tunnels !== undefined) next.tunnels = [...patch.tunnels];
    return next;
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ service */

interface Claim {
    serverId: string;
    sessionId: string;
    content: LockContent;
    /** Verified and renewing. */
    active: boolean;
    /** Released, lost, replaced or disposed: this claim never writes again. */
    stopped: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    /** Serialises renewals, updates and the release so their writes never overtake each other. */
    queue: Promise<void>;
}

type WriteOutcome = 'written' | 'lost' | 'stopped';

export class LockService {
    private readonly drive: DriveApi;
    private readonly launcher: LauncherFiles;
    private readonly me: () => Promise<UserInfo>;
    private readonly onLost: (serverId: string, reason: string) => void;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly renewEveryMs: number;
    private readonly leaseSeconds: number;
    private readonly claimSettleMs: number;
    private readonly remember: LockServiceDeps['remember'];
    private readonly onChange: LockServiceDeps['onChange'];
    private readonly onStaleTakeover: LockServiceDeps['onStaleTakeover'];
    private readonly claims = new Map<string, Claim>();
    private latestSessionId = randomUUID();

    constructor(deps: LockServiceDeps) {
        this.drive = deps.drive;
        this.launcher = deps.launcher;
        this.me = deps.me;
        this.onLost = deps.onLost;
        this.sleep = deps.sleep ?? defaultSleep;
        this.renewEveryMs = deps.renewEveryMs ?? 15_000;
        this.leaseSeconds = deps.leaseSeconds ?? 45;
        this.claimSettleMs = deps.claimSettleMs ?? 3_000;
        this.remember = deps.remember;
        this.onChange = deps.onChange;
        this.onStaleTakeover = deps.onStaleTakeover;
    }

    /** The session id of the most recent claim (a new one per claim). */
    get sessionId(): string {
        return this.latestSessionId;
    }

    /** READ-ONLY: never writes, whatever it finds. A missing or unreadable lock.json counts as free. */
    async inspect(serverId: string): Promise<LockView> {
        const file = await this.readLockFile(serverId);
        if (!file) return { state: 'free', lock: null };
        let lock: LockContent;
        try {
            lock = parseLock(file.text);
        } catch (err) {
            console.warn(`[lock] ${serverId}: ignoring unreadable lock.json:`, err instanceof AppError ? err.detail : err);
            return { state: 'free', lock: null };
        }
        if (lock.phase === 'free') return { state: 'free', lock };
        const modified = Date.parse(file.modifiedTime ?? '');
        // The Date header has whole-second precision, so a just-written lock can look a little "from the future".
        const ageSeconds = Number.isFinite(modified) ? Math.max(0, (file.serverNow - modified) / 1000) : 0;
        const claim = this.claims.get(serverId);
        if (claim && lock.sessionId === claim.sessionId) return { state: 'mine', lock, ageSeconds };
        // Left behind by this PC's previous run: nobody renews it, so there is no lease to wait for.
        if (!claim && this.remembered(serverId) === lock.sessionId) return { state: 'stale', lock, ageSeconds, leftByThisPc: true };
        // The holder's own lease decides, so a version with a different lease is judged by its own rule.
        return { state: ageSeconds > lock.leaseSeconds ? 'stale' : 'held', lock, ageSeconds };
    }

    /** `allowStaleFromMe`: my own unfinished upload may be taken over (this PC resumes it from its journal).
     *  `takeOverUnfinished`: anyone's unfinished upload may be taken over (the owner's repair). A lock that is
     *  still held (renewed) is never taken. */
    async claim(
        serverId: string, baseRevision: number,
        opts: { phase?: LockPhase; allowStaleFromMe?: boolean; takeOverUnfinished?: boolean } = {},
    ): Promise<void> {
        const me = await this.me();
        const before = await this.inspect(serverId);
        if (before.state === 'held') {
            throw new AppError('LOCK_HELD', `${hostName(before.lock)} is ${PHASE_TEXT[before.lock.phase]}.`);
        }
        if (before.state === 'stale' && before.lock.phase === 'uploading') {
            const fromMe = sameEmail(before.lock.host.email, me.email);
            // This PC's own leftover is fine: the session finishes its journal before anything else.
            const allowed = opts.takeOverUnfinished || before.leftByThisPc || (opts.allowStaleFromMe && fromMe);
            if (!allowed) throw unfinishedUpload(before.lock, fromMe);
        }

        const previous = this.claims.get(serverId);
        if (previous) {
            // Claiming again a lock this PC already holds: the old session must stop writing first.
            this.stopRenewing(previous);
            await previous.queue;
        }

        const sessionId = randomUUID();
        this.latestSessionId = sessionId;
        const claim: Claim = {
            serverId,
            sessionId,
            content: {
                format: 2, sessionId, host: { name: me.name, email: me.email }, phase: opts.phase ?? 'claiming',
                leaseSeconds: this.leaseSeconds, baseRevision, startedAt: null, address: null, players: [], tunnels: [],
            },
            active: false,
            stopped: false,
            timer: null,
            queue: Promise.resolve(),
        };
        // Registered before writing: if the read-back fails after our write landed, inspect() still
        // recognises the lock as ours and releaseIfMine() can free it.
        this.claims.set(serverId, claim);
        this.rememberSession(serverId, sessionId);
        await this.write(serverId, claim.content);
        await this.sleep(this.claimSettleMs);
        const after = await this.inspect(serverId);
        if (claim.stopped) throw new AppError('LOCK_LOST', 'The start was cancelled.');
        if (after.state !== 'mine') {
            this.dropClaim(claim);
            throw new AppError('LOCK_HELD', 'Someone else started at the same moment.');
        }
        claim.active = true;
        this.scheduleRenewal(claim);
        this.changed(serverId, { state: 'mine', lock: claim.content, ageSeconds: 0 });
        if (before.state === 'stale' && before.lock.startedAt) {
            this.onStaleTakeover?.(serverId, before.lock, new Date(Date.now() - before.ageSeconds * 1000).toISOString());
        }
    }

    /** Changes what lock.json says. Checks ownership first; if the lock was taken over, calls onLost and
     *  throws LOCK_LOST. When the write fails the patch stays in memory and the next renewal writes it. */
    async update(serverId: string, patch: LockPatch): Promise<void> {
        const claim = this.claims.get(serverId);
        if (!claim || !claim.active) throw new AppError('LOCK_LOST', NOT_HOLDING);
        if (patch.phase === 'free') throw new AppError('INVALID', 'The lock can only be freed by releasing it.');
        claim.content = applyPatch(claim.content, patch);
        const outcome = await this.enqueue(claim, () => this.checkAndWrite(claim));
        if (outcome === 'written') {
            this.changed(serverId, { state: 'mine', lock: claim.content, ageSeconds: 0 });
            return;
        }
        if (outcome === 'lost') this.lose(claim, LOST_REASON);
        throw new AppError('LOCK_LOST', outcome === 'lost' ? LOST_REASON : NOT_HOLDING);
    }

    /** Stops renewing and writes phase "free" (host and session kept for history), but only while the
     *  file still holds our session: a lock someone else took over is never touched. No-op without a claim. */
    async release(serverId: string): Promise<void> {
        const claim = this.claims.get(serverId);
        if (!claim) return;
        this.stopRenewing(claim);
        await claim.queue;                          // let an in-flight renewal or update finish first
        const view = await this.inspect(serverId);
        if (view.state !== 'mine') {
            console.warn(`[lock] ${serverId}: not releasing, the lock is no longer ours (${view.state}).`);
            this.dropClaim(claim);
            return;
        }
        const free: LockContent = { ...claim.content, phase: 'free', address: null, players: [], tunnels: [] };
        // On failure the claim stays registered (inactive), so a later releaseIfMine() can still free it;
        // otherwise the lease simply runs out.
        await this.write(serverId, free);
        claim.content = free;
        this.dropClaim(claim);
        this.changed(serverId, { state: 'free', lock: free });
    }

    /** For cleanup paths: releases only when the lock is ours, and never throws (errors are logged),
     *  so it cannot hide the error that caused the cleanup. */
    async releaseIfMine(serverId: string): Promise<void> {
        try {
            await this.release(serverId);
        } catch (err) {
            console.warn(`[lock] ${serverId}: could not release the lock, it will expire on its own:`, err);
        }
    }

    private changed(serverId: string, view: LockView): void {
        try {
            this.onChange?.(serverId, view);
        } catch (err) {
            console.warn(`[lock] ${serverId}: onChange failed:`, err);
        }
    }

    isHolding(serverId: string): boolean {
        return this.claims.get(serverId)?.active === true;
    }

    /** Stops every renewal timer. Writes nothing. */
    dispose(): void {
        for (const claim of this.claims.values()) this.stopRenewing(claim);
        this.claims.clear();
    }

    /* -------------------------------------------------------------- renewal */

    // A setTimeout chain instead of setInterval, so two renewals never overlap.
    private scheduleRenewal(claim: Claim): void {
        if (claim.stopped) return;
        claim.timer = setTimeout(() => {
            claim.timer = null;
            // renew() catches everything itself.
            void this.renew(claim);
        }, this.renewEveryMs);
    }

    private async renew(claim: Claim): Promise<void> {
        try {
            const outcome = await this.enqueue(claim, () => this.checkAndWrite(claim));
            if (outcome === 'lost') {
                this.lose(claim, LOST_REASON);
                return;
            }
        } catch (err) {
            // A network blip: the lease survives two missed renewals, and the next successful one finds out
            // whether the lock is still ours.
            console.warn(`[lock] ${claim.serverId}: renewal failed, trying again in ${this.renewEveryMs} ms:`, err);
        }
        this.scheduleRenewal(claim);
    }

    /** Inspect, then rewrite our content (which also refreshes modifiedTime). Runs inside the claim's queue. */
    private async checkAndWrite(claim: Claim): Promise<WriteOutcome> {
        if (claim.stopped) return 'stopped';
        const view = await this.inspect(claim.serverId);
        if (claim.stopped) return 'stopped';
        if (view.state !== 'mine') {
            if (view.state !== 'free' || view.lock !== null) return 'lost';
            // lock.json vanished or became unreadable (for example trashed by hand in Drive) and nobody has
            // claimed since: put ours back instead of stopping a healthy session.
            console.warn(`[lock] ${claim.serverId}: lock.json was missing or unreadable, writing it again.`);
        }
        await this.write(claim.serverId, claim.content);
        return 'written';
    }

    private lose(claim: Claim, reason: string): void {
        if (claim.stopped) return;
        this.stopRenewing(claim);
        this.dropClaim(claim);
        console.warn(`[lock] ${claim.serverId}: lost the lock: ${reason}`);
        try {
            this.onLost(claim.serverId, reason);
        } catch (err) {
            console.error('[lock] onLost handler failed:', err);
        }
    }

    private stopRenewing(claim: Claim): void {
        claim.stopped = true;
        claim.active = false;
        if (claim.timer !== null) {
            clearTimeout(claim.timer);
            claim.timer = null;
        }
    }

    private dropClaim(claim: Claim): void {
        claim.active = false;
        if (this.claims.get(claim.serverId) === claim) {
            this.claims.delete(claim.serverId);
            this.rememberSession(claim.serverId, null);
        }
    }

    private remembered(serverId: string): string | null {
        try {
            return this.remember?.read(serverId) ?? null;
        } catch (err) {
            console.warn(`[lock] ${serverId}: could not read the remembered session:`, err);
            return null;
        }
    }

    /** Best effort: without it a crash only means waiting for the lease, as before. */
    private rememberSession(serverId: string, sessionId: string | null): void {
        try {
            this.remember?.write(serverId, sessionId);
        } catch (err) {
            console.warn(`[lock] ${serverId}: could not remember the session on disk:`, err);
        }
    }

    private enqueue<T>(claim: Claim, task: () => Promise<T>): Promise<T> {
        const result = claim.queue.then(task);
        claim.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    /* -------------------------------------------------------------- Drive access */

    /** Writes lock.json in place (LauncherFiles creates it, and .launcher, when missing). */
    private async write(serverId: string, content: LockContent): Promise<void> {
        try {
            await this.launcher.writeText(serverId, LOCK_FILE, serializeLock(content));
        } catch (err) {
            if (err instanceof DriveError && err.quotaFull) throw await this.quotaFullError(serverId, err);
            throw err;
        }
    }

    /** Drive charges a file to its owner, so a full Drive blocks everyone's writes to that owner's files. */
    private async quotaFullError(serverId: string, err: DriveError): Promise<AppError> {
        let owner = 'The lock file owner';
        let mine = false;
        try {
            const id = await this.launcher.findFile(serverId, LOCK_FILE);
            const meta = id ? await this.drive.getMeta(id) : null;
            const first = meta?.owners?.[0];
            mine = id === null || meta?.ownedByMe === true;        // no file yet: we were creating it ourselves
            if (first) owner = first.displayName || first.emailAddress;
        } catch (lookupErr) {
            console.warn(`[lock] ${serverId}: could not look up the lock file's owner:`, lookupErr);
        }
        const message = mine
            ? 'Your Google Drive is full, so nobody can change the files you own.'
            : `${owner}'s Google Drive is full, so nobody can change the files they own.`;
        return new AppError('QUOTA_FULL', message, err.message);
    }

    /** lock.json's text with the modifiedTime and server clock that belong to it, or null when missing. */
    private async readLockFile(serverId: string): Promise<{ text: string; modifiedTime?: string; serverNow: number } | null> {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const id = await this.launcher.findFile(serverId, LOCK_FILE);
                if (!id) return null;
                return await this.readConsistent(id);
            } catch (err) {
                // A cached id (or the .launcher folder) went away: look it up once more.
                if (attempt > 0 || !isNotFound(err)) throw err;
                this.launcher.forget(serverId);
            }
        }
        return null;
    }

    private async readConsistent(id: string): Promise<{ text: string; modifiedTime?: string; serverNow: number }> {
        for (let attempt = 1; ; attempt++) {
            const meta = await this.drive.getMeta(id);
            if (meta.trashed) throw new DriveError(`${LOCK_FILE} is in the trash`, 404, 'notFound');
            const text = await this.drive.readText(id);
            if (meta.md5Checksum === undefined || md5Hex(text) === meta.md5Checksum || attempt >= CONSISTENT_READ_ATTEMPTS) {
                return { text, modifiedTime: meta.modifiedTime, serverNow: meta.serverNow };
            }
        }
    }
}

function unfinishedUpload(lock: LockContent, fromMe: boolean): AppError {
    if (fromMe) {
        return new AppError('UNFINISHED_UPLOAD',
            'Your last upload stopped before it finished. It is completed when the app starts again on the PC that was uploading.');
    }
    const name = hostName(lock);
    return new AppError('UNFINISHED_UPLOAD',
        `${name}'s last upload stopped before it finished. It is completed the next time ${name} opens the app.`);
}
