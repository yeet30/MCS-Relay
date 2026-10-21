import './app-cockpit.css';
import { useState } from 'react';
import { CloudUpload, LoaderCircle, LogIn, Play, Plus, Power, Square } from 'lucide-react';
import { invoke } from '../../api';
import { useConfirm } from '../../hooks/useConfirm';
import { powerMode } from '../../lib/sync';
import type { PowerMode } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { createServer } from '../../stores/serverActions';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { lockFor, reportFor, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { DirectoryMenu, TransferMenu } from '../directory-menu';
import FailedFiles from '../progress-card/failed-files';
import JoinServer from '../join-server';
import Modal from '../modal';

/** The box under the power button: a failed start (Dismiss), an upload that has to be retried, or one the user
 *  paused (an upload-pending without an error). */
function PowerMessage({ mode }: { mode: Extract<PowerMode, { kind: 'failed' | 'upload-pending' }> }) {
    const failures = useSessionStore((s) => s.transfer?.failures);
    const repairing = useSessionStore((s) => s.progress?.kind === 'repair');
    const [busy, setBusy] = useState(false);
    const error = mode.error;
    const transferError = error?.code === 'UPLOAD_INCOMPLETE' || error?.code === 'DOWNLOAD_INCOMPLETE';
    const paused = mode.kind === 'upload-pending' && error === null;
    const what = repairing ? 'repair' : 'upload';

    async function run(action: 'session:dismiss' | 'session:retryUpload') {
        setBusy(true);
        await request(action);
        setBusy(false);
    }

    return (
        <div className={`power-message ${paused ? 'paused' : mode.kind}`}>
            <p className='power-message-title'>
                {mode.kind === 'failed'
                    ? 'The session could not start.'
                    : paused
                        ? `The ${what} is paused. The server stays reserved for you until it finishes.`
                        : `The ${what} did not finish. The server stays reserved for you until it does.`}
            </p>
            {paused && (
                <p className='power-message-text'>
                    What is already uploaded stays on Google Drive, so continuing only sends the rest. If you close Drive Launcher, it continues the next time you open it.
                </p>
            )}
            {error && <p className='power-message-text'>{error.message}</p>}
            {transferError && failures && failures.length > 0 && <FailedFiles failures={failures} />}
            <div className='power-message-buttons'>
                {mode.kind === 'failed'
                    ? <button className='text-button' disabled={busy} onClick={() => run('session:dismiss')}>Dismiss</button>
                    : (
                        <button className='text-button primary' disabled={busy} onClick={() => run('session:retryUpload')}>
                            {busy ? <LoaderCircle size={12} className='spinner' /> : paused ? <Play size={12} /> : <CloudUpload size={12} />}
                            {paused ? `Continue ${what}` : `Retry ${what}`}
                        </button>
                    )}
            </div>
        </div>
    );
}

export default function AppCockpit() {
    const servers = useServersStore((s) => s.servers);
    const loaded = useServersStore((s) => s.loaded);
    const loading = useServersStore((s) => s.loading);
    const selected = useServersStore(selectSelectedServer);
    const selectedId = selected?.id ?? null;
    const session = useSessionStore((s) => s.state);
    const report = useSessionStore((s) => reportFor(s, selectedId));
    const lock = useSessionStore((s) => lockFor(s, selectedId));
    const { confirm, popup } = useConfirm();
    const [creating, setCreating] = useState(false);
    const [isJoinOpen, setIsJoinOpen] = useState(false);
    const [requesting, setRequesting] = useState(false);

    const readOnly = selected !== null && (selected.myRole === 'reader' || selected.myRole === 'commenter');
    const computed = powerMode(session, selectedId, report, lock);
    // Readers can download and watch, but cannot write the lock or upload: they cannot host.
    const mode: PowerMode = readOnly && computed.kind === 'start'
        ? { kind: 'start', enabled: false, reason: 'You were invited as a reader, so you can watch this server but not host it.' }
        : computed;
    // What I may do comes from my role on the server, never from a constant.
    const canWrite = selected !== null && (selected.myRole === 'owner' || selected.myRole === 'writer' || selected.kind === 'owned');

    async function handleCreate() {
        setCreating(true);
        await createServer(confirm);
        setCreating(false);
    }

    /** Mojang's EULA has to be accepted before a server runs; asked once per Google account. */
    async function eulaAccepted(): Promise<boolean> {
        const store = useSettingsStore.getState();
        const prefs = store.settings ?? (await store.load());
        if (!prefs || !prefs.launchServer || prefs.eulaAccepted) return true;
        const accepted = await confirm({
            message: 'A Minecraft server only runs after you accept the Minecraft End User License Agreement (EULA).\n\nDo you accept it? Drive Launcher remembers your answer for this Google account and writes eula=true into the server folder for you.',
            confirmText: 'I accept',
            cancelText: 'Cancel',
            link: { label: 'Read the Minecraft EULA', url: 'https://www.minecraft.net/en-us/eula' },
        });
        return accepted && (await store.update({ eulaAccepted: true }));
    }

    async function handleStart() {
        if (!selectedId) return;
        if (!(await eulaAccepted())) return;
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
                <h3>You are not a member of any server, create or join one.</h3>
                <div className='buttons-div'>
                    <button className='initial-button' title='Create a server in your Google Drive' onClick={handleCreate} disabled={creating}>
                        {creating ? <LoaderCircle size={52} strokeWidth={1.5} className='spinner' /> : <Plus size={52} strokeWidth={1.5} />}
                        <span>Create a server</span>
                    </button>
                    <button className='initial-button' title='Join a server from an invitation' onClick={() => setIsJoinOpen(true)}>
                        <LogIn size={52} strokeWidth={1.5} />
                        <span>Join a server</span>
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
                <div className='side-slot left'><TransferMenu server={selected} canWrite={canWrite} /></div>
                {button}
                <div className='side-slot right'><DirectoryMenu server={selected} canWrite={canWrite} /></div>
            </div>
            {mode.kind === 'start' && !mode.enabled && mode.reason && report && <p className='power-reason'>{mode.reason}</p>}
            {(mode.kind === 'failed' || mode.kind === 'upload-pending') && <PowerMessage mode={mode} />}
        </div>
    );
}
