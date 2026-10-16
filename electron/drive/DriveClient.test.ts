import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors';
import { DriveClient, buildUrl, googleBackoffMs, parseDriveError } from './DriveClient';
import type { DriveAuth } from './DriveClient';
import { DriveError } from './types';

interface Recorded {
    method: string;
    url: URL;
    headers: Headers;
    body: string;
}

type Reply = Response | Error | ((req: Recorded) => Response | Error);

/** A scripted fetch: each call takes the next reply and records the request. */
function scriptedFetch(replies: Reply[]): { fetch: typeof fetch; calls: Recorded[] } {
    const calls: Recorded[] = [];
    const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        const recorded = { method: req.method, url: new URL(req.url), headers: req.headers, body: await req.text() };
        calls.push(recorded);
        init?.signal?.throwIfAborted();
        const next = replies.shift();
        if (!next) throw new Error(`unexpected request ${req.method} ${req.url}`);
        const out = typeof next === 'function' ? next(recorded) : next;
        if (out instanceof Error) throw out;
        return out;
    };
    return { fetch: fake as typeof fetch, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function googleError(status: number, reason: string, message = reason): Response {
    return json(status, { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } });
}

function fakeAuth(tokens: string[] = ['token-1', 'token-2', 'token-3']): DriveAuth & { invalidated: Array<string | undefined> } {
    let current = 0;
    const invalidated: Array<string | undefined> = [];
    return {
        invalidated,
        getAccessToken: async () => tokens[Math.min(current, tokens.length - 1)],
        invalidateAccessToken: (token?: string) => {
            invalidated.push(token);
            current += 1;
        },
    };
}

function client(replies: Reply[], overrides: { auth?: DriveAuth; maxRetries?: number } = {}) {
    const fake = scriptedFetch(replies);
    const sleeps: number[] = [];
    const auth = overrides.auth ?? fakeAuth();
    const drive = new DriveClient({
        auth,
        fetchImpl: fake.fetch,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        random: () => 0.5,
        maxRetries: overrides.maxRetries,
    });
    return { drive, calls: fake.calls, sleeps, auth };
}

describe('DriveClient.request', () => {
    it('builds the URL, adds the token and JSON body, parses JSON and reads the server clock', async () => {
        const date = 'Thu, 15 Oct 2026 12:00:05 GMT';
        const { drive, calls } = client([json(200, { id: 'abc' }, { Date: date })]);
        const result = await drive.request('POST', 'https://www.googleapis.com/drive/v3/files', {
            query: { fields: 'id', supportsAllDrives: true, pageToken: undefined },
            json: { name: 'x' },
        });
        expect(result.data).toEqual({ id: 'abc' });
        expect(result.serverNow).toBe(Date.parse(date));
        const [req] = calls;
        expect(req.method).toBe('POST');
        expect(req.url.pathname).toBe('/drive/v3/files');
        expect(Object.fromEntries(req.url.searchParams)).toEqual({ fields: 'id', supportsAllDrives: 'true' });
        expect(req.headers.get('authorization')).toBe('Bearer token-1');
        expect(req.headers.get('content-type')).toMatch(/^application\/json/);
        expect(JSON.parse(req.body)).toEqual({ name: 'x' });
    });

    it('returns text, nothing, or the raw response as asked', async () => {
        const { drive } = client([
            new Response('hello', { status: 200 }),
            new Response(null, { status: 204 }),
            new Response('raw', { status: 200 }),
        ]);
        expect((await drive.request('GET', 'https://x.test/a', { expect: 'text' })).data).toBe('hello');
        expect((await drive.request('DELETE', 'https://x.test/a', { expect: 'none' })).data).toBeNull();
        const raw = await drive.request('GET', 'https://x.test/a', { expect: 'response' });
        expect(await raw.response.text()).toBe('raw');
    });

    it('accepts a 308 only when the caller wants the raw response', async () => {
        const { drive } = client([
            new Response(null, { status: 308, headers: { Range: 'bytes=0-9' } }),
            new Response(null, { status: 308 }),
        ]);
        const ok = await drive.request('PUT', 'https://x.test/session', { expect: 'response', retry: false });
        expect(ok.response.headers.get('range')).toBe('bytes=0-9');
        await expect(drive.request('PUT', 'https://x.test/session', { retry: false })).rejects.toMatchObject({ status: 308 });
    });

    it('turns a 403 rate limit into a retryable DriveError and retries it', async () => {
        const { drive, calls, sleeps } = client([googleError(403, 'rateLimitExceeded'), json(200, { ok: true })]);
        await expect(drive.request('GET', 'https://x.test/a')).resolves.toMatchObject({ data: { ok: true } });
        expect(calls).toHaveLength(2);
        expect(sleeps).toEqual([1500]);
    });

    it('does not retry a 403 insufficientFilePermissions', async () => {
        const { drive, calls } = client([googleError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.')]);
        const err = await drive.request('PATCH', 'https://x.test/a').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DriveError);
        expect(err).toMatchObject({
            status: 403, reason: 'insufficientFilePermissions', retryable: false, rateLimited: false, quotaFull: false,
            message: 'The user does not have sufficient permissions for this file.',
        });
        expect(calls).toHaveLength(1);
    });

    it('marks storageQuotaExceeded as quotaFull and never retries it', async () => {
        const { drive, calls } = client([googleError(403, 'storageQuotaExceeded')]);
        await expect(drive.request('PATCH', 'https://x.test/a')).rejects.toMatchObject({ quotaFull: true, retryable: false });
        expect(calls).toHaveLength(1);
    });

    it('retries a 503 with Google backoff (2^n s + jitter) and succeeds', async () => {
        const { drive, calls, sleeps } = client([googleError(503, 'backendError'), googleError(503, 'backendError'), json(200, {})]);
        await drive.request('GET', 'https://x.test/a');
        expect(calls).toHaveLength(3);
        expect(sleeps).toEqual([1500, 2500]);
    });

    it('gives up after maxRetries', async () => {
        const replies = Array.from({ length: 5 }, () => googleError(503, 'backendError'));
        const { drive, calls, sleeps } = client(replies);
        await expect(drive.request('GET', 'https://x.test/a')).rejects.toMatchObject({ status: 503, retryable: true });
        expect(calls).toHaveLength(5);
        expect(sleeps).toEqual([1500, 2500, 4500, 8500]);
    });

    it('does not retry when retry is false', async () => {
        const { drive, calls, sleeps } = client([googleError(503, 'backendError')]);
        await expect(drive.request('GET', 'https://x.test/a', { retry: false })).rejects.toMatchObject({ status: 503 });
        expect(calls).toHaveLength(1);
        expect(sleeps).toEqual([]);
    });

    it('waits at least as long as Retry-After asks', async () => {
        const { drive, sleeps } = client([json(429, { error: { message: 'slow down' } }, { 'Retry-After': '7' }), json(200, {})]);
        await drive.request('GET', 'https://x.test/a');
        expect(sleeps).toEqual([7000]);
    });

    it('turns a network failure into DriveError status 0 and retries it', async () => {
        const failure = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
        const { drive, calls } = client([failure, json(200, { ok: 1 })]);
        await expect(drive.request('GET', 'https://x.test/a')).resolves.toMatchObject({ data: { ok: 1 } });
        expect(calls).toHaveLength(2);

        const once = client([failure]);
        const err = await once.drive.request('GET', 'https://x.test/a', { retry: false }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DriveError);
        expect(err).toMatchObject({ status: 0, retryable: true });
        expect((err as Error).message).toContain('ECONNRESET');
    });

    it('after a 401 invalidates the token it used and repeats once with a new one', async () => {
        const { drive, calls, auth } = client([json(401, { error: { message: 'Invalid Credentials' } }), json(200, { ok: true })]);
        await drive.request('GET', 'https://x.test/a', { retry: false });
        expect(calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer token-1', 'Bearer token-2']);
        expect((auth as ReturnType<typeof fakeAuth>).invalidated).toEqual(['token-1']);
    });

    it('a second 401 is thrown', async () => {
        const unauthorized = (): Response => googleError(401, 'authError', 'Invalid Credentials');
        const { drive, calls } = client([unauthorized(), unauthorized()]);
        await expect(drive.request('GET', 'https://x.test/a')).rejects.toMatchObject({ status: 401, reason: 'authError' });
        expect(calls).toHaveLength(2);
    });

    it('passes NOT_SIGNED_IN from the auth through without a request', async () => {
        const auth: DriveAuth = {
            getAccessToken: () => Promise.reject(new AppError('NOT_SIGNED_IN', 'Please log in with Google.')),
            invalidateAccessToken: vi.fn(),
        };
        const { drive, calls } = client([], { auth });
        await expect(drive.request('GET', 'https://x.test/a')).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' });
        expect(calls).toHaveLength(0);
    });

    it('treats a token endpoint that cannot be reached as a retryable network error', async () => {
        let attempts = 0;
        const auth: DriveAuth = {
            getAccessToken: async () => {
                attempts += 1;
                if (attempts === 1) throw new AppError('NETWORK', 'Google could not be reached.', 'getaddrinfo ENOTFOUND oauth2.googleapis.com');
                return 'token-ok';
            },
            invalidateAccessToken: vi.fn(),
        };
        const { drive, calls, sleeps } = client([json(200, {})], { auth });
        await drive.request('GET', 'https://x.test/a');
        expect(calls).toHaveLength(1);
        expect(sleeps).toHaveLength(1);
    });

    it('stops at once when the signal aborts during a backoff', async () => {
        const controller = new AbortController();
        const fake = scriptedFetch([googleError(503, 'backendError'), json(200, {})]);
        const drive = new DriveClient({
            auth: fakeAuth(),
            fetchImpl: fake.fetch,
            sleep: () => new Promise(() => undefined),      // never ends on its own
        });
        const pending = drive.request('GET', 'https://x.test/a', { signal: controller.signal });
        await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(fake.calls).toHaveLength(1);
    });
});

describe('helpers', () => {
    it('parses Google error bodies', () => {
        expect(parseDriveError(403, JSON.stringify({ error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } })))
            .toMatchObject({ status: 403, reason: 'userRateLimitExceeded', rateLimited: true, retryable: true });
        expect(parseDriveError(429, JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } })))
            .toMatchObject({ reason: 'RATE_LIMIT_EXCEEDED', message: 'Quota exceeded', rateLimited: true });
        expect(parseDriveError(400, JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' })))
            .toMatchObject({ reason: 'invalid_grant', message: 'Bad Request' });
        expect(parseDriveError(502, '<html>Bad Gateway</html>', 'Bad Gateway')).toMatchObject({ status: 502, reason: null, message: '<html>Bad Gateway</html>', retryable: true });
        expect(parseDriveError(500, '', 'Internal Server Error').message).toBe('HTTP 500 Internal Server Error');
    });

    it('caps the backoff at 32 s', () => {
        expect(googleBackoffMs(0, () => 0)).toBe(1000);
        expect(googleBackoffMs(3, () => 0.999)).toBe(8999);
        expect(googleBackoffMs(10, () => 0)).toBe(32_000);
    });

    it('builds query strings', () => {
        expect(buildUrl('https://x.test/a', { q: "name = 'a b'", n: 3, f: false, skip: undefined })).toBe("https://x.test/a?q=name+%3D+%27a+b%27&n=3&f=false");
        expect(buildUrl('https://x.test/a?upload_id=1', { x: 1 })).toBe('https://x.test/a?upload_id=1&x=1');
        expect(buildUrl('https://x.test/a', {})).toBe('https://x.test/a');
    });
});
