// The typed face of window.api (exposed by electron/preload.ts). Every request goes through invoke() and every
// pushed event through on(), so a mistyped channel, argument or payload is a compile error (F31).
import type { CommandArgs, CommandName, CommandResult, EventName, Events, Result } from '../shared/ipc';
import type { AppErrorInfo } from '../shared/types';

/** Told about every NOT_SIGNED_IN result. The renderer has exactly one bridge, so this set is the module's
 *  singleton; src/stores/events.ts registers the listener that sends the user to the login page. */
const signedOutListeners = new Set<(message: string) => void>();

function isResult(value: unknown): value is Result<unknown> {
    if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
    if (value.ok === true) return 'value' in value;
    return value.ok === false && 'error' in value && typeof value.error === 'object' && value.error !== null;
}

function bridgeError(detail: string): AppErrorInfo {
    return { code: 'UNKNOWN', message: 'The app could not reach its background process.', detail };
}

export async function invoke<C extends CommandName>(channel: C, ...args: CommandArgs<C>): Promise<Result<CommandResult<C>>> {
    let result: Result<CommandResult<C>>;
    try {
        const raw: unknown = await window.api.invoke(channel, ...args);
        // handle() in the main process always answers with a Result; anything else means a missing handler.
        result = isResult(raw) ? (raw as Result<CommandResult<C>>) : { ok: false, error: bridgeError(`${channel} returned no result`) };
    } catch (err) {
        result = { ok: false, error: bridgeError(err instanceof Error ? err.message : String(err)) };
    }
    if (!result.ok && result.error.code === 'NOT_SIGNED_IN') {
        for (const listener of signedOutListeners) listener(result.error.message);
    }
    return result;
}

/** Subscribes to a pushed event; returns the unsubscribe function. */
export function on<E extends EventName>(event: E, listener: (payload: Events[E]) => void): () => void {
    return window.api.on(event, (payload) => listener(payload as Events[E]));
}

export function onSignedOut(listener: (message: string) => void): () => void {
    signedOutListeners.add(listener);
    return () => {
        signedOutListeners.delete(listener);
    };
}
