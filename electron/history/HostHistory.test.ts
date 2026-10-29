import { describe, expect, it } from 'vitest';
import type { HostedSession, LockContent } from '../../shared/types';
import { HostHistory } from './HostHistory';

function fakeLauncher(initial: string | null = null) {
    let text = initial;
    let writes = 0;
    return {
        launcher: {
            readText: async () => (text === null ? null : { id: 'h', text }),
            writeText: async (_serverId: string, _name: string, next: string) => {
                text = next;
                writes += 1;
                return 'h';
            },
        },
        text: () => text,
        writes: () => writes,
    };
}

const session = (id: string, startedAt: string, extra: Partial<HostedSession> = {}): HostedSession => ({
    id, host: { name: 'Steve', email: 'steve@example.com' }, startedAt, endedAt: startedAt.replace('T10', 'T12'), players: [], ended: 'stopped', ...extra,
});

describe('HostHistory', () => {
    it('adds sessions once each and lists them newest first', async () => {
        const f = fakeLauncher();
        const history = new HostHistory({ launcher: f.launcher as never });
        expect(await history.list('s1')).toEqual([]);
        await history.add('s1', session('a', '2026-10-27T10:00:00.000Z', { players: ['Alex', 'Alex', 'Steve'] }));
        await history.add('s1', session('b', '2026-10-28T10:00:00.000Z'));
        await history.add('s1', session('a', '2026-10-27T10:00:00.000Z'));
        expect(f.writes()).toBe(2);
        const list = await history.list('s1');
        expect(list.map((s) => s.id)).toEqual(['b', 'a']);
        expect(list[1].players).toEqual(['Alex', 'Steve']);
    });

    it('keeps the entries it understands from an older or damaged file', async () => {
        const good = session('a', '2026-10-27T10:00:00.000Z');
        const f = fakeLauncher(JSON.stringify({ format: 1, sessions: [good, { id: 3 }, null] }));
        expect(await new HostHistory({ launcher: f.launcher as never }).list('s1')).toEqual([good]);
        expect(await new HostHistory({ launcher: fakeLauncher('not json').launcher as never }).list('s1')).toEqual([]);
    });

    it('notes a session that never stopped from its stale lock', async () => {
        const f = fakeLauncher();
        const history = new HostHistory({ launcher: f.launcher as never });
        const lock: LockContent = {
            format: 2, sessionId: 'x', host: { name: 'Alex', email: 'alex@example.com' }, phase: 'running', leaseSeconds: 45,
            baseRevision: 3, startedAt: '2026-10-29T10:00:00.000Z', address: null, players: ['Alex'], tunnels: [],
        };
        await history.addUnstopped('s1', lock, '2026-10-29T11:30:00.000Z');
        await history.addUnstopped('s1', { ...lock, sessionId: 'never-ran', startedAt: null }, '2026-10-29T12:00:00.000Z');
        expect(await history.list('s1')).toEqual([{
            id: 'x', host: lock.host, startedAt: lock.startedAt, endedAt: '2026-10-29T11:30:00.000Z', players: ['Alex'], ended: 'unexpected',
        }]);
    });
});
