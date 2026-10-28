import './modpack-browser.css';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileArchive, Loader2, Package, Search, TriangleAlert, X } from 'lucide-react';
import type { ModpackHit, ModpackVersion, ModpackZip } from '../../../shared/types';
import { invoke } from '../../api';
import { formatBytes } from '../../lib/format';
import { kindName } from '../../lib/serverKinds';

/** The pack a new server is made from: a Modrinth pack at one of its versions, or a server pack zip from this PC. */
export type PackChoice =
    | { kind: 'modrinth'; hit: ModpackHit; version: ModpackVersion }
    | { kind: 'zip'; path: string };

const SEARCH_DELAY_MS = 300;

/** "1.2M", "45.3K", "812". */
function shortCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(n);
}

const loaderName = (loader: string) => (loader === 'fabric' || loader === 'forge' || loader === 'neoforge' ? kindName(loader) : loader);
const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;

/** CurseForge's own modpack search, in the browser (its API needs a key MCS-Relay does not have yet): the user
 *  downloads the pack's server pack there and uses its zip here. */
function searchCurseForge(query: string) {
    const params = new URLSearchParams({ page: '1', pageSize: '20', sortBy: 'relevancy', class: 'modpacks' });
    if (query) params.set('search', query);
    void invoke('app:openExternal', `https://www.curseforge.com/minecraft/search?${params}`);
}

/** Modrinth's modpacks that run on a server (most downloaded first, or matching the search), and a way to use a
 *  server pack zip instead (CurseForge's: its own API needs a key MCS-Relay may not share). */
export default function ModpackBrowser({ value, onChange }: { value: PackChoice | null; onChange: (choice: PackChoice | null) => void }) {
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState<ModpackHit[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState<string | null>(value?.kind === 'modrinth' ? value.hit.id : null);
    const [versions, setVersions] = useState<Record<string, ModpackVersion[] | 'error'>>({});
    const [clientPack, setClientPack] = useState<ModpackZip['clientPack']>(null);
    const asked = useRef(0);

    async function load(q: string, offset: number) {
        const ask = ++asked.current;
        setLoading(true);
        setError(null);
        const res = await invoke('modpacks:search', q, offset);
        if (ask !== asked.current) return;
        setLoading(false);
        if (!res.ok) {
            setError(res.error.message);
            return;
        }
        setTotal(res.value.total);
        setHits((list) => (offset === 0 ? res.value.hits : [...list, ...res.value.hits]));
    }

    useEffect(() => {
        const timer = setTimeout(() => void load(query.trim(), 0), query ? SEARCH_DELAY_MS : 0);
        return () => clearTimeout(timer);
    }, [query]);

    // A pack's versions load when it is opened; its newest release (else its newest version) is chosen.
    async function choose(hit: ModpackHit) {
        setOpen(hit.id);
        setClientPack(null);
        let list = versions[hit.id];
        if (!list || list === 'error') {
            const res = await invoke('modpacks:versions', hit.id);
            list = res.ok ? res.value : 'error';
            setVersions((v) => ({ ...v, [hit.id]: list as ModpackVersion[] | 'error' }));
        }
        if (Array.isArray(list) && list.length > 0) onChange({ kind: 'modrinth', hit, version: list.find((v) => v.type === 'release') ?? list[0] });
        else onChange(null);
    }

    // CurseForge's pack for players is not taken: the user is sent for its Server Files instead.
    async function pickZip() {
        const res = await invoke('modpacks:pickZip');
        if (!res.ok) {
            setError(res.error.message);
            return;
        }
        if (!res.value) return;
        setOpen(null);
        if (res.value.clientPack) {
            setClientPack(res.value.clientPack);
            onChange(null);
        } else {
            setClientPack(null);
            onChange({ kind: 'zip', path: res.value.path });
        }
    }

    return (
        <div className='modpack-browser'>
            <span className='setup-search'>
                <Search size={13} />
                <input type='text' autoFocus placeholder='Search Modrinth modpacks' value={query} onChange={(e) => setQuery(e.target.value)} />
                {loading && <Loader2 size={13} className='spinner' />}
            </span>
            <ul className='modpack-list' aria-label='Modpacks'>
                {error && <li className='setup-note'>{error}</li>}
                {!error && !loading && hits.length === 0 && (
                    <li className='setup-note'>
                        No Modrinth modpack matches.
                        <button className='setup-link' onClick={() => searchCurseForge(query.trim())}>
                            Search CurseForge <ExternalLink size={11} />
                        </button>
                    </li>
                )}
                {hits.map((hit) => {
                    const selected = value?.kind === 'modrinth' && value.hit.id === hit.id;
                    const list = versions[hit.id];
                    const newest = hit.gameVersions[hit.gameVersions.length - 1];
                    return (
                        <li key={hit.id} className={`modpack-card ${selected ? 'selected' : ''}`}>
                            <button className='modpack-main' onClick={() => void choose(hit)} aria-pressed={selected}>
                                {hit.iconUrl ? <img src={hit.iconUrl} alt='' loading='lazy' /> : <span className='modpack-icon'><Package size={20} /></span>}
                                <span className='modpack-text'>
                                    <b>{hit.title}</b>
                                    <small className='modpack-by'>by {hit.author} · {shortCount(hit.downloads)} downloads</small>
                                    <small className='modpack-desc'>{hit.description}</small>
                                    <span className='modpack-tags'>
                                        {hit.loaders.map((l) => <span key={l}>{loaderName(l)}</span>)}
                                        {newest && <span>{hit.gameVersions.length > 1 ? `up to ${newest}` : newest}</span>}
                                    </span>
                                </span>
                            </button>
                            {open === hit.id && (
                                <div className='modpack-version'>
                                    {list === undefined && <span className='setup-note'><Loader2 size={13} className='spinner' /> Loading its versions…</span>}
                                    {list === 'error' && <span className='setup-note'>Its versions could not be loaded. Try again.</span>}
                                    {Array.isArray(list) && list.length === 0 && (
                                        <span className='setup-note'>This pack has no version MCS-Relay can set up (Quilt packs are not supported yet).</span>
                                    )}
                                    {Array.isArray(list) && list.length > 0 && (
                                        <label>
                                            Version
                                            <select
                                                value={value?.kind === 'modrinth' && value.hit.id === hit.id ? value.version.id : ''}
                                                onChange={(e) => {
                                                    const version = list.find((v) => v.id === e.target.value);
                                                    if (version) onChange({ kind: 'modrinth', hit, version });
                                                }}
                                            >
                                                {list.map((v) => (
                                                    <option key={v.id} value={v.id}>
                                                        {v.versionNumber} · {v.loaders.map(loaderName).join(', ')} {v.gameVersions.join(', ')}
                                                        {v.type !== 'release' ? ` (${v.type})` : ''} · {formatBytes(v.size)}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                    )}
                                    <button className='setup-link' onClick={() => void invoke('app:openExternal', `https://modrinth.com/modpack/${hit.slug}`)}>
                                        View on Modrinth <ExternalLink size={11} />
                                    </button>
                                </div>
                            )}
                        </li>
                    );
                })}
                {hits.length > 0 && hits.length < total && (
                    <li className='modpack-more'>
                        <button className='text-button' disabled={loading} onClick={() => void load(query.trim(), hits.length)}>Show more</button>
                    </li>
                )}
            </ul>
            <div className={`modpack-zip ${value?.kind === 'zip' ? 'selected' : clientPack ? 'warning' : ''}`}>
                {clientPack ? <TriangleAlert size={15} /> : <FileArchive size={15} />}
                {clientPack && value?.kind !== 'zip'
                    ? (
                        <>
                            <span className='modpack-zip-text' title={`${clientPack.name} only lists its ${clientPack.mods} mods.`}>
                                That zip is <b>{clientPack.name}{clientPack.version ? ` ${clientPack.version}` : ''}</b> for players. Get its <b>Server Files</b> instead.
                            </span>
                            <button className='setup-link' onClick={() => searchCurseForge(clientPack.name)}>
                                Find it on CurseForge <ExternalLink size={11} />
                            </button>
                            <button className='setup-link' onClick={() => void pickZip()}>Choose another</button>
                        </>
                    )
                    : value?.kind === 'zip'
                    ? (
                        <>
                            <span className='modpack-zip-text' title={value.path}>Server pack: <b>{fileName(value.path)}</b></span>
                            <button className='setup-link' onClick={() => void pickZip()}>Change</button>
                            <button className='modpack-zip-clear' title='Use a Modrinth pack instead' onClick={() => onChange(null)}><X size={13} /></button>
                        </>
                    )
                    : (
                        <>
                            <span className='modpack-zip-text'>Not on Modrinth? Get its Server Files from CurseForge.</span>
                            <button className='setup-link' onClick={() => searchCurseForge(query.trim())}>
                                Search CurseForge <ExternalLink size={11} />
                            </button>
                            <button className='setup-link' onClick={() => void pickZip()}>Use its zip</button>
                        </>
                    )}
            </div>
        </div>
    );
}
