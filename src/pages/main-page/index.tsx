import './main-page.css';
import { useEffect } from 'react';
import GreetingSection from '../../components/greeting-section';
import BurgerMenu from '../../components/burger-menu';
import MembersSection from '../../components/members-section';
import { useAuthStore } from '../../stores/authStore';
import { useServersStore } from '../../stores/serversStore';
import { useSettingsStore } from '../../stores/settingsStore';

export default function MainPage() {
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
        </section>
    );
}
