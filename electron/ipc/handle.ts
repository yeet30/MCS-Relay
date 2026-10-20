// The main-process side of the typed IPC contract in shared/ipc.ts.
// Every handler answers with a Result: errors never cross the bridge as exceptions.
import type { BrowserWindow } from 'electron';
import type { CommandArgs, CommandName, CommandResult, EventName, Events, Result } from '../../shared/ipc';
import { toAppError } from '../errors';
import type { EventSink } from '../session/SessionController';

/** The part of ipcMain that handle() uses, so tests can pass a fake. */
export interface IpcMainLike {
    handle(channel: string, listener: (event: { senderFrame?: { url: string } | null }, ...args: unknown[]) => unknown): void;
}

export type Handle = <C extends CommandName>(
    channel: C,
    run: (...args: CommandArgs<C>) => CommandResult<C> | Promise<CommandResult<C>>,
) => void;

/** Returns handle(): registers `run` for `channel`, accepting calls only from our own page. */
export function createHandle(ipc: IpcMainLike, isTrustedUrl: (url: string) => boolean): Handle {
    return (channel, run) => {
        ipc.handle(channel, async (event, ...args): Promise<Result<unknown>> => {
            const url = event.senderFrame?.url ?? '';
            if (!isTrustedUrl(url)) {
                console.error(`[ipc] refused ${channel} from ${url || 'an unknown frame'}`);
                return { ok: false, error: { code: 'FORBIDDEN', message: 'This request is not allowed.' } };
            }
            try {
                return { ok: true, value: await run(...(args as Parameters<typeof run>)) };
            } catch (err) {
                const error = toAppError(err);
                const log = error.code === 'UNKNOWN' ? console.error : console.warn;
                log(`[ipc] ${channel} failed: ${error.message}`, error.detail ?? '');
                return { ok: false, error };
            }
        });
    };
}

/** Sends events to the window; does nothing while there is no window (tray mode, shutting down). */
export function createEventSink(getWindow: () => BrowserWindow | null): EventSink {
    return {
        emit<E extends EventName>(event: E, payload: Events[E]): void {
            const win = getWindow();
            if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
            win.webContents.send(event, payload);
        },
    };
}
