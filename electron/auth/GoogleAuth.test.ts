import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoogleAuth, SCOPES, TokenStore, parseStoredTokens } from './GoogleAuth';
import type { SafeStorageLike } from './GoogleAuth';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const FULL_SCOPE = SCOPES.join(' ');
const NO_DRIVE_SCOPE = SCOPES.filter((s) => !s.endsWith('/auth/drive')).join(' ');

/** Reversible stand-in for Electron's safeStorage. */
const fakeSafe = (available = true): SafeStorageLike => ({
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
});

interface Call { url: string; body: string }

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let dir: string;
let calls: Call[];
let tokenAnswer: () => Response;

/** Plays the browser: answers Google's sign-in page by calling the app's local redirect with a code. */
const browser = async (url: string): Promise<void> => {
    opened.push(url);
    const params = new URL(url).searchParams;
    void fetch(`${params.get('redirect_uri')}/?code=the-code&state=${encodeURIComponent(params.get('state') ?? '')}`);
};

let opened: string[];

function makeAuth(safe: SafeStorageLike = fakeSafe(), openExternal: (url: string) => Promise<void> = async () => undefined): GoogleAuth {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, body: init?.body ? String(init.body) : '' });
        if (url.includes('/token')) return tokenAnswer();
        if (url.includes('userinfo')) return json(200, { email: 'steve@example.com', name: 'Steve', picture: 'https://p' });
        if (url.includes('revoke')) return new Response('', { status: 200 });
        return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return new GoogleAuth({
        userDataDir: dir, client: { clientId: 'cid', clientSecret: 'secret' }, openExternal,
        safeStorage: safe, fetchImpl, now: () => NOW,
    });
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-auth-'));
    calls = [];
    opened = [];
    tokenAnswer = () => json(200, { access_token: 'fresh', expires_in: 3600, token_type: 'Bearer', scope: FULL_SCOPE });
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseStoredTokens', () => {
    it('keeps only known fields with the right types', () => {
        expect(parseStoredTokens(JSON.stringify({ refresh_token: 'r', expiry_date: 5, evil: 'x', scope: 3 }))).toEqual({ refresh_token: 'r', expiry_date: 5 });
    });

    it('rejects damaged or empty files', () => {
        expect(parseStoredTokens('{nope')).toBeNull();
        expect(parseStoredTokens('[]')).toBeNull();
        expect(parseStoredTokens(JSON.stringify({ scope: 'a' }))).toBeNull();
    });
});

describe('TokenStore', () => {
    it('encrypts when it can and moves an old plaintext token.json into tokens.bin', () => {
        fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ refresh_token: 'old' }));
        const store = new TokenStore(dir, fakeSafe());
        expect(store.load()).toEqual({ refresh_token: 'old' });
        expect(fs.existsSync(path.join(dir, 'token.json'))).toBe(false);
        expect(fs.readFileSync(path.join(dir, 'tokens.bin'), 'utf8')).not.toContain('old');
        expect(new TokenStore(dir, fakeSafe()).load()).toEqual({ refresh_token: 'old' });
    });

    it('keeps its own tokens.bin when an older app writes a token.json later', () => {
        new TokenStore(dir, fakeSafe()).save({ refresh_token: 'mine' });
        fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ refresh_token: 'old app' }));
        expect(new TokenStore(dir, fakeSafe()).load()).toEqual({ refresh_token: 'mine' });
    });

    it('falls back to token.json without encryption, and clear removes both', () => {
        const store = new TokenStore(dir, fakeSafe(false));
        store.save({ refresh_token: 'plain' });
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'token.json'), 'utf8'))).toEqual({ refresh_token: 'plain' });
        store.clear();
        expect(store.load()).toBeNull();
    });
});

describe('GoogleAuth', () => {
    function signedIn(tokens: Record<string, unknown>): GoogleAuth {
        new TokenStore(dir, fakeSafe()).save({ scope: FULL_SCOPE, ...tokens });
        return makeAuth();
    }

    it('uses a valid access token without asking Google', async () => {
        const auth = signedIn({ access_token: 'valid', refresh_token: 'r', expiry_date: NOW + 30 * 60_000 });
        expect(await auth.getAccessToken()).toBe('valid');
        expect(calls).toHaveLength(0);
    });

    it('refreshes an expiring token once, however many requests ask at the same time', async () => {
        const auth = signedIn({ access_token: 'old', refresh_token: 'r', expiry_date: NOW + 1000 });
        const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
        expect(tokens).toEqual(['fresh', 'fresh', 'fresh']);
        expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(1);
        // The refreshed token is stored, and the refresh token kept.
        expect(new TokenStore(dir, fakeSafe()).load()).toMatchObject({ access_token: 'fresh', refresh_token: 'r' });
    });

    it('a 401 invalidates only the token that failed', async () => {
        const auth = signedIn({ access_token: 'valid', refresh_token: 'r', expiry_date: NOW + 30 * 60_000 });
        auth.invalidateAccessToken('some-older-token');
        expect(await auth.getAccessToken()).toBe('valid');
        auth.invalidateAccessToken('valid');
        expect(await auth.getAccessToken()).toBe('fresh');
    });

    it('signs out when Google rejects the refresh token (revoked, or the 7-day Testing limit)', async () => {
        tokenAnswer = () => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        const auth = signedIn({ access_token: 'old', refresh_token: 'r', expiry_date: NOW - 1000 });
        await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' });
        expect(new TokenStore(dir, fakeSafe()).load()).toBeNull();
        expect((await auth.status()).loggedIn).toBe(false);
    });

    it('reports the user', async () => {
        const auth = signedIn({ access_token: 'valid', refresh_token: 'r', expiry_date: NOW + 30 * 60_000 });
        expect(await auth.status()).toEqual({
            loggedIn: true, user: { name: 'Steve', email: 'steve@example.com', picture: 'https://p' },
        });
    });

    it('a stored sign-in from the old two-step login (no Drive access) has to sign in again', async () => {
        new TokenStore(dir, fakeSafe()).save({ scope: NO_DRIVE_SCOPE, access_token: 'valid', refresh_token: 'r', expiry_date: NOW + 30 * 60_000 });
        const auth = makeAuth();
        expect((await auth.status()).loggedIn).toBe(false);
        expect(new TokenStore(dir, fakeSafe()).load()).toBeNull();
    });

    it('logout forgets the tokens on this PC without revoking the access at Google', async () => {
        const auth = signedIn({ access_token: 'valid', refresh_token: 'refresh-me', expiry_date: NOW + 30 * 60_000 });
        await auth.logout();
        expect(calls.some((c) => c.url.includes('revoke'))).toBe(false);
        expect(new TokenStore(dir, fakeSafe()).load()).toBeNull();
        await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' });
    });

    it('login asks for everything at once and shows only the account chooser, not the permission page every time', async () => {
        tokenAnswer = () => json(200, { access_token: 'fresh', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: FULL_SCOPE });
        const auth = makeAuth(fakeSafe(), browser);
        expect(await auth.login()).toMatchObject({ loggedIn: true, user: { email: 'steve@example.com' } });
        const params = new URL(opened[0]).searchParams;
        expect(params.get('prompt')).toBe('select_account');
        expect(params.get('scope')?.split(' ')).toEqual(SCOPES);
        expect(new TokenStore(dir, fakeSafe()).load()).toMatchObject({ refresh_token: 'r' });
    });

    it('login fails, keeping nothing, when the Google Drive box was unticked', async () => {
        tokenAnswer = () => json(200, { access_token: 'fresh', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: NO_DRIVE_SCOPE });
        const auth = makeAuth(fakeSafe(), browser);
        await expect(auth.login()).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
        expect(new TokenStore(dir, fakeSafe()).load()).toBeNull();
        expect((await auth.status()).loggedIn).toBe(false);
    });
});
