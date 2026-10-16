import type { ReactNode } from 'react';
import './popup.css';

interface PopupProps {
    isOpen: boolean;
    onClose: () => void;
    onAccept: () => void;
    confirmingOption: string;
    decliningOption: string;
    children: ReactNode;
}

export default function Popup({ isOpen, onClose, onAccept, confirmingOption, decliningOption, children }: PopupProps) {
    if (!isOpen) return null;

    return (
        <div className='popup-wrapper'>
            <div id='popup-overlay' onClick={(e) => { e.stopPropagation(); onClose(); }} />
            <div id='popup' onClick={(e) => e.stopPropagation()}>
                <div id='children' style={{ whiteSpace: 'pre-line' }}>{children}</div>
                <span id='popup-options'>
                    <button onClick={onClose}>{decliningOption}</button>
                    <button onClick={onAccept}>{confirmingOption}</button>
                </span>
                <button id='popup-close' onClick={onClose}>✕</button>
            </div>
        </div>
    );
}
