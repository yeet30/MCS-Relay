import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import './index.css';
import { applyTheme, rememberedTheme } from './lib/theme';
import { startEventSubscriptions } from './stores/events';
import { useSettingsStore } from './stores/settingsStore';

// The last theme first (no flash of the wrong colours), then whatever the settings say from now on.
applyTheme(rememberedTheme());
useSettingsStore.subscribe((s, before) => {
    if (s.settings && s.settings.theme !== before.settings?.theme) applyTheme(s.settings.theme);
});
void useSettingsStore.getState().load();
startEventSubscriptions();

const root = document.getElementById('root');
if (root) ReactDOM.createRoot(root).render(<App />);
