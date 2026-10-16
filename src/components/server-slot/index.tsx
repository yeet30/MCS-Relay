import './server-slot.css';
import { useEffect, useRef, useState } from 'react';
import { Loader2, LogOut, Pencil, Save, Trash2 } from 'lucide-react';
import type { ServerSummary } from '../../../shared/types';
import { useConfirm } from '../../hooks/useConfirm';
import { isMySession } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { chooseLocalPath } from '../../stores/serverActions';
import { useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import PermissionsList from '../permissions-list';

const MAX_NAME = 60;

/** One server in Settings > Drive Folders. Downloading and uploading happen only through a session (F10). */
export default function ServerSlot({ server }: { server: ServerSummary }) {
    const { confirm, popup } = useConfirm();
    const inUse = useSessionStore((s) => isMySession(s.state, server.id) && s.state.phase !== 'failed');
    const isOwner = server.myRole === 'owner';
    const inputRef = useRef<HTMLInputElement>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [nameBuffer, setNameBuffer] = useState(server.name);
    const [loading, setLoading] = useState<'edit' | 'delete' | 'path' | null>(null);

    useEffect(() => {
        if (!isEditing) setNameBuffer(server.name);
    }, [server.name, isEditing]);

    async function handleSave() {
        const name = nameBuffer.trim();
        if (name && name !== server.name) {
            setLoading('edit');
            const res = await request('servers:rename', server.id, name);
            if (res.ok) await useServersStore.getState().reload();
            else setNameBuffer(server.name);
            setLoading(null);
        }
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
                message: `Leave "${server.name}"? You lose access to the shared folder. Your local copy stays on this PC.`,
                confirmText: 'Leave',
                cancelText: 'Stay',
            });
        if (!accepted) return;
        setLoading('delete');
        const res = isOwner ? await request('servers:delete', server.id) : await request('servers:leave', server.id);
        setLoading(null);
        if (!res.ok) return;
        useNoticeStore.getState().success(isOwner ? `"${server.name}" was deleted.` : `You left "${server.name}".`);
        await useServersStore.getState().reload();
    }

    async function handlePath() {
        setLoading('path');
        await chooseLocalPath(server.id);
        setLoading(null);
    }

    return (
        <div className='server-slot'>
            {popup}
            <span className='first-row'>
                <span className='list-text'>
                    <input
                        type='text'
                        ref={inputRef}
                        className='name-input'
                        value={nameBuffer}
                        readOnly={!isEditing}
                        maxLength={MAX_NAME}
                        onChange={(e) => setNameBuffer(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSave();
                            if (e.key === 'Escape') setIsEditing(false);
                        }}
                        style={{ width: `${Math.max(nameBuffer.length, 4)}ch` }}
                    />
                    {isOwner && (isEditing
                        ? (
                            <button className='edit-button' title='Save the name' onClick={handleSave} disabled={loading === 'edit'}>
                                {loading === 'edit' ? <Loader2 size={12} className='spinner' /> : <Save size={12} />}
                            </button>
                        )
                        : (
                            <button
                                className='edit-button'
                                title='Rename'
                                onClick={() => {
                                    setIsEditing(true);
                                    setTimeout(() => inputRef.current?.focus(), 0);
                                }}
                            >
                                <Pencil size={12} />
                            </button>
                        ))}
                </span>
                <span className='button-span'>
                    <button
                        className='list-button'
                        title={inUse ? 'Stop the session first' : isOwner ? 'Delete this server' : 'Leave this server'}
                        style={{ backgroundColor: 'rgb(50, 0, 0)' }}
                        disabled={loading === 'delete' || inUse}
                        onClick={handleDelete}
                    >
                        {loading === 'delete' && <Loader2 size={12} className='spinner' />}
                        {isOwner ? <Trash2 size={16} /> : <LogOut size={16} />}
                    </button>
                </span>
            </span>
            <span className='second-row'>
                {server.localPath ?? 'No folder on this PC yet'}
                <button
                    className='list-button'
                    disabled={loading === 'path' || inUse}
                    title={inUse ? 'The folder cannot change during a session' : 'Choose the folder on this PC'}
                    style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
                    onClick={handlePath}
                >
                    {loading === 'path' && <Loader2 size={12} className='spinner' />}
                    Path <Pencil size={12} style={{ borderBottom: 'solid', borderWidth: '1px' }} />
                </button>
            </span>
            <span className='third-row'>
                <PermissionsList server={server} />
            </span>
        </div>
    );
}
