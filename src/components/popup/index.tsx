import type { ReactNode } from 'react';
import './popup.css';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../../hooks/useScrollLock';

interface PopupProps {
    isOpen: boolean;
    onClose: () => void;
    onAccept: () => void;
    confirmingOption: string;
    decliningOption: string;
    children: ReactNode;
}

export default function Popup({ isOpen, onClose, onAccept, confirmingOption, decliningOption, children }: PopupProps) {
    useScrollLock(isOpen);
    if (!isOpen) return null;

    // At the end of <body>, above everything, wherever the component that asks sits (see Modal).
    return createPortal(
        <div className='popup-wrapper'>
            <div id='popup-overlay' onClick={(e) => { e.stopPropagation(); onClose(); }} />
            <div id='popup' onClick={(e) => e.stopPropagation()}>
                <div id='children' style={{ whiteSpace: 'pre-line' }}>{children}</div>
                <span id='popup-options'>
                    <button className='popup-decline' onClick={onClose}>{decliningOption}</button>
                    <button className='popup-accept' onClick={onAccept}>{confirmingOption}</button>
                </span>
                <button id='popup-close' onClick={onClose}>✕</button>
            </div>
        </div>,
        document.body,
    );
}
