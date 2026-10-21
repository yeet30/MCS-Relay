// The only bridge between the page and the main process: window.api.
// The page can call the channels of shared/ipc.ts and listen to its events, nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { COMMAND_PREFIXES } from '../shared/ipc';
import type { BridgeApi, EventName } from '../shared/ipc';

const EVENTS: Record<EventName, true> = {
    'session:state': true, 'session:step': true, 'session:progress': true, 'sync:report': true, 'lock:update': true,
    'sync:checking': true, 'servers:deleting': true,
    'transfer:progress': true, 'changes:batch': true, 'changes:reset': true, 'console:output': true,
    'app:confirmQuit': true, 'app:quitting': true, 'app:chime': true,
};

const api: BridgeApi = {
    invoke(channel, ...args) {
        if (!COMMAND_PREFIXES.some((prefix) => channel.startsWith(prefix))) {
            return Promise.reject(new Error(`Unknown channel ${channel}`));
        }
        return ipcRenderer.invoke(channel, ...args);
    },
    on(channel, listener) {
        if (!(channel in EVENTS)) throw new Error(`Unknown event ${channel}`);
        const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
        ipcRenderer.on(channel, wrapped);
        return () => {
            ipcRenderer.removeListener(channel, wrapped);
        };
    },
};

contextBridge.exposeInMainWorld('api', api);
