import './notice-list.css';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Notice } from '../../stores/noticeStore';
import { useNoticeStore } from '../../stores/noticeStore';

const LIFETIME_MS: Record<Notice['kind'], number> = { success: 5000, info: 7000, error: 12000 };

function NoticeItem({ notice }: { notice: Notice }) {
    const dismiss = useNoticeStore((s) => s.dismiss);
    const [hovered, setHovered] = useState(false);
    const [showDetail, setShowDetail] = useState(false);

    useEffect(() => {
        if (hovered || showDetail) return;
        const timer = setTimeout(() => dismiss(notice.id), LIFETIME_MS[notice.kind]);
        return () => clearTimeout(timer);
    }, [hovered, showDetail, dismiss, notice.id, notice.kind]);

    return (
        <div
            className={`notice ${notice.kind}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            <div className='notice-text'>
                <span>{notice.message}</span>
                {notice.detail && (
                    <button className='notice-detail-toggle' onClick={() => setShowDetail((v) => !v)}>
                        {showDetail ? 'Hide details' : 'Details'}
                    </button>
                )}
                {showDetail && <code className='notice-detail'>{notice.detail}</code>}
            </div>
            <button className='notice-close' title='Dismiss' onClick={() => dismiss(notice.id)}><X size={14} /></button>
        </div>
    );
}

/** Toasts in the bottom-left corner; they replace the old alert() calls. */
export default function NoticeList() {
    const notices = useNoticeStore((s) => s.notices);
    if (notices.length === 0) return null;
    return (
        <div className='notice-list'>
            {notices.map((notice) => <NoticeItem key={notice.id} notice={notice} />)}
        </div>
    );
}
