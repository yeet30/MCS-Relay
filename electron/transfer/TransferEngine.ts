// Runs a flat list of transfer jobs in parallel lanes. Bottleneck limits how many run at once and
// retries failed jobs after a backoff; LaneController adapts the lane count to Google's answers;
// ProgressReporter turns job events into snapshots for the UI.
import { setMaxListeners } from 'node:events';
import { mkdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import Bottleneck from 'bottleneck';
import { APP_PROPS } from '../../shared/types';
import type { AppErrorInfo, TransferSnapshot, UserInfo } from '../../shared/types';
import { ChecksumError, DriveError, FOLDER_MIME, isRateLimit, isRetryable } from '../drive/types';
import type { DriveApi, DriveFileMeta, TransferOptions, UploadResult, UploadSource } from '../drive/types';
import { AppError, toAppError } from '../errors';
import { LaneController } from './LaneController';
import { ProgressReporter } from './progress';

export type TransferJob =
    | { kind: 'download'; path: string; driveId: string; size: number; md5: string; dest: string }
    | { kind: 'upload'; path: string; name: string; size: number; md5: string; source: string; driveId?: string; parentId?: string; appProperties?: Record<string, string> }
    | { kind: 'delete-remote'; path: string; driveId: string; serverId: string; pendingFolderId: string | null }
    | { kind: 'delete-local'; path: string; target: string };

export type JobOutcome =
    | { kind: 'download'; path: string; driveId: string; md5: string; size: number; mtimeMs: number }
    | { kind: 'upload'; path: string; driveId: string; md5: string; size: number }
    | { kind: 'delete-remote'; path: string; method: 'trashed' | 'placeholder' | 'already-gone' }
    | { kind: 'delete-local'; path: string };

export interface TransferResult {
    done: JobOutcome[];
    failed: Array<{ job: TransferJob; error: AppErrorInfo }>;
}

export interface TransferEngineDeps {
    drive: DriveApi;
    me: () => Promise<UserInfo>;
    emit: (snapshot: TransferSnapshot) => void;
    lanes?: { start: number; min: number; max: number };
    maxAttempts?: number;
    backoffMs?: (attempt: number) => number;
    tickMs?: number;
    now?: () => number;
}

type DownloadJob = Extract<TransferJob, { kind: 'download' }>;
type UploadJob = Extract<TransferJob, { kind: 'upload' }>;
type DeleteRemoteJob = Extract<TransferJob, { kind: 'delete-remote' }>;
type DeleteLocalJob = Extract<TransferJob, { kind: 'delete-local' }>;

interface RunContext {
    signal?: AbortSignal;
    progress: ProgressReporter;
    attempts: Map<TransferJob, number>;
    /** Files created by an earlier attempt of the same job: a retry updates them instead of creating a duplicate. */
    createdIds: Map<TransferJob, string>;
    inflight: Set<Promise<JobOutcome>>;
}

const DEFAULT_LANES = { start: 4, min: 1, max: 12 };
const SPEED_CHECK_MS = 10_000;
const THROTTLE_QUIET_MS = 1_000;        // a burst of 429s from parallel lanes is one congestion event
const ABORT_SETTLE_MS = 5_000;
const MAX_SIGNAL_LISTENERS = 100;
const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Google's advice: 2^n seconds plus up to 1 s of random jitter, capped. */
export function defaultBackoffMs(attempt: number): number {
    return Math.min(2 ** attempt * 1000 + Math.random() * 1000, 32_000);
}

export class TransferEngine {
    private readonly deps: TransferEngineDeps;
    private progress: ProgressReporter;
    private queue: Promise<void> = Promise.resolve();

    constructor(deps: TransferEngineDeps) {
        this.deps = deps;
        this.progress = new ProgressReporter({ now: deps.now });
    }

    /** Never rejects because of failed jobs (they are listed in the result); rejects only when `signal` aborts.
     *  Runs are serialized: a second call waits for the first to finish. */
    run(label: string, jobs: TransferJob[], signal?: AbortSignal): Promise<TransferResult> {
        const result = this.queue.then(() => this.runNow(label, jobs, signal));
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    snapshot(): TransferSnapshot {
        return this.progress.snapshot();
    }

    private async runNow(label: string, jobs: TransferJob[], signal?: AbortSignal): Promise<TransferResult> {
        throwIfAborted(signal);
        const now = this.deps.now ?? Date.now;
        const maxAttempts = Math.max(1, this.deps.maxAttempts ?? 5);
        const backoffMs = this.deps.backoffMs ?? defaultBackoffMs;
        const progress = new ProgressReporter({ now });
        this.progress = progress;
        const lanes = new LaneController(this.deps.lanes ?? DEFAULT_LANES);
        const limiter = new Bottleneck({ maxConcurrent: lanes.lanes });
        // Requests get a per-run child signal: every request in flight adds an abort listener, and Node
        // prints a "possible memory leak" warning above 10 listeners on one signal.
        const runAbort = new AbortController();
        setMaxListeners(MAX_SIGNAL_LISTENERS, runAbort.signal);
        const ctx: RunContext = { signal: runAbort.signal, progress, attempts: new Map(), createdIds: new Map(), inflight: new Set() };
        const result: TransferResult = { done: [], failed: [] };
        const byId = new Map<string, TransferJob>();
        const timers = new Set<ReturnType<typeof setTimeout>>();
        let finished = false;
        let laneCount = lanes.lanes;
        let lastThrottleAt = Number.NEGATIVE_INFINITY;

        progress.begin(label, jobs.map((job) => ({ path: job.path, kind: job.kind, size: jobSize(job) })), lanes.lanes);

        lanes.onChange((n) => {
            const grew = n > laneCount;
            laneCount = n;
            progress.setLaneLimit(n);
            setConcurrency(limiter, n);
            console.log(`[transfer] ${label}: ${n} lanes`);
            if (!grew) return;
            const timer = setTimeout(() => {
                timers.delete(timer);
                if (finished || lanes.lanes !== n) return;
                if (progress.speedGainCheck() === 'no-gain') lanes.onNoSpeedGain();
            }, SPEED_CHECK_MS + 100);
            timers.add(timer);
        });

        // Returning a number asks Bottleneck to retry the job after that many ms; null fails it.
        limiter.on('failed', (error: unknown, info: Bottleneck.EventInfoRetryable) => {
            const job = byId.get(info.options.id);
            if (!job || finished || signal?.aborted) return null;
            if (isRateLimit(error)) {
                const t = now();
                if (t - lastThrottleAt >= THROTTLE_QUIET_MS) {
                    lastThrottleAt = t;
                    lanes.onThrottled();
                }
            }
            // AppErrors are final decisions (forbidden, quota full); their user text could match a network pattern.
            if (error instanceof AppError || !isRetryable(error) || info.retryCount >= maxAttempts - 1) return null;
            const wait = Math.max(0, Math.round(backoffMs(info.retryCount)));
            progress.jobBackoff(job.path, wait);
            console.warn(`[transfer] ${job.path}: attempt ${info.retryCount + 1} failed (${describe(error)}), retrying in ${wait} ms`);
            return wait;
        });

        const schedule = (job: TransferJob, index: number): Promise<void> => {
            const id = `job-${index}`;
            byId.set(id, job);
            return limiter.schedule({ id }, () => this.execute(job, ctx)).then(
                (outcome) => {
                    if (finished) return;
                    if (job.kind !== 'delete-local') lanes.onSuccess();
                    progress.jobDone(job.path);
                    result.done.push(outcome);
                },
                (err: unknown) => {
                    if (finished || signal?.aborted) return;
                    const error = toAppError(err);
                    progress.jobFailed(job.path, job.kind, error.message);
                    result.failed.push({ job, error });
                    console.warn(`[transfer] ${job.kind} ${job.path} failed: ${error.message}${error.detail ? ` (${error.detail})` : ''}`);
                },
            );
        };

        // Local deletions first: a file may have to make room for a folder of the same name (or the other
        // way round), and no download may be writing into a folder while an emptied folder is removed.
        const indexed = jobs.map((job, index) => ({ job, index }));
        const work = (async () => {
            await Promise.all(indexed.filter(({ job }) => job.kind === 'delete-local').map(({ job, index }) => schedule(job, index)));
            await Promise.all(indexed.filter(({ job }) => job.kind !== 'delete-local').map(({ job, index }) => schedule(job, index)));
        })();

        let rejectAborted: (reason: unknown) => void = () => undefined;
        const aborted = new Promise<never>((_, reject) => {
            rejectAborted = reject;
        });
        const onAbort = (): void => {
            const reason = abortReason(signal);
            runAbort.abort(reason);
            rejectAborted(reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        const interval = setInterval(() => {
            progress.tick();
            this.emit(progress.snapshot());
        }, Math.max(1, this.deps.tickMs ?? 250));
        this.emit(progress.snapshot());

        try {
            await Promise.race([work, aborted]);
            return result;
        } catch (err) {
            finished = true;
            limiter.stop({ dropWaitingJobs: true }).catch((stopErr: unknown) => {
                console.warn('[transfer] stopping the limiter failed:', stopErr);
            });
            // Requests in flight see the signal; wait (briefly) so nothing writes after run() has rejected.
            await settleWithin([...ctx.inflight], ABORT_SETTLE_MS);
            throw err;
        } finally {
            finished = true;
            signal?.removeEventListener('abort', onAbort);
            clearInterval(interval);
            for (const timer of timers) clearTimeout(timer);
            progress.end();
            this.emit(progress.snapshot());
        }
    }

    private emit(snapshot: TransferSnapshot): void {
        try {
            this.deps.emit(snapshot);
        } catch (err) {
            console.error('[transfer] emitting progress failed:', err);
        }
    }

    /** One attempt of one job. Bottleneck calls it again for every retry. */
    private async execute(job: TransferJob, ctx: RunContext): Promise<JobOutcome> {
        throwIfAborted(ctx.signal);
        const attempt = ctx.attempts.get(job) ?? 0;
        ctx.attempts.set(job, attempt + 1);
        ctx.progress.jobStarted(job.path);
        const task = this.perform(job, ctx, attempt).catch(async (err: unknown) => {
            if (err instanceof DriveError && err.quotaFull) throw await this.quotaError(job, err, ctx);
            throw err;
        });
        ctx.inflight.add(task);
        try {
            return await task;
        } finally {
            ctx.inflight.delete(task);
        }
    }

    private perform(job: TransferJob, ctx: RunContext, attempt: number): Promise<JobOutcome> {
        switch (job.kind) {
            case 'download': return this.download(job, ctx);
            case 'upload': return this.upload(job, ctx, attempt);
            case 'delete-remote': return this.deleteRemote(job);
            case 'delete-local': return this.deleteLocal(job);
        }
    }

    private transferOptions(job: TransferJob, ctx: RunContext): TransferOptions {
        return { signal: ctx.signal, onProgress: (bytes) => ctx.progress.jobProgress(job.path, bytes) };
    }

    private async download(job: DownloadJob, ctx: RunContext): Promise<JobOutcome> {
        const part = `${job.dest}.part`;
        await mkdir(path.dirname(job.dest), { recursive: true });
        try {
            const got = await this.deps.drive.download(job.driveId, part, this.transferOptions(job, ctx));
            if (!sameMd5(got.md5, job.md5)) {
                throw new ChecksumError(`${job.path}: expected md5 ${job.md5}, received ${got.md5}`);
            }
            await retryWhileLocked(() => rename(part, job.dest));
        } catch (err) {
            // Best effort: a later attempt overwrites the .part anyway, and *.part is never synced.
            await rm(part, { force: true }).catch(() => undefined);
            throw err;
        }
        const info = await stat(job.dest);
        return { kind: 'download', path: job.path, driveId: job.driveId, md5: job.md5.toLowerCase(), size: info.size, mtimeMs: info.mtimeMs };
    }

    private async upload(job: UploadJob, ctx: RunContext, attempt: number): Promise<JobOutcome> {
        const drive = this.deps.drive;
        const source: UploadSource = { kind: 'file', path: job.source, size: job.size };
        const opts = this.transferOptions(job, ctx);
        let targetId = job.driveId ?? ctx.createdIds.get(job);
        // The previous attempt may have created the file before its answer got lost.
        if (!targetId && attempt > 0) targetId = await this.findOwnCopy(job);
        let uploaded: UploadResult;
        if (targetId) {
            uploaded = await drive.updateContent(targetId, source, opts);
        } else {
            if (!job.parentId) throw new AppError('INVALID', `No Google Drive folder was given for ${job.path}.`);
            uploaded = await drive.createFile(job.name, job.parentId, source, opts, job.appProperties);
            ctx.createdIds.set(job, uploaded.id);
        }
        if (!sameMd5(uploaded.md5Checksum, job.md5)) {
            throw new ChecksumError(`${job.path}: uploaded md5 ${uploaded.md5Checksum}, expected ${job.md5}`);
        }
        return { kind: 'upload', path: job.path, driveId: uploaded.id, md5: uploaded.md5Checksum.toLowerCase(), size: uploaded.size };
    }

    /** A file this app created for the same path in an earlier attempt (recognised by its appProperties). */
    private async findOwnCopy(job: UploadJob): Promise<string | undefined> {
        const props = job.appProperties;
        const relPath = props?.[APP_PROPS.path];
        if (!job.parentId || !props || !relPath) return undefined;
        const matches = (await this.deps.drive.listChildren(job.parentId, { name: job.name })).filter((m) =>
            m.ownedByMe === true
            && m.mimeType !== FOLDER_MIME
            && m.appProperties?.[APP_PROPS.path] === relPath
            && m.appProperties[APP_PROPS.server] === props[APP_PROPS.server]
            && m.appProperties[APP_PROPS.tombstone] !== '1');
        return matches.length > 0 ? matches[matches.length - 1].id : undefined;
    }

    /** Owners trash their own files; anyone else turns the file into a 0-byte placeholder for its owner. */
    private async deleteRemote(job: DeleteRemoteJob): Promise<JobOutcome> {
        const drive = this.deps.drive;
        const outcome = (method: 'trashed' | 'placeholder' | 'already-gone'): JobOutcome => ({ kind: 'delete-remote', path: job.path, method });

        let meta: DriveFileMeta;
        try {
            meta = await drive.getMeta(job.driveId);
        } catch (err) {
            if (isNotFound(err)) return outcome('already-gone');
            throw err;
        }
        if (meta.trashed) return outcome('already-gone');
        if (meta.appProperties?.[APP_PROPS.tombstone] === '1') return outcome('placeholder');

        const caps = meta.capabilities ?? {};
        if (caps.canTrash ?? meta.ownedByMe === true) {
            try {
                await drive.trash(job.driveId);
            } catch (err) {
                if (isNotFound(err)) return outcome('already-gone');
                throw err;
            }
            return outcome('trashed');
        }
        if (caps.canModifyContent === false) {
            throw new AppError('FORBIDDEN', `You are not allowed to delete ${job.path} on Google Drive.`);
        }

        const me = await this.deps.me();
        const props: Record<string, string> = {
            [APP_PROPS.tombstone]: '1',
            [APP_PROPS.server]: job.serverId,
            [APP_PROPS.deletedBy]: me.email,
            [APP_PROPS.deletedAt]: new Date((this.deps.now ?? Date.now)()).toISOString(),
        };
        const parent = meta.parents?.[0];
        // An unknown capability (field not returned) is tried; a refusal falls back to marking in place.
        const moveTo = job.pendingFolderId && parent && parent !== job.pendingFolderId && caps.canMoveItemWithinDrive !== false
            ? { addParent: job.pendingFolderId, removeParent: parent }
            : undefined;
        try {
            await drive.markDeleted(job.driveId, props, moveTo);
            return outcome('placeholder');
        } catch (err) {
            if (!moveTo || !isMoveRefusal(err)) {
                if (isNotFound(err)) return outcome('already-gone');
                throw err;
            }
            console.warn(`[transfer] could not move ${job.path} to pending-delete (${describe(err)}); marking it in place`);
        }
        try {
            await drive.markDeleted(job.driveId, props);
        } catch (err) {
            if (isNotFound(err)) return outcome('already-gone');
            throw err;
        }
        return outcome('placeholder');
    }

    private async deleteLocal(job: DeleteLocalJob): Promise<JobOutcome> {
        await retryWhileLocked(() => rm(job.target, { force: true }));
        await removeEmptyParents(job.target, job.path);
        return { kind: 'delete-local', path: job.path };
    }

    /** Storage is charged to a file's owner, so the message names the person who has to free up space. */
    private async quotaError(job: TransferJob, err: DriveError, ctx: RunContext): Promise<AppError> {
        const detail = toAppError(err).detail;
        const fileId = job.kind === 'delete-local' ? undefined
            : job.kind === 'upload' ? job.driveId ?? ctx.createdIds.get(job)
                : job.driveId;
        if (!fileId) {
            // A new file belongs to whoever uploads it.
            return new AppError('QUOTA_FULL', 'Your Google Drive is full, so new files cannot be uploaded. Free up some space and try again.', detail);
        }
        try {
            const meta = await this.deps.drive.getMeta(fileId);
            const owner = meta.owners?.[0];
            if (meta.ownedByMe === true || owner?.me === true) {
                return new AppError('QUOTA_FULL', 'Your Google Drive is full, so nobody can change the files you own. Free up some space and try again.', detail);
            }
            const name = owner?.displayName || owner?.emailAddress;
            if (name) return new AppError('QUOTA_FULL', `${name}'s Google Drive is full, so nobody can change the files they own.`, detail);
        } catch (metaErr) {
            console.warn(`[transfer] could not look up the owner of ${job.path}:`, describe(metaErr));
        }
        return new AppError('QUOTA_FULL', toAppError(err).message, detail);
    }
}

function jobSize(job: TransferJob): number {
    return job.kind === 'download' || job.kind === 'upload' ? job.size : 0;
}

function sameMd5(a: string | undefined, b: string): boolean {
    return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isNotFound(err: unknown): boolean {
    return err instanceof DriveError && err.status === 404;
}

/** Errors that mean "you may not move this file" (or the pending folder is gone), not "you may not change it". */
function isMoveRefusal(err: unknown): boolean {
    return err instanceof DriveError && !err.quotaFull && !err.rateLimited && [400, 403, 404].includes(err.status);
}

function describe(err: unknown): string {
    const info = toAppError(err);
    return info.detail ?? info.message;
}

function abortReason(signal: AbortSignal | undefined): Error {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error('The transfer was cancelled.');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw abortReason(signal);
}

/** Bottleneck's updateSettings is async at runtime although its typings say it returns the limiter. */
function setConcurrency(limiter: Bottleneck, maxConcurrent: number): void {
    Promise.resolve(limiter.updateSettings({ maxConcurrent }) as unknown).catch((err: unknown) => {
        console.warn('[transfer] changing the lane count failed:', err);
    });
}

async function settleWithin(promises: Array<Promise<unknown>>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
        }),
    ]);
    clearTimeout(timer);
}

function errorCode(err: unknown): string | undefined {
    if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
}

/** Windows briefly locks files that a virus scanner or indexer is reading; renames and deletes then fail with
 *  EBUSY/EPERM/EACCES for a moment. */
async function retryWhileLocked<T>(op: () => Promise<T>, attempts = 5): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await op();
        } catch (err) {
            const code = errorCode(err);
            if (attempt >= attempts || code === undefined || !LOCKED_CODES.has(code)) throw err;
            await new Promise<void>((resolve) => setTimeout(resolve, 100 * attempt));
        }
    }
}

/** Removes folders left empty by a deletion, up to (not including) the server root. */
async function removeEmptyParents(target: string, relPath: string): Promise<void> {
    const depth = relPath.split('/').filter(Boolean).length;
    let dir = path.dirname(target);
    for (let level = 1; level < depth; level++) {
        try {
            await rmdir(dir);               // fails on a folder that still has something in it, which ends the walk
        } catch {
            return;
        }
        dir = path.dirname(dir);
    }
}
