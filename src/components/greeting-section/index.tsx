import './greeting-section.css';
import { useEffect, useState } from 'react';
import { ChevronUp } from 'lucide-react';
import SelectServer from '../select-server';
import PermissionInformation from '../permission-information';
import ServerConsole from '../server-console';
import PlayitggLink from '../playitgg-link';
import AppCockpit from '../app-cockpit';
import StartupProgress from '../startup-progress';
import SyncStatusCard from '../sync-status-card';
import TransfersPanel from '../transfers-panel';
import { ChangesSummary } from '../changes-panel';
import { useAuthStore } from '../../stores/authStore';
import { useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import { isSessionBusy } from '../../lib/sync';

/** Under the server picker: the transfer while one runs, the sync status card while idle, and the startup
 *  progress (plus the changes line while running) in between. */
function SessionArea() {
    const phase = useSessionStore((s) => s.state.phase);
    const transferActive = useSessionStore((s) => s.transfer?.active ?? false);
    const hasServers = useServersStore((s) => s.servers.length > 0);

    if (!hasServers) return null;
    if (transferActive) return <TransfersPanel />;
    if (!isSessionBusy(phase)) {
        return (
            <>
                <SyncStatusCard />
                <StartupProgress compact />
            </>
        );
    }
    return (
        <>
            <StartupProgress />
            {phase === 'running' && <ChangesSummary />}
        </>
    );
}

export default function GreetingSection() {
    const authPhase = useAuthStore((s) => s.phase);
    const user = useAuthStore((s) => s.user);
    const collaborationEnabled = useAuthStore((s) => s.collaborationEnabled);
    const [notAtTop, setNotAtTop] = useState(false);

    useEffect(() => {
        function handleScroll() {
            setNotAtTop(window.scrollY > 0);
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

            <div className='console-section'><ServerConsole /></div>
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
