import './create-server.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Boxes, Check, CircleAlert, Download, FolderOpen, Loader2, PackageOpen, RotateCcw } from 'lucide-react';
import type { ServerKind, ServerSummary } from '../../../shared/types';
import { serverFolderPath } from '../../../shared/folderName';
import { invoke } from '../../api';
import { formatBytesPair } from '../../lib/format';
import { isSessionBusy } from '../../lib/sync';
import { useBackupStore } from '../../stores/backupStore';
import { usePlayitStore } from '../../stores/playitStore';
import { useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import Modal from '../modal';
import ModpackBrowser from '../modpack-browser';
import type { PackChoice } from '../modpack-browser';
import PlayitSetup from '../playit-setup';
import RamSliders from '../ram-slider';
import { useCloseGuard } from '../modal/close-guard';
import { kindName } from '../../lib/serverKinds';
import VersionPicker, { JavaLine } from '../server-setup';

type Step = 'name' | 'source' | 'details' | 'place' | 'start' | 'creating';
type Source = 'new' | 'modpack' | 'existing';
type TaskState = 'waiting' | 'running' | 'done' | 'failed';

/** A server folder the user has needs no details: it is chosen where it lives. */
const stepsFor = (source: Source): Step[] => (source === 'existing' ? ['name', 'source', 'place', 'start'] : ['name', 'source', 'details', 'place', 'start']);
/** Memory to start with: modpacks want more. */
const RAM: Record<Source, { maxRAM: number; minRAM: number }> = {
    new: { maxRAM: 4096, minRAM: 2048 },
    modpack: { maxRAM: 6144, minRAM: 4096 },
    existing: { maxRAM: 4096, minRAM: 2048 },
};
const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;

interface Task {
    id: string;
    label: string;
    state: TaskState;
}

/** The questions before a server exists, one window each: its name, what it starts from (a new server, a modpack, or
 *  a server folder already on this PC), which server or modpack, where its folder goes, and how it starts. Nothing is
 *  created until the end. */
function Wizard({ onClose, onWide }: { onClose: () => void; onWide: (wide: boolean) => void }) {
    const [step, setStep] = useState<Step>('name');
    const [name, setName] = useState('');
    const [source, setSource] = useState<Source>('new');
    const [kind, setKind] = useState<ServerKind>('vanilla');
    const [version, setVersion] = useState<string | null>(null);
    const [pack, setPack] = useState<PackChoice | null>(null);
    const [parent, setParent] = useState('');
    const [existing, setExisting] = useState('');
    const [usePlayit, setUsePlayit] = useState(false);
    const [playitPath, setPlayitPath] = useState('');
    const [ram, setRam] = useState(RAM.new);
    const [error, setError] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [created, setCreated] = useState<ServerSummary | null>(null);
    const [java, setJava] = useState<{ needed: number | null; found: number | null } | null>(null);
    // What was made already, so Try again goes on from the step that failed.
    const made = useRef<{ server: ServerSummary | null; folder: boolean; download: boolean }>({ server: null, folder: false, download: false });
    const download = useBackupStore((s) => s.install);
    const playitLinked = usePlayitStore((s) => s.state?.linked ?? false);
    const onVersion = useCallback((v: string | null) => setVersion(v), []);

    useEffect(() => {
        void invoke('servers:serversFolder').then((res) => res.ok && setParent(res.value));
        const settings = useSettingsStore.getState().settings;
        if (settings) {
            setUsePlayit(settings.usePlayitgg);
            setPlayitPath(settings.playitggPath);
        }
    }, []);

    const steps = stepsFor(source);
    const index = steps.indexOf(step);
    const mode = source === 'existing' ? 'existing' : 'new';
    const target = mode === 'new' ? (parent && name.trim() ? serverFolderPath(parent, name.trim()) : '') : existing;
    const running = tasks.some((t) => t.state === 'running');
    const finished = tasks.length > 0 && tasks.every((t) => t.state === 'done');
    const failed = tasks.some((t) => t.state === 'failed');

    // The modpack list wants a bigger window.
    useEffect(() => onWide(step === 'details' && source === 'modpack'), [step, source, onWide]);

    function chooseSource(next: Source) {
        // The memory follows the choice until it is changed by hand.
        if (ram.maxRAM === RAM[source].maxRAM && ram.minRAM === RAM[source].minRAM) setRam(RAM[next]);
        setSource(next);
    }

    async function browse(kindOfFolder: 'parent' | 'existing') {
        const res = await invoke('servers:pickFolder', kindOfFolder, kindOfFolder === 'parent' ? parent || null : existing || null);
        if (!res.ok || !res.value) return;
        setError(null);
        if (kindOfFolder === 'parent') setParent(res.value);
        else setExisting(res.value);
    }

    async function next() {
        setError(null);
        if (step === 'name') {
            if (!name.trim()) return;
            setStep('source');
        } else if (step === 'source') {
            setStep(source === 'existing' ? 'place' : 'details');
        } else if (step === 'details') {
            if (source === 'new' ? !version : !pack) return;
            setStep('place');
        } else if (step === 'place') {
            setChecking(true);
            const res = await invoke('servers:checkFolder', mode, mode === 'new' ? parent : existing, name.trim());
            setChecking(false);
            if (!res.ok) {
                setError(res.error.message);
                return;
            }
            setStep('start');
        } else if (step === 'start') {
            if (usePlayit && !playitLinked && !playitPath) {
                setError('Link playit.gg, or leave it off for now.');
                return;
            }
            void create();
        }
    }

    function back() {
        setError(null);
        if (index > 0) setStep(steps[index - 1]);
    }

    function downloadLabel(): string | null {
        if (source === 'new') return `Downloading ${kindName(kind)} ${version}`;
        if (source === 'modpack' && pack?.kind === 'modrinth') return `Installing ${pack.hit.title} ${pack.version.versionNumber}, with its mod loader and mods`;
        if (source === 'modpack' && pack?.kind === 'zip') return `Unpacking ${fileName(pack.path)}`;
        return null;
    }

    /** Makes the server, step by step; run again after a failure, it goes on from the step that failed. */
    async function create() {
        setStep('creating');
        setError(null);
        const download = downloadLabel();
        const done = made.current;
        const plan: Task[] = [
            { id: 'drive', label: 'Creating the server in Google Drive', state: done.server ? 'done' : 'waiting' },
            { id: 'folder', label: mode === 'new' ? 'Making its folder on this PC' : 'Linking your server folder', state: done.folder ? 'done' : 'waiting' },
            ...(download ? [{ id: 'download', label: download, state: (done.download ? 'done' : 'waiting') as TaskState }] : []),
            { id: 'settings', label: 'Saving how it starts', state: 'waiting' },
        ];
        setTasks(plan);
        const mark = (id: string, state: TaskState) => setTasks((list) => list.map((t) => (t.id === id ? { ...t, state } : t)));
        const fail = (id: string, message: string) => {
            mark(id, 'failed');
            setError(message);
        };

        let server = done.server;
        if (!server) {
            mark('drive', 'running');
            const res = await invoke('servers:create', name.trim());
            if (!res.ok) return fail('drive', res.error.message);
            server = res.value;
            done.server = server;
            setCreated(server);
            useServersStore.getState().add(server);
            mark('drive', 'done');
        }

        const settingsStore = useSettingsStore.getState();
        if (!done.folder) {
            mark('folder', 'running');
            await settingsStore.update({ serversFolder: parent });
            const folder = await invoke('servers:setUpFolder', server.id, mode, mode === 'new' ? parent : existing, name.trim());
            if (!folder.ok) return fail('folder', folder.error.message);
            useServersStore.getState().setLocalPath(server.id, folder.value);
            done.folder = true;
            mark('folder', 'done');
        }

        let needed: number | null = null;
        if (download && !done.download) {
            mark('download', 'running');
            const installed = source === 'new' && version ? await invoke('installer:install', server.id, kind, version)
                : pack?.kind === 'modrinth' ? await invoke('modpacks:install', server.id, pack.version.id)
                    : pack?.kind === 'zip' ? await invoke('modpacks:importZip', server.id, pack.path) : null;
            if (!installed) return fail('download', 'Choose what to install first.');
            if (!installed.ok) return fail('download', installed.error.message);
            needed = installed.value.javaNeeded;
            done.download = true;
            mark('download', 'done');
        }

        mark('settings', 'running');
        const prefs = settingsStore.settings;
        const playitChanged = !prefs || prefs.usePlayitgg !== usePlayit || (usePlayit && prefs.playitggPath !== playitPath);
        if (playitChanged && !(await settingsStore.update({ usePlayitgg: usePlayit, ...(usePlayit ? { playitggPath: playitPath } : {}) }))) {
            return fail('settings', 'playit.gg could not be saved. Set it in Settings > Server settings.');
        }
        const flags = await settingsStore.updateServer(server.id, { javaFlags: ram });
        if (!flags) return fail('settings', 'The memory could not be saved. Set it in Settings > Server settings.');
        const info = await invoke('installer:folder', server.id);
        setJava({ needed, found: info.ok ? info.value.javaFound : null });
        mark('settings', 'done');
    }

    /** The new server becomes the selected one, and an account's first server shows where servers are managed. */
    const afterCreate = useCallback(async (server: ServerSummary | null) => {
        if (!server) return;
        // Servers may be open under the wizard (Create was pressed there): it closes too, so the page is in view.
        useUiStore.getState().closeServers();
        if (!isSessionBusy(useSessionStore.getState().state.phase)) await useServersStore.getState().select(server.id);
        const settings = useSettingsStore.getState().settings ?? (await useSettingsStore.getState().load());
        if (settings && !settings.tourDone) useUiStore.getState().openTour(true);
    }, []);

    async function finish() {
        onClose();
        await afterCreate(created);
    }

    // While it is being created the window stays; closed with X afterwards, it ends like Done.
    const guard = useCallback(async () => {
        if (running) return false;
        void afterCreate(created);
        return true;
    }, [running, created, afterCreate]);
    useCloseGuard(step === 'creating' ? guard : null);
    const canNext = step === 'name' ? name.trim() !== ''
        : step === 'details' ? (source === 'new' ? version !== null : pack !== null)
            : step === 'place' ? (mode === 'new' ? parent !== '' : existing !== '') : true;

    let body;
    if (step === 'name') {
        body = (
            <>
                <h3>What should it be called?</h3>
                <input
                    className='wizard-input'
                    autoFocus
                    maxLength={60}
                    placeholder='For example: Survival with friends'
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void next();
                    }}
                />
                <p className='wizard-hint'>
                    This is the name of its folder in your Google Drive, inside &quot;Minecraft Shared Servers&quot;, and the name
                    everyone you invite sees. Its folder on this PC gets the same name.
                </p>
            </>
        );
    } else if (step === 'source') {
        body = (
            <>
                <h3>What should it start from?</h3>
                <div className='wizard-choices' role='radiogroup' aria-label='What the server starts from'>
                    <button role='radio' aria-checked={source === 'new'} className={`wizard-choice ${source === 'new' ? 'selected' : ''}`} onClick={() => chooseSource('new')}>
                        <Download size={20} />
                        <b>A new server</b>
                        <small>Vanilla, Paper, Fabric, Forge or NeoForge, downloaded for you.</small>
                    </button>
                    <button role='radio' aria-checked={source === 'modpack'} className={`wizard-choice ${source === 'modpack' ? 'selected' : ''}`} onClick={() => chooseSource('modpack')}>
                        <Boxes size={20} />
                        <b>A modpack</b>
                        <small>From Modrinth, or a server pack zip from CurseForge.</small>
                    </button>
                    <button role='radio' aria-checked={source === 'existing'} className={`wizard-choice ${source === 'existing' ? 'selected' : ''}`} onClick={() => chooseSource('existing')}>
                        <PackageOpen size={20} />
                        <b>My server folder</b>
                        <small>A server you have on this PC, with its world and settings.</small>
                    </button>
                </div>
                <p className='wizard-hint'>
                    {source === 'new' && 'Next you choose the server and its Minecraft version.'}
                    {source === 'modpack' && 'Next you choose the modpack. Everyone who joins installs the same pack in their launcher; MCS-Relay shows them which one.'}
                    {source === 'existing' && 'Next you choose that folder. Its world is uploaded the first time you host it.'}
                </p>
            </>
        );
    } else if (step === 'details') {
        body = source === 'modpack'
            ? (
                <>
                    <h3>Which modpack?</h3>
                    <ModpackBrowser value={pack} onChange={setPack} />
                </>
            )
            : (
                <>
                    <h3>Which server?</h3>
                    <VersionPicker kind={kind} version={version} onKind={setKind} onVersion={onVersion} />
                </>
            );
    } else if (step === 'place') {
        body = mode === 'new'
            ? (
                <>
                    <h3>Where should it live on this PC?</h3>
                    <span className='field-label'>Your servers are kept in</span>
                    <div className='wizard-path'>
                        <span className='wizard-path-text' title={parent}>{parent || '…'}</span>
                        <button className='text-button' onClick={() => void browse('parent')}><FolderOpen size={13} /> Browse</button>
                    </div>
                    <p className='wizard-hint'>
                        This server&apos;s folder will be <code>{target}</code>. It is kept out of Documents on purpose: OneDrive
                        often syncs Documents, and the world would then be synced twice.
                    </p>
                </>
            )
            : (
                <>
                    <h3>Where is your server folder?</h3>
                    <span className='field-label'>Your server folder</span>
                    <div className='wizard-path'>
                        <span className={`wizard-path-text ${existing ? '' : 'empty'}`} title={existing}>{existing || 'Choose the folder with your server .jar and world'}</span>
                        <button className='text-button' onClick={() => void browse('existing')}><FolderOpen size={13} /> Browse</button>
                    </div>
                    <p className='wizard-hint'>
                        MCS-Relay uses it where it is, and puts a shortcut to it in <code>{parent}</code>
                        <button className='wizard-link' onClick={() => void browse('parent')}>Change</button>, beside your other servers, so you
                        always find them in one place.
                    </p>
                </>
            );
    } else if (step === 'start') {
        body = (
            <>
                <h3>How should it start?</h3>
                <label className='wizard-toggle'>
                    <input type='checkbox' checked={usePlayit} onChange={(e) => setUsePlayit(e.target.checked)} />
                    <span>
                        <b>Let friends join from anywhere, with playit.gg</b>
                        <small>Without it, friends on the same network as this PC can join; others cannot.</small>
                    </span>
                </label>
                {usePlayit && (
                    <PlayitSetup ownPath={playitPath} onPickOwn={() => void useSettingsStore.getState().pickPlayitPath().then((p) => p && setPlayitPath(p))} onLinked={() => setPlayitPath('')} />
                )}
                <span className='field-label'>Memory for the server</span>
                <RamSliders maxRAM={ram.maxRAM} minRAM={ram.minRAM} onChange={setRam} idPrefix='wizard-ram' />
                <p className='wizard-hint'>
                    {source === 'modpack' ? '6 GB suits most modpacks; big ones want 8 GB or more.' : '4 GB suits a few friends; modded servers want more.'}
                    {' '}Leave a few GB for Windows. You can change all of this later in Settings &gt; Server settings.
                </p>
            </>
        );
    } else {
        body = (
            <>
                <h3>{finished ? `${name.trim()} is ready` : 'Setting it up…'}</h3>
                <ul className='wizard-tasks'>
                    {tasks.map((t) => (
                        <li key={t.id} className={t.state}>
                            {t.state === 'running' ? <Loader2 size={15} className='spinner' /> : t.state === 'done' ? <Check size={15} />
                                : t.state === 'failed' ? <CircleAlert size={15} /> : <span className='wizard-dot' />}
                            <span>{t.label}</span>
                            {t.id === 'download' && t.state === 'running' && download && download.total > 0 && (
                                <small>{formatBytesPair(download.done, download.total)}</small>
                            )}
                        </li>
                    ))}
                </ul>
                {finished && java && created && <JavaLine needed={java.needed} found={java.found} serverId={created.id} />}
                {finished && (
                    <p className='wizard-hint'>
                        Press the power button to start it. The first start makes the world, and the first upload shares it with
                        everyone you invite.
                        {source === 'modpack' && ' To play, everyone installs the same modpack in their launcher; MCS-Relay shows them which one.'}
                    </p>
                )}
            </>
        );
    }

    return (
        <div className='wizard'>
            <div className='wizard-body'>{body}</div>
            {error && <p className='wizard-error'><CircleAlert size={14} /> {error}</p>}
            <div className='wizard-buttons'>
                {step === 'creating'
                    ? (
                        <>
                            {failed && !running && (
                                <button className='text-button' onClick={() => void create()}><RotateCcw size={13} /> Try again</button>
                            )}
                            <button className='text-button primary' disabled={running} onClick={() => void finish()}>
                                {finished ? 'Done' : running ? 'Please wait…' : 'Close'}
                            </button>
                        </>
                    )
                    : (
                        <>
                            <button className='text-button' onClick={onClose}>Cancel</button>
                            <span className='wizard-steps' aria-label={`Step ${index + 1} of ${steps.length}`}>
                                {steps.map((s, i) => <span key={s} className={i === index ? 'current' : i < index ? 'done' : ''} />)}
                            </span>
                            {index > 0 && <button className='text-button' onClick={back}><ArrowLeft size={13} /> Back</button>}
                            <button className='text-button primary' disabled={!canNext || checking} onClick={() => void next()}>
                                {checking ? <Loader2 size={13} className='spinner' /> : null}
                                {step === 'start' ? 'Create server' : <>Next <ArrowRight size={13} /></>}
                            </button>
                        </>
                    )}
            </div>
        </div>
    );
}

/** The wizard's window, opened by "Create a server" anywhere in the app. */
export default function CreateServerHost() {
    const open = useUiStore((s) => s.creating);
    const [key, setKey] = useState(0);
    const [wide, setWide] = useState(false);
    const close = () => {
        useUiStore.getState().openCreate(false);
        setKey((k) => k + 1);                       // the next opening starts fresh
        setWide(false);
    };
    return (
        <Modal
            isOpen={open}
            onClose={close}
            width={wide ? 680 : 560}
            height={wide ? 510 : 490}
            items={[{ title: 'Create a server', content: <Wizard key={key} onClose={close} onWide={setWide} /> }]}
        />
    );
}
