import type { BridgeApi } from '../shared/ipc';

declare global {
    interface Window {
        /** Exposed by electron/preload.ts; use the typed wrappers in src/api.ts instead of calling it directly. */
        api: BridgeApi;
    }
}

export {};
