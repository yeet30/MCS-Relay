import './startup-progress.css';
import { useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import type { StepMessage } from '../../../shared/types';
import { formatClock } from '../../lib/format';
import { latestSteps } from '../../lib/steps';
import { useSessionStore } from '../../stores/sessionStore';
import Modal from '../modal';

function StepLine({ step }: { step: StepMessage }) {
    return (
        <div className={`progress-step ${step.status} ${step.importance}`}>
            {step.status === 'loading' && <Loader2 size={12} className='spinner' />}
            {step.status === 'done' && <Check size={12} />}
            {step.status === 'error' && <X size={12} />}
            <span>{step.message}</span>
        </div>
    );
}

function StepHistory() {
    const steps = useSessionStore((s) => s.steps);
    if (steps.length === 0) return <p className='empty-steps'>Nothing has happened yet.</p>;
    return (
        <div className='step-history'>
            {[...steps].reverse().map((step, i) => (
                <div key={`${step.at}-${i}`} className='history-row'>
                    <span className='history-time'>{formatClock(step.at)}</span>
                    <StepLine step={step} />
                </div>
            ))}
        </div>
    );
}

/** The latest step of the session (and the step under it); "compact" while idle shows only the last result. */
export default function StartupProgress({ compact = false }: { compact?: boolean }) {
    const steps = useSessionStore((s) => s.steps);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const { major, minor } = latestSteps(steps);
    if (!major && !minor) return null;
    if (compact && major?.status === 'loading') return null;

    return (
        <div className={`startup-progress ${compact ? 'compact' : ''}`}>
            <Modal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                width={520}
                height={360}
                items={[{ title: 'Progress Details', content: <StepHistory /> }]}
            />
            {major && <StepLine step={major} />}
            {!compact && minor && <StepLine step={minor} />}
            <button className='details-button' onClick={() => setIsModalOpen(true)}>
                Show detailed progress
            </button>
        </div>
    );
}
