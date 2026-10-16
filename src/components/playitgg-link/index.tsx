import './playitgg-link.css';
import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { livePresence } from '../../lib/sync';
import { useServersStore } from '../../stores/serversStore';
import { lockFor, useSessionStore } from '../../stores/sessionStore';

/** The address friends join with: from my session when I host, otherwise from the host's lock. */
export default function PlayitggLink() {
    const selectedId = useServersStore((s) => s.selectedId);
    const session = useSessionStore((s) => s.state);
    const lock = useSessionStore((s) => lockFor(s, selectedId));
    const [copied, setCopied] = useState(false);
    const link = livePresence(session, selectedId, lock)?.address ?? '';

    useEffect(() => {
        if (!copied) return undefined;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }

    if (!link) return null;
    return (
        <span className='link-wrapper'>
            <pre>{link}</pre>
            <button onClick={handleCopy} style={{ color: copied ? '#4caf50' : '#ccc' }} title='Copy to clipboard'>
                {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
        </span>
    );
}
