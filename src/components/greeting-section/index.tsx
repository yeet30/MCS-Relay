import './greeting-section.css';
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import SelectServer from '../select-server';
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

export default function GreetingSection() {
    const authPhase = useAuthStore((s) => s.phase);
    const user = useAuthStore((s) => s.user);
    const consoleHasOutput = useSessionStore((s) => s.console.length > 0);
    const consoleCount = useSessionStore((s) => s.consoleCount);
    const unseenLines = useSessionStore((s) => s.consoleCount > s.consoleSeen);
    const [notAtTop, setNotAtTop] = useState(false);
    const [consoleOnScreen, setConsoleOnScreen] = useState(false);

    useEffect(() => {
        function handleScroll() {
            setNotAtTop(window.scrollY > 0);
        }
        window.addEventListener('scroll', handleScroll);
        handleScroll();
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    // The red dot means "the console has lines you have not looked at": they count as seen while a good part of the
    // console is on screen.
    const signedIn = authPhase === 'signed-in' && user !== null;
    useEffect(() => {
        const section = document.getElementById('console-section');
        if (!section) return undefined;
        const observer = new IntersectionObserver(([entry]) => setConsoleOnScreen(entry.isIntersecting), { threshold: 0.3 });
        observer.observe(section);
        return () => observer.disconnect();
    }, [signedIn]);

    useEffect(() => {
        if (consoleOnScreen) useSessionStore.getState().markConsoleSeen();
    }, [consoleOnScreen, consoleCount]);

    if (authPhase !== 'signed-in' || !user) {
        return (
            <section className='greeting-wrapper'>
                <h2 className='greeting-title'>Loading user information...</h2>
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
                    {unseenLines && <span className='scroller-dot' aria-label='The console has new lines' />}
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
