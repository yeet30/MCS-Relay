import './scripts-options.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Coffee, FolderInput, Loader2, RotateCcw, Save } from 'lucide-react';
import type { AppSettings, JavaFlags, ServerSettings } from '../../../shared/types';
import { useConfirm } from '../../hooks/useConfirm';
import { isSessionBusy } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { usePlayitStore } from '../../stores/playitStore';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useCloseGuard } from '../modal/close-guard';
import OptionRow from '../option-row';
import PlayitSetup from '../playit-setup';
import RamSliders from '../ram-slider';

/** Java gets the flags on one line; the box shows one flag per line, which wraps far better. */
const flagsToLines = (flags: string): string => flags.trim().split(/\s+/).filter(Boolean).join('\n');
const linesToFlags = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ');

/** Something on the panel differs from what is saved. Flags compare as the list Java gets, so spaces and line
 *  breaks alone are no change. */
function hasChanges(
    saved: AppSettings | null, server: ServerSettings | null,
    edited: { usePlayit: boolean; playitPath: string; launchServer: boolean; flags: JavaFlags | null; flagsText: string; javaPath: string; autoBackup: number },
): boolean {
    if (!saved) return false;
    if (edited.usePlayit !== saved.usePlayitgg || edited.launchServer !== saved.launchServer) return true;
    if (edited.playitPath !== saved.playitggPath || edited.autoBackup !== saved.autoBackupMinutes) return true;
    if (!server || !edited.flags) return false;
    if (edited.javaPath !== (server.javaPath ?? '')) return true;
    return edited.flags.maxRAM !== server.javaFlags.maxRAM || edited.flags.minRAM !== server.javaFlags.minRAM
        || linesToFlags(edited.flagsText) !== linesToFlags(server.javaFlags.customFlags);
}

/** What a session starts on this PC. Downloading and uploading are no longer options: every session
 *  downloads before it starts and uploads after it stops. */
export default function ScriptsOptions() {
    const settings = useSettingsStore((s) => s.settings);
    const server = useServersStore(selectSelectedServer);
    const serverSettings = useSettingsStore((s) => (server ? s.servers[server.id] ?? null : null));
    const busy = useSessionStore((s) => isSessionBusy(s.state.phase));
    const linked = usePlayitStore((s) => s.state?.linked ?? false);
    const [usePlayit, setUsePlayit] = useState(false);
    const [playitPath, setPlayitPath] = useState('');
    const [launchServer, setLaunchServer] = useState(true);
    const [autoBackup, setAutoBackup] = useState(10);            // minutes; 0 = off
    const [autoMinutes, setAutoMinutes] = useState(10);          // the slider, kept while the switch is off
    const [flags, setFlags] = useState<JavaFlags | null>(null);
    const [flagsText, setFlagsText] = useState('');
    const [javaPath, setJavaPath] = useState('');                // '' = "java" from PATH
    const [saving, setSaving] = useState(false);
    const flagsRef = useRef<HTMLTextAreaElement>(null);
    const hasFlags = flags !== null;
    const { ask, popup } = useConfirm();
    const dirty = hasChanges(settings, serverSettings, { usePlayit, playitPath, launchServer, flags, flagsText, javaPath, autoBackup });

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
        setPlayitPath(settings.playitggPath);
        setLaunchServer(settings.launchServer);
        setAutoBackup(settings.autoBackupMinutes);
        if (settings.autoBackupMinutes > 0) setAutoMinutes(settings.autoBackupMinutes);
    }, [settings]);

    useEffect(() => {
        setFlags(serverSettings ? { ...serverSettings.javaFlags } : null);
        setFlagsText(serverSettings ? flagsToLines(serverSettings.javaFlags.customFlags) : '');
        setJavaPath(serverSettings?.javaPath ?? '');
    }, [serverSettings]);

    /** true when everything was saved. */
    async function handleSave(): Promise<boolean> {
        if (!dirty) {
            useNoticeStore.getState().info('There are no new changes to save.');
            return true;
        }
        if (usePlayit && !linked && !playitPath) {
            useNoticeStore.getState().error('Link playit.gg first, or turn playit.gg off.');
            return false;
        }
        setSaving(true);
        const store = useSettingsStore.getState();
        let ok = await store.update({ usePlayitgg: usePlayit, playitggPath: playitPath, launchServer, autoBackupMinutes: autoBackup });
        if (ok && server && flags) {
            ok = await store.updateServer(server.id, { javaFlags: { ...flags, customFlags: linesToFlags(flagsText) }, javaPath: javaPath || null });
        }
        setSaving(false);
        if (ok) useNoticeStore.getState().success('Settings saved. They apply to the next session.');
        return ok;
    }

    async function handlePickJava() {
        const picked = await useSettingsStore.getState().pickJavaPath();
        if (picked) setJavaPath(picked);
    }

    async function handlePickPlayit() {
        const picked = await useSettingsStore.getState().pickPlayitPath();
        if (picked) setPlayitPath(picked);
    }

    // Closing the window with unsaved changes asks first: save them, throw them away, or keep editing.
    const saveRef = useRef(handleSave);
    saveRef.current = handleSave;
    const guard = useCallback(async (): Promise<boolean> => {
        if (busy) {
            const answer = await ask({
                message: 'You changed these settings, but they can only be saved between sessions.\n\nClose without saving them?',
                confirmText: 'Close without saving',
                cancelText: 'Keep editing',
            });
            return answer === 'yes';
        }
        const answer = await ask({
            message: 'You changed these settings but did not save them.\n\nSave them before closing?',
            confirmText: 'Save and close',
            cancelText: 'Discard changes',
        });
        if (answer === 'no') return true;
        if (answer === 'yes') return saveRef.current();
        return false;                                       // the question was put away: keep editing
    }, [ask, busy]);
    useCloseGuard(dirty ? guard : null);

    if (!settings) return <p className='scripts-loading'><Loader2 size={14} className='spinner' /> Loading…</p>;
    return (
        <div className='scripts-wrapper'>
            {popup}
            <OptionRow title='playit.gg' enable={usePlayit} onChange={setUsePlayit}>
                <p>Starts playit.gg with the server, so friends can join from anywhere.</p>
                <PlayitSetup ownPath={playitPath} onPickOwn={() => void handlePickPlayit()} onLinked={() => {
                    setUsePlayit(true);
                    setPlayitPath('');
                }} busy={busy} />
            </OptionRow>

            <OptionRow title='Minecraft server' enable={launchServer} onChange={setLaunchServer}>
                <p>Starts the Minecraft server after the download. Turn it off to only sync the files.</p>
                {server && flags ? (
                    <>
                        <span className='section-label'>Memory for {server.name}</span>
                        <RamSliders maxRAM={flags.maxRAM} minRAM={flags.minRAM} onChange={(ram) => setFlags({ ...flags, ...ram })} />
                        <span className='section-label'>Java for {server.name}</span>
                        <div className='program-path'>
                            <Coffee size={14} />
                            <span className='path-text' title={javaPath || undefined}>
                                {javaPath || 'java (the one Windows finds first)'}
                            </span>
                            {javaPath && (
                                <button className='text-button' title='Use the java Windows finds first' onClick={() => setJavaPath('')}>
                                    <RotateCcw size={12} /> Default
                                </button>
                            )}
                            <button className='text-button' onClick={() => void handlePickJava()}>
                                <FolderInput size={12} /> {javaPath ? 'Change' : 'Choose'}
                            </button>
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
                ) : <p>Select a server to set its Java and memory.</p>}
            </OptionRow>

            <OptionRow title='Automatic backup' enable={autoBackup > 0} onChange={(on) => setAutoBackup(on ? autoMinutes : 0)}>
                <p>
                    While you host, one copy of the world is kept up to date in the server folder, and Backups can restore it.
                    After the first copy, only the files that changed are copied.
                </p>
                <div className='auto-backup-row'>
                    <label htmlFor='auto-backup'>Every</label>
                    <input
                        id='auto-backup'
                        type='range'
                        min={5}
                        max={30}
                        step={5}
                        value={autoMinutes}
                        disabled={autoBackup === 0}
                        style={{ '--fill': `${((autoMinutes - 5) / 25) * 100}%` } as React.CSSProperties}
                        onChange={(e) => {
                            setAutoMinutes(Number(e.target.value));
                            setAutoBackup(Number(e.target.value));
                        }}
                    />
                    <span className='ram-value'>{autoMinutes} min</span>
                </div>
            </OptionRow>

            <div className='save-bar'>
                <span className={dirty && !busy ? 'unsaved' : ''}>
                    {busy ? 'Settings can be changed between sessions.' : dirty ? 'You have unsaved changes.' : 'Changes apply to the next session.'}
                </span>
                <button className={`text-button save-button ${dirty && !busy ? 'primary ready' : ''}`} onClick={handleSave} disabled={saving || busy}>
                    {saving ? <Loader2 size={13} className='spinner' /> : <Save size={13} />} Save changes
                </button>
            </div>
        </div>
    );
}
