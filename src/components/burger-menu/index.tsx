import './burger-menu.css';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bug, FolderTree, LoaderCircle, LogOut, ServerCog, SlidersHorizontal } from 'lucide-react';
import type { IModalItems } from '../../lib/ui-types';
import { useAuthStore } from '../../stores/authStore';
import { selectWhitelistOn, usePropertiesStore } from '../../stores/propertiesStore';
import { useServersStore } from '../../stores/serversStore';
import { useUiStore } from '../../stores/uiStore';
import JoinedDriveFolders from '../joined-drive-folders';
import Modal from '../modal';
import OwnedDriveFolders from '../owned-drive-folders';
import Preferences from '../preferences';
import ReportProblem from '../report-problem';
import ScriptsOptions from '../scripts-options';
import ServerPropertiesPanel from '../server-properties';
import WhitelistPanel from '../whitelist-panel';

export default function BurgerMenu() {
    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);
    const navigate = useNavigate();
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const [modalItems, setModalItems] = useState<IModalItems[] | null>(null);
    // Server settings is built on every render: its Whitelist tab comes and goes with the whitelist switch.
    const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
    const selectedId = useServersStore((s) => s.selectedId);
    const whitelistOn = usePropertiesStore(selectWhitelistOn(selectedId));
    // Servers holds cards with member lists, so it gets a larger window than the settings panels.
    const [wide, setWide] = useState(false);
    const driveFoldersRequested = useUiStore((s) => s.driveFoldersRequested);
    const closeRequested = useUiStore((s) => s.closeRequested);

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

    function openServerSettings() {
        setIsMenuOpen(false);
        setWide(true);
        if (selectedId) void usePropertiesStore.getState().load(selectedId);
        setServerSettingsOpen(true);
    }

    const serverSettings: IModalItems[] = [
        { title: 'Hosting', content: <ScriptsOptions /> },
        { title: 'server.properties', content: <ServerPropertiesPanel /> },
        ...(whitelistOn ? [{ title: 'Whitelist', content: <WhitelistPanel /> }] : []),
    ];
    const closeModal = () => {
        setModalItems(null);
        setServerSettingsOpen(false);
    };

    const driveFolders: IModalItems[] = [
        { title: 'Your servers', content: <OwnedDriveFolders /> },
        { title: 'Joined servers', content: <JoinedDriveFolders /> },
    ];

    // Another part of the app asked for Servers.
    useEffect(() => {
        if (!driveFoldersRequested) return;
        useUiStore.getState().clearDriveFoldersRequest();
        setIsMenuOpen(false);
        setServerSettingsOpen(false);
        setWide(true);
        setModalItems([
            { title: 'Your servers', content: <OwnedDriveFolders /> },
            { title: 'Joined servers', content: <JoinedDriveFolders /> },
        ]);
    }, [driveFoldersRequested]);

    // A server was created from Servers: it closes, so the page (and the tour on it) is in view.
    useEffect(() => {
        if (!closeRequested) return;
        useUiStore.getState().clearCloseRequest();
        setModalItems(null);
        setServerSettingsOpen(false);
    }, [closeRequested]);

    const state = isMenuOpen ? 'open' : 'close';
    return (
        <section id='burger-wrapper'>
            <Modal
                isOpen={modalItems !== null || serverSettingsOpen}
                onClose={closeModal}
                items={serverSettingsOpen ? serverSettings : modalItems ?? []}
                width={wide ? 500 : 460}
                height={wide ? 450 : 380}
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
                        <li onClick={openServerSettings}>
                            <ServerCog size={15} /> Server settings
                        </li>
                        <li onClick={() => open(driveFolders, true)}>
                            <FolderTree size={15} /> Servers
                        </li>
                        <li onClick={() => open([{ title: 'Preferences', content: <Preferences /> }])}>
                            <SlidersHorizontal size={15} /> Preferences
                        </li>
                        <li onClick={() => open([{ title: 'Report a problem', content: <ReportProblem signedIn onDone={closeModal} /> }], true)}>
                            <Bug size={15} /> Report a problem
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
