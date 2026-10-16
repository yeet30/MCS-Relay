import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

/** Sends the user to the login page whenever the auth store says signed out (logout, or a NOT_SIGNED_IN error
 *  from any request). */
export default function SignedOutRedirect() {
    const phase = useAuthStore((s) => s.phase);
    const navigate = useNavigate();
    const { pathname } = useLocation();

    useEffect(() => {
        if (phase === 'signed-out' && pathname !== '/') navigate('/');
    }, [phase, pathname, navigate]);

    return null;
}
