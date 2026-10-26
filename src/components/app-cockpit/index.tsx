import './app-cockpit.css';
import { useState } from 'react';
import { LoaderCircle, LogIn, Plus, Power, Square } from 'lucide-react';
import { invoke } from '../../api';
import { useConfirm } from '../../hooks/useConfirm';
import { incompleteStartQuestion, powerMode } from '../../lib/sync';
import type { PowerMode } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { lockFor, reportFor, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { useUiStore } from '../../stores/uiStore';
import { DirectoryMenu, TransferMenu } from '../directory-menu';
import JoinServer from '../join-server';
import Modal from '../modal';

export default function AppCockpit() {
    const servers = useServersStore((s) => s.servers);
    const loaded = useServersStore((s) => s.loaded);
    const loading = useServersStore((s) => s.loading);
    const selected = useServersStore(selectSelectedServer);
    const selectedId = selected?.id ?? null;
    const session = useSessionStore((s) => s.state);
    const report = useSessionStore((s) => reportFor(s, selectedId));
    const lock = useSessionStore((s) => lockFor(s, selectedId));
    // While the folder is compared with the cloud, what may be done with the server is not known yet.
    const checking = useSessionStore((s) => selectedId !== null && s.checkingId === selectedId);
    const { confirm, popup } = useConfirm();
    const creating = useUiStore((s) => s.creating);
    const [isJoinOpen, setIsJoinOpen] = useState(false);
    const [requesting, setRequesting] = useState(false);

    const readOnly = selected !== null && (selected.myRole === 'reader' || selected.myRole === 'commenter');
    const computed = powerMode(session, selectedId, report, lock);
    // Readers can download and watch, but cannot write the lock or upload: they cannot host.
    const mode: PowerMode = readOnly && computed.kind === 'start'
        ? { kind: 'start', enabled: false, reason: 'You were invited as a reader, so you can watch this server but not host it.' }
        : checking && computed.kind === 'start'
            ? { kind: 'start', enabled: false, reason: 'Checking the server first…' }
            : computed;
    // What I may do comes from my role on the server, never from a constant.
    const canWrite = selected !== null && (selected.myRole === 'owner' || selected.myRole === 'writer' || selected.kind === 'owned');

    function handleCreate() {
        useUiStore.getState().openCreate(true);
    }

    /** Mojang's EULA has to be accepted before a server runs; asked once per Google account. */
    async function eulaAccepted(): Promise<boolean> {
        const store = useSettingsStore.getState();
        const prefs = store.settings ?? (await store.load());
        if (!prefs || !prefs.launchServer || prefs.eulaAccepted) return true;
        const accepted = await confirm({
            message: 'A Minecraft server only runs after you accept the Minecraft End User License Agreement (EULA).\n\nDo you accept it? MCS-Relay remembers your answer for this Google account and writes eula=true into the server folder for you.',
            confirmText: 'I accept',
            cancelText: 'Cancel',
            link: { label: 'Read the Minecraft EULA', url: 'https://www.minecraft.net/en-us/eula' },
        });
        return accepted && (await store.update({ eulaAccepted: true }));
    }

    async function handleStart() {
        if (!selectedId) return;
        if (!(await eulaAccepted())) return;
        // A version saved from a cancelled upload is a mixed world: say so before anyone plays it.
        const question = incompleteStartQuestion(reportFor(useSessionStore.getState(), selectedId), useAuthStore.getState().user?.email ?? null);
        if (question && !(await confirm(question))) return;
        setRequesting(true);
        const res = await invoke('session:start', selectedId);
        setRequesting(false);
        // A start that fails moves the session to "failed", which shows the error under the button already.
        if (!res.ok && res.error.code !== 'NOT_SIGNED_IN' && useSessionStore.getState().state.phase !== 'failed') {
            useNoticeStore.getState().error(res.error);
        }
    }

    async function handleStop() {
        setRequesting(true);
        const res = await invoke('session:stop');
        setRequesting(false);
        if (!res.ok && res.error.code !== 'NOT_SIGNED_IN' && useSessionStore.getState().state.phase !== 'upload-pending') {
            useNoticeStore.getState().error(res.error);
        }
    }

    // Rendered in every branch: a dialog opened by the empty state must survive the switch to the power button.
    const dialogs = (
        <>
            <Modal
                isOpen={isJoinOpen}
                onClose={() => setIsJoinOpen(false)}
                items={[{ title: 'Join a server', content: <JoinServer confirm={confirm} onJoined={() => setIsJoinOpen(false)} /> }]}
            />
            {popup}
        </>
    );

    if (!loaded && loading) {
        return (
            <div className='loading-div'>
                {dialogs}
                <h2><LoaderCircle size={32} className='spinner' /> Loading Servers...</h2>
            </div>
        );
    }

    if (servers.length === 0) {
        return (
            <div className='initial-buttons-section'>
                {dialogs}
                <h3 className='initial-title'>Let's get a server going</h3>
                <p className='initial-text'>You are not in any server yet. Start one in your own Google Drive, or join one a friend shared with you.</p>
                <div className='buttons-div'>
                    <button className='initial-button' onClick={handleCreate} disabled={creating}>
                        <span className='initial-icon'>
                            <Plus size={26} />
                        </span>
                        <span className='initial-label'>Create a server</span>
                        <span className='initial-hint'>A few questions, then a new server in your Google Drive and on this PC.</span>
                    </button>
                    <button className='initial-button' onClick={() => setIsJoinOpen(true)}>
                        <span className='initial-icon'><LogIn size={26} /></span>
                        <span className='initial-label'>Join a server</span>
                        <span className='initial-hint'>Paste the link from the invitation email Google Drive sent you.</span>
                    </button>
                </div>
            </div>
        );
    }

    let button;
    switch (mode.kind) {
        case 'stop':
            button = (
                <button className='onOff-button stop' title='Stop the server and upload the world' onClick={handleStop} disabled={requesting}>
                    {requesting ? <LoaderCircle size={76} strokeWidth={1.75} className='spinner' /> : <Square size={46} strokeWidth={1.75} fill='currentColor' />}
                </button>
            );
            break;
        case 'busy':
            button = (
                <button className='onOff-button busy' title={mode.label} disabled>
                    <LoaderCircle size={76} strokeWidth={1.75} className='spinner' />
                </button>
            );
            break;
        case 'start':
            button = (
                <button
                    className='onOff-button start'
                    title={mode.reason ?? 'Start the server'}
                    onClick={handleStart}
                    disabled={!mode.enabled || requesting}
                >
                    {requesting ? <LoaderCircle size={76} strokeWidth={1.75} className='spinner' /> : <Power size={72} strokeWidth={1.75} />}
                </button>
            );
            break;
        default:
            button = (
                <button
                    className='onOff-button'
                    title={mode.kind === 'failed' ? 'Dismiss the error first' : mode.error ? 'Retry the upload first' : 'Continue the upload first'}
                    disabled
                >
                    <Power size={72} strokeWidth={1.75} />
                </button>
            );
    }

    return (
        <div className='cockpit'>
            {dialogs}
            <div className='cockpit-wrapper'>
                <div className='side-slot left'><TransferMenu server={selected} canWrite={canWrite} checking={checking} /></div>
                {button}
                <div className='side-slot right'><DirectoryMenu server={selected} canWrite={canWrite} /></div>
            </div>
            {mode.kind === 'start' && !mode.enabled && mode.reason && report && !checking && <p className='power-reason'>{mode.reason}</p>}
        </div>
    );
}
