import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Copies `text`; the icon turns into a tick for a moment. */
export default function CopyButton({ text, size = 18 }: { text: string; size?: number }) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return undefined;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }

    return (
        <button className='copy-button' onClick={handleCopy} style={{ color: copied ? 'var(--good)' : 'var(--muted)' }} title='Copy to clipboard'>
            {copied ? <Check size={size} /> : <Copy size={size} />}
        </button>
    );
}
