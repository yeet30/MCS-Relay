// The ONE place that subscribes to events from the main process. Called once from main.tsx; calling it again
// does nothing, so the subscriptions cannot pile up (F37).
import { on, onSignedOut } from '../api';
import { useAuthStore } from './authStore';
import { useServersStore } from './serversStore';
import { useSessionStore } from './sessionStore';

/** The active unsubscribe functions; null while not subscribed. Module singleton (one renderer, one bridge). */
let unsubscribers: Array<() => void> | null = null;

export function startEventSubscriptions(): void {
    if (unsubscribers) return;
    const session = useSessionStore.getState;
    unsubscribers = [
        on('session:state', (state) => session().applyState(state)),
        on('session:step', (step) => session().applyStep(step)),
        on('sync:report', (report) => session().applyReport(report)),
        on('lock:update', ({ serverId, view }) => session().applyLock(serverId, view)),
        on('transfer:progress', (snapshot) => session().applyTransfer(snapshot)),
        on('changes:batch', (batch) => session().applyChanges(batch)),
        on('changes:reset', () => session().resetChanges()),
        on('console:output', (lines) => session().appendConsole(lines)),
        on('app:confirmQuit', (prompt) => session().setQuitPrompt(prompt)),
        on('app:quitting', () => session().setQuitting(true)),
        onSignedOut((message) => {
            useAuthStore.getState().markSignedOut(message);
            useServersStore.getState().reset();
        }),
    ];
    // Catch up with anything that happened before this window subscribed (e.g. after a reload).
    void session().resync();
}

export function stopEventSubscriptions(): void {
    if (!unsubscribers) return;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = null;
}

if (import.meta.hot) import.meta.hot.dispose(stopEventSubscriptions);
