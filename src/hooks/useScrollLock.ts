import { useEffect } from 'react';

/** While `active`, the page behind a modal or popup does not scroll. Several open at once are counted, so the
 *  page scrolls again only when the last one closes. */
export function useScrollLock(active: boolean): void {
    useEffect(() => {
        if (!active) return undefined;
        const root = document.documentElement;
        const count = Number(root.dataset.scrollLocks ?? '0') + 1;
        root.dataset.scrollLocks = String(count);
        root.style.overflow = 'hidden';
        return () => {
            const left = Math.max(0, Number(root.dataset.scrollLocks ?? '1') - 1);
            root.dataset.scrollLocks = String(left);
            if (left === 0) root.style.overflow = '';
        };
    }, [active]);
}
