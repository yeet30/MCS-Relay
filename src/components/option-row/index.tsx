import './options-row.css';
import type { ReactNode } from 'react';

type OptionProps = {
    title: string;
    enable: boolean;
    onChange: (newValue: boolean) => void;
    children: ReactNode;
};

/** A setting that can be switched off as a whole; its details fade while it is off. */
export default function OptionRow({ title, enable, onChange, children }: OptionProps) {
    return (
        <div className={`option-card ${enable ? '' : 'off'}`}>
            <div className='option-head'>
                <h3>{title}</h3>
                <label className='switch' title={enable ? 'On' : 'Off'}>
                    <input type='checkbox' checked={enable} onChange={(e) => onChange(e.target.checked)} />
                    <span className='switch-track'><span className='switch-thumb' /></span>
                </label>
            </div>
            <div className='option-body' aria-disabled={!enable}>{children}</div>
        </div>
    );
}
