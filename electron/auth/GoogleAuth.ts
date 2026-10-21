// Google sign-in for the whole app: one OAuth2Client for the app's lifetime, one consent screen,
// tokens stored encrypted (Electron safeStorage), and one shared in-flight refresh.
// No electron import: main.ts passes openExternal, safeStorage and the folders in.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Credentials } from 'google-auth-library';
import type { AuthStatus } from '../../shared/ipc';
import type { UserInfo } from '../../shared/types';
import { AppError } from '../errors';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile';

/** base: the one consent at login. The full drive scope is needed because drive.file cannot see files
 *  other members uploaded. collaboration: what tokens from the old two-step login may still lack. */
export const SCOPES: { base: string[]; collaboration: string } = {
    base: ['openid', EMAIL_SCOPE, PROFILE_SCOPE, DRIVE_SCOPE],
    collaboration: DRIVE_SCOPE,
};

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;            // refresh a little early so a request never starts with a dying token
const HTTP_TIMEOUT_MS = 30_000;

export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(s: string): Buffer;
    decryptString(b: Buffer): string;
}

export interface GoogleAuthDeps {
    userDataDir: string;
    credentialsPath: string;                        // config/client_secret.json
    openExternal: (url: string) => Promise<void>;
    safeStorage?: SafeStorageLike;
    /** For tests: replaces fetch for userinfo, revoke and the OAuth client's token requests. */
    fetchImpl?: typeof fetch;
    loginTimeoutMs?: number;
    now?: () => number;
    /** Called when the signed-in account changes (null: signed out), so per-account data can follow it. */
    onUserChanged?: (user: UserInfo | null) => void;
}

const LOGGED_OUT: AuthStatus = { loggedIn: false, user: null, collaborationEnabled: false };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function notSignedIn(message = 'Please log in with Google.', detail?: string): AppError {
    return new AppError('NOT_SIGNED_IN', message, detail);
}

function scopesOf(tokens: Credentials | null): string[] {
    return (tokens?.scope ?? '').split(/\s+/).filter(Boolean);
}

/** Keeps only the known token fields with the right types; null when nothing usable is left. */
export function parseStoredTokens(text: string): Credentials | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(raw)) return null;
    const tokens: Credentials = {};
    for (const key of ['access_token', 'refresh_token', 'scope', 'token_type', 'id_token'] as const) {
        const value = raw[key];
        if (typeof value === 'string' && value) tokens[key] = value;
    }
    if (typeof raw.expiry_date === 'number' && Number.isFinite(raw.expiry_date)) tokens.expiry_date = raw.expiry_date;
    return tokens.refresh_token || tokens.access_token ? tokens : null;
}

function isInvalidGrant(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const data = (err as Error & { response?: { data?: unknown } }).response?.data;
    if (isRecord(data) && data.error === 'invalid_grant') return true;
    return /invalid_grant/.test(err.message);
}

function writeAtomic(file: string, data: string | Buffer): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
}

function removeQuietly(file: string): void {
    try {
        fs.rmSync(file, { force: true });
    } catch (err) {
        console.warn(`[auth] could not delete ${file}:`, describe(err));
    }
}

/** tokens.bin (encrypted with safeStorage) when encryption is available, else token.json.
 *  A plaintext token.json next to working encryption is a legacy file: it is moved into tokens.bin. */
export class TokenStore {
    constructor(private readonly dir: string, private readonly safe?: SafeStorageLike) {}

    get encryptedPath(): string {
        return path.join(this.dir, 'tokens.bin');
    }

    get plainPath(): string {
        return path.join(this.dir, 'token.json');
    }

    load(): Credentials | null {
        const cipher = this.cipher();
        if (cipher) {
            const legacy = this.readPlain();
            if (legacy) {
                // token.json only exists next to working encryption when an older app (or a run without a keyring) wrote it, so it is the newest.
                this.save(legacy);
                console.log('[auth] moved token.json into encrypted storage');
                return legacy;
            }
            if (!fs.existsSync(this.encryptedPath)) return null;
            try {
                return parseStoredTokens(cipher.decryptString(fs.readFileSync(this.encryptedPath)));
            } catch (err) {
                console.warn('[auth] could not read tokens.bin, signing in again is needed:', describe(err));
                return null;
            }
        }
        return this.readPlain();
    }

    save(tokens: Credentials): void {
        fs.mkdirSync(this.dir, { recursive: true });
        const json = JSON.stringify(tokens);
        const cipher = this.cipher();
        if (cipher) {
            writeAtomic(this.encryptedPath, cipher.encryptString(json));
            removeQuietly(this.plainPath);
        } else {
            writeAtomic(this.plainPath, json);
        }
    }

    clear(): void {
        removeQuietly(this.encryptedPath);
        removeQuietly(this.plainPath);
    }

    private cipher(): SafeStorageLike | null {
        try {
            return this.safe?.isEncryptionAvailable() ? this.safe : null;
        } catch {
            return null;
        }
    }

    private readPlain(): Credentials | null {
        if (!fs.existsSync(this.plainPath)) return null;
        try {
            const tokens = parseStoredTokens(fs.readFileSync(this.plainPath, 'utf8'));
            if (!tokens) console.warn('[auth] token.json is unreadable; ignoring it');
            return tokens;
        } catch (err) {
            console.warn('[auth] could not read token.json:', describe(err));
            return null;
        }
    }
}

function readClientSecrets(file: string): { clientId: string; clientSecret: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new AppError('UNKNOWN', "The app's Google sign-in settings are missing or damaged.", `${file}: ${describe(err)}`);
    }
    const section = isRecord(parsed) ? (isRecord(parsed.installed) ? parsed.installed : parsed.web) : null;
    if (!isRecord(section) || typeof section.client_id !== 'string') {
        throw new AppError('UNKNOWN', "The app's Google sign-in settings are missing or damaged.", `${file}: no installed.client_id`);
    }
    return { clientId: section.client_id, clientSecret: typeof section.client_secret === 'string' ? section.client_secret : '' };
}

function page(title: string, text: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<style>body{font-family:system-ui,sans-serif;background:#f4f4f5;color:#18181b;display:grid;place-items:center;min-height:100vh;margin:0}'
        + 'main{background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:420px;text-align:center}'
        + 'h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#52525b}'
        + '@media (prefers-color-scheme: dark){body{background:#18181b;color:#f4f4f5}main{background:#27272a}p{color:#a1a1aa}}</style></head>'
        + `<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

function sendPage(res: http.ServerResponse, status: number, html: string): Promise<void> {
    return new Promise((resolve) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
        res.end(html, () => resolve());
    });
}

function listenOnLoopback(server: http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            const address = server.address();
            if (address && typeof address === 'object') resolve(address.port);
            else reject(new Error('The sign-in helper could not open a local port.'));
        });
    });
}

interface OAuthCallback {
    code: string;
    respond: (status: number, html: string) => Promise<void>;
}

/** Resolves with the first redirect that carries our state; rejects on "access_denied", timeout or abort. */
function waitForCallback(server: http.Server, state: string, timeoutMs: number, signal: AbortSignal): Promise<OAuthCallback> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (settle: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            settle();
        };
        const timer = setTimeout(() => {
            finish(() => reject(new AppError('TIMEOUT', 'Google sign-in took too long. Please try again.')));
        }, timeoutMs);
        const onAbort = (): void => finish(() => reject(signal.reason));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });

        server.on('request', (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (url.pathname !== '/') {
                void sendPage(res, 404, page('Not found', ''));
                return;
            }
            if (settled || url.searchParams.get('state') !== state) {
                void sendPage(res, 400, page('This sign-in link is no longer valid', 'Close this tab and start the sign-in again from MCS-Relay.'));
                return;
            }
            const error = url.searchParams.get('error');
            const code = url.searchParams.get('code');
            if (error || !code) {
                void sendPage(res, 200, page('Sign-in cancelled', 'You can close this tab and go back to MCS-Relay.'));
                const message = error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed. Please try again.';
                finish(() => reject(notSignedIn(message, error ?? 'no code in the redirect')));
                return;
            }
            finish(() => resolve({ code, respond: (status, html) => sendPage(res, status, html) }));
        });
    });
}

export class GoogleAuth {
    private readonly store: TokenStore;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    private oauth: OAuth2Client | null = null;
    private creds: Credentials | null = null;
    private loaded = false;
    /** Bumped on every login/logout so a refresh or userinfo call that finishes afterwards is dropped. */
    private generation = 0;
    private refreshing: Promise<string> | null = null;
    private staleToken: string | null = null;
    private user: UserInfo | null = null;
    private userLoading: Promise<UserInfo> | null = null;
    private pendingLogin: AbortController | null = null;
    private announced: string | null = null;

    constructor(private readonly deps: GoogleAuthDeps) {
        this.store = new TokenStore(deps.userDataDir, deps.safeStorage);
        this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
        this.now = deps.now ?? Date.now;
    }

    async status(): Promise<AuthStatus> {
        if (!this.tokens()) return LOGGED_OUT;
        try {
            const user = await this.me();
            return { loggedIn: true, user, collaborationEnabled: this.hasScope(SCOPES.collaboration) };
        } catch (err) {
            if (err instanceof AppError && err.code === 'NOT_SIGNED_IN') return LOGGED_OUT;
            throw err;
        }
    }

    async login(): Promise<AuthStatus> {
        const tokens = await this.authorize(SCOPES.base, { prompt: 'select_account consent' });
        this.replaceTokens(tokens);
        return this.status();
    }

    /** Incremental consent for the full drive scope, for tokens from the old two-step login (drive.file only),
     *  or when the Drive box was unticked on Google's consent screen. */
    async enableCollaboration(): Promise<AuthStatus> {
        const current = this.tokens();
        if (!current) throw notSignedIn();
        if (this.hasScope(SCOPES.collaboration)) return this.status();
        const user = await this.me();
        const granted = await this.authorize([SCOPES.collaboration], { prompt: 'consent', loginHint: user.email });
        // include_granted_scopes returns everything this account granted; no email scope means another account was picked.
        const grantedUser = granted.access_token && scopesOf(granted).includes(EMAIL_SCOPE)
            ? await this.userInfo(granted.access_token)
            : 'unauthorized';
        const sameAccount = grantedUser !== 'unauthorized' && grantedUser.email === user.email;
        if (!sameAccount) {
            throw new AppError('SCOPE_MISSING', `Please choose ${user.email}, the Google account you are logged in with.`);
        }
        this.replaceTokens({ ...current, ...granted, refresh_token: granted.refresh_token ?? current.refresh_token }, user);
        return this.status();
    }

    async logout(): Promise<void> {
        this.pendingLogin?.abort(notSignedIn('Signed out.'));
        const current = this.tokens();
        this.clearTokens();
        // Revoking the refresh token ends the grant (and its access tokens) at Google, not only on this PC.
        const token = current?.refresh_token ?? current?.access_token;
        if (token) await this.revoke(token);
    }

    async getAccessToken(): Promise<string> {
        const creds = this.tokens();
        if (!creds) throw notSignedIn();
        const token = creds.access_token;
        const expiring = typeof creds.expiry_date === 'number' && creds.expiry_date <= this.now() + EXPIRY_MARGIN_MS;
        if (token && token !== this.staleToken && !expiring) return token;
        if (!this.refreshing) {
            this.refreshing = this.refresh().finally(() => {
                this.refreshing = null;
            });
        }
        return this.refreshing;
    }

    /** After a 401. With `token`, only that token is dropped: a newer one from a refresh in between stays. */
    invalidateAccessToken(token?: string): void {
        const current = this.creds?.access_token ?? null;
        if (token !== undefined && token !== current) return;
        this.staleToken = current;
    }

    async me(): Promise<UserInfo> {
        if (this.user) return this.user;
        if (!this.userLoading) {
            const generation = this.generation;
            this.userLoading = this.loadUser()
                .then((user) => {
                    if (generation === this.generation) {
                        this.user = user;
                        this.announce(user);
                    }
                    return user;
                })
                .finally(() => {
                    this.userLoading = null;
                });
        }
        return this.userLoading;
    }

    hasScope(scope: string): boolean {
        return scopesOf(this.tokens()).includes(scope);
    }

    /* ------------------------------------------------------------------ tokens */

    private tokens(): Credentials | null {
        if (!this.loaded) {
            this.loaded = true;
            this.creds = this.store.load();
            if (this.creds) this.oauth?.setCredentials(this.creds);
        }
        return this.creds;
    }

    private client(): OAuth2Client {
        if (!this.oauth) {
            const { clientId, clientSecret } = readClientSecrets(this.deps.credentialsPath);
            this.oauth = new OAuth2Client({
                clientId,
                clientSecret,
                transporterOptions: this.deps.fetchImpl ? { fetchImplementation: this.deps.fetchImpl } : undefined,
            });
            const creds = this.tokens();
            if (creds) this.oauth.setCredentials(creds);
        }
        return this.oauth;
    }

    private async refresh(): Promise<string> {
        const generation = this.generation;
        const client = this.client();
        if (!client.credentials.refresh_token) {
            this.clearTokens();
            throw notSignedIn('Your Google sign-in expired. Please log in again.');
        }
        let refreshed: Credentials;
        try {
            ({ credentials: refreshed } = await client.refreshAccessToken());
        } catch (err) {
            if (generation !== this.generation) throw notSignedIn();
            if (isInvalidGrant(err)) {
                // Revoked, unused for 6 months, or the 7-day limit of an OAuth app still in "Testing" mode.
                console.warn('[auth] Google rejected the refresh token (invalid_grant); signing out');
                this.clearTokens();
                throw notSignedIn('Your Google sign-in expired or was revoked. Please log in again.', describe(err));
            }
            throw new AppError('NETWORK', 'Google could not be reached to renew your sign-in. Check your connection.', describe(err));
        }
        if (generation !== this.generation) {
            // Logged out (or in again) while this refresh ran: the library already put the result on the client.
            client.setCredentials(this.creds ?? {});
            throw notSignedIn();
        }
        if (!refreshed.access_token) throw new AppError('NETWORK', 'Google did not renew your sign-in. Try again.', 'no access_token in the refresh answer');
        this.staleToken = null;
        this.setTokens({ ...this.creds, ...refreshed, refresh_token: refreshed.refresh_token ?? this.creds?.refresh_token });
        return refreshed.access_token;
    }

    /** A new grant (login): everything cached about the previous one goes. */
    private replaceTokens(tokens: Credentials, user: UserInfo | null = null): void {
        this.generation += 1;
        this.staleToken = null;
        this.user = user;
        this.userLoading = null;
        this.setTokens(tokens);
        if (user) this.announce(user);
    }

    private announce(user: UserInfo | null): void {
        const email = user?.email.toLowerCase() ?? null;
        if (email === this.announced) return;
        this.announced = email;
        try {
            this.deps.onUserChanged?.(user);
        } catch (err) {
            console.error('[auth] onUserChanged failed:', describe(err));
        }
    }

    private setTokens(tokens: Credentials): void {
        this.loaded = true;
        this.creds = tokens;
        this.oauth?.setCredentials(tokens);
        try {
            this.store.save(tokens);
        } catch (err) {
            // Still signed in for this run; the next start asks for a login again.
            console.error('[auth] could not save the Google tokens:', describe(err));
        }
    }

    private clearTokens(): void {
        this.generation += 1;
        this.loaded = true;
        this.creds = null;
        this.staleToken = null;
        this.user = null;
        this.userLoading = null;
        this.oauth?.setCredentials({});
        this.store.clear();
        this.announce(null);
    }

    private async revoke(token: string): Promise<void> {
        try {
            const res = await this.fetchImpl(REVOKE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token }).toString(),
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
            });
            // 400 invalid_token = already revoked or expired: nothing left to do.
            if (!res.ok) console.warn(`[auth] Google answered ${res.status} to the token revoke`);
        } catch (err) {
            console.warn('[auth] could not revoke the token at Google:', describe(err));
        }
    }

    /* ------------------------------------------------------------------ user info */

    private async loadUser(): Promise<UserInfo> {
        const first = await this.getAccessToken();
        const user = await this.userInfo(first);
        if (user !== 'unauthorized') return user;
        this.invalidateAccessToken(first);
        const second = await this.userInfo(await this.getAccessToken());
        if (second !== 'unauthorized') return second;
        // A freshly refreshed token that userinfo still refuses lacks the email/profile scopes.
        throw new AppError('SCOPE_MISSING', 'Google did not share your account details with the app. Log out and allow them when you sign in.');
    }

    private async userInfo(accessToken: string): Promise<UserInfo | 'unauthorized'> {
        let res: Response;
        try {
            res = await this.fetchImpl(USERINFO_URL, {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
            });
        } catch (err) {
            throw new AppError('NETWORK', 'Google could not be reached. Check your connection.', describe(err));
        }
        if (res.status === 401) {
            await res.arrayBuffer().catch(() => undefined);
            return 'unauthorized';
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new AppError('NETWORK', 'Google could not load your account details. Try again.', `HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        const data: unknown = await res.json().catch(() => null);
        if (!isRecord(data) || typeof data.email !== 'string' || !data.email) {
            throw new AppError('SCOPE_MISSING', 'Google did not share your email address with the app. Log out and allow it when you sign in.');
        }
        const email = data.email;
        const name = typeof data.name === 'string' && data.name ? data.name
            : typeof data.given_name === 'string' && data.given_name ? data.given_name
                : email.split('@')[0];
        return { name, email, picture: typeof data.picture === 'string' ? data.picture : '' };
    }

    /* ------------------------------------------------------------------ consent (loopback + PKCE) */

    private async authorize(scopes: string[], opts: { prompt: string; loginHint?: string }): Promise<Credentials> {
        const client = this.client();
        // A second click on "Log in" (the first tab was closed) restarts the flow instead of waiting 5 minutes.
        this.pendingLogin?.abort(notSignedIn('Sign-in was restarted.'));
        const abort = new AbortController();
        this.pendingLogin = abort;
        const server = http.createServer();
        try {
            const port = await listenOnLoopback(server);
            const redirectUri = `http://127.0.0.1:${port}`;
            const state = randomBytes(24).toString('base64url');
            const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
            const url = client.generateAuthUrl({
                access_type: 'offline',
                prompt: opts.prompt,
                scope: scopes,
                include_granted_scopes: true,
                redirect_uri: redirectUri,
                state,
                code_challenge: codeChallenge,
                code_challenge_method: CodeChallengeMethod.S256,
                ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
            });
            const callback = waitForCallback(server, state, this.deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS, abort.signal);
            callback.catch(() => undefined);    // awaited below; this only keeps an early failure from being "unhandled"
            await this.deps.openExternal(url);
            const { code, respond } = await callback;
            let tokens: Credentials;
            try {
                ({ tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri }));
            } catch (err) {
                await respond(500, page('Sign-in failed', 'MCS-Relay could not finish signing you in. Close this tab and try again.'));
                throw notSignedIn('Google sign-in could not be completed. Please try again.', describe(err));
            }
            await respond(200, page('You are signed in', 'You can close this tab and go back to MCS-Relay.'));
            if (abort.signal.aborted) throw abort.signal.reason;
            return tokens;
        } finally {
            if (this.pendingLogin === abort) this.pendingLogin = null;
            abort.abort(notSignedIn('Sign-in finished.'));
            server.close();
            server.closeAllConnections();
        }
    }
}
