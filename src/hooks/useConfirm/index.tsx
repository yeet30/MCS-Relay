import { useCallback, useEffect, useRef, useState } from 'react';
import Popup from '../../components/popup';
import { invoke } from '../../api';

export interface ConfirmOptions {
    message: string;
    confirmText?: string;
    cancelText?: string;
    /** A link shown under the message, opened in the browser. */
    link?: { label: string; url: string };
}

/** yes, no, or null when the question was put away with the X or a click beside it. */
export type Answer = 'yes' | 'no' | null;

/** A promise-based confirm dialog. Render `popup` somewhere that stays mounted while the dialog is open.
 *  `confirm` (true only for yes) and `ask` (all three answers) are stable across renders, so they are safe in
 *  effect dependencies. */
export function useConfirm() {
    const [options, setOptions] = useState<ConfirmOptions | null>(null);
    const resolverRef = useRef<((value: Answer) => void) | null>(null);

    const settle = useCallback((value: Answer) => {
        const resolve = resolverRef.current;
        resolverRef.current = null;
        setOptions(null);
        resolve?.(value);
    }, []);

    const ask = useCallback((next: ConfirmOptions) => {
        // A newer question replaces an unanswered one; the old caller gets "put away" instead of waiting forever.
        resolverRef.current?.(null);
        setOptions(next);
        return new Promise<Answer>((resolve) => {
            resolverRef.current = resolve;
        });
    }, []);

    const confirm = useCallback(async (next: ConfirmOptions) => (await ask(next)) === 'yes', [ask]);

    useEffect(() => () => {
        resolverRef.current?.(null);
        resolverRef.current = null;
    }, []);

    const popup = (
        <Popup
            isOpen={options !== null}
            onClose={() => settle('no')}
            onAccept={() => settle('yes')}
            onDismiss={() => settle(null)}
            confirmingOption={options?.confirmText ?? 'Confirm'}
            decliningOption={options?.cancelText ?? 'Cancel'}
        >
            {options?.message ?? ''}
            {options?.link && (
                <button className='popup-link' onClick={() => void invoke('app:openExternal', options.link!.url)}>
                    {options.link.label}
                </button>
            )}
        </Popup>
    );

    return { confirm, ask, popup };
}
