import './invitation-interface.css';
import { useState } from 'react';
import { Eye, Gamepad2, Loader2, Mail, Send, ShieldAlert } from 'lucide-react';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { useServersStore } from '../../stores/serversStore';

type Role = 'writer' | 'reader';

const ROLES: Array<{ role: Role; icon: typeof Gamepad2; title: string; text: string }> = [
    { role: 'writer', icon: Gamepad2, title: 'Can play', text: 'Starts and hosts the server, like you' },
    { role: 'reader', icon: Eye, title: 'Can view', text: 'Sees the server and who is playing' },
];

/** Shares the server folder with someone: Google Drive emails them a link, which they paste into "Join a server". */
export default function InvitationInterface({ serverId, serverName, onDone }: { serverId: string; serverName: string; onDone: () => void }) {
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<Role>('writer');
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);

    async function handleSend() {
        setSending(true);
        const res = await request('servers:invite', serverId, email.trim(), role, message);
        setSending(false);
        if (!res.ok) return;
        useNoticeStore.getState().success(`Invitation sent to ${email.trim()}.`);
        useServersStore.getState().putMember(serverId, res.value);
        onDone();
    }

    return (
        <form
            className='invite-form'
            onSubmit={(e) => {
                e.preventDefault();
                void handleSend();
            }}
        >
            <label className='field'>
                <span className='field-label'>Their Google account</span>
                <span className='input-with-icon'>
                    <Mail size={15} />
                    <input type='email' placeholder='friend@gmail.com' value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
                </span>
            </label>
            <div className='field'>
                <span className='field-label'>What they can do in {serverName}</span>
                <div className='role-options'>
                    {ROLES.map(({ role: value, icon: Icon, title, text }) => (
                        <label key={value} className={`role-option ${role === value ? 'selected' : ''}`}>
                            <input type='radio' name='invite-role' value={value} checked={role === value} onChange={() => setRole(value)} />
                            <Icon size={18} />
                            <span>
                                <b>{title}</b>
                                <small>{text}</small>
                            </span>
                        </label>
                    ))}
                </div>
            </div>
            <label className='field'>
                <span className='field-label'>Message <small>(optional)</small></span>
                <textarea rows={2} placeholder='Come build with us!' value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <p className='invite-note'>Google Drive emails them a link. They paste it into "Join a server" in MCS-Relay.</p>
            <p className='invite-note warning'>
                <ShieldAlert size={13} aria-hidden />
                Invite only people you trust: what they upload runs on the host&apos;s PC.
            </p>
            <div className='form-buttons'>
                <button type='button' className='text-button' onClick={onDone}>Cancel</button>
                <button type='submit' className='text-button primary' disabled={sending || email.trim() === ''}>
                    {sending ? <Loader2 size={13} className='spinner' /> : <Send size={13} />} Send invitation
                </button>
            </div>
        </form>
    );
}
