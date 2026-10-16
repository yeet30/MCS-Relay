// The only code that talks HTTP to Google Drive: adds the access token, turns error answers into
// DriveError, refreshes the token once after a 401 and retries retryable failures with Google's backoff.
import { AppError } from '../errors';
import { DriveError } from './types';

export interface DriveAuth {
    getAccessToken(): Promise<string>;
    /** `token` is the token the failed request used, so a late 401 does not throw away a newer token. */
    invalidateAccessToken(token?: string): void;
}

export interface DriveClientDeps {
    auth: DriveAuth;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    maxRetries?: number;                        // 4
    random?: () => number;                      // jitter source, for tests
    now?: () => number;                         // fallback clock when a response has no Date header
}

export type Expect = 'json' | 'text' | 'none' | 'response';

export interface DriveRequestInit {
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
    /** Must be re-sendable (string or bytes): it is sent again after a 401 or a retry. */
    body?: BodyInit | null;
    json?: unknown;                             // sets body + content-type
    retry?: boolean;                            // default true; transfers pass false and retry themselves
    signal?: AbortSignal;
    /** 'response' hands back the unread Response and also accepts 308 (resumable upload "Resume Incomplete"). */
    expect?: Expect;
}

export interface DriveResponse {
    data: unknown;
    response: Response;
    serverNow: number;                          // Google's clock (Date header), in ms
}

const MAX_BACKOFF_MS = 32_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** Google's exponential backoff: 2^n seconds plus up to one second of jitter, capped at 32 s. */
export function googleBackoffMs(attempt: number, random: () => number = Math.random): number {
    return Math.min(2 ** attempt * 1000 + Math.floor(random() * 1000), MAX_BACKOFF_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Turns an error answer into a DriveError. Understands Drive's `{ error: { errors: [{ reason }], message } }`,
 *  the newer `details[].reason` form and OAuth's `{ error: 'invalid_token' }`. */
export function parseDriveError(status: number, bodyText: string, statusText = ''): DriveError {
    let message = '';
    let reason: string | null = null;
    try {
        const parsed: unknown = JSON.parse(bodyText);
        if (isRecord(parsed)) {
            const error = parsed.error;
            if (isRecord(error)) {
                if (typeof error.message === 'string') message = error.message;
                const first = Array.isArray(error.errors) ? error.errors[0] : undefined;
                if (isRecord(first)) {
                    if (typeof first.reason === 'string') reason = first.reason;
                    if (!message && typeof first.message === 'string') message = first.message;
                }
                if (reason === null && Array.isArray(error.details)) {
                    const detail = error.details.find((d) => isRecord(d) && typeof d.reason === 'string');
                    if (isRecord(detail) && typeof detail.reason === 'string') reason = detail.reason;
                }
            } else if (typeof error === 'string') {
                reason = error;
                message = typeof parsed.error_description === 'string' ? parsed.error_description : error;
            }
        }
    } catch {
        // Not JSON (a proxy's HTML page, for example): keep the start of the text.
        message = bodyText.trim().slice(0, 200);
    }
    if (!message) message = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
    return new DriveError(message, status, reason);
}

function describeNetworkError(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const cause: unknown = (err as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
        const code = (cause as Error & { code?: unknown }).code;
        return `${err.message}: ${typeof code === 'string' ? `${code} ` : ''}${cause.message}`;
    }
    return err.message;
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function pause(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return sleep(ms);
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        sleep(ms).then(
            () => { signal.removeEventListener('abort', onAbort); resolve(); },
            (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err); },
        );
    });
}

function retryAfterMs(response: Response): number | null {
    const header = response.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS) : null;
}

export class DriveClient {
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly maxRetries: number;
    private readonly random: () => number;
    private readonly now: () => number;

    constructor(private readonly deps: DriveClientDeps) {
        this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
        this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.maxRetries = deps.maxRetries ?? 4;
        this.random = deps.random ?? Math.random;
        this.now = deps.now ?? Date.now;
    }

    get retries(): number {
        return this.maxRetries;
    }

    /** Waits Google's backoff for the given attempt (0-based); rejects early when `signal` aborts. */
    wait(attempt: number, signal?: AbortSignal): Promise<void> {
        return pause(this.sleep, googleBackoffMs(attempt, this.random), signal);
    }

    async request(method: string, url: string, init: DriveRequestInit = {}): Promise<DriveResponse> {
        const retry = init.retry ?? true;
        let retriesDone = 0;
        let refreshedAfter401 = false;
        for (;;) {
            init.signal?.throwIfAborted();
            let errorResponse: Response | null = null;
            try {
                const token = await this.accessToken();
                const response = await this.send(method, url, init, token);
                if (response.status === 401 && !refreshedAfter401) {
                    refreshedAfter401 = true;
                    await response.arrayBuffer().catch(() => undefined);
                    this.deps.auth.invalidateAccessToken(token);
                    continue;
                }
                const accepted = response.ok || (response.status === 308 && init.expect === 'response');
                if (!accepted) {
                    errorResponse = response;
                    throw parseDriveError(response.status, await response.text().catch(() => ''), response.statusText);
                }
                return await this.finish(response, init.expect ?? 'json');
            } catch (err) {
                if (init.signal?.aborted) throw abortReason(init.signal);
                if (!(err instanceof DriveError) || !retry || !err.retryable || retriesDone >= this.maxRetries) throw err;
                const backoff = googleBackoffMs(retriesDone, this.random);
                const hinted = errorResponse ? retryAfterMs(errorResponse) : null;
                console.warn(`[drive] ${method} ${url.split('?')[0]} failed (${err.status} ${err.reason ?? err.message}), retry ${retriesDone + 1}/${this.maxRetries}`);
                retriesDone += 1;
                await pause(this.sleep, Math.max(backoff, hinted ?? 0), init.signal);
            }
        }
    }

    private async accessToken(): Promise<string> {
        try {
            return await this.deps.auth.getAccessToken();
        } catch (err) {
            // A token endpoint that cannot be reached is a network problem worth retrying, like any other.
            if (err instanceof AppError && err.code === 'NETWORK') throw new DriveError(err.detail ?? err.message, 0);
            throw err;
        }
    }

    private async send(method: string, url: string, init: DriveRequestInit, token: string): Promise<Response> {
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...init.headers };
        let body: BodyInit | null | undefined = init.body;
        if (init.json !== undefined) {
            body = JSON.stringify(init.json);
            headers['Content-Type'] = 'application/json; charset=UTF-8';
        }
        try {
            return await this.fetchImpl(buildUrl(url, init.query), { method, headers, body, signal: init.signal });
        } catch (err) {
            if (init.signal?.aborted) throw abortReason(init.signal);
            throw new DriveError(describeNetworkError(err), 0);
        }
    }

    private async finish(response: Response, expect: Expect): Promise<DriveResponse> {
        const date = Date.parse(response.headers.get('date') ?? '');
        const serverNow = Number.isFinite(date) ? date : this.now();
        let data: unknown = null;
        try {
            if (expect === 'json') {
                const text = await response.text();
                data = text ? JSON.parse(text) : null;
            } else if (expect === 'text') {
                data = await response.text();
            } else if (expect === 'none') {
                await response.arrayBuffer();
            }
        } catch (err) {
            if (err instanceof SyntaxError) throw new DriveError(`Google Drive sent an unreadable answer: ${err.message}`, response.status);
            throw new DriveError(describeNetworkError(err), 0);
        }
        return { data, response, serverNow };
    }
}

export function buildUrl(url: string, query?: DriveRequestInit['query']): string {
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.append(key, String(value));
    }
    const qs = params.toString();
    if (!qs) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}
