// The app's own log, for problem reports: everything the main process writes to the console, plus what the window
// and Electron report, in <data folder>/logs/mcs-relay.log. When it passes MAX_BYTES it becomes mcs-relay.old.log and
// a new one starts, so the two together never take more than about twice that. Lines are written synchronously: the
// last one before a crash is the one that explains it.
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

export const LOG_FILE = 'mcs-relay.log';
export const OLD_LOG_FILE = 'mcs-relay.old.log';
const MAX_BYTES = 4 * 1024 * 1024;

export type LogLevel = 'info' | 'warn' | 'error';

// Sign-in secrets never belong in a log, even if some message happens to carry one.
const SECRETS: Array<[RegExp, string]> = [
    [/(Bearer\s+)[\w.~+/-]+=*/gi, '$1[hidden]'],
    [/ya29\.[\w.-]+/g, 'ya29.[hidden]'],                                         // access tokens
    [/\b1\/\/[\w-]{20,}/g, '1//[hidden]'],                                      // refresh tokens
    [/GOCSPX-[\w-]+/g, 'GOCSPX-[hidden]'],                                      // client secrets
    [/("(?:access_token|refresh_token|id_token|client_secret|code)"\s*:\s*")[^"]*"/g, '$1[hidden]"'],
    [/([?&](?:code|access_token|refresh_token)=)[^&\s"']+/g, '$1[hidden]'],
];

export function redact(text: string): string {
    return SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

export class AppLog {
    private fd: number | null = null;
    private size = 0;

    /** `now` exists for tests. */
    constructor(readonly folder: string, private readonly now: () => Date = () => new Date(), private readonly maxBytes = MAX_BYTES) {}

    get file(): string {
        return path.join(this.folder, LOG_FILE);
    }

    write(level: LogLevel, text: string): void {
        try {
            if (this.fd === null) this.open();
            if (this.fd === null) return;
            const line = `${this.now().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(text).replace(/\r?\n/g, '\n    ')}\n`;
            this.size += fs.writeSync(this.fd, line);
            if (this.size > this.maxBytes) this.rotate();
        } catch {
            // A log that cannot be written must never break the app.
        }
    }

    /** console.log / info / warn / error / debug of this process also go to the log. */
    captureConsole(target: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'> = console): void {
        const levels: Record<'log' | 'info' | 'warn' | 'error' | 'debug', LogLevel> = { log: 'info', info: 'info', debug: 'info', warn: 'warn', error: 'error' };
        for (const method of Object.keys(levels) as Array<keyof typeof levels>) {
            const original = target[method].bind(target);
            target[method] = (...args: unknown[]) => {
                original(...args);
                this.write(levels[method], format(...args));
            };
        }
    }

    /** The end of the log: up to `maxBytes`, taken from the old file first when the current one is shorter. */
    tail(maxBytes: number): string {
        const parts: string[] = [];
        let left = maxBytes;
        for (const name of [LOG_FILE, OLD_LOG_FILE]) {
            if (left <= 0) break;
            const text = readEnd(path.join(this.folder, name), left);
            if (text === null) continue;
            parts.unshift(text);
            left -= Buffer.byteLength(text);
        }
        return parts.join('');
    }

    private open(): void {
        fs.mkdirSync(this.folder, { recursive: true });
        try {
            this.size = fs.statSync(this.file).size;
        } catch {
            this.size = 0;
        }
        if (this.size > this.maxBytes) {
            this.rotate();
            return;
        }
        this.fd = fs.openSync(this.file, 'a');
    }

    private rotate(): void {
        if (this.fd !== null) fs.closeSync(this.fd);
        this.fd = null;
        fs.rmSync(path.join(this.folder, OLD_LOG_FILE), { force: true });
        fs.renameSync(this.file, path.join(this.folder, OLD_LOG_FILE));
        this.fd = fs.openSync(this.file, 'a');
        this.size = 0;
    }
}

/** The last `maxBytes` of a file, starting at a whole line; null when it does not exist. */
function readEnd(file: string, maxBytes: number): string | null {
    let fd: number;
    try {
        fd = fs.openSync(file, 'r');
    } catch {
        return null;
    }
    try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        const text = buffer.toString('utf8');
        if (length === size) return text;
        const firstLine = text.indexOf('\n');
        return firstLine === -1 ? '' : text.slice(firstLine + 1);
    } finally {
        fs.closeSync(fd);
    }
}
