import './server-setup.css';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, Loader2, Search, TriangleAlert } from 'lucide-react';
import type { InstallableVersion, ServerKind } from '../../../shared/types';
import { invoke } from '../../api';
import { formatBytesPair } from '../../lib/format';
import { KINDS } from '../../lib/serverKinds';
import { useBackupStore } from '../../stores/backupStore';
import { useNoticeStore } from '../../stores/noticeStore';

const javaDownload = (major: number) => `https://adoptium.net/temurin/releases/?version=${major}`;

/** Whether this PC's Java can run the server. When it cannot, Java can be downloaded for the server (Eclipse Temurin,
 *  from Adoptium), or fetched by hand from Adoptium's site. */
export function JavaLine({ needed, found, serverId }: { needed: number | null; found: number | null; serverId: string }) {
    const [downloaded, setDownloaded] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const progress = useBackupStore((s) => (s.install?.serverId === serverId ? s.install : null));
    if (needed === null) return null;
    const have = downloaded ?? found;
    const ok = have !== null && have >= needed;

    async function download(major: number) {
        setBusy(true);
        const res = await invoke('installer:installJava', serverId, major);
        setBusy(false);
        if (res.ok) setDownloaded(res.value.major);
        else useNoticeStore.getState().error(res.error);
    }

    return (
        <div className={`setup-java ${ok ? 'ok' : 'missing'}`}>
            {ok ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}
            <span>
                This version needs Java {needed}.{' '}
                {downloaded !== null
                    ? `MCS-Relay downloaded Java ${downloaded} for this server.`
                    : found === null ? 'No Java was found on this PC.' : `This PC has Java ${found}.`}
                {!ok && (
                    <span className='setup-java-actions'>
                        <button className='text-button primary' disabled={busy} onClick={() => void download(needed)}>
                            {busy ? <Loader2 size={12} className='spinner' /> : <Download size={12} />}
                            {busy ? `Downloading Java ${needed}${progress && progress.total > 0 ? ` (${formatBytesPair(progress.done, progress.total)})` : '…'}` : `Download Java ${needed}`}
                        </button>
                        <button className='setup-link' onClick={() => void invoke('app:openExternal', javaDownload(needed))}>
                            or get it yourself <ExternalLink size={11} />
                        </button>
                    </span>
                )}
            </span>
        </div>
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
