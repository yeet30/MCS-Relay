// Everything the app keeps on this PC, in Electron's userData folder:
//   settings.json                         settings of this PC (playit.gg, launch, notifications)
//   accounts/<email>/account.json         settings of one Google account (selected and joined servers, EULA, terms)
//   accounts/<email>/servers/<id>/        that account's files for one server:
//       settings.json                     local path, Java flags
//       base.json                         what this PC and the cloud last agreed on
//       journal.json, journal.log         exist only while an upload is unfinished
//       backups/<time>-<label>/           copies made before overwriting local files
// Server data is kept per account, so two accounts on one PC can each pick any folder for their servers.
// Data from before accounts were separated lives in servers/<id>/ and moves to the first account that uses it.
// The files are small, so synchronous fs is fine; every write is atomic (write *.tmp, fsync, rename).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_JAVA_FLAGS, THEMES } from '../../shared/types';
import type { AppSettings, BaseEntry, BaseSnapshot, JavaFlags, ServerSettings, ThemeName } from '../../shared/types';
import { normalizeRule } from '../../shared/paths';
import { AppError } from '../errors';

export interface UploadJournal {
    format: 1;
    serverId: string;
    startedAt: string;
    baseRevision: number;
    sessionId: string;
    /** true when journal.log records every job; journals from before the log existed lack it. */
    logged?: boolean;
    /** The upload repairs another member's unfinished upload: resuming it checks the cloud again. */
    repair?: boolean;
    /** How many changes (uploads and deletions) the upload means to send. */
    planned?: number;
}

/** One line of journal.log. Appended as things happen, so after a crash the file says exactly what reached
 *  Drive: a "start" without its "done" is the only case that has to be checked on Drive. */
export type JournalEntry =
    | { t: 'folder'; p: string; id: string }
    | { t: 'start'; p: string }
    | { t: 'done'; p: string; id: string; md5: string; size: number }
    | { t: 'gone'; p: string };

export const RAM_LIMITS = { min: 256, max: 65536 } as const;

export const DEFAULT_SETTINGS: AppSettings = {
    selectedServerId: null,
    playitggPath: '',
    usePlayitgg: false,
    launchServer: true,
    joinedServerIds: [],
    eulaAccepted: false,
    termsAccepted: 0,
    tourDone: false,
    serversFolder: '',
    autoBackupMinutes: 10,
    notifications: true,
    notificationSound: true,
    theme: 'light',
    playitPrimary: null,
};

const LEGACY_FILE = 'localStore.json';
const LEGACY_MIGRATED_FILE = 'localStore.migrated.json';
const BACKUPS = 'backups';
const ACCOUNTS = 'accounts';
// Drive file ids use this alphabet. Checking it also keeps ids that arrive over IPC from escaping servers/.
const SERVER_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function isValidServerId(id: unknown): id is string {
    return typeof id === 'string' && SERVER_ID.test(id);
}

/** The folder name for an account: the lower-cased email with anything unusual replaced. */
export function accountKey(email: string): string {
    return email.trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, '_').slice(0, 200) || '_';
}

export class AppData {
    private serversRoot: string;
    private account: string | null = null;

    /** `now` exists for tests (backup folder names). */
    constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {
        this.serversRoot = path.join(root, 'servers');
    }

    /** Switches to the files of a Google account; null (nobody signed in) uses the shared, older location. */
    setAccount(email: string | null): void {
        const key = email ? accountKey(email) : null;
        if (key === this.account) return;
        this.account = key;
        this.serversRoot = key ? path.join(this.root, ACCOUNTS, key, 'servers') : path.join(this.root, 'servers');
        if (key) this.seedAccount(key);
        console.log(`[appData] using the data of ${key ?? 'no account'}`);
    }

    /* -------------------------------------------------------------- app settings */

    readSettings(): AppSettings {
        const pc = parseSettings(this.readJson(this.settingsFile()));
        const file = this.accountFile();
        return file ? { ...pc, ...parseAccount(this.readJson(file)) } : pc;
    }

    writeSettings(s: AppSettings): void {
        const clean = parseSettings(s);
        const file = this.accountFile();
        if (!file) {
            writeJsonAtomic(this.settingsFile(), clean);
            return;
        }
        // The account's part goes to its own file; settings.json keeps what belongs to this PC.
        const { selectedServerId, joinedServerIds, eulaAccepted, termsAccepted, tourDone, ...pc } = clean;
        writeJsonAtomic(this.settingsFile(), { ...parseSettings(this.readJson(this.settingsFile())), ...pc });
        writeJsonAtomic(file, { selectedServerId, joinedServerIds, eulaAccepted, termsAccepted, tourDone });
    }

    private settingsFile(): string {
        return path.join(this.root, 'settings.json');
    }

    private accountFile(): string | null {
        return this.account ? path.join(this.root, ACCOUNTS, this.account, 'account.json') : null;
    }

    /** The first account on this PC inherits the servers selected and joined before accounts were separated. */
    private seedAccount(key: string): void {
        const file = path.join(this.root, ACCOUNTS, key, 'account.json');
        if (fs.existsSync(file)) return;
        let others: string[] = [];
        try {
            others = fs.readdirSync(path.join(this.root, ACCOUNTS)).filter((name) => name !== key);
        } catch {
            // no accounts yet
        }
        const legacy = parseSettings(this.readJson(this.settingsFile()));
        const inherit = others.length === 0;
        writeJsonAtomic(file, {
            selectedServerId: inherit ? legacy.selectedServerId : null,
            joinedServerIds: inherit ? legacy.joinedServerIds : [],
            eulaAccepted: false,
            termsAccepted: 0,
            tourDone: false,
        });
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

    /** The lock session this PC holds for a server, written at each claim and removed at the release: one still
     *  here after a restart means the app stopped while holding the lock. */
    readLockSession(id: string): string | null {
        const raw = this.readJson(this.serverFile(id, 'lock-session.json'));
        return isRecord(raw) && typeof raw.sessionId === 'string' ? raw.sessionId : null;
    }

    writeLockSession(id: string, sessionId: string | null): void {
        const file = this.serverFile(id, 'lock-session.json');
        if (sessionId === null) fs.rmSync(file, { force: true });
        else writeJsonAtomic(file, { sessionId });
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
        fs.rmSync(this.serverFile(id, 'journal.log'), { force: true });
    }

    /** Appends entries to journal.log (append-only, so a crash can lose at most the line being written). */
    appendJournalLog(id: string, entries: JournalEntry[]): void {
        if (entries.length === 0) return;
        const file = this.serverFile(id, 'journal.log');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
    }

    /** The log's entries in order; a torn last line (the app died while writing it) is skipped. */
    readJournalLog(id: string): JournalEntry[] {
        let text: string;
        try {
            text = fs.readFileSync(this.serverFile(id, 'journal.log'), 'utf8');
        } catch {
            return [];
        }
        const entries: JournalEntry[] = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const entry = parseJournalEntry(JSON.parse(line));
                if (entry) entries.push(entry);
            } catch {
                console.warn(`[appData] ${id}: skipping a damaged journal line`);
            }
        }
        return entries;
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
        if (fs.existsSync(path.join(this.root, LEGACY_MIGRATED_FILE))) {
            // Imported before: this one was written since by the old app, run again. Importing it would overwrite
            // what was set in this app since then.
            console.log(`[appData] ${LEGACY_FILE} was written again by the old app; not importing it a second time`);
            return;
        }
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
        // The old default was "playit.gg on" with no path, which blocked every start.
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
        const dir = path.join(this.serversRoot, id);
        if (this.account) this.adoptLegacy(id, dir);
        return dir;
    }

    /** Moves a server's data from the shared, older location to the first account that uses that server. */
    private adoptLegacy(id: string, dir: string): void {
        const legacy = path.join(this.root, 'servers', id);
        if (fs.existsSync(dir) || !fs.existsSync(legacy)) return;
        try {
            fs.mkdirSync(path.dirname(dir), { recursive: true });
            renameWithRetry(legacy, dir);
            console.log(`[appData] moved the data of server ${id} to account ${this.account}`);
        } catch (err) {
            console.warn(`[appData] could not move the data of server ${id}:`, err);
        }
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
        eulaAccepted: r.eulaAccepted === true,
        termsAccepted: isCount(r.termsAccepted) ? r.termsAccepted : 0,
        tourDone: r.tourDone === true,
        serversFolder: typeof r.serversFolder === 'string' ? r.serversFolder : '',
        autoBackupMinutes: isAutoBackupMinutes(r.autoBackupMinutes) ? r.autoBackupMinutes : DEFAULT_SETTINGS.autoBackupMinutes,
        notifications: typeof r.notifications === 'boolean' ? r.notifications : DEFAULT_SETTINGS.notifications,
        notificationSound: typeof r.notificationSound === 'boolean' ? r.notificationSound : DEFAULT_SETTINGS.notificationSound,
        theme: THEMES.includes(r.theme as ThemeName) ? (r.theme as ThemeName) : DEFAULT_SETTINGS.theme,
        playitPrimary: typeof r.playitPrimary === 'string' && r.playitPrimary !== '' ? r.playitPrimary : null,
    };
}

function parseAccount(raw: unknown): Pick<AppSettings, 'selectedServerId' | 'joinedServerIds' | 'eulaAccepted' | 'termsAccepted' | 'tourDone'> {
    const s = parseSettings(raw);
    return {
        selectedServerId: s.selectedServerId, joinedServerIds: s.joinedServerIds, eulaAccepted: s.eulaAccepted, termsAccepted: s.termsAccepted,
        tourDone: s.tourDone,
    };
}

function parseServerSettings(raw: unknown): ServerSettings {
    const r = isRecord(raw) ? raw : {};
    const flags = isRecord(r.javaFlags) ? r.javaFlags : {};
    const settings: ServerSettings = {
        localPath: typeof r.localPath === 'string' && r.localPath !== '' ? r.localPath : null,
        javaFlags: sanitizeJavaFlags(flags.minRAM, flags.maxRAM, flags.customFlags) ?? { ...DEFAULT_JAVA_FLAGS },
    };
    if (typeof r.javaPath === 'string' && r.javaPath !== '') settings.javaPath = r.javaPath;
    return settings;
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
    const journal: UploadJournal = { format: 1, serverId: id, startedAt: raw.startedAt, baseRevision: raw.baseRevision, sessionId: raw.sessionId };
    if (raw.logged === true) journal.logged = true;
    if (raw.repair === true) journal.repair = true;
    if (isCount(raw.planned)) journal.planned = raw.planned;
    return journal;
}

function parseJournalEntry(raw: unknown): JournalEntry | null {
    if (!isRecord(raw) || typeof raw.p !== 'string') return null;
    switch (raw.t) {
        case 'folder':
            return typeof raw.id === 'string' ? { t: 'folder', p: raw.p, id: raw.id } : null;
        case 'start':
            return { t: 'start', p: raw.p };
        case 'done':
            return typeof raw.id === 'string' && typeof raw.md5 === 'string' && isCount(raw.size)
                ? { t: 'done', p: raw.p, id: raw.id, md5: raw.md5, size: raw.size }
                : null;
        case 'gone':
            return { t: 'gone', p: raw.p };
        default:
            return null;
    }
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

/** 0 (off), or every 5 to 30 minutes. */
export function isAutoBackupMinutes(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && (v === 0 || (v >= 5 && v <= 30));
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
