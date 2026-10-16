import './login-page.css';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';

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
        <div className='wrapper'>
            <h1 id='login-title'>Please login with your Google account</h1>
            {signedOutReason && !error && <p className='login-note'>{signedOutReason}</p>}
            <p className='login-note'>
                {loading && <><LoaderCircle size={14} className='spinner' /> Waiting for you to finish signing in in your browser…</>}
            </p>
            <button id='login-button' onClick={handleLogin} disabled={loading}>
                Login
            </button>
            {error && <p className='login-error'>{error}</p>}
        </div>
    );
}
