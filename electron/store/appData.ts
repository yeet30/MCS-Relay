// Everything the app keeps on this PC, in Electron's userData folder:
//   settings.json                         app-wide settings (AppSettings)
//   servers/<id>/settings.json            per-server settings (local path, Java flags)
//   servers/<id>/base.json                what this PC and the cloud last agreed on
//   servers/<id>/journal.json             exists only while an upload is unfinished
//   servers/<id>/backups/<time>-<label>/  copies made before overwriting local files
// The files are small, so synchronous fs is fine; every write is atomic (write *.tmp, fsync, rename).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_JAVA_FLAGS } from '../../shared/types';
import type { AppSettings, BaseEntry, BaseSnapshot, JavaFlags, ServerSettings } from '../../shared/types';
import { normalizeRule } from '../../shared/paths';
import { AppError } from '../errors';

export interface UploadJournal {
    format: 1;
    serverId: string;
    startedAt: string;
    baseRevision: number;
    sessionId: string;
}

export const RAM_LIMITS = { min: 256, max: 65536 } as const;

export const DEFAULT_SETTINGS: AppSettings = {
    selectedServerId: null,
    playitggPath: '',
    usePlayitgg: false,
    launchServer: true,
    joinedServerIds: [],
};

const LEGACY_FILE = 'localStore.json';
const LEGACY_MIGRATED_FILE = 'localStore.migrated.json';
const BACKUPS = 'backups';
// Drive file ids use this alphabet. Checking it also keeps ids that arrive over IPC from escaping servers/.
const SERVER_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function isValidServerId(id: unknown): id is string {
    return typeof id === 'string' && SERVER_ID.test(id);
}

export class AppData {
    private readonly serversRoot: string;

    /** `now` exists for tests (backup folder names). */
    constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {
        this.serversRoot = path.join(root, 'servers');
    }

    /* -------------------------------------------------------------- app settings */

    readSettings(): AppSettings {
        return parseSettings(this.readJson(path.join(this.root, 'settings.json')));
    }

    writeSettings(s: AppSettings): void {
        writeJsonAtomic(path.join(this.root, 'settings.json'), parseSettings(s));
    }

    /* -------------------------------------------------------------- per-server files */

    readServerSettings(id: string): ServerSettings {
        return parseServerSettings(this.readJson(this.serverFile(id, 'settings.json')));
    }

    writeServerSettings(id: string, s: ServerSettings): void {
        writeJsonAtomic(this.serverFile(id, 'settings.json'), parseServerSettings(s));
    }

    /** Deletes everything this PC knows about a server except its backups. */
    removeServer(id: string): void {
        const dir = this.serverDir(id);
        let entries: string[];
        try {
            entries = fs.readdirSync(dir);
        } catch (err) {
            if (isErrno(err, 'ENOENT')) return;
            throw err;
        }
        for (const entry of entries) {
            if (entry === BACKUPS) continue;
            fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        }
        try {
            fs.rmdirSync(dir);
        } catch (err) {
            if (!isErrno(err, 'ENOTEMPTY') && !isErrno(err, 'EEXIST')) throw err;     // backups stay
        }
    }

    readBase(id: string): BaseSnapshot | null {
        const file = this.serverFile(id, 'base.json');
        const raw = this.readJson(file);
        if (raw === undefined) return null;
        const base = parseBase(raw, id);
        if (!base) this.moveAside(file, 'invalid base snapshot');
        return base;
    }

    writeBase(id: string, b: BaseSnapshot): void {
        if (b.serverId !== id) throw new AppError('INVALID', 'The sync state belongs to another server.', `${b.serverId} !== ${id}`);
        writeJsonAtomic(this.serverFile(id, 'base.json'), b);
    }

    readJournal(id: string): UploadJournal | null {
        const file = this.serverFile(id, 'journal.json');
        const raw = this.readJson(file);
        if (raw === undefined) return null;
        const journal = parseJournal(raw, id);
        if (!journal) this.moveAside(file, 'invalid upload journal');
        return journal;
    }

    writeJournal(id: string, j: UploadJournal): void {
        if (j.serverId !== id) throw new AppError('INVALID', 'The upload journal belongs to another server.', `${j.serverId} !== ${id}`);
        writeJsonAtomic(this.serverFile(id, 'journal.json'), j);
    }

    deleteJournal(id: string): void {
        fs.rmSync(this.serverFile(id, 'journal.json'), { force: true });
    }

    serversWithJournal(): string[] {
        return this.serverIds().filter((id) => this.readJournal(id) !== null);
    }

    /** Every server that has a folder in servers/ (settings, base, journal or backups). */
    serverIds(): string[] {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(this.serversRoot, { withFileTypes: true });
        } catch (err) {
            if (isErrno(err, 'ENOENT')) return [];
            throw err;
        }
        return entries.filter((e) => e.isDirectory() && isValidServerId(e.name)).map((e) => e.name).sort();
    }

    /** Creates and returns servers/<id>/backups/<yyyy-mm-dd_hh-mm-ss>-<label>/ (unique). */
    backupDir(id: string, label: string): string {
        const parent = path.join(this.serverDir(id), BACKUPS);
        fs.mkdirSync(parent, { recursive: true });
        const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'backup';
        const stem = `${timestamp(this.now())}-${safeLabel}`;
        for (let n = 1; ; n++) {
            const dir = path.join(parent, n === 1 ? stem : `${stem}-${n}`);
            try {
                fs.mkdirSync(dir);
                return dir;
            } catch (err) {
                if (!isErrno(err, 'EEXIST')) throw err;
            }
        }
    }

    /* -------------------------------------------------------------- the old app's localStore.json */

    /** One-time import of the old app's localStore.json. Idempotent: the file is renamed when done. */
    migrateLegacy(): void {
        const legacyPath = path.join(this.root, LEGACY_FILE);
        if (!fs.existsSync(legacyPath)) return;
        const legacy = this.readLegacy(legacyPath);
        if (!legacy) return;            // unreadable: moved aside as .corrupt

        const settings = this.readSettings();
        const vars = isRecord(legacy.localVariables) ? legacy.localVariables : {};
        const paths = legacyPaths(legacy);
        const joined = Array.isArray(legacy.joinedServerIds) ? legacy.joinedServerIds.filter(isValidServerId) : [];

        settings.joinedServerIds = unique([...settings.joinedServerIds, ...joined]);
        if (typeof vars.playitggPath === 'string' && vars.playitggPath.trim() !== '') {
            settings.playitggPath = vars.playitggPath.trim();
        }
        const checklist = isRecord(vars.checklist) ? vars.checklist : {};
        // The old default was "playit.gg on" with no path, which blocked every start (F41).
        if (typeof checklist.playitgg === 'boolean') settings.usePlayitgg = checklist.playitgg && settings.playitggPath !== '';
        if (typeof checklist.serverConsole === 'boolean') settings.launchServer = checklist.serverConsole;
        this.writeSettings(settings);

        const javaFlags = legacyJavaFlags(vars);
        for (const id of unique([...Object.keys(paths), ...joined])) {
            const server = this.readServerSettings(id);
            if (paths[id]) server.localPath = paths[id];
            if (javaFlags) server.javaFlags = { ...javaFlags };
            this.writeServerSettings(id, server);
        }

        renameWithRetry(legacyPath, path.join(this.root, LEGACY_MIGRATED_FILE));
        console.log(`[appData] imported ${LEGACY_FILE} (${Object.keys(paths).length} local paths, ${joined.length} joined servers)`);
    }

    /** The old app's global ignore list, as shared rules. Folders that exist in one of the old local
     *  paths get a trailing "/". The app's own files are dropped (they are builtin rules now). */
    legacyBlacklist(): string[] {
        const migrated = path.join(this.root, LEGACY_MIGRATED_FILE);
        const pending = path.join(this.root, LEGACY_FILE);
        const file = fs.existsSync(migrated) ? migrated : pending;
        const legacy = fs.existsSync(file) ? this.readLegacy(file) : null;
        if (!legacy) return [];
        const vars = isRecord(legacy.localVariables) ? legacy.localVariables : {};
        if (!Array.isArray(vars.watcherBlacklist)) return [];
        const roots = Object.values(legacyPaths(legacy));

        const rules: string[] = [];
        for (const entry of vars.watcherBlacklist) {
            if (typeof entry !== 'string') continue;
            const relative = relativeToRoots(entry.trim(), roots);
            if (relative === null) continue;
            const rule = normalizeRule(relative);
            if (rule === null) continue;
            const bare = rule.endsWith('/') ? rule.slice(0, -1) : rule;
            if (bare === 'manifest.json' || bare === 'lock.json') continue;
            const isFolder = rule.endsWith('/') || roots.some((r) => isDirectory(path.join(r, ...bare.split('/'))));
            rules.push(isFolder ? `${bare}/` : bare);
        }
        return unique(rules);
    }

    /* -------------------------------------------------------------- helpers */

    private serverDir(id: string): string {
        if (!isValidServerId(id)) throw new AppError('INVALID', 'Invalid server id.', JSON.stringify(id));
        return path.join(this.serversRoot, id);
    }

    private serverFile(id: string, name: string): string {
        return path.join(this.serverDir(id), name);
    }

    /** Parsed JSON, or undefined when the file is missing or unreadable (corrupt files are moved aside). */
    private readJson(file: string): unknown {
        let text: string;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (err) {
            if (!isErrno(err, 'ENOENT')) console.warn(`[appData] cannot read ${file}:`, err);
            return undefined;
        }
        try {
            return JSON.parse(stripBom(text));
        } catch (err) {
            this.moveAside(file, err instanceof Error ? err.message : String(err));
            return undefined;
        }
    }

    private readLegacy(file: string): Record<string, unknown> | null {
        const value = this.readJson(file);
        return isRecord(value) ? value : null;
    }

    /** Keeps a broken file as <name>.corrupt so the defaults can be written over it. */
    private moveAside(file: string, why: string): void {
        console.warn(`[appData] ${file} is corrupt (${why}); keeping a copy as .corrupt and using defaults`);
        try {
            renameWithRetry(file, `${file}.corrupt`);
        } catch (err) {
            console.warn(`[appData] could not move ${file} aside:`, err);
        }
    }
}

/* ------------------------------------------------------------------ parsing */

function parseSettings(raw: unknown): AppSettings {
    const r = isRecord(raw) ? raw : {};
    return {
        selectedServerId: isValidServerId(r.selectedServerId) ? r.selectedServerId : null,
        playitggPath: typeof r.playitggPath === 'string' ? r.playitggPath : DEFAULT_SETTINGS.playitggPath,
        usePlayitgg: typeof r.usePlayitgg === 'boolean' ? r.usePlayitgg : DEFAULT_SETTINGS.usePlayitgg,
        launchServer: typeof r.launchServer === 'boolean' ? r.launchServer : DEFAULT_SETTINGS.launchServer,
        joinedServerIds: Array.isArray(r.joinedServerIds) ? unique(r.joinedServerIds.filter(isValidServerId)) : [],
    };
}

function parseServerSettings(raw: unknown): ServerSettings {
    const r = isRecord(raw) ? raw : {};
    const flags = isRecord(r.javaFlags) ? r.javaFlags : {};
    return {
        localPath: typeof r.localPath === 'string' && r.localPath !== '' ? r.localPath : null,
        javaFlags: sanitizeJavaFlags(flags.minRAM, flags.maxRAM, flags.customFlags) ?? { ...DEFAULT_JAVA_FLAGS },
    };
}

/** Clamps stored or imported values into the allowed range; null when they are not numbers at all. */
function sanitizeJavaFlags(minRaw: unknown, maxRaw: unknown, customRaw: unknown): JavaFlags | null {
    const min = toNumber(minRaw);
    const max = toNumber(maxRaw);
    if (min === null || max === null) return null;
    const clamp = (n: number) => Math.min(RAM_LIMITS.max, Math.max(RAM_LIMITS.min, Math.round(n)));
    const maxRAM = clamp(max);
    return {
        minRAM: Math.min(clamp(min), maxRAM),
        maxRAM,
        customFlags: typeof customRaw === 'string' ? customRaw.trim() : '',
    };
}

function parseBase(raw: unknown, id: string): BaseSnapshot | null {
    if (!isRecord(raw) || raw.format !== 2 || raw.serverId !== id || !isCount(raw.revision)) return null;
    if (!isRecord(raw.files)) return null;
    const files: Record<string, BaseEntry> = {};
    for (const [p, e] of Object.entries(raw.files)) {
        if (!isRecord(e) || !isCount(e.size) || typeof e.md5 !== 'string' || typeof e.driveId !== 'string'
            || typeof e.mtimeMs !== 'number' || !Number.isFinite(e.mtimeMs)) return null;
        files[p] = { size: e.size, md5: e.md5, driveId: e.driveId, mtimeMs: e.mtimeMs };
    }
    const folders: Record<string, string> = {};
    if (raw.folders !== undefined) {
        if (!isRecord(raw.folders)) return null;
        for (const [p, folderId] of Object.entries(raw.folders)) {
            if (typeof folderId !== 'string') return null;
            folders[p] = folderId;
        }
    }
    return { format: 2, serverId: id, revision: raw.revision, files, folders };
}

function parseJournal(raw: unknown, id: string): UploadJournal | null {
    if (!isRecord(raw) || raw.format !== 1 || raw.serverId !== id) return null;
    if (typeof raw.startedAt !== 'string' || !isCount(raw.baseRevision) || typeof raw.sessionId !== 'string') return null;
    return { format: 1, serverId: id, startedAt: raw.startedAt, baseRevision: raw.baseRevision, sessionId: raw.sessionId };
}

function legacyPaths(legacy: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {};
    if (!isRecord(legacy.paths)) return result;
    for (const [id, p] of Object.entries(legacy.paths)) {
        if (isValidServerId(id) && typeof p === 'string' && p.trim() !== '') result[id] = p.trim();
    }
    return result;
}

/** The current branch stored allocatedRAM {MIN, MAX}; the old main stored javaFlags {minRAM, maxRAM, customFlags}. */
function legacyJavaFlags(vars: Record<string, unknown>): JavaFlags | null {
    if (isRecord(vars.javaFlags)) {
        const flags = sanitizeJavaFlags(vars.javaFlags.minRAM, vars.javaFlags.maxRAM, vars.javaFlags.customFlags);
        if (flags) return flags;
    }
    if (isRecord(vars.allocatedRAM)) {
        return sanitizeJavaFlags(vars.allocatedRAM.MIN, vars.allocatedRAM.MAX, '');
    }
    return null;
}

/** Old entries were meant relative to the server folder; absolute ones are made relative to a known
 *  local path when possible and dropped otherwise (the old app never matched them either). */
function relativeToRoots(entry: string, roots: string[]): string | null {
    const absolute = path.win32.isAbsolute(entry) || path.posix.isAbsolute(entry);
    if (!absolute) return entry;
    const lower = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    for (const root of roots) {
        const prefix = `${lower(root)}/`;
        if (lower(entry).startsWith(prefix)) return entry.replace(/\\/g, '/').slice(prefix.length);
    }
    // "/logs" or "\logs" was probably meant as root-relative; a drive letter or UNC path never was.
    return /^([A-Za-z]:|[\\/]{2})/.test(entry) ? null : entry;
}

/* ------------------------------------------------------------------ small utilities */

function writeJsonAtomic(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, null, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    renameWithRetry(tmp, file);
}

/** Windows briefly locks files that antivirus or the search indexer are reading; rename then fails
 *  with EPERM/EACCES/EBUSY. A few quick retries get past it; the last resort is copy + delete. */
function renameWithRetry(from: string, to: string): void {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (err) {
            const locked = isErrno(err, 'EPERM') || isErrno(err, 'EACCES') || isErrno(err, 'EBUSY');
            if (!locked) throw err;
            if (attempt < 4) {
                sleepSync(20 * (attempt + 1));
                continue;
            }
            fs.copyFileSync(from, to);
            fs.rmSync(from, { force: true });
            return;
        }
    }
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function timestamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function toNumber(v: unknown): number | null {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isErrno(err: unknown, code: string): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}
