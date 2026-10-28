import './modpack-link.css';
import { useEffect, useState } from 'react';
import { Boxes, ExternalLink } from 'lucide-react';
import type { ModpackInfo } from '../../../shared/types';
import { invoke } from '../../api';
import { kindName } from '../../lib/serverKinds';
import { useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';

/** The modpack the selected server was made from, so everyone installs the same one in their launcher: its Modrinth
 *  page, or the name of the server pack it came from. Read from the server's folder, so it shows once its files are on
 *  this PC. */
export default function ModpackLink() {
    const selectedId = useServersStore((s) => s.selectedId);
    const localPath = useServersStore((s) => s.servers.find((server) => server.id === s.selectedId)?.localPath ?? null);
    const phase = useSessionStore((s) => s.state.phase);
    const [info, setInfo] = useState<ModpackInfo | null>(null);

    // Read again when the server, its folder, or the session (which brings the files) changes.
    useEffect(() => {
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

    if (!info) return null;
    const loader = info.loader === 'fabric' || info.loader === 'forge' || info.loader === 'neoforge' ? kindName(info.loader) : info.loader;
    const about = [info.versionNumber, loader && info.minecraft ? `${loader} ${info.minecraft}` : null].filter(Boolean).join(' · ');
    return (
        <div className='modpack-link'>
            <Boxes size={16} />
            <span className='modpack-link-text'>
                <span className='modpack-link-kind'>Modpack</span>
                <b title={info.title}>{info.title}</b>
                {about && <small>{about}</small>}
            </span>
            {info.url
                ? (
                    <button title='Install this version in your launcher to join' onClick={() => void invoke('app:openExternal', info.url!)}>
                        Get it on Modrinth <ExternalLink size={12} />
                    </button>
                )
                : <small className='modpack-link-hint'>Install the same pack in your launcher to join.</small>}
        </div>
    );
}
