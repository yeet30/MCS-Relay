// Plain-language formatting for sizes, speeds, durations and times. Pure: no React, no stores.

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** The unit index (-1 = bytes) that suits `bytes`. */
function unitFor(bytes: number): number {
    if (Math.round(bytes) < 1024) return -1;
    let size = bytes / 1024;
    let unit = 0;
    // Compare the rounded value so 1023.96 KB is shown as "1.0 MB", not "1024 KB".
    while (unit < UNITS.length - 1 && round(size, digitsFor(size)) >= 1024) {
        size /= 1024;
        unit++;
    }
    return unit;
}

function digitsFor(size: number): number {
    return size >= 100 ? 0 : 1;
}

function round(value: number, digits: number): number {
    return Number(value.toFixed(digits));
}

function inUnit(bytes: number, unit: number): string {
    if (unit < 0) return String(Math.round(bytes));
    const size = bytes / 1024 ** (unit + 1);
    return size.toFixed(digitsFor(size));
}

function unitName(unit: number): string {
    return unit < 0 ? 'B' : UNITS[unit];
}

/** "0 B", "512 B", "7.0 MB", "180 MB", "1.4 GB". */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const unit = unitFor(bytes);
    return `${inUnit(bytes, unit)} ${unitName(unit)}`;
}

/** Two sizes in the unit of the larger one: "3.1 / 7.0 MB", "412 of 700 MB". */
export function formatBytesPair(done: number, total: number, separator: ' / ' | ' of ' = ' / '): string {
    const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
    const safeDone = Number.isFinite(done) && done > 0 ? Math.min(done, safeTotal || done) : 0;
    const unit = unitFor(Math.max(safeTotal, safeDone));
    return `${inUnit(safeDone, unit)}${separator}${inUnit(safeTotal, unit)} ${unitName(unit)}`;
}

export function formatSpeed(bytesPerSec: number): string {
    return `${formatBytes(bytesPerSec)}/s`;
}

/** "about 40 s left", "about 1 min 10 s left", "about 2 h 5 min left". Seconds are rounded to tens above a minute
 *  so the estimate does not flicker. */
export function formatEta(etaSec: number | null): string {
    if (etaSec === null || !Number.isFinite(etaSec) || etaSec < 0) return 'estimating time left…';
    if (etaSec >= 99 * 3600) return 'more than 99 h left';
    if (etaSec < 1) return 'almost done';
    if (etaSec < 60) return `about ${Math.ceil(etaSec)} s left`;
    if (etaSec < 3600) {
        let minutes = Math.floor(etaSec / 60);
        let seconds = Math.round((etaSec % 60) / 10) * 10;
        if (seconds === 60) {
            minutes++;
            seconds = 0;
        }
        if (minutes === 60) return 'about 1 h left';
        return seconds === 0 ? `about ${minutes} min left` : `about ${minutes} min ${seconds} s left`;
    }
    let hours = Math.floor(etaSec / 3600);
    let minutes = Math.round((etaSec % 3600) / 60);
    if (minutes === 60) {
        hours++;
        minutes = 0;
    }
    return minutes === 0 ? `about ${hours} h left` : `about ${hours} h ${minutes} min left`;
}

/** "05:09" or "1:02:03". */
export function formatUptime(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A rough duration: "45 s", "3 min", "2 h", "4 days". */
export function formatAgo(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    const days = Math.floor(s / 86400);
    return days === 1 ? '1 day' : `${days} days`;
}

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "today at 18:05", "yesterday at 21:40", "on 3 Oct at 09:15", "on 3 Oct 2025 at 09:15" (local time). */
export function formatWhen(iso: string | null, now: number = Date.now()): string {
    if (!iso) return 'at an unknown time';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'at an unknown time';
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const today = new Date(now);
    if (sameDay(date, today)) return `today at ${time}`;
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (sameDay(date, yesterday)) return `yesterday at ${time}`;
    const year = date.getFullYear() === today.getFullYear() ? '' : ` ${date.getFullYear()}`;
    return `on ${date.getDate()} ${MONTHS[date.getMonth()]}${year} at ${time}`;
}

/** "14:05:09" (local time), for step lists. */
export function formatClock(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** "1,204" */
export function formatCount(n: number): string {
    return Math.round(n).toLocaleString('en-US');
}

/** "1 file", "1,204 files". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
    return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c", "a, b, c and 4 more". */
export function listNames(names: string[], max = 3): string {
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];
    if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${names.slice(0, max).join(', ')} and ${formatCount(names.length - max)} more`;
}
