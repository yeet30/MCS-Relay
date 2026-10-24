import './terms-gate.css';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, Cpu, ExternalLink, Loader2, ShieldCheck, Users } from 'lucide-react';
import { TERMS_URL, TERMS_VERSION } from '../../../shared/types';
import { invoke } from '../../api';
import { useAuthStore } from '../../stores/authStore';
import { useServersStore } from '../../stores/serversStore';
import { useSettingsStore } from '../../stores/settingsStore';

const POINTS = [
    {
        icon: Cpu,
        title: 'Hosting runs the server\'s files on this PC',
        text: 'The server .jar, mods and plugins are programs. When you host, they run here and can do anything a program you open yourself can do.',
    },
    {
        icon: Users,
        title: 'Every member can change those files',
        text: 'Someone with bad intentions, or whose Google account was taken over, could hide harmful software in them. It would run on the PC of whoever hosts next. MCS-Relay does not scan what members upload.',
    },
    {
        icon: ShieldCheck,
        title: 'How to stay safe',
        text: 'Create, join and invite only with people you trust. Keep your antivirus on. If mods, plugins or programs appear that nobody mentioned, ask before you host.',
    },
    {
        icon: Archive,
        title: 'No guarantees',
        text: 'MCS-Relay is free software, provided as it is, without any warranty. Keep a backup of the worlds you care about.',
    },
];

/** Shown instead of the main page until this Google account agrees to the current terms of use: what sharing a
 *  server folder means for the PC that hosts it. */
export default function TermsGate({ agreedBefore }: { agreedBefore: boolean }) {
    const email = useAuthStore((s) => s.user?.email);
    const navigate = useNavigate();
    const [busy, setBusy] = useState<'agree' | 'logout' | null>(null);

    async function agree() {
        setBusy('agree');
        await useSettingsStore.getState().update({ termsAccepted: TERMS_VERSION });
        setBusy(null);
    }

    async function logout() {
        setBusy('logout');
        const done = await useAuthStore.getState().logout();
        setBusy(null);
        if (!done) return;
        useServersStore.getState().reset();
        navigate('/');
    }

    return (
        <div className='terms-gate'>
            <section className='terms-card' aria-labelledby='terms-title'>
                <h1 id='terms-title'>Play only with people you trust</h1>
                <p className='terms-lead'>
                    {agreedBefore
                        ? 'The terms of use have changed. Please read them again before you continue.'
                        : 'MCS-Relay shares one server folder among friends. Here is what that means for your PC.'}
                </p>
                <div className='terms-points'>
                    {POINTS.map(({ icon: Icon, title, text }) => (
                        <div key={title} className='terms-point'>
                            <Icon size={18} aria-hidden />
                            <div>
                                <h2>{title}</h2>
                                <p>{text}</p>
                            </div>
                        </div>
                    ))}
                </div>
                <p className='terms-foot'>
                    By choosing &quot;I understand and agree&quot;{email ? ` as ${email}` : ''}, you accept the terms of use.
                </p>
                <div className='terms-actions'>
                    <button className='terms-link' onClick={() => void invoke('app:openExternal', TERMS_URL)}>
                        Read the terms of use <ExternalLink size={12} />
                    </button>
                    <span className='terms-buttons'>
                        <button className='text-button' disabled={busy !== null} onClick={() => void logout()}>
                            {busy === 'logout' && <Loader2 size={13} className='spinner' />} Log out
                        </button>
                        <button className='text-button primary' disabled={busy !== null} onClick={() => void agree()}>
                            {busy === 'agree' && <Loader2 size={13} className='spinner' />} I understand and agree
                        </button>
                    </span>
                </div>
            </section>
        </div>
    );
}
