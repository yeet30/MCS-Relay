import './sync-status-card.css';
import { useState } from 'react';
import { FolderInput, Loader2, RefreshCw } from 'lucide-react';
import type { ConflictChoice, SyncReport } from '../../../shared/types';
import { useConfirm } from '../../hooks/useConfirm';
import { formatWhen } from '../../lib/format';
import { CHOICE_LABELS, FIRST_SYNC_CHOICE_LABELS, cleanupLines, describeReport, planHasFiles } from '../../lib/sync';
import type { IModalItems } from '../../lib/ui-types';
import { useAuthStore } from '../../stores/authStore';
import { request } from '../../stores/request';
import { chooseLocalPath } from '../../stores/serverActions';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { reportFor, useSessionStore } from '../../stores/sessionStore';
import FileGroups from '../file-groups';
import Modal from '../modal';

function planTabs(report: SyncReport): IModalItems[] {
    const plan = report.plan;
    const tabs: Array<[string, string[]]> = [
        ['Both changed', plan.conflicts],
        ['To download', plan.download],
        ['To upload', plan.upload],
        ['Deleted in the cloud', plan.deleteLocal],
        ['Deleted here', plan.deleteRemote],
    ];
    return tabs.filter(([, paths]) => paths.length > 0).map(([title, paths]) => ({ title, content: <FileGroups paths={paths} /> }));
}

function confirmText(choice: ConflictChoice, report: SyncReport, author: string): string {
    switch (choice) {
        case 'keep-cloud':
            return 'Use the cloud version?\n\nEvery file in your folder that differs from the cloud is first copied to the backups folder, then replaced when you press Start.';
        case 'keep-local':
            return `Keep your version?\n\nWhen your next session ends, your folder replaces revision ${report.remoteRevision ?? '?'} in the cloud. What ${author} changed in that revision is lost.`;
        default:
            return 'Combine both versions?\n\nTheir changes are downloaded when you start and yours are uploaded when the session ends. No file was changed on both sides, so nothing is overwritten.';
    }
}

/** What happens to this server's files if I press Start now, and the choice to make when both sides changed. */
export default function SyncStatusCard() {
    const server = useServersStore(selectSelectedServer);
    const serverId = server?.id ?? null;
    const report = useSessionStore((s) => reportFor(s, serverId));
    const checking = useSessionStore((s) => s.checkingId !== null && s.checkingId === serverId);
    const checkError = useSessionStore((s) => (s.checkError?.serverId === serverId ? s.checkError.error : null));
    const myEmail = useAuthStore((s) => s.user?.email ?? null);
    const { confirm, popup } = useConfirm();
    const [resolving, setResolving] = useState<ConflictChoice | null>(null);
    const [showFiles, setShowFiles] = useState(false);

    if (!server || !serverId) return null;
    const nameFor = (email: string) => server.members.find((m) => m.email === email)?.name || email;

    if (!report) {
        return (
            <div className='sync-card info'>
                {checkError
                    ? <p className='sync-body'>{checkError.message}</p>
                    : <p className='sync-body'><Loader2 size={12} className='spinner' /> Comparing your folder with the cloud…</p>}
            </div>
        );
    }

    const copy = describeReport(report, { myEmail, nameFor, now: Date.now() });
    const labels = report.firstSyncOnThisPc ? FIRST_SYNC_CHOICE_LABELS : CHOICE_LABELS;
    const choices = report.status === 'diverged' ? report.allowedChoices.filter((c) => c !== report.pendingChoice) : [];
    const cleanup = cleanupLines(report.cleanup, nameFor);
    const author = report.remoteAuthor ? report.remoteAuthor.name || nameFor(report.remoteAuthor.email) : 'the other member';

    async function handleChoice(choice: ConflictChoice) {
        if (!serverId || !report) return;
        if (!(await confirm({ message: confirmText(choice, report, author), confirmText: labels[choice], cancelText: 'Cancel' }))) return;
        setResolving(choice);
        const res = await request('session:resolve', serverId, choice);
        if (res.ok) useSessionStore.getState().applyReport(res.value);
        setResolving(null);
    }

    return (
        <div className={`sync-card ${copy.tone}`}>
            {popup}
            <Modal isOpen={showFiles} onClose={() => setShowFiles(false)} width={520} height={400} items={planTabs(report)} />
            <div className='sync-head'>
                <span className={`sync-pill ${copy.tone}`}>{copy.pill}</span>
                <span className='sync-title'>{copy.title}</span>
                <button
                    className='sync-refresh'
                    title={`Checked ${formatWhen(report.checkedAt)}. Check again`}
                    disabled={checking}
                    onClick={() => void useSessionStore.getState().preflight(serverId)}
                >
                    <RefreshCw size={13} className={checking ? 'spinner' : ''} />
                </button>
            </div>
            <p className='sync-body'>{copy.body}</p>
            {cleanup.map((line) => <p key={line} className='sync-cleanup'>{line}</p>)}
            <div className='sync-actions'>
                {choices.map((choice) => (
                    <button
                        key={choice}
                        className={`text-button ${choice === 'keep-cloud' && !report.pendingChoice ? 'primary' : ''}`}
                        disabled={resolving !== null}
                        onClick={() => handleChoice(choice)}
                    >
                        {resolving === choice && <Loader2 size={12} className='spinner' />}
                        {report.pendingChoice ? `Instead: ${labels[choice]}` : labels[choice]}
                    </button>
                ))}
                {report.status === 'no-local-path' && (
                    <button className='text-button primary' onClick={() => void chooseLocalPath(serverId)}>
                        <FolderInput size={12} /> Choose folder
                    </button>
                )}
                {planHasFiles(report) && <button className='text-button' onClick={() => setShowFiles(true)}>Show files</button>}
            </div>
        </div>
    );
}
