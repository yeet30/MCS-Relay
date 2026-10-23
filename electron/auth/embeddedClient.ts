// The Google sign-in client of the app, built into the code at build time (vite.config.ts) instead of shipped as
// config/client_secret.json. Google does not treat a desktop app's client secret as a secret: anyone determined can
// pull it out of any installed app. Scrambling it only keeps it from being a readable file, or a plain string, that a
// quick look through the app's files turns up.

export interface ClientCredentials {
    clientId: string;
    clientSecret: string;
}

const KEY = 'MCS-Relay sign-in';

function mask(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ KEY.charCodeAt(i % KEY.length) ^ ((i * 31) & 0xff);
    return out;
}

/** client_secret.json's text (as Google Cloud Console downloads it) -> the scrambled form built into the app.
 *  An empty string when the file is missing or has no desktop client in it. */
export function scrambleClientFile(text: string | null): string {
    if (!text) return '';
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return '';
    }
    const section = (parsed as { installed?: { client_id?: unknown; client_secret?: unknown } } | null)?.installed;
    if (typeof section?.client_id !== 'string') return '';
    const credentials: ClientCredentials = {
        clientId: section.client_id,
        clientSecret: typeof section.client_secret === 'string' ? section.client_secret : '',
    };
    return Buffer.from(mask(new TextEncoder().encode(JSON.stringify(credentials))).reverse()).toString('base64');
}

/** The built-in client, or null when this build has none (it was built without config/client_secret.json). */
export function unscrambleClient(blob: string): ClientCredentials | null {
    if (!blob) return null;
    try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(mask(Buffer.from(blob, 'base64').reverse())));
        const { clientId, clientSecret } = (parsed ?? {}) as Partial<ClientCredentials>;
        return typeof clientId === 'string' && clientId && typeof clientSecret === 'string' ? { clientId, clientSecret } : null;
    } catch {
        return null;
    }
}
