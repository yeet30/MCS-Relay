import './preferences.css';
import { useEffect } from 'react';
import { Bell, Download, ExternalLink, Loader2, Play, RefreshCw, ScrollText, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { THEMES } from '../../../shared/types';
import type { AppSettings, ThemeName } from '../../../shared/types';
import { invoke } from '../../api';
import { playChime } from '../../lib/chime';
import { applyTheme } from '../../lib/theme';
import { updateLine } from '../../lib/updates';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUpdateStore } from '../../stores/updateStore';

const EULA_URL = 'https://www.minecraft.net/en-us/eula';

/** Each theme's own page, card and accent colours, so the choice shows what it looks like. */
const THEME_PREVIEW: Record<ThemeName, { label: string; bg: string; panel: string; accent: string }> = {
    light: { label: 'Light', bg: '#e6e6e8', panel: '#ffffff', accent: '#c23b30' },
    mint: { label: 'Mint', bg: '#1b2822', panel: '#283b31', accent: '#4cc38a' },
    dark: { label: 'Dark', bg: '#141416', panel: '#242428', accent: '#e2574c' },
};

function Toggle({ icon, title, text, checked, onChange, children }: {
    icon: ReactNode; title: string; text: string; checked: boolean; onChange: (value: boolean) => void; children?: ReactNode;
}) {
    return (
        <div className='pref-row'>
            <span className='pref-icon'>{icon}</span>
            <div className='pref-text'>
                <span className='pref-title'>{title}</span>
                <span className='pref-help'>{text}</span>
                {children}
            </div>
            <label className='switch'>
                <input type='checkbox' checked={checked} onChange={(e) => onChange(e.target.checked)} />
                <span className='switch-track'><span className='switch-thumb' /></span>
            </label>
        </div>
    );
}

/** The running version and its update. */
function AboutRow() {
    const update = useUpdateStore((s) => s.state);
    if (!update) return null;
    const busy = update.status === 'checking' || update.status === 'downloading';
    return (
        <div className='pref-row'>
            <span className='pref-icon'><Download size={16} /></span>
            <div className='pref-text'>
                <span className='pref-title'>MCS-Relay {update.current}</span>
                <span className='pref-help'>{updateLine(update)}</span>
                {update.status !== 'unavailable' && (
                    <span className='pref-actions'>
                        {update.status === 'ready'
                            ? (
                                <button className='text-button primary' onClick={() => void useUpdateStore.getState().install()}>
                                    <RefreshCw size={11} /> Restart to update
                                </button>
                            )
                            : (
                                <button className='text-button' disabled={busy} onClick={() => void useUpdateStore.getState().check()}>
                                    {busy ? <Loader2 size={11} className='spinner' /> : <RefreshCw size={11} />} Check for updates
                                </button>
                            )}
                    </span>
                )}
            </div>
        </div>
    );
}

/** The theme, how MCS-Relay tells you that something finished or failed, the EULA answer of this account, and the
 *  version with its updates. */
export default function Preferences() {
    const settings = useSettingsStore((s) => s.settings);

    useEffect(() => {
        if (!useSettingsStore.getState().settings) void useSettingsStore.getState().load();
    }, []);

    if (!settings) return <p className='pref-help'>Loading…</p>;
    const set = (patch: Partial<Pick<AppSettings, 'notifications' | 'notificationSound' | 'eulaAccepted' | 'theme'>>) => void useSettingsStore.getState().update(patch);
    const chooseTheme = (theme: ThemeName) => {
        applyTheme(theme);                                  // at once; the setting is saved meanwhile
        set({ theme });
    };

    return (
        <div className='preferences'>
            <h4 className='pref-section'>Appearance</h4>
            <div className='theme-options' role='radiogroup' aria-label='Theme'>
                {THEMES.map((theme) => {
                    const preview = THEME_PREVIEW[theme];
                    return (
                        <button
                            key={theme}
                            role='radio'
                            aria-checked={settings.theme === theme}
                            className={`theme-option ${settings.theme === theme ? 'selected' : ''}`}
                            onClick={() => chooseTheme(theme)}
                        >
                            <span className='theme-swatch' style={{ background: preview.bg }} aria-hidden>
                                <span className='theme-swatch-card' style={{ background: preview.panel }}>
                                    <span className='theme-swatch-accent' style={{ background: preview.accent }} />
                                </span>
                            </span>
                            <span className='theme-name'>{preview.label}</span>
                        </button>
                    );
                })}
            </div>

            <h4 className='pref-section'>Notifications</h4>
            <Toggle
                icon={<Bell size={16} />}
                title='Desktop notifications'
                text='When a start, stop or upload finishes while MCS-Relay is in the background or in the tray, and whenever something fails.'
                checked={settings.notifications}
                onChange={(notifications) => set({ notifications })}
            />
            <Toggle
                icon={<Volume2 size={16} />}
                title='Notification sound'
                text='A short chime when something finishes, and a lower one when something fails.'
                checked={settings.notificationSound}
                onChange={(notificationSound) => set({ notificationSound })}
            >
                <span className='pref-actions'>
                    <button className='text-button pref-test' onClick={() => playChime('done')}>
                        <Play size={11} /> Finished
                    </button>
                    <button className='text-button pref-test' onClick={() => playChime('failed')}>
                        <Play size={11} /> Failed
                    </button>
                </span>
            </Toggle>

            <h4 className='pref-section'>Minecraft EULA</h4>
            <div className='pref-row'>
                <span className='pref-icon'><ScrollText size={16} /></span>
                <div className='pref-text'>
                    <span className='pref-title'>{settings.eulaAccepted ? 'Accepted for this Google account' : 'Not accepted yet'}</span>
                    <span className='pref-help'>
                        {settings.eulaAccepted
                            ? 'MCS-Relay writes eula=true into a server folder when the server needs it.'
                            : 'You will be asked the first time you start a server.'}
                    </span>
                    <span className='pref-actions'>
                        <button className='text-button' onClick={() => void invoke('app:openExternal', EULA_URL)}>
                            Read the EULA <ExternalLink size={11} />
                        </button>
                        {settings.eulaAccepted && (
                            <button className='text-button' onClick={() => set({ eulaAccepted: false })}>Withdraw my answer</button>
                        )}
                    </span>
                </div>
            </div>

            <h4 className='pref-section'>About</h4>
            <AboutRow />
        </div>
    );
}
