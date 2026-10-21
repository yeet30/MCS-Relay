import './burger-menu.css';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderTree, LoaderCircle, LogOut, SlidersHorizontal, Terminal } from 'lucide-react';
import type { IModalItems } from '../../lib/ui-types';
import { useAuthStore } from '../../stores/authStore';
import { useServersStore } from '../../stores/serversStore';
import JoinedDriveFolders from '../joined-drive-folders';
import Modal from '../modal';
import OwnedDriveFolders from '../owned-drive-folders';
import Preferences from '../preferences';
import ScriptsOptions from '../scripts-options';

export default function BurgerMenu() {
    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);
    const navigate = useNavigate();
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const [modalItems, setModalItems] = useState<IModalItems[] | null>(null);
    // Drive Folders holds cards with member lists, so it gets a larger window than the settings panels.
    const [wide, setWide] = useState(false);

    async function handleLogout() {
        setLoggingOut(true);
        const done = await logout();
        setLoggingOut(false);
        setIsMenuOpen(false);
        if (!done) return;
        useServersStore.getState().reset();
        navigate('/');
    }

    function open(items: IModalItems[], large = false) {
        setIsMenuOpen(false);
        setWide(large);
        setModalItems(items);
    }

    const state = isMenuOpen ? 'open' : 'close';
    return (
        <section id='burger-wrapper'>
            <Modal
                isOpen={modalItems !== null}
                onClose={() => setModalItems(null)}
                items={modalItems ?? []}
                width={wide ? 500 : 460}
                height={wide ? 470 : 380}
            />
            <div id='menu-clicker' onClick={() => setIsMenuOpen(!isMenuOpen)} className={state}>
                {user?.picture
                    ? <img id='profile-picture' src={user.picture} alt='Profile Picture' width='40' height='40' referrerPolicy='no-referrer' />
                    : <span id='profile-picture' className='initial'>{(user?.name ?? '?').charAt(0).toUpperCase()}</span>}
                <span id='settings-span' className={state}>Settings</span>
                <div id='hamburger-icon'>☰</div>
            </div>
            <div id='drawer' className={state}>
                <div className='drawer-body'>
                    {user && (
                        <div className='drawer-user'>
                            <span className='drawer-name'>{user.name}</span>
                            <span className='drawer-email' title={user.email}>{user.email}</span>
                        </div>
                    )}
                    <ul>
                        <li onClick={() => open([{ title: 'Script Options', content: <ScriptsOptions /> }])}>
                            <Terminal size={15} /> Scripts
                        </li>
                        <li onClick={() => open([
                            { title: 'Your Folders', content: <OwnedDriveFolders /> },
                            { title: 'Joined Folders', content: <JoinedDriveFolders /> },
                        ], true)}
                        >
                            <FolderTree size={15} /> Drive Folders
                        </li>
                        <li onClick={() => open([{ title: 'Preferences', content: <Preferences /> }])}>
                            <SlidersHorizontal size={15} /> Preferences
                        </li>
                        <li className='danger' onClick={handleLogout}>
                            {loggingOut ? <LoaderCircle size={15} className='spinner' /> : <LogOut size={15} />}
                            {loggingOut ? 'Logging out…' : 'Log out'}
                        </li>
                    </ul>
                </div>
            </div>
            {isMenuOpen && <div id='burger-overlay' onClick={() => setIsMenuOpen(false)} />}
        </section>
    );
}
