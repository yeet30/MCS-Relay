import './progress-card.css';
import { useEffect, useState } from 'react';
import { Ban, Check, ChevronRight, CirclePause, CircleX, Clock, CloudUpload, ExternalLink, Info, Loader2, Play, RotateCcw, X } from 'lucide-react';
import type {
    LaneView, RunKind, ServerId, SessionPhase, SessionProgress, StepMessage, TransferKind, TransferSnapshot,
} from '../../../shared/types';
import { invoke } from '../../api';
import { useConfirm } from '../../hooks/useConfirm';
import {
    durationBetween, formatBytes, formatBytesPair, formatClock, formatCount, formatDuration, formatEta, formatSpeed, formatWhen,
} from '../../lib/format';
import { abandonControl, cancelQuestion, continueAction, stopControl } from '../../lib/sync';
import type { IModalItems } from '../../lib/ui-types';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import CancelUploadDialog from '../cancel-upload-dialog';
import Modal from '../modal';
import FailedFiles from './failed-files';

/** Re-renders every second while `running`, for clocks that count up. */
function useNow(running: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!running) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running]);
    return running ? now : Date.now();
}

function StatusIcon({ status }: { status: StepMessage['status'] }) {
    if (status === 'loading') return <Loader2 size={12} className='spinner' />;
    if (status === 'done') return <Check size={12} />;
    if (status === 'cancelled') return <CirclePause size={12} />;
    return <X size={12} />;
}

/** Every line the session wrote, newest first, with how long each task took. A task's line changes in place
 *  from loading to done or error. */
function ProgressLog() {
    const steps = useSessionStore((s) => s.steps);
    const running = steps.some((s) => s.status === 'loading');
    const now = useNow(running);
    if (steps.length === 0) return <p className='log-empty'>Nothing has happened yet.</p>;
    return (
        <ul className='progress-log'>
            {[...steps].reverse().map((step) => {
                const ms = step.status === 'loading' ? now - Date.parse(step.at) : durationBetween(step.at, step.endedAt);
                return (
                    <li key={step.id} className={`${step.status} ${step.importance}`}>
                        <span className='log-time'>{formatClock(step.at)}</span>
                        <StatusIcon status={step.status} />
                        <span className='log-text'>{step.message}</span>
                        <span className='log-duration'>{ms !== null && Number.isFinite(ms) ? formatDuration(ms) : ''}</span>
                    </li>
                );
            })}
        </ul>
    );
}

const DOING: Record<TransferKind, string> = {
    download: 'downloading', upload: 'uploading', 'delete-remote': 'deleting', 'delete-local': 'deleting', 'create-folder': 'creating',
};

function shortTime(ms: number | null): string {
    if (ms === null) return '';
    return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : formatDuration(ms);
}

/** One lane. A small file goes in one request, so its bytes cannot be followed: the lane shows that it is busy
 *  and for how long. Only a file that reports bytes along the way (big uploads, downloads) gets a real bar. */
function Lane({ lane }: { lane: LaneView }) {
    const measurable = lane.size > 0 && lane.bytesDone > 0 && lane.bytesDone < lane.size;
    let status;
    if (lane.state === 'backoff') {
        status = <span className='lane-wait'><Clock size={11} /> retry in {Math.ceil((lane.retryInMs ?? 0) / 1000)} s</span>;
    } else if (lane.path === null) {
        status = <span className='lane-idle' />;
    } else if (measurable) {
        status = <span className='lane-bar'><span style={{ width: `${(lane.bytesDone / lane.size) * 100}%` }} /></span>;
    } else {
        status = <span className='lane-busy' title={lane.kind ? DOING[lane.kind] : 'working'}><span /></span>;
    }
    return (
        <li className={`lane ${lane.state}`}>
            <span className='lane-number'>{lane.lane}</span>
            <span className='lane-name' title={lane.path ?? ''}>{lane.path ?? 'idle'}</span>
            {status}
            <span className='lane-meta'>
                {lane.path === null ? '' : [lane.size > 0 ? formatBytes(lane.size) : lane.kind ? DOING[lane.kind] : '', shortTime(lane.elapsedMs)]
                    .filter(Boolean).join(' · ')}
            </span>
        </li>
    );
}

/** What each parallel lane of the running transfer is doing. */
function LanesView() {
    const transfer = useSessionStore((s) => s.transfer);
    if (!transfer || transfer.lanes.length === 0) return <p className='log-empty'>No transfer is running right now.</p>;
    const busy = transfer.lanes.filter((lane) => lane.state !== 'idle').length;
    return (
        <div className='lanes-view'>
            <p className='lanes-head'>
                {transfer.label}: {busy} of {transfer.laneLimit} lanes busy · {formatCount(transfer.filesQueued)} waiting
            </p>
            <ul className='lanes'>{transfer.lanes.map((lane) => <Lane key={lane.lane} lane={lane} />)}</ul>
            <FailedFiles failures={transfer.failures} open />
        </div>
    );
}

function percent(progress: SessionProgress): number {
    return Math.floor(Math.min(1, Math.max(0, progress.fraction)) * 100);
}

/** "412 / 700 MB", "4.1 MB/s", "about 1 min left" while files move, spread over the line. */
function TransferMeta({ transfer }: { transfer: TransferSnapshot }) {
    if (!transfer.active) return null;
    return (
        <p className='progress-meta'>
            {transfer.bytesTotal > 0 && <span>{formatBytesPair(transfer.bytesDone, transfer.bytesTotal)}</span>}
            {transfer.bytesPerSec > 0 && transfer.bytesTotal > 0 && <span>{formatSpeed(transfer.bytesPerSec)}</span>}
            <span className='progress-eta'>{formatEta(transfer.etaSec)}</span>
        </p>
    );
}

/** "Step 5 of 8 · 1,210 of 2,320 actions" */
function stageLine(progress: SessionProgress): string {
    const stages = progress.stages.filter((s) => s.state !== 'skipped');
    const finished = stages.filter((s) => s.state === 'done').length;
    const current = Math.min(stages.length, finished + (progress.active ? 1 : 0));
    return `Step ${current} of ${stages.length} · ${formatCount(progress.unitsDone)} of ${formatCount(progress.unitsTotal)} actions`;
}

const OUTCOME_WORDS: Record<SessionProgress['outcome'], string> = {
    running: 'in progress', done: 'done', failed: 'stopped with an error', cancelled: 'cancelled',
};

/** A cancelled upload that still waits in upload-pending is paused, not over. */
function outcomeWord(progress: SessionProgress, phase: SessionPhase): string {
    return progress.outcome === 'cancelled' && phase === 'upload-pending' ? 'paused' : OUTCOME_WORDS[progress.outcome];
}

/** A paused upload shows the pause sign; a cancelled start, download or upload a crossed circle. */
function CancelledIcon({ phase, size }: { phase: SessionPhase; size: number }) {
    return phase === 'upload-pending' ? <CirclePause size={size} /> : <CircleX size={size} />;
}

/** Cancel (a start, a download) or Pause (an upload), after saying what that means for the files. Shown for the
 *  whole run; while it cannot act (Java is saving the world, the server is being released) it says why. */
function StopButton({ progress, phase }: { progress: SessionProgress; phase: SessionPhase }) {
    const { confirm, popup } = useConfirm();
    const [stopping, setStopping] = useState(false);
    const { label, reason } = stopControl(progress.kind, phase);

    async function handleClick() {
        if (!(await confirm(cancelQuestion(progress.kind, phase)))) return;
        setStopping(true);
        await request('session:cancel');
        setStopping(false);
    }

    return (
        <>
            {popup}
            <button className='text-button' disabled={stopping || reason !== null} title={reason ?? undefined} onClick={handleClick}>
                {stopping ? <Loader2 size={12} className='spinner' /> : label === 'Pause' ? <CirclePause size={12} /> : <CircleX size={12} />}
                {stopping ? (label === 'Pause' ? 'Pausing…' : 'Cancelling…') : label}
            </button>
        </>
    );
}

/** Cancel for good (next to Pause): opens the warning dialog that says what that does to the world. */
function AbandonButton({ progress, phase }: { progress: SessionProgress; phase: SessionPhase }) {
    const [open, setOpen] = useState(false);
    const { show, reason } = abandonControl(progress.kind, phase);
    if (!show) return null;
    return (
        <>
            <CancelUploadDialog isOpen={open} running onClose={() => setOpen(false)} />
            <button className='text-button' disabled={reason !== null} title={reason ?? 'Stop for good and save what was sent'} onClick={() => setOpen(true)}>
                <Ban size={12} /> Cancel…
            </button>
        </>
    );
}

/** playit.gg errors the user fixes on playit.gg's site: where. */
const PLAYIT_PAGES: Record<string, string> = {
    'agent-over-limit': 'https://playit.gg/account/agents',
    'agent-disabled': 'https://playit.gg/account/agents',
    'email-not-verified': 'https://playit.gg/account',
};
/** playit.gg refused this PC's key, so the app removed the link (PlayitLink). */
const LINK_GONE_REASONS = new Set(['InvalidAgentKey', 'NoLongerValid', 'AccountDoesNotExist', 'AgentNotFound']);

/** After a run that left work waiting: continue or retry the upload (or cancel it for good), or dismiss or retry a
 *  start that failed. In the card itself, so nothing is pushed down the page. */
function WaitingActions({ kind, phase }: { kind: RunKind | null; phase: SessionPhase }) {
    const error = useSessionStore((s) => s.state.error);
    const serverId = useSessionStore((s) => s.state.serverId);
    const [busy, setBusy] = useState(false);
    const [cancelOpen, setCancelOpen] = useState(false);
    if (phase !== 'failed' && phase !== 'upload-pending') return null;
    const repairing = kind === 'repair';
    const what = repairing ? 'repair' : 'upload';
    const paused = phase === 'upload-pending' && error === null;

    async function run(action: 'session:dismiss' | 'session:retryUpload') {
        setBusy(true);
        await request(action);
        setBusy(false);
    }

    /** A failed start, started again (after fixing the cause elsewhere, such as on playit.gg). */
    async function retryStart() {
        if (!serverId) return;
        setBusy(true);
        await invoke('session:dismiss');
        await continueRun('start', serverId);
        setBusy(false);
    }

    const playitPage = error?.code === 'PLAYIT' && error.detail ? PLAYIT_PAGES[error.detail] : undefined;
    // Not after the playit.gg link was removed: the start would go on without playit.gg until it is linked again.
    const linkGone = error?.code === 'PLAYIT' && LINK_GONE_REASONS.has(error.detail ?? '');
    const startFailed = phase === 'failed' && (kind === 'start' || (kind === null && error?.code === 'PLAYIT')) && serverId !== null && !linkGone;

    return (
        <>
            <CancelUploadDialog isOpen={cancelOpen} running={false} onClose={() => setCancelOpen(false)} />
            {phase === 'upload-pending' && !repairing && (
                <button className='text-button' disabled={busy} title='Stop for good and save what was sent' onClick={() => setCancelOpen(true)}>
                    <Ban size={12} /> Cancel…
                </button>
            )}
            {playitPage && (
                <button className='text-button' onClick={() => void invoke('app:openExternal', playitPage)}>
                    <ExternalLink size={12} /> Open playit.gg
                </button>
            )}
            {phase === 'failed'
                ? (
                    <>
                        <button className='text-button' disabled={busy} onClick={() => void run('session:dismiss')}>Dismiss</button>
                        {startFailed && (
                            <button className='text-button primary' disabled={busy} onClick={() => void retryStart()}>
                                {busy ? <Loader2 size={12} className='spinner' /> : <RotateCcw size={12} />} Try again
                            </button>
                        )}
                    </>
                )
                : (
                    <button className='text-button primary' disabled={busy} onClick={() => void run('session:retryUpload')}>
                        {busy ? <Loader2 size={12} className='spinner' /> : paused ? <Play size={12} /> : <CloudUpload size={12} />}
                        {paused ? `Continue ${what}` : `Retry ${what}`}
                    </button>
                )}
        </>
    );
}

/** Under the message of a waiting upload: what pausing kept, and that the server is still reserved. */
function waitingHint(phase: SessionPhase, paused: boolean): string | null {
    if (phase !== 'upload-pending') return null;
    return paused
        ? 'Continuing sends only what is not on Google Drive yet. Closing the app keeps the reservation.'
        : 'The server stays reserved for you until the upload finishes.';
}

/** Runs a cancelled run again; what was already done (downloaded files, the upload journal) is not redone. */
async function continueRun(action: NonNullable<ReturnType<typeof continueAction>>, serverId: ServerId): Promise<void> {
    let result;
    if (action === 'start') result = await invoke('session:start', serverId);
    else if (action === 'repair') result = await invoke('session:repair', serverId);
    else result = await invoke('session:syncNow', serverId, action);
    const phase = useSessionStore.getState().state.phase;
    // A run that fails shows its error under the power button already.
    if (!result.ok && result.error.code !== 'NOT_SIGNED_IN' && phase !== 'failed' && phase !== 'upload-pending') {
        useNoticeStore.getState().error(result.error);
    }
}

/** The block under the server picker: what is happening, how far it is, and the details behind a button. */
export default function ProgressCard({ compact = false }: { compact?: boolean }) {
    const progress = useSessionStore((s) => s.progress);
    const transfer = useSessionStore((s) => s.transfer);
    const phase = useSessionStore((s) => s.state.phase);
    const sessionError = useSessionStore((s) => s.state.error);
    const selectedId = useServersStore((s) => s.selectedId);
    const [modalTab, setModalTab] = useState<number | null>(null);
    const [continuing, setContinuing] = useState(false);
    const now = useNow(Boolean(progress?.active));
    if (!progress) {
        // No run in memory (the window was reloaded) but work is waiting: still offer what to do about it.
        if (phase !== 'failed' && phase !== 'upload-pending') return null;
        return (
            <div className='progress-card failed'>
                <p className='progress-message'><X size={12} /><span>{sessionError?.message ?? 'The last upload did not finish.'}</span></p>
                <div className='progress-foot'>
                    <span />
                    <span className='progress-buttons'><WaitingActions kind={null} phase={phase} /></span>
                </div>
            </div>
        );
    }

    const transferring = Boolean(transfer?.active);
    const tabs: IModalItems[] = [{ title: 'Progress log', content: <ProgressLog /> }];
    if (transferring) tabs.push({ title: 'Lanes', content: <LanesView /> });
    // During a transfer the lanes are what people want to see, so the button opens that tab.
    const openDetails = () => setModalTab(transferring ? 1 : 0);
    const modal = (
        <Modal isOpen={modalTab !== null} initialTab={modalTab ?? 0} onClose={() => setModalTab(null)} width={560} height={400} items={tabs} />
    );
    const took = progress.active
        ? durationBetween(progress.startedAt, new Date(now).toISOString())
        : durationBetween(progress.startedAt, progress.endedAt);

    // Only offered for the selected server, and only while nothing else runs.
    const action = progress.outcome === 'cancelled' && phase === 'idle' && progress.serverId === selectedId
        ? continueAction(progress.kind)
        : null;

    async function handleContinue() {
        if (!action || !progress?.serverId) return;
        setContinuing(true);
        await continueRun(action, progress.serverId);
        setContinuing(false);
    }

    if (compact || (!progress.active && progress.outcome === 'done')) {
        return (
            <div className={`progress-card compact ${progress.outcome}${action ? ' with-action' : ''}`}>
                {modal}
                <span className='compact-icon'>
                    {progress.outcome === 'done' ? <Check size={13} /> : progress.outcome === 'cancelled' ? <CancelledIcon phase={phase} size={13} /> : <X size={13} />}
                </span>
                <span className='compact-text'>
                    {progress.title}: {outcomeWord(progress, phase)}
                    {took !== null && ` ${progress.outcome === 'done' ? 'in' : 'after'} ${formatDuration(took)}`}
                    {progress.endedAt && <span className='compact-when'> · {formatWhen(progress.endedAt)}</span>}
                </span>
                <span className='compact-buttons'>
                    {action && (
                        <button className='text-button primary' disabled={continuing} title='Pick up where it stopped' onClick={handleContinue}>
                            {continuing ? <Loader2 size={12} className='spinner' /> : <Play size={12} />} Continue
                        </button>
                    )}
                    <button className='text-button' onClick={openDetails}>Show details</button>
                </span>
            </div>
        );
    }

    const failed = progress.outcome === 'failed' || progress.outcome === 'cancelled';
    return (
        <div className={`progress-card ${progress.outcome}`}>
            {modal}
            <div className='progress-head'>
                <span className='progress-title'>{progress.title}</span>
                <span className='progress-percent'>{failed ? outcomeWord(progress, phase) : `${percent(progress)}%`}</span>
            </div>
            <div className='progress-bar'><span style={{ width: `${progress.fraction * 100}%` }} /></div>
            <p className='progress-message'>
                {progress.active
                    ? <Loader2 size={12} className='spinner' />
                    : progress.outcome === 'cancelled' ? <CancelledIcon phase={phase} size={12} /> : failed ? <X size={12} /> : <Check size={12} />}
                <span>{progress.message}</span>
            </p>
            {transfer && <TransferMeta transfer={transfer} />}
            {progress.note && progress.active && <p className='progress-note'><Info size={12} /> <span>{progress.note}</span></p>}
            {!progress.active && waitingHint(phase, sessionError === null) && (
                <p className='progress-hint'>{waitingHint(phase, sessionError === null)}</p>
            )}
            {transfer && transfer.failures.length > 0 && <FailedFiles failures={transfer.failures} />}
            <div className='progress-foot'>
                <span className='progress-steps'>
                    {stageLine(progress)}
                    {took !== null && ` · ${failed ? 'after ' : ''}${formatDuration(took)}`}
                </span>
                <span className='progress-buttons'>
                    {progress.active && <StopButton progress={progress} phase={phase} />}
                    {progress.active && <AbandonButton progress={progress} phase={phase} />}
                    {!progress.active && <WaitingActions kind={progress.kind} phase={phase} />}
                    <button className='text-button' onClick={openDetails}>
                        Details <ChevronRight size={12} />
                    </button>
                </span>
            </div>
        </div>
    );
}
