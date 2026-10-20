import './scripts-options.css';
import { useEffect, useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import type { JavaFlags } from '../../../shared/types';
import { isSessionBusy } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import OptionRow from '../option-row';

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
    const [saving, setSaving] = useState(false);

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
    }, [serverSettings]);

    async function handleSave() {
        if (usePlayit && !settings?.playitggPath) {
            useNoticeStore.getState().error('Choose the playit.gg program first, or turn playit.gg off.');
            return;
        }
        setSaving(true);
        const store = useSettingsStore.getState();
        let ok = await store.update({ usePlayitgg: usePlayit, launchServer });
        if (ok && server && flags) ok = await store.updateServer(server.id, { javaFlags: flags });
        setSaving(false);
        if (ok) useNoticeStore.getState().success('Settings saved. They apply to the next session.');
    }

    if (!settings) return <h3>Loading...</h3>;
    const playitPath = settings.playitggPath;
    return (
        <div className='scripts-wrapper'>
            <div className='options-div'>
                <OptionRow title='Playitgg' enable={usePlayit} onChange={setUsePlayit}>
                    <p>Starts playit.gg with the server so friends can join from anywhere.</p>
                    <span className='path-span'>
                        {playitPath || 'No playit.gg program chosen yet'}
                        <button className='path-button' onClick={() => void useSettingsStore.getState().choosePlayitPath()}>
                            {playitPath ? 'Change Path' : 'Set Path'}
                            <Pencil size={12} style={{ borderBottom: 'solid', borderWidth: '1px' }} />
                        </button>
                    </span>
                </OptionRow>

                <OptionRow title='Launch Server Console' enable={launchServer} onChange={setLaunchServer}>
                    <p>Starts the Minecraft server after the download. Turn it off to only sync the files.</p>
                    {server && flags ? (
                        <>
                            <h4>RAM Allocation for {server.name}</h4>
                            <div className='ram-allocation'>
                                <div className='ram-div'>
                                    <label htmlFor='min-ram'>Min RAM</label>
                                    <span>
                                        <input id='min-ram' type='number' min={256} step={256} value={flags.minRAM}
                                            onChange={(e) => setFlags({ ...flags, minRAM: Number(e.target.value) })} /> MB
                                    </span>
                                </div>
                                <div className='ram-div'>
                                    <label htmlFor='max-ram'>Max RAM</label>
                                    <span>
                                        <input id='max-ram' type='number' min={256} step={256} value={flags.maxRAM}
                                            onChange={(e) => setFlags({ ...flags, maxRAM: Number(e.target.value) })} /> MB
                                    </span>
                                </div>
                            </div>
                            <div className='ram-div custom-flags'>
                                <label htmlFor='custom-flags'>Extra Java flags</label>
                                <input id='custom-flags' type='text' value={flags.customFlags} spellCheck={false}
                                    placeholder='-XX:+UseG1GC' onChange={(e) => setFlags({ ...flags, customFlags: e.target.value })} />
                            </div>
                        </>
                    ) : <p>Select a server to set its RAM.</p>}
                </OptionRow>
            </div>
            <span className='save-span'>
                <button className='save-button' onClick={handleSave} disabled={saving || busy} title={busy ? 'Settings can be changed between sessions' : undefined}>
                    {saving && <Loader2 size={12} className='spinner' />} Save Changes
                </button>
            </span>
        </div>
    );
}
