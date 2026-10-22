import './title-bar.css';
import { useEffect } from 'react';
import type { LogoState } from '../../../shared/types';
import { invoke } from '../../api';
import logoOff from '../../assets/logo-off.svg';
import logoHere from '../../assets/logo.svg';
import logoElsewhere from '../../assets/logo-front-lit.svg';
import { logoState } from '../../lib/sync';
import { useServersStore } from '../../stores/serversStore';
import { lockFor, useSessionStore } from '../../stores/sessionStore';

const LOGOS: Record<LogoState, { src: string; title: string }> = {
    off: { src: logoOff, title: 'Nobody is hosting the selected server' },
    here: { src: logoHere, title: 'You are hosting the selected server from this PC' },
    elsewhere: { src: logoElsewhere, title: 'Someone else is hosting the selected server' },
};

/** The window's title bar, drawn by the page in the theme's colour; Windows draws the minimise and close buttons
 *  over its right end. Dragging anywhere on it moves the window. Its comparator shows who hosts the selected server,
 *  and so do the taskbar and the tray. */
export default function TitleBar() {
    const selectedId = useServersStore((s) => s.selectedId);
    const session = useSessionStore((s) => s.state);
    const lock = useSessionStore((s) => lockFor(s, selectedId));
    const state = logoState(session, selectedId, lock);
    const logo = LOGOS[state];

    // The taskbar and tray icons show the same state.
    useEffect(() => {
        void invoke('app:setLogoState', state);
    }, [state]);
    return (
        <header className='title-bar'>
            <img src={logo.src} alt='' title={logo.title} width={16} height={16} />
            <span>MCS-Relay</span>
        </header>
    );
}
