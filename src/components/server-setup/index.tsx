import './server-setup.css';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, Loader2, Search, TriangleAlert } from 'lucide-react';
import type { InstallableVersion, InstallResult, ServerFolderInfo, ServerKind } from '../../../shared/types';
import { invoke } from '../../api';
import { formatBytesPair } from '../../lib/format';
import { useBackupStore } from '../../stores/backupStore';
import { request } from '../../stores/request';

const KINDS: Array<{ kind: ServerKind; name: string; text: string }> = [
    { kind: 'vanilla', name: 'Vanilla', text: 'Minecraft as Mojang makes it' },
    { kind: 'paper', name: 'Paper', text: 'Runs faster, and runs plugins' },
    { kind: 'fabric', name: 'Fabric', text: 'Runs Fabric mods' },
];

const javaDownload = (major: number) => `https://adoptium.net/temurin/releases/?version=${major}`;

/** Whether this PC's Java can run the server, with a link to the right Java when it cannot. */
function JavaLine({ needed, found }: { needed: number | null; found: number | null }) {
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

/** Downloads a server program (vanilla, Paper or Fabric) from its official source into the server's folder. */
export default function ServerSetup({ serverId, serverName, onDone }: { serverId: string; serverName: string; onDone: () => void }) {
    const [kind, setKind] = useState<ServerKind>('vanilla');
    const [versions, setVersions] = useState<Record<string, InstallableVersion[] | 'error'>>({});
    const [query, setQuery] = useState('');
    const [unstable, setUnstable] = useState(false);
    const [picked, setPicked] = useState<string | null>(null);
    const [folder, setFolder] = useState<ServerFolderInfo | null>(null);
    const [installing, setInstalling] = useState(false);
    const [result, setResult] = useState<InstallResult | null>(null);
    const progress = useBackupStore((s) => (s.install?.serverId === serverId ? s.install : null));

    useEffect(() => {
        void invoke('installer:folder', serverId).then((res) => res.ok && setFolder(res.value));
    }, [serverId]);

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
    const choice = picked && shown.some((v) => v.id === picked) ? picked : latest && shown.some((v) => v.id === latest) ? latest : null;
    const kindName = KINDS.find((k) => k.kind === kind)?.name ?? '';

    async function install() {
        if (!choice) return;
        setInstalling(true);
        const res = await request('installer:install', serverId, kind, choice);
        setInstalling(false);
        if (res.ok) setResult(res.value);
    }

    if (result) {
        return (
            <div className='server-setup'>
                <p className='setup-done'>
                    <CheckCircle2 size={18} /> {kindName} {choice} is in the folder of {serverName} ({result.file}).
                </p>
                <JavaLine needed={result.javaNeeded} found={folder?.javaFound ?? null} />
                <p className='setup-lead'>
                    Press the power button to start it. The first start makes the world, and the first upload shares the
                    server with everyone in it.
                </p>
                <div className='setup-buttons'>
                    <button className='text-button primary' onClick={onDone}>Done</button>
                </div>
            </div>
        );
    }

    return (
        <div className='server-setup'>
            <p className='setup-lead'>
                Download a Minecraft server into the folder of {serverName}, straight from its official source.
            </p>
            {folder?.hasServer && (
                <p className='setup-java missing'>
                    <TriangleAlert size={14} /> <span>This folder already has a server program. Choose an empty folder for a new server.</span>
                </p>
            )}
            <div className='setup-kinds' role='radiogroup' aria-label='Server type'>
                {KINDS.map((k) => (
                    <button
                        key={k.kind}
                        role='radio'
                        aria-checked={kind === k.kind}
                        className={`setup-kind ${kind === k.kind ? 'selected' : ''}`}
                        disabled={installing}
                        onClick={() => {
                            setKind(k.kind);
                            setPicked(null);
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
                    <input type='text' placeholder='Search versions' value={query} onChange={(e) => setQuery(e.target.value)} disabled={installing} />
                </span>
                <label className='setup-check'>
                    <input type='checkbox' checked={unstable} onChange={(e) => setUnstable(e.target.checked)} disabled={installing} />
                    Test versions
                </label>
            </div>
            <ul className='setup-versions' aria-label='Versions'>
                {list === undefined && <li className='setup-note'><Loader2 size={13} className='spinner' /> Loading versions…</li>}
                {list === 'error' && <li className='setup-note'>The versions could not be loaded. Check your internet connection and open this again.</li>}
                {Array.isArray(list) && shown.length === 0 && <li className='setup-note'>No version matches.</li>}
                {shown.map((v) => (
                    <li key={v.id}>
                        <button className={`setup-version ${choice === v.id ? 'selected' : ''}`} disabled={installing} onClick={() => setPicked(v.id)}>
                            {v.id}
                            {v.id === latest && <span className='setup-tag'>Latest</span>}
                            {!v.stable && <span className='setup-tag test'>Test</span>}
                        </button>
                    </li>
                ))}
            </ul>
            {progress && (
                <div className='setup-progress'>
                    <span><Loader2 size={13} className='spinner' /> Downloading {kindName} {choice}…{progress.total > 0 && <small>{formatBytesPair(progress.done, progress.total)}</small>}</span>
                    <span className='setup-bar'><span style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 30}%` }} /></span>
                </div>
            )}
            <div className='setup-buttons'>
                <button className='text-button' onClick={onDone} disabled={installing}>Later</button>
                <button className='text-button primary' disabled={installing || !choice || folder?.hasServer === true} onClick={() => void install()}>
                    {installing ? <Loader2 size={13} className='spinner' /> : <Download size={13} />} Download {kindName} {choice ?? ''}
                </button>
            </div>
        </div>
    );
}
