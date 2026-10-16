import './transfers-panel.css';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import type { LaneView } from '../../../shared/types';
import { formatBytesPair, formatCount, formatEta, formatSpeed } from '../../lib/format';
import { transferFraction } from '../../lib/sync';
import { useSessionStore } from '../../stores/sessionStore';
import FailedFiles from './failed-files';

function Lane({ lane }: { lane: LaneView }) {
    const fraction = lane.size > 0 ? Math.min(1, lane.bytesDone / lane.size) : 0;
    return (
        <li className={`lane ${lane.state}`}>
            <span className='lane-name' title={lane.path ?? ''}>{lane.path ? lane.path.split('/').pop() : 'idle'}</span>
            {lane.state === 'backoff'
                ? <span className='lane-wait'><Clock size={11} /> retry in {Math.ceil((lane.retryInMs ?? 0) / 1000)} s</span>
                : <span className='lane-bar'><span style={{ width: `${fraction * 100}%` }} /></span>}
        </li>
    );
}

/** The running download or upload: overall progress, speed, time left, and what each lane is doing. */
export default function TransfersPanel() {
    const snapshot = useSessionStore((s) => s.transfer);
    const [showLanes, setShowLanes] = useState(false);
    if (!snapshot) return null;

    const fraction = transferFraction(snapshot);
    const files = `${formatCount(snapshot.filesDone)} of ${formatCount(snapshot.filesTotal)} files`;
    const active = snapshot.lanes.filter((lane) => lane.state !== 'idle');

    return (
        <div className='transfers-panel'>
            <div className='transfer-head'>
                <span className='transfer-label'>{snapshot.label}</span>
                <span className='transfer-percent'>{Math.floor(fraction * 100)}%</span>
            </div>
            <div className='transfer-bar'><span style={{ width: `${fraction * 100}%` }} /></div>
            <div className='transfer-meta'>
                <span>{files}</span>
                {snapshot.bytesTotal > 0 && <span>{formatBytesPair(snapshot.bytesDone, snapshot.bytesTotal)}</span>}
                {snapshot.active && <span>{formatSpeed(snapshot.bytesPerSec)}</span>}
                {snapshot.active && <span>{formatEta(snapshot.etaSec)}</span>}
            </div>
            {snapshot.active && (
                <button className='lanes-toggle' onClick={() => setShowLanes(!showLanes)}>
                    {showLanes ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {active.length} of {snapshot.laneLimit} lanes busy
                </button>
            )}
            {showLanes && <ul className='lanes'>{snapshot.lanes.map((lane) => <Lane key={lane.lane} lane={lane} />)}</ul>}
            <FailedFiles failures={snapshot.failures} />
        </div>
    );
}
