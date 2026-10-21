import './modal.css';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../../hooks/useScrollLock';
import type { IModalItems } from '../../lib/ui-types';

interface IModal {
    isOpen: boolean;
    onClose: () => void;
    items: IModalItems[];
    width?: number;
    height?: number;
    /** The tab shown when the modal opens. */
    initialTab?: number;
}

export default function Modal({ isOpen, onClose, items, width = 400, height = 300, initialTab = 0 }: IModal) {
    const [activeTab, setActiveTab] = useState(0);
    useScrollLock(isOpen);

    // Reset only when the modal opens: callers pass a new items array on every render, and the stores update
    // several times a second, so resetting on items would make the other tabs unreachable.
    useEffect(() => {
        if (isOpen) setActiveTab(initialTab);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    if (!isOpen || items.length === 0) return null;

    const safeIndex = activeTab < items.length ? activeTab : 0;

    // Rendered at the end of <body>: a modal opened from inside a small component (the folder button, a card) is
    // otherwise caught in that component's stacking layer and can end up under other parts of the page.
    return createPortal(
        <div className='modal-wrapper'>
            <div id='modal-overlay' onClick={onClose} />
            <div id='modal' style={{ width, height }}>
                <button id='modal-close' onClick={onClose}>✕</button>
                <div className='tab-section'>
                    <div id='modal-tabs'>
                        {items.map((item, index) => (
                            <h4
                                key={index}
                                className={`tab ${safeIndex === index ? 'active' : ''}`}
                                onClick={() => setActiveTab(index)}
                            >
                                {item.title}
                            </h4>
                        ))}
                    </div>
                    <div id='title-seperator' />
                </div>
                <div id='children'>{items[safeIndex].content}</div>
            </div>
        </div>,
        document.body,
    );
}
