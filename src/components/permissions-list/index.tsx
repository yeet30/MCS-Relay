import './permissions-list.css';
import { useState } from 'react';
import { ChevronsDown, ChevronsLeft, Trash2 } from 'lucide-react';
import type { ServerMember, ServerSummary } from '../../../shared/types';
import { useConfirm } from '../../hooks/useConfirm';
import { useAuthStore } from '../../stores/authStore';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { useServersStore } from '../../stores/serversStore';
import InvitationInterface from '../invitation-interface';
import Modal from '../modal';

const ROLE_WORDS: Record<ServerMember['role'], string> = {
    owner: 'owner', writer: 'can play', reader: 'can view', commenter: 'can view', organizer: 'manager', fileOrganizer: 'manager',
};

export default function PermissionsList({ server }: { server: ServerSummary }) {
    const myEmail = useAuthStore((s) => s.user?.email ?? null);
    const { confirm, popup } = useConfirm();
    const [isListOpen, setIsListOpen] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);
    const isOwner = server.myRole === 'owner';

    async function handleRemove(member: ServerMember) {
        const accepted = await confirm({
            message: `Remove ${member.name || member.email} from "${server.name}"? Files they uploaded stay in the server.`,
            confirmText: 'Remove',
            cancelText: 'Cancel',
        });
        if (!accepted) return;
        setRemoving(member.permissionId);
        const res = await request('servers:removeMember', server.id, member.permissionId);
        setRemoving(null);
        if (!res.ok) return;
        useNoticeStore.getState().success(`${member.name || member.email} was removed.`);
        await useServersStore.getState().reload();
    }

    return (
        <div className='permission-list-wrapper'>
            {popup}
            <Modal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                width={450}
                height={350}
                items={[{ title: 'Invite User', content: <InvitationInterface serverId={server.id} onDone={() => setIsModalOpen(false)} /> }]}
            />
            <div id='permissions-dropdown'>
                <button id='permissions-button' className={isListOpen ? 'open' : ''} onClick={() => setIsListOpen(!isListOpen)}>
                    <span id='permissions-title' className={isListOpen ? 'open' : ''}>Members</span>
                    <span id='permissions-chevrons'>{isListOpen ? <ChevronsDown size={18} /> : <ChevronsLeft size={18} />}</span>
                </button>
                <div id='permissions-drawer' className={isListOpen ? 'open' : ''}>
                    <span id='members-titles'>
                        <span>Username</span>
                        <span>Role</span>
                    </span>
                    {server.members.map((member) => (
                        <span id='members-item' key={member.permissionId}>
                            <span id='member-span'>
                                <span id='member-username' title={member.email}>{member.name || member.email}</span>
                                <span id='member-role'>({ROLE_WORDS[member.role]})</span>
                                <span id='member-remove'>
                                    {isOwner && member.email !== myEmail && member.role !== 'owner' && (
                                        <button id='remove-button' title='Remove' disabled={removing === member.permissionId} onClick={() => handleRemove(member)}>
                                            <Trash2 size={16} />
                                        </button>
                                    )}
                                </span>
                            </span>
                        </span>
                    ))}
                    {isOwner && <span id='invite-member'><button onClick={() => setIsModalOpen(true)}>Invite Member</button></span>}
                </div>
            </div>
        </div>
    );
}
