import './login-page.css';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, FolderLock, HardDrive, LoaderCircle, ShieldCheck } from 'lucide-react';
import { invoke } from '../../api';
import logoUrl from '../../assets/logo.svg';
import { useAuthStore } from '../../stores/authStore';

const GOOGLE_ACCESS_PAGE = 'https://myaccount.google.com/connections';

/** What Google's permission page is about to ask, before it does: why the whole Drive, what the app really
 *  touches, and how to take the access back. */
function BeforeSignIn() {
    return (
        <section className='login-about' aria-label='Before you sign in'>
            <h2>Before you sign in</h2>
            <div className='about-point'>
                <HardDrive size={18} aria-hidden />
                <div>
                    <h3>Google asks for access to your whole Drive</h3>
                    <p>
                        Friends upload their changes to the shared folder, and those files are theirs. Google's smaller
                        permission only shows an app the files it made itself, so it could not get their changes.
                    </p>
                </div>
            </div>
            <div className='about-point'>
                <FolderLock size={18} aria-hidden />
                <div>
                    <h3>It only touches the server folders</h3>
                    <p>
                        The &quot;Minecraft Shared Servers&quot; folder it makes, and the servers you join. Your other files
                        are never opened, listed or changed.
                    </p>
                </div>
            </div>
            <div className='about-point'>
                <ShieldCheck size={18} aria-hidden />
                <div>
                    <h3>Nothing goes through anyone else</h3>
                    <p>
                        The app talks to Google straight from this PC and keeps your sign-in encrypted on it. You can take
                        the access back at any time.
                    </p>
                    <button className='about-link' onClick={() => void invoke('app:openExternal', GOOGLE_ACCESS_PAGE)}>
                        Apps with access to your Google Account <ExternalLink size={12} />
                    </button>
                </div>
            </div>
            <p className='about-foot'>
                Google asks only once per account. It may first warn that it has not verified the app, as it does for
                apps with full Drive access that have not been through its review.
            </p>
        </section>
    );
}

/** Google's "G", as its sign-in buttons show it. */
function GoogleMark() {
    return (
        <svg width='18' height='18' viewBox='0 0 48 48' aria-hidden>
            <path fill='#EA4335' d='M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z' />
            <path fill='#4285F4' d='M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z' />
            <path fill='#FBBC05' d='M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z' />
            <path fill='#34A853' d='M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z' />
        </svg>
    );
}

export default function LoginPage() {
    const navigate = useNavigate();
    const signedOutReason = useAuthStore((s) => s.signedOutReason);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        // After a NOT_SIGNED_IN error stay here, even if a stored token still claims to be valid; going back to
        // the main page would only fail again.
        if (useAuthStore.getState().signedOutReason) return;
        let cancelled = false;
        void useAuthStore.getState().refresh().then((status) => {
            if (!cancelled && status?.loggedIn) navigate('/main');
        });
        return () => {
            cancelled = true;
        };
    }, [navigate]);

    async function handleLogin() {
        setLoading(true);
        setError('');
        const res = await useAuthStore.getState().login();
        setLoading(false);
        if (!res.ok) {
            setError(res.error.message);
            return;
        }
        if (res.value.loggedIn) navigate('/main');
        else setError('The login was not completed. Please try again.');
    }

    return (
        <div className='login-page'>
            <div className='login-main'>
                <div className='login-card'>
                    <img className='login-mark' src={logoUrl} alt='' width={72} height={72} />
                    <h1 className='login-title'>MCS-Relay</h1>
                    <p className='login-tagline'>
                        Host a Minecraft server from a shared Google Drive. Whoever plays hosts it, and the world is saved for
                        the next one.
                    </p>
                    <button className='google-button' onClick={handleLogin} disabled={loading}>
                        {loading ? <LoaderCircle size={18} className='spinner' /> : <GoogleMark />}
                        {loading ? 'Waiting for your browser…' : 'Sign in with Google'}
                    </button>
                    {loading && <p className='login-note'>Finish signing in in the browser window that opened, then come back here.</p>}
                    {signedOutReason && !error && !loading && <p className='login-note'>{signedOutReason}</p>}
                    {error && <p className='login-error'>{error}</p>}
                </div>
                <BeforeSignIn />
            </div>
            <p className='login-footer'>Your browser opens so you can sign in. Server files are kept in your Google Drive.</p>
            <p className='login-disclaimer'>Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.</p>
        </div>
    );
}
