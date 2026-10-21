import './join-server.css';
import { useState } from 'react';
import { Link, Loader2, LogIn } from 'lucide-react';
import type { ConfirmFn } from '../../stores/serverActions';
import { joinServer } from '../../stores/serverActions';

/** Joins a server from the folder ID or Drive link in the invitation email. */
export default function JoinServer({ confirm, onJoined }: { confirm: ConfirmFn; onJoined?: () => void }) {
    const [idOrLink, setIdOrLink] = useState('');
    const [joining, setJoining] = useState(false);

    async function handleJoin() {
        setJoining(true);
        const joined = await joinServer(idOrLink, confirm);
        setJoining(false);
        if (!joined) return;
        setIdOrLink('');
        onJoined?.();
    }

    return (
        <div className='join-card'>
            <span className='join-title'><LogIn size={15} /> Join a server</span>
            <p className='join-hint'>Paste the link (or folder ID) from the invitation email Google Drive sent you.</p>
            <div className='join-row'>
                <span className='join-input'>
                    <Link size={14} />
                    <input
                        type='text'
                        placeholder='https://drive.google.com/drive/folders/…'
                        value={idOrLink}
                        onChange={(e) => setIdOrLink(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && idOrLink.trim()) void handleJoin();
                        }}
                    />
                </span>
                <button className='text-button primary' disabled={joining || idOrLink.trim() === ''} onClick={handleJoin}>
                    {joining && <Loader2 size={12} className='spinner' />}
                    Join
                </button>
            </div>
        </div>
    );
}
