// "48 s", "3 min 12 s", "1 h 5 min": how long something took, for both processes.

export function formatDuration(ms: number): string {
    const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The time between two ISO timestamps, or null when one is missing. */
export function durationBetween(startIso: string | null | undefined, endIso: string | null | undefined): number | null {
    if (!startIso || !endIso) return null;
    const ms = Date.parse(endIso) - Date.parse(startIso);
    return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
