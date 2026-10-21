import './directory-menu.css';
import { useRef, useState } from 'react';
import { CloudDownload, CloudSync, CloudUpload, EyeOff, FileDiff, FolderCog, FolderInput, FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ServerSummary } from '../../../shared/types';
import { useConfirm } from '../../hooks/useConfirm';
import { isSessionBusy, manualSyncBlockers } from '../../lib/sync';
import type { IModalItems } from '../../lib/ui-types';
import { request } from '../../stores/request';
import { chooseLocalPath } from '../../stores/serverActions';
import { reportFor, useSessionStore } from '../../stores/sessionStore';
import ChangesPanel from '../changes-panel';
import Modal from '../modal';
import SyncRules from '../sync-rules';

/** A round button next to the power button with a small menu that opens sideways, away from the power button.
 *  The menu stays open while the pointer is over the button or the menu. */
function SideMenu({ side, icon, title, disabled = false, children }: {
    side: 'left' | 'right'; icon: ReactNode; title: string; disabled?: boolean;
    children: (close: () => void) => ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    function cancelClose() {
        if (closeTimer.current) clearTimeout(closeTimer.current);
    }

    function scheduleClose() {
        closeTimer.current = setTimeout(() => setOpen(false), 500);
    }

    return (
        <div className={`side-menu-anchor ${side}`}>
            <button
                className={`side-button ${open ? 'open' : ''}`}
                title={title}
                disabled={disabled}
                onClick={() => setOpen((value) => !value)}
                onMouseEnter={cancelClose}
                onMouseLeave={scheduleClose}
            >
                {icon}
            </button>
            {open && !disabled && (
                <div className='side-menu' onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
                    {children(() => setOpen(false))}
                </div>
            )}
        </div>
    );
}

/** The folder menu at the bottom right of the power button. What it offers follows from my role on the server. */
export function DirectoryMenu({ server, canWrite }: { server: ServerSummary | null; canWrite: boolean }) {
    const [modalItems, setModalItems] = useState<IModalItems[] | null>(null);
    const busy = useSessionStore((s) => isSessionBusy(s.state.phase));

    if (!server) return null;
    return (
        <>
            <Modal isOpen={modalItems !== null} onClose={() => setModalItems(null)} width={480} height={400} items={modalItems ?? []} />
            <SideMenu side='right' icon={<FolderCog size={20} />} title='Server folder'>
                {(close) => {
                    const show = (items: IModalItems[]) => {
                        close();
                        setModalItems(items);
                    };
                    return (
                        <>
                            <button className='side-option' onClick={() => show([{ title: 'Changes', content: <ChangesPanel /> }])}>
                                <FileDiff size={15} /> Changes
                            </button>
                            {canWrite && (
                                <button className='side-option' onClick={() => show([{ title: 'Ignored files', content: <SyncRules serverId={server.id} /> }])}>
                                    <EyeOff size={15} /> Ignored files
                                </button>
                            )}
                            {!busy && (
                                <button className='side-option' onClick={() => { close(); void chooseLocalPath(server.id); }}>
                                    <FolderInput size={15} /> Choose folder
                                </button>
                            )}
                            {server.localPath && (
                                <button className='side-option' onClick={() => { close(); void request('servers:openFolder', server.id); }}>
                                    <FolderOpen size={15} /> Open folder
                                </button>
                            )}
                        </>
                    );
                }}
            </SideMenu>
        </>
    );
}

/** Downloading or uploading without starting the server, at the bottom left of the power button. Both reserve
 *  the server like a session does, so nobody else starts it meanwhile. */
export function TransferMenu({ server, canWrite }: { server: ServerSummary | null; canWrite: boolean }) {
    const { confirm, popup } = useConfirm();
    const busy = useSessionStore((s) => isSessionBusy(s.state.phase));
    const report = useSessionStore((s) => reportFor(s, server?.id ?? null));

    if (!server) return null;
    const reason = !canWrite
        ? 'Members who can only view a server cannot download or upload it'
        : !server.localPath ? 'Choose a folder for this server first' : busy ? 'Wait until the current session has finished' : null;
    const blockers = manualSyncBlockers(report);

    async function syncNow(direction: 'down' | 'up', close: () => void) {
        if (!server) return;
        close();
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

    return (
        <>
            {popup}
            <SideMenu side='left' icon={<CloudSync size={20} />} title={reason ?? 'Download or upload without starting the server'} disabled={reason !== null}>
                {(close) => (
                    <>
                        <span className='side-menu-title'>Sync without playing</span>
                        <button className='side-option' disabled={blockers.down !== null} onClick={() => void syncNow('down', close)}>
                            <CloudDownload size={15} />
                            <span className='side-option-text'>
                                Download latest
                                <small>{blockers.down ?? 'Get the newest version from the cloud'}</small>
                            </span>
                        </button>
                        <button className='side-option' disabled={blockers.up !== null} onClick={() => void syncNow('up', close)}>
                            <CloudUpload size={15} />
                            <span className='side-option-text'>
                                Upload my changes
                                <small>{blockers.up ?? 'Send what changed on this PC'}</small>
                            </span>
                        </button>
                    </>
                )}
            </SideMenu>
        </>
    );
}
