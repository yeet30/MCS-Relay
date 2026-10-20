import './greeting-section.css';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import SelectServer from '../select-server';
import PermissionInformation from '../permission-information';
import ServerConsole from '../server-console';
import PlayitggLink from '../playitgg-link';
import AppCockpit from '../app-cockpit';
import ProgressCard from '../progress-card';
import SyncStatusCard from '../sync-status-card';
import { ChangesSummary } from '../changes-panel';
import { useAuthStore } from '../../stores/authStore';
import { useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import { isSessionBusy } from '../../lib/sync';

/** Under the server picker: the progress of a start or stop while one runs (or failed), the sync status card
 *  while idle, and the session's changes while the server runs. */
function SessionArea() {
    const phase = useSessionStore((s) => s.state.phase);
    const hasServers = useServersStore((s) => s.servers.length > 0);

    if (!hasServers) return null;
    if (phase === 'running') {
        return (
            <>
                <ProgressCard compact />
                <ChangesSummary />
            </>
        );
    }
    if (isSessionBusy(phase) || phase === 'failed') return <ProgressCard />;
    return (
        <>
            <SyncStatusCard />
            <ProgressCard compact />
        </>
    );
}

const CONSOLE_HINT_KEY = 'mdh.consoleHintSeen';

function readHintSeen(): boolean {
    try {
        return localStorage.getItem(CONSOLE_HINT_KEY) === '1';
    } catch {
        return false;
    }
}

function rememberHintSeen(): void {
    try {
        localStorage.setItem(CONSOLE_HINT_KEY, '1');
    } catch {
        // private storage unavailable: the dot simply shows again next time
    }
}

export default function GreetingSection() {
    const authPhase = useAuthStore((s) => s.phase);
    const user = useAuthStore((s) => s.user);
    const collaborationEnabled = useAuthStore((s) => s.collaborationEnabled);
    const consoleHasOutput = useSessionStore((s) => s.console.length > 0);
    const [notAtTop, setNotAtTop] = useState(false);
    // The red dot points out the console the first time it shows something; any scroll dismisses it for good.
    const [hintSeen, setHintSeen] = useState(readHintSeen);
    const outputRef = useRef(consoleHasOutput);
    outputRef.current = consoleHasOutput;

    useEffect(() => {
        function handleScroll() {
            const scrolled = window.scrollY > 0;
            setNotAtTop(scrolled);
            if (scrolled && outputRef.current) {
                setHintSeen(true);
                rememberHintSeen();
            }
        }
        window.addEventListener('scroll', handleScroll);
        handleScroll();
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    if (authPhase !== 'signed-in' || !user) {
        return (
            <section className='greeting-wrapper'>
                <h2 className='greeting-title'>Loading user information...</h2>
            </section>
        );
    }
    if (!collaborationEnabled) {
        return (
            <section className='greeting-wrapper'>
                <h2 className='greeting-title'>Welcome, {user.name}!</h2>
                <PermissionInformation />
            </section>
        );
    }
    return (
        <section className='greeting-wrapper'>
            <div className='first-page'>
                <h2 className='greeting-title'>Welcome, {user.name}!</h2>
                <div className='starter-section'>
                    <AppCockpit />
                    <SelectServer />
                    <SessionArea />
                    <PlayitggLink />
                </div>
            </div>

            <div className='console-section' id='console-section'><ServerConsole /></div>
            {!notAtTop && consoleHasOutput && (
                <button
                    className='scroller-button console-jump'
                    title='Go to the server console'
                    onClick={() => document.getElementById('console-section')?.scrollIntoView({ behavior: 'smooth' })}
                >
                    <Terminal size={16} />
                    <ChevronDown size={18} />
                    {!hintSeen && <span className='scroller-dot' aria-label='The console has new output' />}
                </button>
            )}
            {notAtTop && (
                <button
                    className='scroller-button'
                    title='Back to the top'
                    onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                >
                    <ChevronUp size={20} />
                </button>
            )}
        </section>
    );
}
