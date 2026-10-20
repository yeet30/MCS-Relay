import './modal.css';
import { useEffect, useState } from 'react';
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

    // Reset only when the modal opens: callers pass a new items array on every render, and the stores update
    // several times a second, so resetting on items would make the other tabs unreachable.
    useEffect(() => {
        if (isOpen) setActiveTab(initialTab);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    if (!isOpen || items.length === 0) return null;

    const safeIndex = activeTab < items.length ? activeTab : 0;

    return (
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
        </div>
    );
}
