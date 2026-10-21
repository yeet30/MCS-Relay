// The colour theme: index.css reads data-theme on <html>. The choice is a setting of this PC; a copy in
// localStorage lets the very first paint use it, before the settings arrive from the main process.
import { THEMES, TITLE_BAR_HEIGHT, WINDOW_COLORS } from '../../shared/types';
import type { ThemeName } from '../../shared/types';

const STORAGE_KEY = 'mcs.theme';
const DEFAULT_THEME: ThemeName = 'light';

export function applyTheme(theme: ThemeName): void {
    const root = document.documentElement;
    root.dataset.theme = theme;
    // The title bar shares its colours with the window's own buttons, which the main process paints.
    root.style.setProperty('--titlebar', WINDOW_COLORS[theme].titleBar);
    root.style.setProperty('--titlebar-text', WINDOW_COLORS[theme].titleText);
    root.style.setProperty('--titlebar-h', `${TITLE_BAR_HEIGHT}px`);
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
