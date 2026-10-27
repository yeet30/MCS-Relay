// Reads and changes a server's server.properties on this PC. The file is Java's .properties format: "key=value"
// lines, "#" comments, backslash escapes ("§", "\:"). A change rewrites only the lines whose value changed (new
// keys go at the end), so comments, order and everything else stay as Minecraft wrote them. Minecraft reads the file
// when the server starts, and the next upload shares it with the other members like any other server file.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerPropertiesInfo } from '../../shared/types';
import { AppError } from '../errors';
import type { SettingsService } from '../settings/SettingsService';

export const PROPERTIES_FILE = 'server.properties';
const MAX_VALUE = 1000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** One logical line: its physical lines (several when continued with a trailing backslash) and its key. */
interface Line {
    physical: string[];
    key: string | null;                 // null: a comment or a blank line
    value: string;
}

/** Java's unescaping: \t \n \r \f, \uXXXX, and a backslash before anything else keeps that character. */
function unescape(text: string): string {
    return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
        if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
        return ({ t: '\t', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c;
    });
}

/** Escapes a value the way Java writes one, so Minecraft reads back exactly this text; the result is plain ASCII. */
export function escapeValue(value: string): string {
    let out = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        const code = value.charCodeAt(i);
        if (ch === '\\') out += '\\\\';
        else if (ch === '\t') out += '\\t';
        else if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\f') out += '\\f';
        else if (ch === '=' || ch === ':' || ch === '#' || ch === '!') out += `\\${ch}`;
        else if (ch === ' ' && i === 0) out += '\\ ';
        else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`;  // UTF-16 units
        else out += ch;
    }
    return out;
}

/** The key and value of a "key=value" line (also "key: value" and "key value"); null for comments and blanks. */
export function parseLine(text: string): { key: string; value: string } | null {
    const line = text.replace(/^[ \t\f]+/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) return null;
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '\\') i += 2;
        else if (ch === '=' || ch === ':' || ch === ' ' || ch === '\t' || ch === '\f') break;
        else i += 1;
    }
    let rest = line.slice(i).replace(/^[ \t\f]*/, '');
    if (rest.startsWith('=') || rest.startsWith(':')) rest = rest.slice(1).replace(/^[ \t\f]*/, '');
    return { key: unescape(line.slice(0, i)), value: unescape(rest) };
}

const continues = (text: string): boolean => /(?:^|[^\\])(?:\\\\)*\\$/.test(text);

function splitLines(text: string): Line[] {
    const all = text.split(/\r?\n/);
    if (all.at(-1) === '') all.pop();
    const lines: Line[] = [];
    for (let i = 0; i < all.length; i++) {
        const physical = [all[i]];
        while (continues(physical.at(-1)!) && i + 1 < all.length) physical.push(all[++i]);
        const logical = physical
            .map((p, n) => (n === 0 ? p : p.replace(/^[ \t\f]+/, '')))
            .map((p, n) => (n < physical.length - 1 ? p.slice(0, -1) : p))
            .join('');
        const parsed = parseLine(logical);
        lines.push({ physical, key: parsed?.key ?? null, value: parsed?.value ?? '' });
    }
    return lines;
}

export function parseProperties(text: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const line of splitLines(text)) if (line.key !== null) values[line.key] = line.value;
    return values;
}

/** The file with `changes` applied: changed values rewrite their own line, new keys are added at the end. */
export function applyChanges(text: string, changes: Record<string, string>): string {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const current = parseProperties(text);
    const pending = new Map(Object.entries(changes).filter(([key, value]) => current[key] !== value));
    if (pending.size === 0) return text;
    const out: string[] = [];
    for (const line of splitLines(text)) {
        if (line.key !== null && pending.has(line.key)) {
            out.push(`${line.key}=${escapeValue(pending.get(line.key)!)}`);
            pending.delete(line.key);
        } else out.push(line.physical.join(eol));
    }
    for (const [key, value] of pending) out.push(`${key}=${escapeValue(value)}`);
    return `${out.join(eol)}${eol}`;
}

export interface ServerPropertiesDeps {
    settings: Pick<SettingsService, 'getServer'>;
}

export class ServerProperties {
    constructor(private readonly d: ServerPropertiesDeps) {}

    async read(serverId: string): Promise<ServerPropertiesInfo> {
        const file = this.file(serverId);
        if (!existsSync(file)) return { exists: false, values: {} };
        // Minecraft reads and writes the file as ISO-8859-1 (anything else as \u escapes).
        return { exists: true, values: parseProperties(await fs.readFile(file, 'latin1')) };
    }

    /** Writes the changed values; a missing file is made with just them (Minecraft adds the rest when it starts). */
    async write(serverId: string, changes: Record<string, string>): Promise<ServerPropertiesInfo> {
        for (const [key, value] of Object.entries(changes)) {
            if (!KEY_RE.test(key)) throw new AppError('INVALID', `"${key}" is not a property name.`);
            if (typeof value !== 'string' || value.length > MAX_VALUE) throw new AppError('INVALID', `The value of ${key} is too long.`);
            if (/[\r\n]/.test(value)) throw new AppError('INVALID', `The value of ${key} must be on one line.`);
        }
        const file = this.file(serverId);
        const before = existsSync(file) ? await fs.readFile(file, 'latin1') : '';
        const after = applyChanges(before, changes);
        if (after !== before) {
            const old = parseProperties(before);
            await fs.writeFile(`${file}.tmp`, after, 'latin1');
            await fs.rename(`${file}.tmp`, file);
            console.log(`[properties] ${serverId}: changed ${Object.keys(changes).filter((k) => old[k] !== changes[k]).join(', ')}`);
        }
        return { exists: true, values: parseProperties(after) };
    }

    private file(serverId: string): string {
        const folder = this.d.settings.getServer(serverId).localPath;
        if (!folder) throw new AppError('NO_LOCAL_PATH', 'Choose a folder on this PC for this server first.');
        return path.join(folder, PROPERTIES_FILE);
    }
}
