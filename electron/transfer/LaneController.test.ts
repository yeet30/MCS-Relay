import { describe, expect, it } from 'vitest';
import { LaneController } from './LaneController';

function succeed(lanes: LaneController, times: number): void {
    for (let i = 0; i < times; i++) lanes.onSuccess();
}

describe('LaneController', () => {
    it('starts at the start value, clamped into [min, max]', () => {
        expect(new LaneController({ start: 4, min: 1, max: 12 }).lanes).toBe(4);
        expect(new LaneController({ start: 20, min: 1, max: 12 }).lanes).toBe(12);
        expect(new LaneController({ start: 0, min: 2, max: 12 }).lanes).toBe(2);
    });

    it('adds one lane after N clean jobs (20 by default)', () => {
        const lanes = new LaneController({ start: 4, min: 1, max: 12 });
        succeed(lanes, 19);
        expect(lanes.lanes).toBe(4);
        lanes.onSuccess();
        expect(lanes.lanes).toBe(5);
        succeed(lanes, 20);
        expect(lanes.lanes).toBe(6);
    });

    it('never goes above max', () => {
        const lanes = new LaneController({ start: 2, min: 1, max: 3, cleanJobsPerStep: 2 });
        succeed(lanes, 20);
        expect(lanes.lanes).toBe(3);
    });

    it('halves on throttling, never below min, and resets the streak', () => {
        const lanes = new LaneController({ start: 8, min: 1, max: 12, cleanJobsPerStep: 5 });
        succeed(lanes, 4);
        lanes.onThrottled();
        expect(lanes.lanes).toBe(4);
        lanes.onSuccess();                  // the streak restarted, so one success is not enough
        expect(lanes.lanes).toBe(4);
        lanes.onThrottled();
        lanes.onThrottled();
        expect(lanes.lanes).toBe(1);
        lanes.onThrottled();
        expect(lanes.lanes).toBe(1);

        const floor = new LaneController({ start: 5, min: 3, max: 12 });
        floor.onThrottled();
        expect(floor.lanes).toBe(3);
    });

    it('sets a ceiling of lanes - 1 when the last lane gave no speed gain', () => {
        const lanes = new LaneController({ start: 4, min: 1, max: 12, cleanJobsPerStep: 2 });
        succeed(lanes, 2);
        expect(lanes.lanes).toBe(5);
        lanes.onNoSpeedGain();
        expect(lanes.lanes).toBe(4);
        succeed(lanes, 50);
        expect(lanes.lanes).toBe(4);        // capped by the ceiling now
        lanes.onThrottled();
        expect(lanes.lanes).toBe(2);
        succeed(lanes, 50);
        expect(lanes.lanes).toBe(4);        // climbs back, but only up to the ceiling
    });

    it('a no-gain at min stays at min', () => {
        const lanes = new LaneController({ start: 1, min: 1, max: 4 });
        lanes.onNoSpeedGain();
        expect(lanes.lanes).toBe(1);
    });

    it('notifies listeners of real changes only, and unsubscribes', () => {
        const lanes = new LaneController({ start: 2, min: 1, max: 12, cleanJobsPerStep: 1 });
        const seen: number[] = [];
        const off = lanes.onChange((n) => seen.push(n));
        lanes.onSuccess();
        lanes.onThrottled();
        lanes.onThrottled();
        lanes.onThrottled();                // already at min: no change, no event
        off();
        lanes.onSuccess();
        expect(seen).toEqual([3, 1]);
        expect(lanes.lanes).toBe(2);
    });
});
