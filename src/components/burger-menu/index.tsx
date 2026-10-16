import './burger-menu.css';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IModalItems } from '../../lib/ui-types';
import { useAuthStore } from '../../stores/authStore';
import { useServersStore } from '../../stores/serversStore';
import JoinedDriveFolders from '../joined-drive-folders';
import Modal from '../modal';
import OwnedDriveFolders from '../owned-drive-folders';
import ScriptsOptions from '../scripts-options';

export default function BurgerMenu() {
    const picture = useAuthStore((s) => s.user?.picture ?? '');
    const logout = useAuthStore((s) => s.logout);
    const navigate = useNavigate();
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const [modalItems, setModalItems] = useState<IModalItems[] | null>(null);

    async function handleLogout() {
        setLoggingOut(true);
        const done = await logout();
        setLoggingOut(false);
        setIsMenuOpen(false);
        if (!done) return;
        useServersStore.getState().reset();
        navigate('/');
    }

    function open(items: IModalItems[]) {
        setIsMenuOpen(false);
        setModalItems(items);
    }

    return (
        <section id='burger-wrapper'>
            <Modal isOpen={modalItems !== null} onClose={() => setModalItems(null)} items={modalItems ?? []} height={360} />
            <div id='menu-clicker' onClick={() => setIsMenuOpen(!isMenuOpen)} className={isMenuOpen ? 'open' : 'close'}>
                {picture
                    ? <img id='profile-picture' src={picture} alt='Profile Picture' width='40' height='40' referrerPolicy='no-referrer' />
                    : <span id='profile-picture' />}
                <span id='settings-span' className={isMenuOpen ? 'open' : 'close'}>Settings</span>
                <div id='hamburger-icon'>☰</div>
            </div>
            <div id='drawer' className={isMenuOpen ? 'open' : 'close'}>
                <ul className={isMenuOpen ? 'open' : 'close'}>
                    <li onClick={() => open([{ title: 'Script Options', content: <ScriptsOptions /> }])}>Scripts</li>
                    <li onClick={() => open([
                        { title: 'Your Folders', content: <OwnedDriveFolders /> },
                        { title: 'Joined Folders', content: <JoinedDriveFolders /> },
                    ])}
                    >Drive Folders</li>
                    <li onClick={handleLogout}>Log Out</li>
                    {loggingOut && <p>Logging out...</p>}
                </ul>
            </div>
            {isMenuOpen && <div id='burger-overlay' onClick={() => setIsMenuOpen(false)} />}
        </section>
    );
}
