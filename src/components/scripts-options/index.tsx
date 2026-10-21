import './scripts-options.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileCog, FolderInput, Loader2, Save } from 'lucide-react';
import type { JavaFlags } from '../../../shared/types';
import { isSessionBusy } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import OptionRow from '../option-row';

const RAM_STEP = 512;
const RAM_SLIDER_MIN = 512;
const RAM_SLIDER_MAX = 32768;

/** Java gets the flags on one line; the box shows one flag per line, which wraps far better. */
const flagsToLines = (flags: string): string => flags.trim().split(/\s+/).filter(Boolean).join('\n');
const linesToFlags = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ');

/** 6144 -> "6 GB", 2560 -> "2.5 GB", 768 -> "768 MB". */
function formatRam(mb: number): string {
    if (mb < 1024) return `${mb} MB`;
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** One memory slider; the value is in MB, shown in GB. */
function RamSlider({ id, label, hint, value, onChange }: {
    id: string; label: string; hint: string; value: number; onChange: (mb: number) => void;
}) {
    const max = Math.max(RAM_SLIDER_MAX, value);
    const fill = ((Math.min(value, max) - RAM_SLIDER_MIN) / (max - RAM_SLIDER_MIN)) * 100;
    return (
        <div className='ram-row'>
            <label htmlFor={id}>
                {label}
                <small>{hint}</small>
            </label>
            <input
                id={id}
                type='range'
                min={RAM_SLIDER_MIN}
                max={max}
                step={RAM_STEP}
                value={value}
                style={{ '--fill': `${Math.max(0, fill)}%` } as React.CSSProperties}
                onChange={(e) => onChange(Number(e.target.value))}
            />
            <span className='ram-value'>{formatRam(value)}</span>
        </div>
    );
}

/** What a session starts on this PC. Downloading and uploading are no longer options: every session
 *  downloads before it starts and uploads after it stops. */
export default function ScriptsOptions() {
    const settings = useSettingsStore((s) => s.settings);
    const server = useServersStore(selectSelectedServer);
    const serverSettings = useSettingsStore((s) => (server ? s.servers[server.id] ?? null : null));
    const busy = useSessionStore((s) => isSessionBusy(s.state.phase));
    const [usePlayit, setUsePlayit] = useState(false);
    const [launchServer, setLaunchServer] = useState(true);
    const [flags, setFlags] = useState<JavaFlags | null>(null);
    const [flagsText, setFlagsText] = useState('');
    const [saving, setSaving] = useState(false);
    const flagsRef = useRef<HTMLTextAreaElement>(null);
    const hasFlags = flags !== null;

    // The flags box grows with its text, so even a long list of flags is readable without scrolling inside it.
    useLayoutEffect(() => {
        const box = flagsRef.current;
        if (!box) return;
        box.style.height = 'auto';
        box.style.height = `${box.scrollHeight + 2}px`;
    }, [flagsText, hasFlags]);

    useEffect(() => {
        void useSettingsStore.getState().load();
        if (server) void useSettingsStore.getState().loadServer(server.id);
    }, [server]);

    useEffect(() => {
        if (!settings) return;
        setUsePlayit(settings.usePlayitgg);
        setLaunchServer(settings.launchServer);
    }, [settings]);

    useEffect(() => {
        setFlags(serverSettings ? { ...serverSettings.javaFlags } : null);
        setFlagsText(serverSettings ? flagsToLines(serverSettings.javaFlags.customFlags) : '');
    }, [serverSettings]);

    async function handleSave() {
        if (usePlayit && !settings?.playitggPath) {
            useNoticeStore.getState().error('Choose the playit.gg program first, or turn playit.gg off.');
            return;
        }
        setSaving(true);
        const store = useSettingsStore.getState();
        let ok = await store.update({ usePlayitgg: usePlayit, launchServer });
        if (ok && server && flags) ok = await store.updateServer(server.id, { javaFlags: { ...flags, customFlags: linesToFlags(flagsText) } });
        setSaving(false);
        if (ok) useNoticeStore.getState().success('Settings saved. They apply to the next session.');
    }

    if (!settings) return <p className='scripts-loading'><Loader2 size={14} className='spinner' /> Loading…</p>;
    const playitPath = settings.playitggPath;
    // The maximum pulls the minimum down with it, and the other way round, so min <= max always holds.
    const setMax = (maxRAM: number) => flags && setFlags({ ...flags, maxRAM, minRAM: Math.min(flags.minRAM, maxRAM) });
    const setMin = (minRAM: number) => flags && setFlags({ ...flags, minRAM, maxRAM: Math.max(flags.maxRAM, minRAM) });
    return (
        <div className='scripts-wrapper'>
            <OptionRow title='playit.gg' enable={usePlayit} onChange={setUsePlayit}>
                <p>Starts playit.gg with the server, so friends can join from anywhere.</p>
                <div className='program-path'>
                    <FileCog size={14} />
                    <span className={`path-text ${playitPath ? '' : 'missing'}`} title={playitPath || undefined}>
                        {playitPath || 'No playit.gg program chosen yet'}
                    </span>
                    <button className='text-button' onClick={() => void useSettingsStore.getState().choosePlayitPath()}>
                        <FolderInput size={12} /> {playitPath ? 'Change' : 'Choose'}
                    </button>
                </div>
            </OptionRow>

            <OptionRow title='Minecraft server' enable={launchServer} onChange={setLaunchServer}>
                <p>Starts the Minecraft server after the download. Turn it off to only sync the files.</p>
                {server && flags ? (
                    <>
                        <span className='section-label'>Memory for {server.name}</span>
                        <div className='ram-sliders'>
                            <RamSlider id='max-ram' label='Maximum' hint='-Xmx' value={flags.maxRAM} onChange={setMax} />
                            <RamSlider id='min-ram' label='At start' hint='-Xms' value={flags.minRAM} onChange={setMin} />
                        </div>
                        <label className='section-label' htmlFor='custom-flags'>Extra Java flags <small>one per line</small></label>
                        <textarea
                            id='custom-flags'
                            ref={flagsRef}
                            className='flags-input'
                            rows={2}
                            value={flagsText}
                            spellCheck={false}
                            placeholder={'-XX:+UseG1GC\n-XX:MaxGCPauseMillis=200'}
                            onChange={(e) => setFlagsText(e.target.value)}
                        />
                    </>
                ) : <p>Select a server to set its memory.</p>}
            </OptionRow>

            <div className='save-bar'>
                <span>{busy ? 'Settings can be changed between sessions.' : 'Changes apply to the next session.'}</span>
                <button className='text-button primary' onClick={handleSave} disabled={saving || busy}>
                    {saving ? <Loader2 size={13} className='spinner' /> : <Save size={13} />} Save changes
                </button>
            </div>
        </div>
    );
}
