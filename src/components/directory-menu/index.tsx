import './directory-menu.css';
import { useRef, useState } from 'react';
import { CloudDownload, CloudUpload, FolderCog, FolderOpen } from 'lucide-react';
import type { ServerSummary } from '../../../shared/types';
import { useConfirm } from '../../hooks/useConfirm';
import { isSessionBusy } from '../../lib/sync';
import type { IModalItems } from '../../lib/ui-types';
import { request } from '../../stores/request';
import { chooseLocalPath } from '../../stores/serverActions';
import { useSessionStore } from '../../stores/sessionStore';
import ChangesPanel from '../changes-panel';
import Modal from '../modal';
import SyncRules from '../sync-rules';

/** The folder menu next to the power button. What it offers follows from my role on the server. */
export function DirectoryMenu({ server, canWrite }: { server: ServerSummary | null; canWrite: boolean }) {
    const [open, setOpen] = useState(false);
    const { confirm, popup } = useConfirm();
    const [modalItems, setModalItems] = useState<IModalItems[] | null>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const busy = useSessionStore((s) => isSessionBusy(s.state.phase));

    function cancelClose() {
        if (closeTimer.current) clearTimeout(closeTimer.current);
    }

    function scheduleClose() {
        closeTimer.current = setTimeout(() => setOpen(false), 500);
    }

    function show(items: IModalItems[]) {
        setOpen(false);
        setModalItems(items);
    }

    /** Syncing without playing, under the lock: the old Download and Upload buttons, made safe. */
    async function syncNow(direction: 'down' | 'up') {
        if (!server) return;
        setOpen(false);
        const accepted = await confirm(direction === 'down'
            ? {
                message: `Download the latest version of "${server.name}" into its folder on this PC?\n\nThe server is reserved for you while the files download, and nothing is started.`,
                confirmText: 'Download', cancelText: 'Cancel',
            }
            : {
                message: `Upload the changes in this PC's folder of "${server.name}" to the cloud?\n\nThe server is reserved for you while the files upload, and nothing is started.`,
                confirmText: 'Upload', cancelText: 'Cancel',
            });
        if (accepted) void request('session:syncNow', server.id, direction);
    }

    if (!server) return null;
    return (
        <div className='directory-menu-wrapper'>
            {popup}
            <Modal isOpen={modalItems !== null} onClose={() => setModalItems(null)} width={480} height={400} items={modalItems ?? []} />
            <button
                className={`folder-cog ${open ? 'open' : 'closed'}`}
                title='Server folder'
                onClick={() => setOpen((value) => !value)}
                onMouseEnter={cancelClose}
                onMouseLeave={scheduleClose}
            >
                <FolderCog />
            </button>
            {open && (
                <div className='directory-options' onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
                    <div className='dir-option' onClick={() => show([{ title: 'Changes', content: <ChangesPanel /> }])}>
                        Changes
                    </div>
                    {canWrite && !busy && server.localPath && (
                        <>
                            <div className='dir-option' onClick={() => void syncNow('down')}>
                                Download latest <CloudDownload className='folder-open' size={16} />
                            </div>
                            <div className='dir-option' onClick={() => void syncNow('up')}>
                                Upload my changes <CloudUpload className='folder-open' size={16} />
                            </div>
                        </>
                    )}
                    {canWrite && (
                        <div className='dir-option' onClick={() => show([{ title: 'Ignored files', content: <SyncRules serverId={server.id} /> }])}>
                            Ignored files
                        </div>
                    )}
                    {!busy && (
                        <div className='dir-option' onClick={() => { setOpen(false); void chooseLocalPath(server.id); }}>
                            Choose folder
                        </div>
                    )}
                    {server.localPath && (
                        <div className='dir-option' onClick={() => { setOpen(false); void request('servers:openFolder', server.id); }}>
                            Directory <FolderOpen className='folder-open' size={16} />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
