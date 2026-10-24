import './backups-panel.css';
import { useCallback, useEffect, useState } from 'react';
import { Archive, Cloud, CloudDownload, CloudUpload, FolderOpen, HardDrive, History, Loader2, Trash2 } from 'lucide-react';
import type { BackupInfo, BackupList, BackupProgress, ServerSummary } from '../../../shared/types';
import { useConfirm } from '../../hooks/useConfirm';
import { formatBytes, formatBytesPair, formatWhen } from '../../lib/format';
import { isSessionBusy } from '../../lib/sync';
import { useBackupStore } from '../../stores/backupStore';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { lockFor, useSessionStore } from '../../stores/sessionStore';

const ACTIONS: Record<BackupProgress['action'], string> = {
    saving: 'Asking the server to save the world',
    packing: 'Packing the world',
    uploading: 'Uploading the backup',
    downloading: 'Downloading the backup',
    restoring: 'Restoring the world',
};

function ProgressLine({ progress }: { progress: BackupProgress }) {
    const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;
    return (
        <div className='backup-progress' role='status'>
            <span>
                <Loader2 size={13} className='spinner' /> {ACTIONS[progress.action]}…
                {progress.total > 0 && <small>{formatBytesPair(progress.done, progress.total)}</small>}
            </span>
            <span className='backup-bar'><span style={{ width: `${percent ?? 0}%` }} /></span>
        </div>
    );
}

/** Backups of the world: the ones on this PC and the ones in the cloud in one list, newest first. */
export default function BackupsPanel({ server, canWrite }: { server: ServerSummary; canWrite: boolean }) {
    const [list, setList] = useState<BackupList | null>(null);
    const [name, setName] = useState('');
    const [upload, setUpload] = useState(false);
    const [starting, setStarting] = useState(false);
    const progress = useBackupStore((s) => s.progress);
    const session = useSessionStore((s) => s.state);
    const lock = useSessionStore((s) => lockFor(s, server.id));
    const { ask, confirm, popup } = useConfirm();
    const working = starting || progress !== null;
    const busy = isSessionBusy(session.phase);
    const hostingHere = busy && session.phase === 'running' && session.serverId === server.id;
    const backupBlocked = busy && session.serverId === server.id && !hostingHere
        ? 'Wait until the server has started or the upload has finished'
        : null;

    const reload = useCallback(async () => {
        const res = await request('backups:list', server.id);
        if (res.ok) setList(res.value);
    }, [server.id]);

    useEffect(() => {
        void reload();
    }, [reload]);

    /** Runs a backup command, then shows the list as it is now. */
    async function run(task: () => Promise<boolean>, done?: string) {
        setStarting(true);
        const ok = await task();
        setStarting(false);
        if (ok && done) useNoticeStore.getState().success(done);
        await reload();
    }

    function backUp() {
        void run(async () => (await request('backups:create', server.id, name, upload && canWrite)).ok, 'The backup is ready.');
        setName('');
    }

    async function restore(backup: BackupInfo) {
        const host = lock && (lock.state === 'held' || lock.state === 'stale') ? lock.lock.host.name : null;
        const accepted = await confirm({
            message: `Restore "${backup.name}" from ${formatWhen(backup.createdAt).replace(/^on /, '')}?\n\n`
                + 'The world in this PC\'s folder is replaced by the backup. The current world is backed up first, so you can go back.\n\n'
                + 'Everyone gets the restored world after you next host this server (or upload your changes).'
                + (host ? `\n\n${host} is hosting it right now. Once they stop, you will be asked which version to keep.` : ''),
            confirmText: 'Restore',
            cancelText: 'Cancel',
        });
        if (!accepted) return;
        await run(async () => (await request('backups:restore', server.id, backup.fileName)).ok, `"${backup.name}" was restored.`);
        void useSessionStore.getState().preflight(server.id);
    }

    async function remove(backup: BackupInfo) {
        const fromCloud = !backup.local;
        const answer = await ask({
            message: fromCloud
                ? `Delete "${backup.name}" from the cloud? Nobody in the server can restore it afterwards.`
                : `Delete "${backup.name}" from this PC?${backup.cloud ? ' The copy in the cloud stays.' : ''}`,
            confirmText: 'Delete',
            cancelText: 'Cancel',
        });
        if (answer !== 'yes') return;
        await run(async () => (fromCloud
            ? await request('backups:deleteCloud', server.id, backup.cloud!.id)
            : await request('backups:deleteLocal', server.id, backup.fileName)).ok);
    }

    const backups = list?.backups ?? [];
    return (
        <div className='backups-panel'>
            {popup}
            <div className='backup-new'>
                <div className='backup-new-row'>
                    <input
                        type='text'
                        maxLength={40}
                        placeholder='Name, for example "Before the End"'
                        value={name}
                        disabled={working}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !working && !backupBlocked) backUp();
                        }}
                    />
                    <button className='text-button primary' disabled={working || backupBlocked !== null} title={backupBlocked ?? undefined} onClick={backUp}>
                        <Archive size={13} /> Back up
                    </button>
                </div>
                {canWrite && (
                    <label className='backup-check'>
                        <input type='checkbox' checked={upload} disabled={working} onChange={(e) => setUpload(e.target.checked)} />
                        Also put it in the cloud, for everyone in the server
                    </label>
                )}
                <p className='backup-hint'>
                    Backs up the world folders on this PC.{hostingHere ? ' The server pauses saving for a moment meanwhile.' : ''}
                </p>
                {progress && progress.serverId === server.id && <ProgressLine progress={progress} />}
            </div>

            {list === null && <p className='backup-empty'><Loader2 size={13} className='spinner' /> Loading…</p>}
            {list !== null && backups.length === 0 && <p className='backup-empty'>No backups yet.</p>}
            {list?.cloudError && <p className='backup-warning'>Cloud backups could not be loaded: {list.cloudError}</p>}
            <ul className='backup-list'>
                {backups.map((backup) => (
                    <li key={backup.fileName} className='backup-item'>
                        <div className='backup-text'>
                            <span className='backup-name' title={backup.fileName}>{backup.name}</span>
                            <span className='backup-meta'>
                                {formatWhen(backup.createdAt)} · {formatBytes(backup.size)}
                            </span>
                            <span className='backup-places'>
                                {backup.local && <span className='backup-place'><HardDrive size={11} /> This PC</span>}
                                {backup.cloud && <span className='backup-place'><Cloud size={11} /> Cloud, by {backup.cloud.by}</span>}
                            </span>
                        </div>
                        <div className='backup-actions'>
                            {backup.local && (
                                <button className='text-button' disabled={working || busy} title={busy ? 'Stop the server first' : undefined} onClick={() => void restore(backup)}>
                                    <History size={12} /> Restore
                                </button>
                            )}
                            {!backup.local && backup.cloud && (
                                <button
                                    className='text-button'
                                    disabled={working}
                                    onClick={() => void run(async () => (await request('backups:download', server.id, backup.cloud!.id)).ok, `"${backup.name}" is on this PC now.`)}
                                >
                                    <CloudDownload size={12} /> Download
                                </button>
                            )}
                            {backup.local && !backup.cloud && canWrite && (
                                <button
                                    className='text-button'
                                    disabled={working}
                                    title='Put it in the cloud, for everyone in the server'
                                    onClick={() => void run(async () => (await request('backups:upload', server.id, backup.fileName)).ok, `"${backup.name}" is in the cloud now.`)}
                                >
                                    <CloudUpload size={12} /> Upload
                                </button>
                            )}
                            {(backup.local || backup.cloud?.canDelete) && (
                                <button className='icon-button' disabled={working} title={backup.local ? 'Delete from this PC' : 'Delete from the cloud'} onClick={() => void remove(backup)}>
                                    <Trash2 size={13} />
                                </button>
                            )}
                        </div>
                    </li>
                ))}
            </ul>

            <p className='backup-foot'>
                Backups on this PC are in the server folder, under mcs-relay-backups; they are never synced. Cloud backups
                are seen by every member and use the Google Drive storage of whoever uploaded them.
                <button className='backup-link' onClick={() => void request('backups:openFolder', server.id)}>
                    <FolderOpen size={12} /> Open the folder
                </button>
            </p>
        </div>
    );
}
