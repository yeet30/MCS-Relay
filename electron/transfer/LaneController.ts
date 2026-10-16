// Decides how many transfers run at once (AIMD, like TCP): one more lane after a streak of clean jobs,
// half the lanes when Google says "too many requests", and a fixed ceiling once more lanes stop helping.

export interface LaneControllerOptions {
    start: number;
    min: number;
    max: number;
    cleanJobsPerStep?: number;
}

export class LaneController {
    private current: number;
    private ceiling: number;
    private streak = 0;
    private readonly min: number;
    private readonly step: number;
    private readonly listeners = new Set<(lanes: number) => void>();

    constructor(opts: LaneControllerOptions) {
        this.min = Math.max(1, Math.floor(opts.min));
        const max = Math.max(this.min, Math.floor(opts.max));
        this.current = Math.min(max, Math.max(this.min, Math.floor(opts.start)));
        this.ceiling = max;
        this.step = Math.max(1, Math.floor(opts.cleanJobsPerStep ?? 20));
    }

    get lanes(): number {
        return this.current;
    }

    /** A job finished without being throttled. */
    onSuccess(): void {
        this.streak += 1;
        if (this.streak < this.step || this.current >= this.ceiling) return;
        this.streak = 0;
        this.set(this.current + 1);
    }

    /** Google answered 429 or a rate-limit 403. */
    onThrottled(): void {
        this.streak = 0;
        this.set(Math.max(this.min, Math.floor(this.current / 2)));
    }

    /** The last added lane did not make the transfer faster: the connection is full. */
    onNoSpeedGain(): void {
        this.streak = 0;
        this.ceiling = Math.max(this.min, this.current - 1);
        this.set(this.ceiling);
    }

    onChange(listener: (lanes: number) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private set(lanes: number): void {
        if (lanes === this.current) return;
        this.current = lanes;
        for (const listener of [...this.listeners]) listener(lanes);
    }
}
