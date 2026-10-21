// The colour theme: index.css reads data-theme on <html>. The choice is a setting of this PC; a copy in
// localStorage lets the very first paint use it, before the settings arrive from the main process.
import { THEMES } from '../../shared/types';
import type { ThemeName } from '../../shared/types';

const STORAGE_KEY = 'mcs.theme';
const DEFAULT_THEME: ThemeName = 'light';

export function applyTheme(theme: ThemeName): void {
    document.documentElement.dataset.theme = theme;
    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // no storage: the next start shows the default until the settings load
    }
}

export function rememberedTheme(): ThemeName {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && (THEMES as readonly string[]).includes(stored)) return stored as ThemeName;
    } catch {
        // fall through to the default
    }
    return DEFAULT_THEME;
}
