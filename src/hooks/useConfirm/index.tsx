import { useCallback, useEffect, useRef, useState } from 'react';
import Popup from '../../components/popup';

export interface ConfirmOptions {
    message: string;
    confirmText?: string;
    cancelText?: string;
}

/** A promise-based confirm dialog. Render `popup` somewhere that stays mounted while the dialog is open.
 *  `confirm` is stable across renders, so it is safe in effect dependencies. */
export function useConfirm() {
    const [options, setOptions] = useState<ConfirmOptions | null>(null);
    const resolverRef = useRef<((value: boolean) => void) | null>(null);

    const settle = useCallback((value: boolean) => {
        const resolve = resolverRef.current;
        resolverRef.current = null;
        setOptions(null);
        resolve?.(value);
    }, []);

    const confirm = useCallback((next: ConfirmOptions) => {
        // A newer question replaces an unanswered one; the old caller gets "no" instead of waiting forever.
        resolverRef.current?.(false);
        setOptions(next);
        return new Promise<boolean>((resolve) => {
            resolverRef.current = resolve;
        });
    }, []);

    useEffect(() => () => {
        resolverRef.current?.(false);
        resolverRef.current = null;
    }, []);

    const popup = (
        <Popup
            isOpen={options !== null}
            onClose={() => settle(false)}
            onAccept={() => settle(true)}
            confirmingOption={options?.confirmText ?? 'Confirm'}
            decliningOption={options?.cancelText ?? 'Cancel'}
        >
            {options?.message ?? ''}
        </Popup>
    );

    return { confirm, popup };
}
