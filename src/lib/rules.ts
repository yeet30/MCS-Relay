// Client-side clean-up of a typed sync rule. The main process normalizes again when saving; this only gives the
// user immediate feedback and avoids obvious duplicates.

export const DISTANT_HORIZONS_RULE = '**/DistantHorizons.sqlite';

export const RULE_HELP =
    'Use "folder/" for a folder and everything in it, "*.ext" for a file type, "**/name" for a file name in any folder, or an exact path such as "world/data/raids.dat".';

/** Trims, turns "\" into "/", strips a leading "./" or "/", collapses "//". Returns null for empty input or a
 *  path that climbs out of the server folder (".."). Keeps a trailing "/" (a folder rule). */
export function cleanRuleInput(text: string): string | null {
    let rule = text.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    while (rule.startsWith('./')) rule = rule.slice(2);
    while (rule.startsWith('/')) rule = rule.slice(1);
    if (rule === '' || rule === '/' || rule === '.') return null;
    if (rule.split('/').some((segment) => segment === '..')) return null;
    return rule;
}

/** Rules compare case-insensitively (see shared/paths.ts), so "Logs/" and "logs/" are the same rule. */
export function hasRule(rules: readonly string[], rule: string): boolean {
    const lower = rule.toLowerCase();
    return rules.some((existing) => existing.toLowerCase() === lower);
}

export function addRule(rules: readonly string[], rule: string): string[] {
    return hasRule(rules, rule) ? [...rules] : [...rules, rule];
}

export function sameRules(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((rule, i) => rule === b[i]);
}
