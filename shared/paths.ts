// Relative POSIX paths and ignore rules, shared by the main process and the renderer (no Node imports).
// Every stored or transmitted path is relative to the server folder and uses "/" ("world/region/r.0.0.mca").

/** "\\" -> "/", strips leading "./" and "/", collapses "//". A trailing "/" is kept (rules use it for folders). */
export function toPosix(relPath: string): string {
    let p = relPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    for (;;) {
        if (p.startsWith('./')) p = p.slice(2);
        else if (p.startsWith('/')) p = p.slice(1);
        else break;
    }
    return p;
}

/** "world/region/r.0.0.mca" -> "world/region"; a top-level path -> "". */
export function parentOf(relPath: string): string {
    const p = stripTrailingSlash(relPath);
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
}

export function baseName(relPath: string): string {
    const p = stripTrailingSlash(relPath);
    return p.slice(p.lastIndexOf('/') + 1);
}

/** "a/b/c" -> ["a", "a/b", "a/b/c"]; "" -> []. */
export function ancestorsOf(relDir: string): string[] {
    const result: string[] = [];
    let current = '';
    for (const part of relDir.split('/')) {
        if (!part) continue;
        current = current ? `${current}/${part}` : part;
        result.push(current);
    }
    return result;
}

/** Always applied, never shared: the app's own files, the old app's root files, partial downloads,
 *  Minecraft's session.lock (held open by a running server) and the world backups made on this PC. */
export const BUILTIN_IGNORES: string[] = ['.launcher/', 'manifest.json', 'manifest.tmp', 'lock.json', '*.part', '**/session.lock', 'mcs-relay-backups/'];

/** The rules a new server's .launcher/sync-rules.json starts with. */
export const DEFAULT_SHARED_IGNORES: string[] = ['logs/', 'crash-reports/', 'debug/', '*.tmp'];

/** Trims and converts a user-written rule (keeping a trailing "/" for folders); null when it is empty
 *  or contains "..". */
export function normalizeRule(rule: string): string | null {
    const posix = toPosix(rule.trim());
    let folder = posix.endsWith('/');
    const parts = posix.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.includes('..')) return null;
    // "dir/**" is how .gitignore users write "dir/".
    if (parts.length > 0 && parts[parts.length - 1] === '**') {
        parts.pop();
        folder = true;
    }
    if (parts.length === 0 || (parts.length === 1 && parts[0] === '**')) return null;
    return parts.join('/') + (folder ? '/' : '');
}

/**
 * Compiles rules into a matcher. Returns true when a path is ignored. Rule forms:
 *   "dir/"     the folder and everything below it
 *   "*.ext"    any path ending in ".ext"
 *   "**\/name"  any path whose last segment is "name" (also "**\/a/b": any path ending in "/a/b")
 *   other      that exact path
 * Matching is always case-insensitive (Windows users, and the renderer cannot know the platform).
 * A path is also ignored when one of its folders is ignored, so skipping an ignored folder while
 * walking the disk gives the same answer as checking every file below it.
 * Folder paths may be passed with or without a trailing "/". Invalid rules are dropped.
 */
export function compileRules(rules: string[]): (relPath: string) => boolean {
    const exact = new Set<string>();         // exact paths and "dir/" rules, without the trailing "/"
    const suffixes: string[] = [];           // "*.ext" -> ".ext"
    const tails: string[] = [];              // "**/name" -> "name"

    for (const raw of rules) {
        const rule = normalizeRule(raw);
        if (rule === null) continue;
        const lower = stripTrailingSlash(rule.toLowerCase());
        if (lower.startsWith('**/')) {
            tails.push(lower.slice(3));
        } else if (lower.startsWith('*.') && !lower.includes('/') && !lower.slice(1).includes('*')) {
            suffixes.push(lower.slice(1));
        } else {
            exact.add(lower);
        }
    }

    return (relPath: string): boolean => {
        const p = stripTrailingSlash(toPosix(relPath).toLowerCase());
        if (!p) return false;
        let prefix = '';
        for (const part of p.split('/')) {
            prefix = prefix ? `${prefix}/${part}` : part;
            if (exact.has(prefix)) return true;
            for (const suffix of suffixes) {
                if (part.endsWith(suffix)) return true;
            }
            for (const tail of tails) {
                if (prefix === tail || prefix.endsWith(`/${tail}`)) return true;
            }
        }
        return false;
    };
}

function stripTrailingSlash(p: string): string {
    return p.endsWith('/') ? p.slice(0, -1) : p;
}
