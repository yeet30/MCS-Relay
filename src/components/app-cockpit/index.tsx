import './app-cockpit.css';
import { useState } from 'react';
import { CloudUpload, LoaderCircle, LogIn, Plus, Power, Square } from 'lucide-react';
import { invoke } from '../../api';
import { useConfirm } from '../../hooks/useConfirm';
import { powerMode } from '../../lib/sync';
import type { PowerMode } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { createServer } from '../../stores/serverActions';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { lockFor, reportFor, useSessionStore } from '../../stores/sessionStore';
import { DirectoryMenu } from '../directory-menu';
import FailedFiles from '../transfers-panel/failed-files';
import JoinServer from '../join-server';
import Modal from '../modal';

/** The error box under the power button: a failed start (Dismiss) or an upload that has to be retried. */
function PowerMessage({ mode }: { mode: Extract<PowerMode, { kind: 'failed' | 'upload-pending' }> }) {
    const failures = useSessionStore((s) => s.transfer?.failures);
    const [busy, setBusy] = useState(false);
    const error = mode.error;
    const transferError = error?.code === 'UPLOAD_INCOMPLETE' || error?.code === 'DOWNLOAD_INCOMPLETE';

    async function run(action: 'session:dismiss' | 'session:retryUpload') {
        setBusy(true);
        await request(action);
        setBusy(false);
    }

    return (
        <div className={`power-message ${mode.kind}`}>
            <p className='power-message-title'>
                {mode.kind === 'failed' ? 'The session could not start.' : 'The upload did not finish. The server stays reserved for you until it does.'}
            </p>
            {error && <p className='power-message-text'>{error.message}</p>}
            {transferError && failures && failures.length > 0 && <FailedFiles failures={failures} />}
            <div className='power-message-buttons'>
                {mode.kind === 'failed'
                    ? <button className='text-button' disabled={busy} onClick={() => run('session:dismiss')}>Dismiss</button>
                    : (
                        <button className='text-button primary' disabled={busy} onClick={() => run('session:retryUpload')}>
                            {busy ? <LoaderCircle size={12} className='spinner' /> : <CloudUpload size={12} />}
                            Retry upload
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

    const mode = powerMode(session, selectedId, report, lock);
    // F33: what I may do comes from my role on the server, never from a constant.
    const canEditRules = selected !== null && (selected.myRole === 'owner' || selected.myRole === 'writer' || selected.kind === 'owned');

    async function handleCreate() {
        setCreating(true);
        await createServer(confirm);
        setCreating(false);
    }

    async function handleStart() {
        if (!selectedId) return;
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
                items={[{ title: 'Join Server', content: <JoinServer confirm={confirm} onJoined={() => setIsJoinOpen(false)} /> }]}
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
                    <button className='initial-button' title='Create a server' onClick={handleCreate} disabled={creating}>
                        {creating ? <LoaderCircle size={120} className='spinner' /> : <Plus size={120} />}
                    </button>
                    <button className='initial-button' title='Join a server' onClick={() => setIsJoinOpen(true)}>
                        <LogIn size={120} />
                    </button>
                </div>
            </div>
        );
    }

    let button;
    switch (mode.kind) {
        case 'stop':
            button = (
                <button className='onOff-button' title='Stop the server and upload the world' onClick={handleStop} disabled={requesting}>
                    {requesting ? <LoaderCircle size={128} className='spinner' /> : <Square size={120} fill='currentColor' />}
                </button>
            );
            break;
        case 'busy':
            button = (
                <button className='onOff-button' title={mode.label} disabled>
                    <LoaderCircle size={128} className='spinner' />
                </button>
            );
            break;
        case 'start':
            button = (
                <button
                    className='onOff-button'
                    title={mode.reason ?? 'Start the server'}
                    onClick={handleStart}
                    disabled={!mode.enabled || requesting}
                >
                    {requesting ? <LoaderCircle size={128} className='spinner' /> : <Power size={128} />}
                </button>
            );
            break;
        default:
            button = (
                <button className='onOff-button' title={mode.kind === 'failed' ? 'Dismiss the error first' : 'Retry the upload first'} disabled>
                    <Power size={128} />
                </button>
            );
    }

    return (
        <div className='cockpit'>
            {dialogs}
            <div className='cockpit-wrapper'>
                {button}
                <div className='directory-menu'>
                    <DirectoryMenu server={selected} canEditRules={canEditRules} />
                </div>
            </div>
            {mode.kind === 'start' && !mode.enabled && mode.reason && report && <p className='power-reason'>{mode.reason}</p>}
            {(mode.kind === 'failed' || mode.kind === 'upload-pending') && <PowerMessage mode={mode} />}
        </div>
    );
}
