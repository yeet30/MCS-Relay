import './quit-guard.css';
import { useEffect, useRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { QuitPrompt } from '../../../shared/ipc';
import { invoke } from '../../api';
import { useConfirm } from '../../hooks/useConfirm';
import { useSessionStore } from '../../stores/sessionStore';

function quitMessage(prompt: QuitPrompt): string {
    if (!prompt.sessionActive) return 'Are you sure you want to quit?';
    switch (prompt.phase) {
        case 'running':
            return 'You are hosting a server. Quitting stops it and uploads the world to the cloud first. This may take a moment.';
        case 'upload-pending':
            return 'Your last upload has not finished. Drive Launcher finishes it the next time you open it; until then nobody else can start this server.';
        case 'stopping':
        case 'uploading':
        case 'releasing':
            return 'Drive Launcher is still saving the world to the cloud. Quitting waits until it is done.';
        default:
            return 'The server is starting. Quitting cancels the start and frees the server for others.';
    }
}

/** Answers the main process's quit question (app:confirmQuit) and covers the window while it shuts down.
 *  Lives in App, not in a page, so the question is answered even on the login page. */
export default function QuitGuard() {
    const prompt = useSessionStore((s) => s.quitPrompt);
    const quitting = useSessionStore((s) => s.quitting);
    const message = useSessionStore((s) => (s.progress?.active ? s.progress.message : null));
    const { confirm, popup } = useConfirm();
    const asking = useRef(false);

    useEffect(() => {
        // One dialog at a time; a second close click while it is open is answered by the same dialog.
        if (!prompt || asking.current) return;
        asking.current = true;
        void confirm({ message: quitMessage(prompt), confirmText: 'Quit', cancelText: 'Cancel' }).then(async (confirmed) => {
            asking.current = false;
            useSessionStore.getState().setQuitPrompt(null);
            await invoke('app:quitResponse', confirmed);
        });
    }, [prompt, confirm]);

    return (
        <>
            {popup}
            {quitting && (
                <div className='quit-overlay'>
                    <LoaderCircle size={32} className='spinner' />
                    <p>Stopping the server and saving the world…</p>
                    {message && <p className='quit-step'>{message}</p>}
                </div>
            )}
        </>
    );
}
