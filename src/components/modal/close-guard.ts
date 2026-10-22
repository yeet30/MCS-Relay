import { createContext, useContext, useEffect } from 'react';

/** Asked before a modal closes or switches tabs; true lets it. */
export type CloseGuard = () => Promise<boolean>;

/** Given by Modal to what it shows. */
export const CloseGuardContext = createContext<(guard: CloseGuard | null) => void>(() => undefined);

/** For what a modal shows: while `guard` is set, closing the modal (or switching its tab) asks it first, for
 *  example to offer saving changes. */
export function useCloseGuard(guard: CloseGuard | null): void {
    const register = useContext(CloseGuardContext);
    useEffect(() => {
        register(guard);
        return () => register(null);
    }, [register, guard]);
}
