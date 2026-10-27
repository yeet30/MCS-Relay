import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { offlineUuid, Whitelist } from './Whitelist';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(o: { online?: boolean; whitelist?: unknown } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-wl-'));
    dirs.push(dir);
    if (o.online === false) fs.writeFileSync(path.join(dir, 'server.properties'), 'online-mode=false\nwhite-list=true\n');
    if (o.whitelist !== undefined) fs.writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify(o.whitelist));
    // Mojang's profile lookup: a few known players.
    const fetchImpl = vi.fn(async (url: string) => {
        const name = decodeURIComponent(url.split('/').pop()!).toLowerCase();
        const known: Record<string, { id: string; name: string }> = { notch: { id: '069a79f444e94726a5befca90e38aaf5', name: 'Notch' } };
        return known[name] ? new Response(JSON.stringify(known[name])) : new Response('{}', { status: 404 });
    });
    const whitelist = new Whitelist({ settings: { getServer: () => ({ localPath: dir }) } as never, appVersion: '1.0.0', fetchImpl });
    const file = () => JSON.parse(fs.readFileSync(path.join(dir, 'whitelist.json'), 'utf8')) as unknown;
    return { whitelist, fetchImpl, file };
}

describe('Whitelist', () => {
    it('adds a player with the id and spelling Mojang has, in the file Minecraft reads', async () => {
        const t = setup();
        expect(await t.whitelist.list('s1')).toEqual([]);
        const players = await t.whitelist.add('s1', ' notch ');
        expect(players).toEqual([{ uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch' }]);
        expect(t.file()).toEqual(players);
        expect(t.fetchImpl).toHaveBeenCalledWith('https://api.mojang.com/users/profiles/minecraft/notch', expect.anything());
    });

    it('does not add a player twice, and keeps the players already there', async () => {
        const t = setup({ whitelist: [{ uuid: 'aaaa', name: 'Alex' }] });
        await t.whitelist.add('s1', 'Notch');
        const again = await t.whitelist.add('s1', 'NOTCH');
        expect(again.map((p) => p.name)).toEqual(['Alex', 'Notch']);
        expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('says so when no account has the name', async () => {
        const t = setup();
        await expect(t.whitelist.add('s1', 'nobody_here')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(t.whitelist.add('s1', 'not a name')).rejects.toMatchObject({ code: 'INVALID' });
    });

    it('uses offline ids on a server with online-mode off, without asking Mojang', async () => {
        const t = setup({ online: false });
        expect(await t.whitelist.add('s1', 'Steve')).toEqual([{ uuid: '5627dd98-e6be-3c21-b8a8-e92344183641', name: 'Steve' }]);
        expect(t.fetchImpl).not.toHaveBeenCalled();
    });

    it('removes a player', async () => {
        const t = setup({ whitelist: [{ uuid: 'aaaa', name: 'Alex' }, { uuid: 'bbbb', name: 'Steve' }] });
        expect(await t.whitelist.remove('s1', 'aaaa')).toEqual([{ uuid: 'bbbb', name: 'Steve' }]);
        expect(t.file()).toEqual([{ uuid: 'bbbb', name: 'Steve' }]);
    });
});

describe('offlineUuid', () => {
    it('matches Java\'s UUID.nameUUIDFromBytes("OfflinePlayer:<name>")', () => {
        expect(offlineUuid('Steve')).toBe('5627dd98-e6be-3c21-b8a8-e92344183641');
    });
});
