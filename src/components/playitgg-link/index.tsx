import './playitgg-link.css';
import { useState } from 'react';
import { Network } from 'lucide-react';
import { describeTunnel } from '../../lib/tunnels';
import { isMySession, livePresence } from '../../lib/sync';
import { useServersStore } from '../../stores/serversStore';
import { lockFor, useSessionStore } from '../../stores/sessionStore';
import Modal from '../modal';
import CopyButton from './copy-button';
import TunnelsList from './tunnels-list';

/** The address friends join with: from my session when I host, otherwise from the host's lock. Only the tunnel
 *  shown first is here; the button next to it lists all of them. */
export default function PlayitggLink() {
    const selectedId = useServersStore((s) => s.selectedId);
    const session = useSessionStore((s) => s.state);
    const lock = useSessionStore((s) => lockFor(s, selectedId));
    const [listOpen, setListOpen] = useState(false);
    const presence = livePresence(session, selectedId, lock);
    const link = presence?.address ?? '';
    const tunnels = presence?.tunnels ?? [];
    const mine = isMySession(session, selectedId);
    const host = mine ? null : lock && lock.state !== 'free' ? lock.lock.host.name : 'The host';
    const primary = tunnels.find((t) => t.address === link);
    // Hosting here without playit.gg: the address on this PC's network, for friends on the same Wi-Fi or LAN.
    const lan = mine && !link && session.phase === 'running' ? session.lanAddress : null;

    if (lan) {
        return (
            <div className='link-block'>
                <span className='link-wrapper'>
                    <span className='link-kind' title='Works for friends on the same Wi-Fi or network as this PC'>Same network</span>
                    <pre>{lan}</pre>
                    <CopyButton text={lan} />
                </span>
                <p className='link-hint'>
                    On this PC, join with <b>localhost</b>. For friends elsewhere, turn on playit.gg in Settings &gt; Server settings.
                </p>
            </div>
        );
    }
    if (!link) return null;
    return (
        <span className='link-wrapper'>
            <Modal
                isOpen={listOpen}
                onClose={() => setListOpen(false)}
                items={[{ title: 'playit.gg addresses', content: <TunnelsList tunnels={tunnels} primary={link} host={host} /> }]}
                width={480}
                height={420}
            />
            {primary && <span className='link-kind'>{describeTunnel(primary).name}</span>}
            <pre>{link}</pre>
            <CopyButton text={link} />
            {tunnels.length > 0 && (
                <button
                    className='tunnels-button'
                    title={tunnels.length > 1 ? `All ${tunnels.length} addresses, and what each one is for` : 'What this address is for'}
                    onClick={() => setListOpen(true)}
                >
                    <Network size={17} />
                    {tunnels.length > 1 && <span className='tunnels-count'>{tunnels.length}</span>}
                </button>
            )}
        </span>
    );
}
