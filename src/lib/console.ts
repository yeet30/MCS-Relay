// Console helpers: line colouring and merging a resync answer with lines that arrived meanwhile.

export const MAX_CONSOLE_LINES = 1000;

export type LineType = 'info' | 'warn' | 'error' | 'success' | 'system';

export function classifyLine(text: string): LineType {
    if (/\[System\]/.test(text)) return 'system';
    // The level comes as "[18:09:20] [Server thread/WARN]" (vanilla, Forge) or "[18:09:20 WARN]" (Paper, Spigot).
    const level = /[\s/[](INFO|WARN|WARNING|ERROR|FATAL|SEVERE)\]/i.exec(text)?.[1].toUpperCase();
    if (level === 'ERROR' || level === 'FATAL' || level === 'SEVERE') return 'error';
    if (level === 'WARN' || level === 'WARNING') return 'warn';
    // Lines without a level (a stack trace, a mod's own output) go by their words.
    if (!level && /Exception|FATAL|failed/i.test(text)) return 'error';
    if (!level && /Warning/i.test(text)) return 'warn';
    if (/Done|started|logged in|joined/i.test(text)) return 'success';
    return 'info';
}

/** Appends lines and keeps only the newest `max`. */
export function appendLines(current: readonly string[], lines: readonly string[], max = MAX_CONSOLE_LINES): string[] {
    const next = current.concat(lines);
    return next.length > max ? next.slice(next.length - max) : next;
}

/** The main process answered a resync with `snapshot` (its last lines); `buffered` arrived as events while the
 *  request was in flight. When the snapshot already ends with them they are not added twice. */
export function mergeConsole(snapshot: readonly string[], buffered: readonly string[], max = MAX_CONSOLE_LINES): string[] {
    if (buffered.length === 0) return appendLines([], snapshot, max);
    if (endsWith(snapshot, buffered)) return appendLines([], snapshot, max);
    return appendLines(snapshot, buffered, max);
}

function endsWith(list: readonly string[], tail: readonly string[]): boolean {
    if (tail.length > list.length) return false;
    const offset = list.length - tail.length;
    for (let i = 0; i < tail.length; i++) {
        if (list[offset + i] !== tail[i]) return false;
    }
    return true;
}
