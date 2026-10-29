import './modpack-link.css';
import { useEffect, useRef, useState } from 'react';
import { Boxes, ExternalLink } from 'lucide-react';
import type { ModpackInfo } from '../../../shared/types';
import { invoke } from '../../api';
import { kindName } from '../../lib/serverKinds';
import { useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';

/** The modpack the selected server was made from, so everyone installs the same one in their launcher: a small
 *  button beside the server picker that opens the pack's name, version and Modrinth page. Read from the server's
 *  folder, so it shows once its files are on this PC. */
export default function ModpackLink() {
    const selectedId = useServersStore((s) => s.selectedId);
    const localPath = useServersStore((s) => s.servers.find((server) => server.id === s.selectedId)?.localPath ?? null);
    const phase = useSessionStore((s) => s.state.phase);
    const [info, setInfo] = useState<ModpackInfo | null>(null);
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLSpanElement>(null);

    // Read again when the server, its folder, or the session (which brings the files) changes.
    useEffect(() => {
        setOpen(false);
        if (!selectedId || !localPath) {
            setInfo(null);
            return undefined;
        }
        let current = true;
        void invoke('modpacks:info', selectedId).then((res) => current && setInfo(res.ok ? res.value : null));
        return () => {
            current = false;
        };
    }, [selectedId, localPath, phase]);

    // A click anywhere else, or Escape, closes it.
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    if (!info) return null;
    const loader = info.loader === 'fabric' || info.loader === 'forge' || info.loader === 'neoforge' ? kindName(info.loader) : info.loader;
    const about = [info.versionNumber, loader && info.minecraft ? `${loader} ${info.minecraft}` : null].filter(Boolean).join(' · ');
    return (
        <span className='modpack-link' ref={ref}>
            <button
                className={`modpack-badge ${open ? 'open' : ''}`}
                title={`Modpack: ${info.title}`}
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <Boxes size={16} />
            </button>
            {open && (
                <div className='modpack-pop' role='dialog' aria-label='Modpack'>
                    <span className='modpack-pop-kind'>Modpack</span>
                    <b>{info.title}</b>
                    {about && <small>{about}</small>}
                    {info.url
                        ? (
                            <button className='text-button primary' onClick={() => void invoke('app:openExternal', info.url!)}>
                                Get it on Modrinth <ExternalLink size={12} />
                            </button>
                        )
                        : <p>Install the same pack in your launcher to join.</p>}
                </div>
            )}
        </span>
    );
}
