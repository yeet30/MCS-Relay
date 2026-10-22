import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PlayitTunnel } from '../../../shared/types';
import { describeTunnel } from '../../lib/tunnels';
import { request } from '../../stores/request';
import CopyButton from './copy-button';

/** Every tunnel the host's playit.gg shares: what each is for, a copy button, and (for the host) which one is shown
 *  first under the server picker. The others read the same list from the lock. */
export default function TunnelsList({ tunnels, primary, host }: {
    tunnels: PlayitTunnel[];
    primary: string | null;
    /** null: I am the host and may choose. */
    host: string | null;
}) {
    const [choosing, setChoosing] = useState<string | null>(null);

    async function choose(address: string) {
        setChoosing(address);
        await request('session:setPrimaryTunnel', address);
        setChoosing(null);
    }

    return (
        <div className='tunnels-list'>
            <p className='tunnels-intro'>
                {host === null
                    ? 'Everything your playit.gg shares while you host. The one shown first is the address under the server picker, for you and the other members; they see this list too.'
                    : `Everything ${host}'s playit.gg shares. ${host} chose which one is shown first.`}
            </p>
            {tunnels.map((tunnel) => {
                const info = describeTunnel(tunnel);
                const isPrimary = tunnel.address === primary;
                return (
                    <div key={tunnel.address} className={`tunnel-card ${isPrimary ? 'primary' : ''}`}>
                        <div className='tunnel-head'>
                            <span className='tunnel-name'>{info.name}</span>
                            {isPrimary && <span className='tunnel-badge'>Shown first</span>}
                        </div>
                        <div className='tunnel-address'>
                            <code title={tunnel.address}>{tunnel.address}</code>
                            <CopyButton text={tunnel.address} />
                        </div>
                        <p className='tunnel-help'>{info.help}</p>
                        <div className='tunnel-foot'>
                            <span>To {tunnel.local} on the host's PC</span>
                            {host === null && !isPrimary && (
                                <button className='text-button' disabled={choosing !== null} onClick={() => void choose(tunnel.address)}>
                                    {choosing === tunnel.address && <Loader2 size={12} className='spinner' />} Show this one first
                                </button>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
