import './progress-card.css';
import { useEffect, useState } from 'react';
import { Check, ChevronRight, Clock, Info, Loader2, X } from 'lucide-react';
import type { LaneView, SessionProgress, StepMessage, TransferKind, TransferSnapshot } from '../../../shared/types';
import {
    durationBetween, formatBytes, formatBytesPair, formatClock, formatCount, formatDuration, formatEta, formatSpeed, formatWhen,
} from '../../lib/format';
import type { IModalItems } from '../../lib/ui-types';
import { useSessionStore } from '../../stores/sessionStore';
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

/** "412 / 700 MB · 4.1 MB/s · about 1 min left" while files move. */
function transferLine(transfer: TransferSnapshot): string | null {
    if (!transfer.active) return null;
    const parts: string[] = [];
    if (transfer.bytesTotal > 0) parts.push(formatBytesPair(transfer.bytesDone, transfer.bytesTotal));
    if (transfer.bytesPerSec > 0 && transfer.bytesTotal > 0) parts.push(formatSpeed(transfer.bytesPerSec));
    parts.push(formatEta(transfer.etaSec));
    return parts.join(' · ');
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

/** The block under the server picker: what is happening, how far it is, and the details behind a button. */
export default function ProgressCard({ compact = false }: { compact?: boolean }) {
    const progress = useSessionStore((s) => s.progress);
    const transfer = useSessionStore((s) => s.transfer);
    const [modalTab, setModalTab] = useState<number | null>(null);
    const now = useNow(Boolean(progress?.active));
    if (!progress) return null;

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

    if (compact || (!progress.active && progress.outcome === 'done')) {
        return (
            <div className={`progress-card compact ${progress.outcome}`}>
                {modal}
                <span className='compact-icon'>{progress.outcome === 'done' ? <Check size={13} /> : <X size={13} />}</span>
                <span className='compact-text'>
                    {progress.title}: {OUTCOME_WORDS[progress.outcome]}
                    {took !== null && ` in ${formatDuration(took)}`}
                    {progress.endedAt && <span className='compact-when'> · {formatWhen(progress.endedAt)}</span>}
                </span>
                <button className='text-button' onClick={openDetails}>Show details</button>
            </div>
        );
    }

    const failed = progress.outcome === 'failed' || progress.outcome === 'cancelled';
    const extra = transfer ? transferLine(transfer) : null;
    return (
        <div className={`progress-card ${progress.outcome}`}>
            {modal}
            <div className='progress-head'>
                <span className='progress-title'>{progress.title}</span>
                <span className='progress-percent'>{failed ? OUTCOME_WORDS[progress.outcome] : `${percent(progress)}%`}</span>
            </div>
            <div className='progress-bar'><span style={{ width: `${progress.fraction * 100}%` }} /></div>
            <p className='progress-message'>
                {progress.active ? <Loader2 size={12} className='spinner' /> : failed ? <X size={12} /> : <Check size={12} />}
                <span>{progress.message}</span>
            </p>
            {extra && <p className='progress-meta'>{extra}</p>}
            {progress.note && progress.active && <p className='progress-note'><Info size={12} /> <span>{progress.note}</span></p>}
            {transfer && transfer.failures.length > 0 && <FailedFiles failures={transfer.failures} />}
            <div className='progress-foot'>
                <span className='progress-steps'>
                    {stageLine(progress)}
                    {took !== null && ` · ${failed ? 'after ' : ''}${formatDuration(took)}`}
                </span>
                <button className='text-button' onClick={openDetails}>
                    Show details <ChevronRight size={12} />
                </button>
            </div>
        </div>
    );
}
