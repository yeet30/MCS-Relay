import './server-slot.css';
import { useEffect, useRef, useState } from 'react';
import { Check, FolderInput, HardDrive, Loader2, LogOut, Pencil, Trash2 } from 'lucide-react';
import type { ServerSummary } from '../../../shared/types';
import { useConfirm } from '../../hooks/useConfirm';
import { formatCount } from '../../lib/format';
import { isMySession } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { askForServerFolder, chooseLocalPath } from '../../stores/serverActions';
import { useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useUiStore } from '../../stores/uiStore';
import PermissionsList from '../permissions-list';

const MAX_NAME = 60;

/** One server in Settings > Drive Folders: its name, its folder on this PC and its members. Downloading and
 *  uploading happen only through a session. */
export default function ServerSlot({ server }: { server: ServerSummary }) {
    const { confirm, popup } = useConfirm();
    const inUse = useSessionStore((s) => isMySession(s.state, server.id) && s.state.phase !== 'failed');
    const pathStep = useServersStore((s) => (s.pathBusy?.serverId === server.id ? s.pathBusy.step : null));
    const pathBusy = pathStep !== null;
    const checkProgress = useSessionStore((s) => (s.checkProgress?.serverId === server.id ? s.checkProgress : null));
    const isOwner = server.myRole === 'owner';
    const inputRef = useRef<HTMLInputElement>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [nameBuffer, setNameBuffer] = useState(server.name);
    const [loading, setLoading] = useState<'edit' | null>(null);
    const leaving = useServersStore((s) => server.id in s.leaving);
    const leaveProgress = useServersStore((s) => s.leaving[server.id] ?? null);
    const renameId = useUiStore((s) => s.renameId);
    const cardRef = useRef<HTMLDivElement>(null);
    /** The server was just created: once it is named, its folder on this PC is asked for. */
    const namingNew = useRef(false);

    useEffect(() => {
        if (!isEditing) setNameBuffer(server.name);
    }, [server.name, isEditing]);

    async function handleSave() {
        const name = nameBuffer.trim();
        let saved = true;
        if (name && name !== server.name) {
            setLoading('edit');
            const res = await request('servers:rename', server.id, name);
            if (res.ok) useServersStore.getState().setName(server.id, name);
            else setNameBuffer(server.name);
            saved = res.ok;
            setLoading(null);
        }
        setIsEditing(false);
        if (namingNew.current && saved) {
            namingNew.current = false;
            await askForServerFolder({ ...server, name: name || server.name }, confirm);
        }
    }

    function cancelEditing() {
        namingNew.current = false;
        setIsEditing(false);
    }

    async function handleDelete() {
        const accepted = await confirm(isOwner
            ? {
                message: `Delete "${server.name}" from your Google Drive?\n\nThe folder goes to your Drive trash. Files other members uploaded are handed back to them, and their apps delete them for good.`,
                confirmText: 'Delete',
                cancelText: 'Keep',
            }
            : {
                message: `Leave "${server.name}"? You lose access to the shared folder. Your local copy stays on this PC.

World files you uploaded stay in the server, because the others still need them, and keep using your Google storage until the owner deletes the server.`,
                confirmText: 'Leave',
                cancelText: 'Stay',
            });
        if (!accepted || server.id in useServersStore.getState().leaving) return;
        const servers = useServersStore.getState();
        servers.setLeaving(server.id, null);
        const res = isOwner ? await request('servers:delete', server.id) : await request('servers:leave', server.id);
        servers.setLeaving(server.id, undefined);
        if (!res.ok) return;
        useNoticeStore.getState().success(isOwner ? `"${server.name}" was deleted.` : `You left "${server.name}".`);
        await useServersStore.getState().reload();
    }

    function startEditing() {
        setIsEditing(true);
        setTimeout(() => inputRef.current?.select(), 0);
    }

    // A server that was just created opens with its name selected, as if the pen button had been pressed.
    useEffect(() => {
        if (renameId !== server.id || !useUiStore.getState().takeRename(server.id)) return;
        cardRef.current?.scrollIntoView({ block: 'nearest' });
        namingNew.current = true;
        startEditing();
    }, [renameId, server.id]);

    return (
        <div className={`server-card ${isEditing ? 'renaming' : ''} ${leaving ? 'leaving' : ''}`} ref={cardRef} aria-busy={leaving}>
            {popup}
            <div className='server-card-head'>
                <span className='server-initial' aria-hidden>{server.name.charAt(0).toUpperCase() || '?'}</span>
                <input
                    type='text'
                    ref={inputRef}
                    className={`name-input ${isEditing ? 'editing' : ''}`}
                    value={nameBuffer}
                    readOnly={!isEditing}
                    maxLength={MAX_NAME}
                    onChange={(e) => setNameBuffer(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSave();
                        if (e.key === 'Escape') cancelEditing();
                    }}
                />
                {isOwner && (isEditing
                    ? (
                        <button className='icon-button' title='Save the name' onClick={handleSave} disabled={loading === 'edit'}>
                            {loading === 'edit' ? <Loader2 size={14} className='spinner' /> : <Check size={14} />}
                        </button>
                    )
                    : <button className='icon-button' title='Rename' onClick={startEditing}><Pencil size={14} /></button>)}
                <button
                    className='icon-button danger'
                    title={inUse ? 'Stop the session first' : isOwner ? 'Delete this server' : 'Leave this server'}
                    disabled={leaving || inUse}
                    onClick={handleDelete}
                >
                    {leaving
                        ? <Loader2 size={14} className='spinner' />
                        : isOwner ? <Trash2 size={15} /> : <LogOut size={15} />}
                </button>
            </div>
            <div className='server-path'>
                <HardDrive size={14} />
                <span className={`path-text ${server.localPath ? '' : 'missing'}`} title={server.localPath ?? undefined}>
                    {server.localPath ?? 'No folder on this PC yet'}
                </span>
                <button
                    className={`text-button ${server.localPath ? '' : 'primary'}`}
                    disabled={pathBusy || inUse}
                    title={inUse ? 'The folder cannot change during a session' : 'Choose the folder on this PC'}
                    onClick={() => void chooseLocalPath(server.id)}
                >
                    {pathBusy ? <Loader2 size={12} className='spinner' /> : <FolderInput size={12} />}
                    {server.localPath ? 'Change' : 'Choose folder'}
                </button>
            </div>
            {pathBusy && (
                <p className='server-checking'>
                    <Loader2 size={12} className='spinner' />
                    {pathStep === 'choosing'
                        ? 'Waiting for you to choose a folder…'
                        : checkProgress && checkProgress.total > 0
                            ? `Checking the files in this folder (${formatCount(checkProgress.done)} of ${formatCount(checkProgress.total)})…`
                            : 'Looking through the folder…'}
                </p>
            )}
            {leaving && (
                <p className='server-checking leaving-line'>
                    <Loader2 size={12} className='spinner' />
                    {!isOwner
                        ? 'Leaving the server…'
                        : leaveProgress && leaveProgress.total > 0
                            ? `Deleting: handing the other members' files back to them (${formatCount(leaveProgress.done)} of ${formatCount(leaveProgress.total)})…`
                            : 'Deleting the server…'}
                </p>
            )}
            <PermissionsList server={server} />
        </div>
    );
}
