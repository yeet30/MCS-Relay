// What the update section of Preferences says.
import type { UpdateState } from '../../shared/types';

export function updateLine(state: UpdateState): string {
    switch (state.status) {
        case 'unavailable':
            return 'This is a development build, so it does not look for updates.';
        case 'idle':
            return 'MCS-Relay looks for a newer version shortly after it starts, and every few hours.';
        case 'checking':
            return 'Looking for a newer version…';
        case 'up-to-date':
            return 'You have the latest version.';
        case 'downloading':
            return `Downloading version ${state.version ?? 'next'} (${state.percent}%)…`;
        case 'ready':
            return `Version ${state.version ?? 'next'} is ready. It installs when you quit MCS-Relay, or restart now.`;
        case 'error':
            return `The last check did not work: ${state.error ?? 'unknown error'}`;
    }
}
