// Scans the local server folder into a Snapshot. Like git, a file whose size and modified time are exactly
// what the base recorded is assumed unchanged and keeps its stored md5; only the rest is hashed.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';
import type { Snapshot, SnapshotEntry } from '../../shared/types';

const HASH_CONCURRENCY = 8;
const READ_CHUNK_BYTES = 1024 * 1024;

/** Streams the file through MD5 (hex, as Drive's md5Checksum). */
export async function md5OfFile(absPath: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const hash = createHash('md5');
    const stream = createReadStream(absPath, { highWaterMark: READ_CHUNK_BYTES, signal });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

/**
 * Walks `root` (symlinks are not followed, ignored folders are not entered) and returns path -> entry,
 * sorted by path. A file that disappears during the scan is left out; a missing root gives an empty snapshot.
 * onProgress(done, total) is called after every file once the folder walk has counted them.
 */
export async function scanLocal(
    root: string, base: Snapshot, isIgnored: (rel: string) => boolean, signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
): Promise<Snapshot> {
    const files: Array<{ rel: string; abs: string }> = [];
    await walk(root, '', isIgnored, files, signal);
    let scanned = 0;
    onProgress?.(0, files.length);

    const entries = new Map<string, SnapshotEntry>();
    let next = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
        while (next < files.length && !failed) {
            const file = files[next++];
            try {
                signal?.throwIfAborted();
                const entry = await scanFile(file.abs, file.rel, base.get(file.rel), signal);
                if (entry) entries.set(file.rel, entry);
                onProgress?.(++scanned, files.length);
            } catch (err) {
                failed = true;              // stop the other workers; Promise.all rejects with this error
                throw err;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, worker));

    const result: Snapshot = new Map();
    for (const rel of [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        result.set(rel, entries.get(rel) as SnapshotEntry);
    }
    return result;
}

async function walk(
    absDir: string, relDir: string, isIgnored: (rel: string) => boolean,
    out: Array<{ rel: string; abs: string }>, signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    let dirents: Dirent[];
    try {
        dirents = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
        // The root (or a folder) is gone: nothing below it exists any more.
        if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return;
        throw readError(relDir || '.', err);
    }
    for (const dirent of dirents) {
        const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
        const abs = path.join(absDir, dirent.name);
        // Symlinks (and Windows junctions) are skipped: following them could leave the server folder or loop.
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) {
            if (!isIgnored(rel)) await walk(abs, rel, isIgnored, out, signal);
        } else if (dirent.isFile()) {
            if (!isIgnored(rel)) out.push({ rel, abs });
        }
    }
}

async function scanFile(abs: string, rel: string, known: SnapshotEntry | undefined, signal?: AbortSignal): Promise<SnapshotEntry | null> {
    try {
        const st = await stat(abs);
        if (!st.isFile()) return null;
        if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) {
            const entry: SnapshotEntry = { size: st.size, md5: known.md5, mtimeMs: st.mtimeMs };
            if (known.driveId !== undefined) entry.driveId = known.driveId;
            return entry;
        }
        const md5 = await md5OfFile(abs, signal);
        return { size: st.size, md5, mtimeMs: st.mtimeMs };
    } catch (err) {
        if (errnoCode(err) === 'ENOENT') return null;       // deleted between readdir and stat/hash
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
        throw readError(rel, err);
    }
}

function errnoCode(err: unknown): string | undefined {
    if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code;
    return undefined;
}

// Other read errors are not skipped: a file left out of the scan would look deleted and be deleted in the cloud.
function readError(rel: string, err: unknown): AppError {
    const code = errnoCode(err);
    const busy = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    const message = busy
        ? `Could not read "${rel}" in the server folder. Close any program that is using it and try again.`
        : `Could not read "${rel}" in the server folder.`;
    return new AppError('UNKNOWN', message, err instanceof Error ? err.message : String(err));
}
