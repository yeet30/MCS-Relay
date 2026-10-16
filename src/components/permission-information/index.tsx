import './permission-information.css';
import { useState } from 'react';
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useServersStore } from '../../stores/serversStore';
import { useSettingsStore } from '../../stores/settingsStore';

/** Shown to accounts that signed in with the old two-step login and lack the full Drive permission. */
export default function PermissionInformation() {
    const collaborationEnabled = useAuthStore((s) => s.collaborationEnabled);
    const enableCollaboration = useAuthStore((s) => s.enableCollaboration);
    const [loading, setLoading] = useState(false);

    async function handleEnable() {
        setLoading(true);
        const enabled = await enableCollaboration();
        setLoading(false);
        if (!enabled) return;
        const settings = await useSettingsStore.getState().load();
        if (await useServersStore.getState().load()) {
            await useServersStore.getState().selectInitial(settings?.selectedServerId ?? null);
        }
    }

    if (collaborationEnabled) return null;
    return (
        <div className='permission-information'>
            <h3>Please grant the app permission to see the files created by others and the folders you joined.</h3>
            <div className='access-statement'>
                <AlertCircle size={48} />
                <h4>Without it the app only sees the files it created itself, so it cannot sync a world with your friends.</h4>
            </div>
            <span>
                <button onClick={handleEnable} disabled={loading}>
                    {loading && <Loader2 size={16} className='spinner' />}
                    Enable Collaboration <ExternalLink size={16} />
                </button>
            </span>
        </div>
    );
}
