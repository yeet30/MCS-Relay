import './ram-slider.css';

const RAM_STEP = 512;
const RAM_SLIDER_MIN = 512;
const RAM_SLIDER_MAX = 32768;

/** 6144 -> "6 GB", 2560 -> "2.5 GB", 768 -> "768 MB". */
function formatRam(mb: number): string {
    if (mb < 1024) return `${mb} MB`;
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** One memory slider; the value is in MB, shown in GB. */
function RamSlider({ id, label, hint, value, onChange }: {
    id: string; label: string; hint: string; value: number; onChange: (mb: number) => void;
}) {
    const max = Math.max(RAM_SLIDER_MAX, value);
    const fill = ((Math.min(value, max) - RAM_SLIDER_MIN) / (max - RAM_SLIDER_MIN)) * 100;
    return (
        <div className='ram-row'>
            <label htmlFor={id}>
                {label}
                <small>{hint}</small>
            </label>
            <input
                id={id}
                type='range'
                min={RAM_SLIDER_MIN}
                max={max}
                step={RAM_STEP}
                value={value}
                style={{ '--fill': `${Math.max(0, fill)}%` } as React.CSSProperties}
                onChange={(e) => onChange(Number(e.target.value))}
            />
            <span className='ram-value'>{formatRam(value)}</span>
        </div>
    );
}

/** The server's memory: the most Java may use (-Xmx) and what it takes at start (-Xms). Each pulls the other along,
 *  so the start never exceeds the maximum. */
export default function RamSliders({ maxRAM, minRAM, onChange, idPrefix = 'ram' }: {
    maxRAM: number; minRAM: number; onChange: (ram: { maxRAM: number; minRAM: number }) => void; idPrefix?: string;
}) {
    return (
        <div className='ram-sliders'>
            <RamSlider id={`${idPrefix}-max`} label='Maximum' hint='-Xmx' value={maxRAM} onChange={(max) => onChange({ maxRAM: max, minRAM: Math.min(minRAM, max) })} />
            <RamSlider id={`${idPrefix}-min`} label='At start' hint='-Xms' value={minRAM} onChange={(min) => onChange({ minRAM: min, maxRAM: Math.max(maxRAM, min) })} />
        </div>
    );
}
