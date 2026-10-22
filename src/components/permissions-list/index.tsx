import './permissions-list.css';
import { useState } from 'react';
import { ChevronDown, Loader2, Trash2, UserPlus, Users } from 'lucide-react';
import type { ServerMember, ServerSummary } from '../../../shared/types';
import { useConfirm } from '../../hooks/useConfirm';
import { useAuthStore } from '../../stores/authStore';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { useServersStore } from '../../stores/serversStore';
import InvitationInterface from '../invitation-interface';
import Modal from '../modal';

const ROLE_WORDS: Record<ServerMember['role'], string> = {
    owner: 'Owner', writer: 'Can play', reader: 'Can view', commenter: 'Can view', organizer: 'Manager', fileOrganizer: 'Manager',
};

/** A steady colour per person, so the same member looks the same in every server. */
function avatarHue(email: string): number {
    let hash = 0;
    for (const char of email.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % 360;
}

/** The members of a server, folded away under a "Members" row; the owner can invite and remove. */
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
        useServersStore.getState().dropMember(server.id, member.permissionId);
    }

    return (
        <div className='members'>
            {popup}
            <Modal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                width={460}
                height={420}
                items={[{ title: 'Invite someone', content: <InvitationInterface serverId={server.id} serverName={server.name} onDone={() => setIsModalOpen(false)} /> }]}
            />
            <button className={`members-toggle ${isListOpen ? 'open' : ''}`} onClick={() => setIsListOpen(!isListOpen)}>
                <Users size={14} />
                <span>Members</span>
                <span className='members-count'>{server.members.length}</span>
                <ChevronDown size={15} className='members-chevron' />
            </button>
            {isListOpen && (
                <ul className='member-list'>
                    {server.members.map((member) => {
                        const name = member.name || member.email;
                        const removable = isOwner && member.email !== myEmail && member.role !== 'owner';
                        return (
                            <li className='member-row' key={member.permissionId}>
                                <span className='member-avatar' style={{ background: `hsl(${avatarHue(member.email)} 32% 30%)` }} aria-hidden>
                                    {name.charAt(0).toUpperCase()}
                                </span>
                                <span className='member-name' title={member.email}>
                                    {name}
                                    {member.name && <small>{member.email}</small>}
                                </span>
                                <span className={`member-role ${member.role}`}>{ROLE_WORDS[member.role]}</span>
                                {removable
                                    ? (
                                        <button
                                            className='icon-button danger'
                                            title={`Remove ${name}`}
                                            disabled={removing === member.permissionId}
                                            onClick={() => handleRemove(member)}
                                        >
                                            {removing === member.permissionId ? <Loader2 size={14} className='spinner' /> : <Trash2 size={14} />}
                                        </button>
                                    )
                                    : <span className='member-spacer' />}
                            </li>
                        );
                    })}
                    {isOwner && (
                        <li className='member-invite'>
                            <button className='text-button primary' onClick={() => setIsModalOpen(true)}>
                                <UserPlus size={13} /> Invite someone
                            </button>
                        </li>
                    )}
                </ul>
            )}
        </div>
    );
}
