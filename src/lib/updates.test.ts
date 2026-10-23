import { describe, expect, test } from 'vitest';
import type { UpdateState } from '../../shared/types';
import { updateLine } from './updates';

const state = (patch: Partial<UpdateState>): UpdateState => ({ current: '1.0.0', status: 'idle', version: null, percent: 0, error: null, ...patch });

describe('updateLine', () => {
    test('says what the update is doing', () => {
        expect(updateLine(state({ status: 'downloading', version: '1.1.0', percent: 40 }))).toBe('Downloading version 1.1.0 (40%)…');
        expect(updateLine(state({ status: 'ready', version: '1.1.0' }))).toContain('installs when you quit');
        expect(updateLine(state({ status: 'error', error: 'offline' }))).toBe('The last check did not work: offline');
        expect(updateLine(state({ status: 'unavailable' }))).toContain('development build');
    });
});
