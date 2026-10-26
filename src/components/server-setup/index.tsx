import './server-setup.css';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, Search, TriangleAlert } from 'lucide-react';
import type { InstallableVersion, ServerKind } from '../../../shared/types';
import { invoke } from '../../api';
import { KINDS } from '../../lib/serverKinds';

const javaDownload = (major: number) => `https://adoptium.net/temurin/releases/?version=${major}`;

/** Whether this PC's Java can run the server, with a link to the right Java when it cannot. */
export function JavaLine({ needed, found }: { needed: number | null; found: number | null }) {
    if (needed === null) return null;
    const ok = found !== null && found >= needed;
    return (
        <p className={`setup-java ${ok ? 'ok' : 'missing'}`}>
            {ok ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}
            <span>
                This version needs Java {needed}.{' '}
                {found === null ? 'No Java was found on this PC.' : `This PC has Java ${found}.`}
                {!ok && (
                    <button className='setup-link' onClick={() => void invoke('app:openExternal', javaDownload(needed))}>
                        Get Java {needed} <ExternalLink size={11} />
                    </button>
                )}
            </span>
        </p>
    );
}

/** Vanilla, Paper or Fabric, and a version of it: a searchable list, newest first, with the latest stable version
 *  chosen until another is picked. `onChange` hears the version actually chosen (null while none can be). */
export default function VersionPicker({ kind, version, onKind, onVersion }: {
    kind: ServerKind; version: string | null; onKind: (kind: ServerKind) => void; onVersion: (version: string | null) => void;
}) {
    const [versions, setVersions] = useState<Record<string, InstallableVersion[] | 'error'>>({});
    const [query, setQuery] = useState('');
    const [unstable, setUnstable] = useState(false);

    useEffect(() => {
        if (versions[kind]) return;
        void invoke('installer:versions', kind).then((res) => setVersions((v) => ({ ...v, [kind]: res.ok ? res.value : 'error' })));
    }, [kind, versions]);

    const list = versions[kind];
    const shown = useMemo(() => {
        if (!Array.isArray(list)) return [];
        const q = query.trim().toLowerCase();
        return list.filter((v) => (unstable || v.stable) && (!q || v.id.toLowerCase().includes(q)));
    }, [list, query, unstable]);
    const latest = Array.isArray(list) ? list.find((v) => v.stable)?.id ?? null : null;

    // Until something else is picked, the latest stable version is the choice.
    useEffect(() => {
        if (!Array.isArray(list)) {
            if (version !== null) onVersion(null);
            return;
        }
        if (version && list.some((v) => v.id === version)) return;
        onVersion(latest);
    }, [list, latest, version, onVersion]);

    return (
        <div className='version-picker'>
            <div className='setup-kinds' role='radiogroup' aria-label='Server type'>
                {KINDS.map((k) => (
                    <button
                        key={k.kind}
                        role='radio'
                        aria-checked={kind === k.kind}
                        className={`setup-kind ${kind === k.kind ? 'selected' : ''}`}
                        onClick={() => {
                            if (k.kind === kind) return;
                            onKind(k.kind);
                            onVersion(null);
                        }}
                    >
                        <b>{k.name}</b>
                        <small>{k.text}</small>
                    </button>
                ))}
            </div>
            <div className='setup-tools'>
                <span className='setup-search'>
                    <Search size={13} />
                    <input type='text' placeholder='Search versions' value={query} onChange={(e) => setQuery(e.target.value)} />
                </span>
                <label className='setup-check'>
                    <input type='checkbox' checked={unstable} onChange={(e) => setUnstable(e.target.checked)} />
                    Test versions
                </label>
            </div>
            <ul className='setup-versions' aria-label='Versions'>
                {list === undefined && <li className='setup-note'><Loader2 size={13} className='spinner' /> Loading versions…</li>}
                {list === 'error' && <li className='setup-note'>The versions could not be loaded. Check your internet connection and try again.</li>}
                {Array.isArray(list) && shown.length === 0 && <li className='setup-note'>No version matches.</li>}
                {shown.map((v) => (
                    <li key={v.id}>
                        <button className={`setup-version ${version === v.id ? 'selected' : ''}`} onClick={() => onVersion(v.id)}>
                            {v.id}
                            {v.id === latest && <span className='setup-tag'>Latest</span>}
                            {!v.stable && <span className='setup-tag test'>Test</span>}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}
