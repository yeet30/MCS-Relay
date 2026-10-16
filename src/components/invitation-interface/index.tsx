import './invitation-interface.css';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { useServersStore } from '../../stores/serversStore';

type Role = 'writer' | 'reader';

export default function InvitationInterface({ serverId, onDone }: { serverId: string; onDone: () => void }) {
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
        await useServersStore.getState().reload();
        onDone();
    }

    return (
        <div id='invitation-wrapper'>
            <form onSubmit={(e) => {
                e.preventDefault();
                void handleSend();
            }}
            >
                <div id='email-div' className='input-div'>
                    <label htmlFor='invitation-email'><h4 className='input-title'>User's Email Address</h4></label>
                    <input type='email' id='invitation-email' value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div id='role-div' className='input-div'>
                    <h4 className='input-title'>Role</h4>
                    <div className='radio-div'>
                        <input type='radio' name='user-role' id='radio-writer' className='user-role' value='writer'
                            checked={role === 'writer'} onChange={() => setRole('writer')} />
                        <label htmlFor='radio-writer' className='radio-label'>
                            Writer <span className='radio-description'>(can host the server)</span>
                        </label>
                    </div>
                    <div className='radio-div'>
                        <input type='radio' name='user-role' id='radio-reader' className='user-role' value='reader'
                            checked={role === 'reader'} onChange={() => setRole('reader')} />
                        <label htmlFor='radio-reader' className='radio-label'>
                            Reader <span className='radio-description'>(can see the server and who is playing)</span>
                        </label>
                    </div>
                </div>
                <div id='message-div' className='input-div'>
                    <label htmlFor='invitation-message'>
                        <h4 className='input-title'>Message </h4><span className='radio-description'>(optional)</span>
                    </label>
                    <textarea id='invitation-message' rows={1} value={message} onChange={(e) => setMessage(e.target.value)} />
                </div>
                <div id='email-buttons'>
                    <button type='button' onClick={onDone}>Cancel</button>
                    <button type='submit' disabled={sending || email.trim() === ''}>
                        {sending && <Loader2 size={12} className='spinner' />} Send
                    </button>
                </div>
            </form>
        </div>
    );
}
