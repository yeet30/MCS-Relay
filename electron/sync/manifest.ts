// manifest.json (format 2) and sync-rules.json: parsing, serializing and conversion to snapshots.
// All Drive access goes through LauncherFiles.
import { AppError } from '../errors';
import { DEFAULT_SHARED_IGNORES, normalizeRule } from '../../shared/paths';
import type {
    IncompleteUpload, BaseSnapshot, Manifest, ManifestEntry, Snapshot, SnapshotEntry } from '../../shared/types';
import type { LauncherFiles } from './launcherFiles';

const DAMAGED = "The server's manifest.json on Google Drive is damaged, so the app cannot tell which files belong to the server.";

export function emptyManifest(author: { name: string; email: string }): Manifest {
    return {
        format: 2,
        revision: 0,
        parentRevision: 0,
        author: { name: author.name, email: author.email },
        createdAt: new Date().toISOString(),
        files: {},
        folders: {},
    };
}

/** Validates format 2 and every field type; a missing "folders" becomes {}. Throws AppError('INVALID'). */
export function parseManifest(text: string): Manifest {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        throw invalid(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isRecord(raw)) throw invalid('not an object');
    if (raw.format !== 2) throw invalid(`unsupported format ${JSON.stringify(raw.format)}`);
    const revision = count(raw.revision, 'revision');
    const parentRevision = count(raw.parentRevision, 'parentRevision');

    const author = raw.author;
    if (!isRecord(author) || typeof author.name !== 'string' || typeof author.email !== 'string') throw invalid('bad author');
    if (typeof raw.createdAt !== 'string') throw invalid('bad createdAt');

    if (!isRecord(raw.files)) throw invalid('bad files');
    const files: Record<string, ManifestEntry> = {};
    for (const [path, value] of Object.entries(raw.files)) {
        checkPath(path);
        if (!isRecord(value) || typeof value.md5 !== 'string' || typeof value.driveId !== 'string') {
            throw invalid(`bad entry for ${path}`);
        }
        files[path] = { size: count(value.size, `size of ${path}`), md5: value.md5, driveId: value.driveId };
    }

    const folders: Record<string, string> = {};
    if (raw.folders !== undefined) {
        if (!isRecord(raw.folders)) throw invalid('bad folders');
        for (const [path, id] of Object.entries(raw.folders)) {
            checkPath(path);
            if (typeof id !== 'string') throw invalid(`bad folder id for ${path}`);
            folders[path] = id;
        }
    }

    const manifest: Manifest = {
        format: 2,
        revision,
        parentRevision,
        author: { name: author.name, email: author.email },
        createdAt: raw.createdAt,
        files,
        folders,
    };
    const incomplete = parseIncomplete(raw.incomplete);
    if (incomplete) manifest.incomplete = incomplete;
    return manifest;
}

/** Older apps do not write it; a damaged one is ignored rather than making the whole manifest unreadable. */
function parseIncomplete(raw: unknown): IncompleteUpload | null {
    if (!isRecord(raw) || !isRecord(raw.by) || typeof raw.by.name !== 'string' || typeof raw.by.email !== 'string') return null;
    if (typeof raw.at !== 'string' || typeof raw.sent !== 'number' || !Number.isInteger(raw.sent) || raw.sent < 0) return null;
    const planned = typeof raw.planned === 'number' && Number.isInteger(raw.planned) && raw.planned >= 0 ? raw.planned : null;
    return { by: { name: raw.by.name, email: raw.by.email }, at: raw.at, sent: raw.sent, planned };
}

/** Stable output: fixed key order, files and folders sorted by path, 2-space JSON. */
export function serializeManifest(m: Manifest): string {
    const files: Record<string, ManifestEntry> = {};
    for (const path of sortedKeys(m.files)) {
        const e = m.files[path];
        files[path] = { size: e.size, md5: e.md5, driveId: e.driveId };
    }
    const folders: Record<string, string> = {};
    for (const path of sortedKeys(m.folders)) folders[path] = m.folders[path];
    const ordered: Manifest = {
        format: 2,
        revision: m.revision,
        parentRevision: m.parentRevision,
        author: { name: m.author.name, email: m.author.email },
        createdAt: m.createdAt,
        files,
        folders,
    };
    if (m.incomplete) {
        const { by, at, sent, planned } = m.incomplete;
        ordered.incomplete = { by: { name: by.name, email: by.email }, at, sent, planned };
    }
    return JSON.stringify(ordered, null, 2);
}

export function manifestToSnapshot(m: Manifest | null): Snapshot {
    const snap: Snapshot = new Map();
    if (!m) return snap;
    for (const path of sortedKeys(m.files)) {
        const e = m.files[path];
        snap.set(path, { size: e.size, md5: e.md5, driveId: e.driveId });
    }
    return snap;
}

export function baseToSnapshot(b: BaseSnapshot | null): Snapshot {
    const snap: Snapshot = new Map();
    if (!b) return snap;
    for (const path of sortedKeys(b.files)) {
        const e = b.files[path];
        const entry: SnapshotEntry = { size: e.size, md5: e.md5, mtimeMs: e.mtimeMs, driveId: e.driveId };
        snap.set(path, entry);
    }
    return snap;
}

/** The "ignore" list of sync-rules.json, normalized. Unreadable content falls back to the defaults. */
export function parseRules(text: string): string[] {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        console.warn('[sync] sync-rules.json is not valid JSON; using the default rules');
        return [...DEFAULT_SHARED_IGNORES];
    }
    if (!isRecord(raw) || !Array.isArray(raw.ignore)) {
        console.warn('[sync] sync-rules.json has no "ignore" list; using the default rules');
        return [...DEFAULT_SHARED_IGNORES];
    }
    return normalizeList(raw.ignore.filter((r): r is string => typeof r === 'string'));
}

export function serializeRules(ignore: string[]): string {
    return JSON.stringify({ format: 1, ignore: normalizeList(ignore) }, null, 2);
}

export async function readManifest(launcher: LauncherFiles, serverId: string): Promise<Manifest | null> {
    const file = await launcher.readText(serverId, 'manifest.json');
    return file ? parseManifest(file.text) : null;
}

export async function writeManifest(launcher: LauncherFiles, serverId: string, m: Manifest): Promise<void> {
    await launcher.writeText(serverId, 'manifest.json', serializeManifest(m));
}

/** null when the server has no sync-rules.json yet. */
export async function readRules(launcher: LauncherFiles, serverId: string): Promise<string[] | null> {
    const file = await launcher.readText(serverId, 'sync-rules.json');
    return file ? parseRules(file.text) : null;
}

export async function writeRules(launcher: LauncherFiles, serverId: string, ignore: string[]): Promise<void> {
    await launcher.writeText(serverId, 'sync-rules.json', serializeRules(ignore));
}

function normalizeList(rules: string[]): string[] {
    const result: string[] = [];
    for (const rule of rules) {
        const normalized = normalizeRule(rule);
        if (normalized !== null && !result.includes(normalized)) result.push(normalized);
    }
    return result;
}

// Manifest paths become local paths (path.join(root, ...rel.split('/'))), so anything that could point
// outside the server folder is refused instead of being downloaded there.
function checkPath(rel: string): void {
    const parts = rel.split('/');
    const unsafe = rel === '' || rel === '__proto__' || rel.includes('\\') || rel.includes('\0') || /^[a-zA-Z]:/.test(rel)
        || parts.some((part) => part === '' || part === '.' || part === '..');
    if (unsafe) throw invalid(`unsafe path ${JSON.stringify(rel)}`);
}

function count(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(`bad ${field}`);
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedKeys(record: Record<string, unknown>): string[] {
    return Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function invalid(detail: string): AppError {
    return new AppError('INVALID', DAMAGED, `manifest.json: ${detail}`);
}
