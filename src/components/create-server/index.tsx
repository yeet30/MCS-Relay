import './create-server.css';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, Download, FolderOpen, Loader2, PackageOpen } from 'lucide-react';
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
import PlayitSetup from '../playit-setup';
import RamSliders from '../ram-slider';
import { useCloseGuard } from '../modal/close-guard';
import { kindName } from '../../lib/serverKinds';
import VersionPicker, { JavaLine } from '../server-setup';

type Step = 'name' | 'source' | 'place' | 'start' | 'creating';
type Source = 'new' | 'existing';
type TaskState = 'waiting' | 'running' | 'done' | 'failed';

const STEPS: Step[] = ['name', 'source', 'place', 'start'];

interface Task {
    id: string;
    label: string;
    state: TaskState;
}

/** The questions before a server exists, one window each: its name, whether there is a server folder already (if
 *  not, which server to download), where its folder goes, and how it starts. Nothing is created until the end. */
function Wizard({ onClose }: { onClose: () => void }) {
    const [step, setStep] = useState<Step>('name');
    const [name, setName] = useState('');
    const [source, setSource] = useState<Source>('new');
    const [kind, setKind] = useState<ServerKind>('vanilla');
    const [version, setVersion] = useState<string | null>(null);
    const [parent, setParent] = useState('');
    const [existing, setExisting] = useState('');
    const [usePlayit, setUsePlayit] = useState(false);
    const [playitPath, setPlayitPath] = useState('');
    const [ram, setRam] = useState({ maxRAM: 4096, minRAM: 2048 });
    const [error, setError] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [created, setCreated] = useState<ServerSummary | null>(null);
    const [java, setJava] = useState<{ needed: number | null; found: number | null } | null>(null);
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

    const index = STEPS.indexOf(step);
    const target = source === 'new' ? (parent && name.trim() ? serverFolderPath(parent, name.trim()) : '') : existing;
    const running = tasks.some((t) => t.state === 'running');
    const finished = tasks.length > 0 && tasks.every((t) => t.state === 'done');

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
            if (source === 'new' && !version) return;
            setStep('place');
        } else if (step === 'place') {
            setChecking(true);
            const res = await invoke('servers:checkFolder', source, source === 'new' ? parent : existing, name.trim());
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
        if (index > 0) setStep(STEPS[index - 1]);
    }

    async function create() {
        setStep('creating');
        const plan: Task[] = [
            { id: 'drive', label: 'Creating the server in Google Drive', state: 'waiting' },
            { id: 'folder', label: source === 'new' ? 'Making its folder on this PC' : 'Linking your server folder', state: 'waiting' },
            ...(source === 'new' ? [{ id: 'download', label: `Downloading ${kindName(kind)} ${version}`, state: 'waiting' as TaskState }] : []),
            { id: 'settings', label: 'Saving how it starts', state: 'waiting' },
        ];
        setTasks(plan);
        const mark = (id: string, state: TaskState) => setTasks((list) => list.map((t) => (t.id === id ? { ...t, state } : t)));
        const fail = (id: string, message: string) => {
            mark(id, 'failed');
            setError(message);
        };

        mark('drive', 'running');
        const made = await invoke('servers:create', name.trim());
        if (!made.ok) return fail('drive', made.error.message);
        const server = made.value;
        setCreated(server);
        useServersStore.getState().add(server);
        mark('drive', 'done');

        mark('folder', 'running');
        const settingsStore = useSettingsStore.getState();
        await settingsStore.update({ serversFolder: parent });
        const folder = await invoke('servers:setUpFolder', server.id, source, source === 'new' ? parent : existing, name.trim());
        if (!folder.ok) return fail('folder', folder.error.message);
        useServersStore.getState().setLocalPath(server.id, folder.value);
        mark('folder', 'done');

        let needed: number | null = null;
        if (source === 'new' && version) {
            mark('download', 'running');
            const installed = await invoke('installer:install', server.id, kind, version);
            if (!installed.ok) return fail('download', `${installed.error.message} You can download it later from Settings > Servers.`);
            needed = installed.value.javaNeeded;
            mark('download', 'done');
        }

        mark('settings', 'running');
        const prefs = settingsStore.settings;
        const playitChanged = !prefs || prefs.usePlayitgg !== usePlayit || (usePlayit && prefs.playitggPath !== playitPath);
        if (playitChanged && !(await settingsStore.update({ usePlayitgg: usePlayit, ...(usePlayit ? { playitggPath: playitPath } : {}) }))) {
            return fail('settings', 'playit.gg could not be saved. Set it in Settings > Scripts.');
        }
        const flags = await settingsStore.updateServer(server.id, { javaFlags: ram });
        if (!flags) return fail('settings', 'The memory could not be saved. Set it in Settings > Scripts.');
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
    const canNext = step === 'name' ? name.trim() !== '' : step === 'source' ? source === 'existing' || version !== null
        : step === 'place' ? (source === 'new' ? parent !== '' : existing !== '') : true;

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
                <h3>Do you have a server folder already?</h3>
                <div className='wizard-choices'>
                    <button className={`wizard-choice ${source === 'new' ? 'selected' : ''}`} onClick={() => setSource('new')}>
                        <Download size={18} />
                        <span><b>No, start a new server</b><small>MCS-Relay downloads it for you.</small></span>
                    </button>
                    <button className={`wizard-choice ${source === 'existing' ? 'selected' : ''}`} onClick={() => setSource('existing')}>
                        <PackageOpen size={18} />
                        <span><b>Yes, I have one</b><small>Use its world and settings.</small></span>
                    </button>
                </div>
                {source === 'new'
                    ? <VersionPicker kind={kind} version={version} onKind={setKind} onVersion={onVersion} />
                    : <p className='wizard-hint'>Next you choose that folder. Its world is uploaded the first time you host it.</p>}
            </>
        );
    } else if (step === 'place') {
        body = source === 'new'
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
                    <PlayitSetup ownPath={playitPath} onPickOwn={() => void useSettingsStore.getState().pickPlayitPath().then((p) => p && setPlayitPath(p))} />
                )}
                <span className='field-label'>Memory for the server</span>
                <RamSliders maxRAM={ram.maxRAM} minRAM={ram.minRAM} onChange={setRam} idPrefix='wizard-ram' />
                <p className='wizard-hint'>4 GB suits a few friends; modded servers want more. Leave a few GB for Windows. You can change all of this later in Settings &gt; Scripts.</p>
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
                {finished && java && <JavaLine needed={java.needed} found={java.found} />}
                {finished && (
                    <p className='wizard-hint'>
                        Press the power button to start it. The first start makes the world, and the first upload shares it with
                        everyone you invite.
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
                        <button className='text-button primary' disabled={running} onClick={() => void finish()}>
                            {finished ? 'Done' : running ? 'Please wait…' : 'Close'}
                        </button>
                    )
                    : (
                        <>
                            <button className='text-button' onClick={onClose}>Cancel</button>
                            <span className='wizard-steps' aria-label={`Step ${index + 1} of ${STEPS.length}`}>
                                {STEPS.map((s, i) => <span key={s} className={i === index ? 'current' : i < index ? 'done' : ''} />)}
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
    const close = () => {
        useUiStore.getState().openCreate(false);
        setKey((k) => k + 1);                       // the next opening starts fresh
    };
    return (
        <Modal
            isOpen={open}
            onClose={close}
            width={560}
            height={490}
            items={[{ title: 'Create a server', content: <Wizard key={key} onClose={close} /> }]}
        />
    );
}
