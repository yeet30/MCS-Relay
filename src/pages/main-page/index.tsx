import './main-page.css';
import { useEffect } from 'react';
import GreetingSection from '../../components/greeting-section';
import BurgerMenu from '../../components/burger-menu';
import MembersSection from '../../components/members-section';
import TermsGate from '../../components/terms-gate';
import ServerSetupHost from '../../components/server-setup/host';
import { TERMS_VERSION } from '../../../shared/types';
import { useAuthStore } from '../../stores/authStore';
import { useServersStore } from '../../stores/serversStore';
import { useSettingsStore } from '../../stores/settingsStore';

export default function MainPage() {
    // null while the settings load. Until this account agrees to the terms, the terms take the place of the page.
    const termsAccepted = useSettingsStore((s) => s.settings?.termsAccepted ?? null);

    useEffect(() => {
        let cancelled = false;
        async function init() {
            // Signed out -> the auth store says so and SignedOutRedirect returns to the login page.
            const status = await useAuthStore.getState().refresh();
            if (cancelled || !status?.loggedIn) return;
            const settings = await useSettingsStore.getState().load();
            if (cancelled) return;
            const loaded = await useServersStore.getState().load();
            if (cancelled || !loaded) return;
            await useServersStore.getState().selectInitial(settings?.selectedServerId ?? null);
        }
        void init();
        return () => {
            cancelled = true;
        };
    }, []);

    if (termsAccepted !== null && termsAccepted < TERMS_VERSION) return <TermsGate agreedBefore={termsAccepted > 0} />;

    return (
        <section id='main-section'>
            <section id='members-section'>
                <MembersSection />
            </section>
            <section id='greeting-section'>
                <GreetingSection />
            </section>
            <section id='menu-section'>
                <BurgerMenu />
            </section>
            <ServerSetupHost />
        </section>
    );
}
