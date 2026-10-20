// The short "ring" played when a start or stop finishes. Synthesised with Web Audio, so there is no sound file:
// two bell-like notes going up when it worked, going down when it failed.

/** One audio context for the page (browsers limit how many may exist). */
let context: AudioContext | null = null;

function bell(ctx: AudioContext, frequency: number, at: number): void {
    // A bell is a fundamental plus a quieter, faster-fading overtone.
    for (const [ratio, peak, decay] of [[1, 0.22, 1.1], [2.76, 0.06, 0.45]] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency * ratio;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + decay + 0.05);
    }
}

export function playChime(outcome: 'done' | 'failed'): void {
    try {
        context ??= new AudioContext();
        const ctx = context;
        if (ctx.state === 'suspended') void ctx.resume();
        const notes = outcome === 'done' ? [880, 1318.5] : [659.3, 440];
        const start = ctx.currentTime + 0.03;
        notes.forEach((frequency, i) => bell(ctx, frequency, start + i * 0.17));
    } catch (err) {
        console.warn('[chime] could not play the sound:', err);
    }
}
