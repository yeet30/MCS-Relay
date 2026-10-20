import './preferences.css';
import { useEffect } from 'react';
import { Bell, ExternalLink, Play, ScrollText, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AppSettings } from '../../../shared/types';
import { invoke } from '../../api';
import { playChime } from '../../lib/chime';
import { useSettingsStore } from '../../stores/settingsStore';

const EULA_URL = 'https://www.minecraft.net/en-us/eula';

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

/** How Drive Launcher tells you that a start or stop finished, and the EULA answer of this account. */
export default function Preferences() {
    const settings = useSettingsStore((s) => s.settings);

    useEffect(() => {
        if (!useSettingsStore.getState().settings) void useSettingsStore.getState().load();
    }, []);

    if (!settings) return <p className='pref-help'>Loading…</p>;
    const set = (patch: Partial<Pick<AppSettings, 'notifications' | 'notificationSound' | 'eulaAccepted'>>) => void useSettingsStore.getState().update(patch);

    return (
        <div className='preferences'>
            <h4 className='pref-section'>Notifications</h4>
            <Toggle
                icon={<Bell size={16} />}
                title='Desktop notifications'
                text='When a server has finished starting or stopping while Drive Launcher is in the background or in the tray.'
                checked={settings.notifications}
                onChange={(notifications) => set({ notifications })}
            />
            <Toggle
                icon={<Volume2 size={16} />}
                title='Notification sound'
                text='A short chime when a server has finished starting or stopping.'
                checked={settings.notificationSound}
                onChange={(notificationSound) => set({ notificationSound })}
            >
                <button className='text-button pref-test' onClick={() => playChime('done')}>
                    <Play size={11} /> Play it
                </button>
            </Toggle>

            <h4 className='pref-section'>Minecraft EULA</h4>
            <div className='pref-row'>
                <span className='pref-icon'><ScrollText size={16} /></span>
                <div className='pref-text'>
                    <span className='pref-title'>{settings.eulaAccepted ? 'Accepted for this Google account' : 'Not accepted yet'}</span>
                    <span className='pref-help'>
                        {settings.eulaAccepted
                            ? 'Drive Launcher writes eula=true into a server folder when the server needs it.'
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
        </div>
    );
}
