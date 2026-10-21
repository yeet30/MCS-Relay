import './repair-dialog.css';
import { useState } from 'react';
import { Check, Info, TriangleAlert, Wrench, X } from 'lucide-react';
import type { SyncReport } from '../../../shared/types';
import { invoke } from '../../api';
import { formatWhen } from '../../lib/format';
import { repairBlocker, stoppedAt } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { useSessionStore } from '../../stores/sessionStore';
import Modal from '../modal';

interface RepairProps {
    report: SyncReport;
    myEmail: string | null;
    nameFor: (email: string) => string;
    onClose: () => void;
}

/** Everything the owner should know before overriding someone else's unfinished upload: what happened, what
 *  the repair does step by step, what is lost, when to use it, and whether this PC can do it at all. */
function RepairExplanation({ report, myEmail, nameFor, onClose }: RepairProps) {
    const [understood, setUnderstood] = useState(false);
    const host = report.lock.lock?.host ?? null;
    const mine = host !== null && myEmail !== null && host.email.toLowerCase() === myEmail.toLowerCase();
    const name = host ? host.name || nameFor(host.email) : 'The other member';
    const revision = report.remoteRevision ?? 0;
    const blocker = repairBlocker(report);

    const whose = mine ? 'Your upload from another PC' : `${name}'s upload`;
    const thatPc = mine ? 'that PC' : `${name}'s PC`;
    const whenOpened = mine ? 'you open Drive Launcher on that PC' : `${name} opens Drive Launcher`;

    async function handleRepair() {
        onClose();
        const result = await invoke('session:repair', report.serverId);
        const phase = useSessionStore.getState().state.phase;
        // A repair that fails part way shows its error under the power button already.
        if (!result.ok && result.error.code !== 'NOT_SIGNED_IN' && phase !== 'failed' && phase !== 'upload-pending') {
            useNoticeStore.getState().error(result.error);
        }
    }

    return (
        <div className='repair-dialog'>
            <section>
                <h5>What happened</h5>
                <p>
                    {whose} stopped halfway {formatWhen(stoppedAt(report))}. Some files in the cloud already have the new
                    version and others still have the old one, so right now the cloud is a mix that nobody should play.
                </p>
                <p>
                    Normally this fixes itself: the next time {whenOpened}, it finishes the upload. Only {thatPc} can do
                    that, because only {thatPc} knows which files were already sent.
                </p>
            </section>

            <section>
                <h5>What the repair does</h5>
                <ol>
                    <li>Takes the server over from {mine ? 'your other PC' : name}.</li>
                    <li>Checks every file of revision {revision}, the last saved version, on Google Drive.</li>
                    <li>
                        Wherever the cloud no longer matches, puts this PC&apos;s copy back: files that were already replaced,
                        removed or emptied are uploaded again from this PC. Changes you made on this PC are uploaded too.
                    </li>
                    <li>Saves the result as revision {revision + 1}, so everyone can play again.</li>
                </ol>
            </section>

            <section className='repair-warning'>
                <h5><TriangleAlert size={13} /> What is lost</h5>
                <p>
                    The unfinished session never reaches the cloud. It is not deleted: it stays on {thatPc}. When{' '}
                    {whenOpened}, it says that the cloud changed and lets {mine ? 'you' : 'them'} choose which
                    version to keep. Choosing the cloud version copies {mine ? 'your' : 'their'} files to a backups folder first.
                </p>
            </section>

            <section>
                <h5>When to use it</h5>
                <p>
                    Only when {mine ? 'you cannot get to that PC' : `${name} cannot open Drive Launcher`} soon, for example
                    because of a broken or lost PC or a long trip. If {mine ? 'you can' : 'they can'},{' '}
                    {mine ? 'open it there instead' : `ask ${name} to open it instead`}: that keeps the unfinished session.
                </p>
            </section>

            <section>
                <h5>Before you start</h5>
                <ul className='repair-checks'>
                    <li className={blocker ? 'bad' : 'good'}>
                        {blocker ? <X size={13} /> : <Check size={13} />}
                        <span>{blocker ?? `This PC has revision ${revision}, the last saved version, so it can repair the cloud.`}</span>
                    </li>
                    <li>
                        <Info size={13} />
                        <span>Every file is checked first, so a repair takes a while even when little is broken. You can pause it and continue later.</span>
                    </li>
                </ul>
            </section>

            <label className='repair-ack'>
                <input type='checkbox' checked={understood} disabled={blocker !== null} onChange={(e) => setUnderstood(e.target.checked)} />
                <span>I understand that {mine ? 'the session from my other PC' : `${name}'s unfinished session`} will not be in the cloud.</span>
            </label>

            <div className='repair-buttons'>
                <button className='text-button' onClick={onClose}>Cancel</button>
                <button className='text-button danger' disabled={!understood || blocker !== null} onClick={handleRepair}>
                    <Wrench size={12} /> Repair from this PC
                </button>
            </div>
        </div>
    );
}

export default function RepairDialog({ isOpen, ...props }: RepairProps & { isOpen: boolean }) {
    return (
        <Modal
            isOpen={isOpen}
            onClose={props.onClose}
            width={560}
            height={440}
            items={[{ title: 'Repair from this PC', content: <RepairExplanation {...props} /> }]}
        />
    );
}
