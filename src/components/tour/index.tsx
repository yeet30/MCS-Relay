import './tour.css';
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';

const TARGET = '#menu-clicker';
const PAD = 6;

interface Box {
    top: number;
    left: number;
    width: number;
    height: number;
}

/** After an account's first server: the page dims, the settings menu is lit, and an arrow says what is in there.
 *  Shown once per Google account (tourDone). */
export default function Tour() {
    const open = useUiStore((s) => s.touring);
    const [box, setBox] = useState<Box | null>(null);

    useEffect(() => {
        if (!open) return undefined;
        const measure = () => {
            const rect = document.querySelector(TARGET)?.getBoundingClientRect();
            setBox(rect ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 } : null);
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [open]);

    if (!open || !box) return null;

    function done() {
        useUiStore.getState().openTour(false);
        void useSettingsStore.getState().update({ tourDone: true });
    }

    const cardTop = box.top + box.height + 70;
    const cardRight = Math.max(16, window.innerWidth - (box.left + box.width));
    // From under the card's top right corner up to the lit menu.
    const arrowX = box.left + box.width / 2;
    return (
        <div className='tour' role='dialog' aria-label='Where your servers are managed'>
            <div className='tour-spot' style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />
            <svg className='tour-arrow' width={window.innerWidth} height={window.innerHeight} aria-hidden>
                <defs>
                    <marker id='tour-head' markerWidth='10' markerHeight='10' refX='5' refY='5' orient='auto'>
                        <path d='M0,0 L10,5 L0,10 z' fill='#ffffff' />
                    </marker>
                </defs>
                <path
                    d={`M ${arrowX - 70} ${cardTop - 6} Q ${arrowX - 60} ${box.top + box.height + 20} ${arrowX - 8} ${box.top + box.height + 8}`}
                    stroke='#ffffff'
                    strokeWidth='2.5'
                    fill='none'
                    markerEnd='url(#tour-head)'
                />
            </svg>
            <div className='tour-card' style={{ top: cardTop, right: cardRight }}>
                <h3>Your server is ready</h3>
                <p>
                    Everything about your servers is in this menu. <b>Servers</b> holds their names, folders and members, and
                    where you invite your friends. <b>Scripts</b> holds Java, memory and playit.gg.
                </p>
                <button className='text-button primary' onClick={done} autoFocus>Got it</button>
            </div>
        </div>
    );
}
