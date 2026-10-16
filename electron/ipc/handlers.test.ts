import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandName, Result } from '../../shared/ipc';
import { createHandle } from './handle';
import type { IpcMainLike } from './handle';
import { httpsUrl, registerHandlers, ruleFromPick } from './handlers';
import type { HandlerDeps } from './handlers';

// A literal with every command: adding a command to shared/ipc.ts without listing it here is a compile error.
const ALL_COMMANDS: Record<CommandName, true> = {
    'auth:status': true, 'auth:login': true, 'auth:enableCollaboration': true, 'auth:logout': true,
    'servers:list': true, 'servers:create': true, 'servers:delete': true, 'servers:rename': true, 'servers:invite': true,
    'servers:removeMember': true, 'servers:leave': true, 'servers:join': true, 'servers:chooseLocalPath': true,
    'servers:openFolder': true, 'servers:info': true, 'servers:select': true,
    'session:get': true, 'session:preflight': true, 'session:lastReport': true, 'session:start': true, 'session:stop': true,
    'session:resolve': true, 'session:retryUpload': true, 'session:dismiss': true, 'session:command': true,
    'session:changes': true, 'session:transfers': true, 'session:steps': true, 'session:console': true,
    'settings:get': true, 'settings:set': true, 'settings:getServer': true, 'settings:setServer': true,
    'settings:choosePlayitPath': true,
    'rules:get': true, 'rules:set': true, 'rules:pickPath': true,
    'app:quitResponse': true, 'app:openExternal': true,
};

type Listener = (event: { senderFrame?: { url: string } | null }, ...args: unknown[]) => unknown;

function setup() {
    const listeners = new Map<string, Listener>();
    const ipc: IpcMainLike = { handle: (channel, listener) => void listeners.set(channel, listener) };
    const handle = createHandle(ipc, (url) => url.startsWith('app://'));
    const auto = () => new Proxy({}, { get: (target: Record<string, unknown>, key: string) => (target[key] ??= vi.fn(async () => undefined)) });
    const deps = {
        auth: auto(), servers: auto(), session: auto(), settings: auto(), sync: auto(), transfers: auto(),
        changes: auto(), dialogs: auto(), app: auto(),
    } as unknown as HandlerDeps;
    (deps.session.isBusy as unknown as ReturnType<typeof vi.fn>) = vi.fn(() => false);
    registerHandlers(handle, deps);
    const call = async (channel: string, ...args: unknown[]): Promise<Result<unknown>> =>
        (await listeners.get(channel)!({ senderFrame: { url: 'app://index.html' } }, ...args)) as Result<unknown>;
    return { listeners, deps, call };
}

describe('registerHandlers', () => {
    it('registers exactly the commands of the contract', () => {
        const { listeners } = setup();
        expect([...listeners.keys()].sort()).toEqual(Object.keys(ALL_COMMANDS).sort());
    });

    it('wraps results and errors in a Result', async () => {
        const { call, deps } = setup();
        (deps.settings.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ launchServer: true });
        expect(await call('settings:get')).toEqual({ ok: true, value: { launchServer: true } });
        const failed = await call('servers:delete', '../../etc');
        expect(failed).toMatchObject({ ok: false, error: { code: 'INVALID' } });
        expect(deps.servers.delete).not.toHaveBeenCalled();
    });

    it('checks arguments before a service sees them', async () => {
        const { call, deps } = setup();
        expect(await call('servers:invite', 'abc', 'not-an-email', 'writer', '')).toMatchObject({ ok: false });
        expect(await call('servers:invite', 'abc', 'bob@example.com', 'owner', '')).toMatchObject({ ok: false });
        expect(await call('servers:invite', 'abc', 'bob@example.com', 'writer', 'hi')).toMatchObject({ ok: true });
        expect(deps.servers.invite).toHaveBeenCalledWith('abc', 'bob@example.com', 'writer', 'hi');
        expect(await call('session:resolve', 'abc', 'overwrite-everything')).toMatchObject({ ok: false });
        expect(await call('app:quitResponse', 'yes')).toMatchObject({ ok: false });
        expect(await call('rules:set', 'abc', 'logs/')).toMatchObject({ ok: false });
    });

    it('refuses calls from other pages', async () => {
        const { listeners, deps } = setup();
        const result = await listeners.get('settings:get')!({ senderFrame: { url: 'https://evil.example' } });
        expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
        expect(deps.settings.get).not.toHaveBeenCalled();
    });

    it('does not log out in the middle of a session', async () => {
        const { call, deps } = setup();
        (deps.session.isBusy as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
        expect(await call('auth:logout')).toMatchObject({ ok: false, error: { code: 'BUSY' } });
        expect(deps.auth.logout).not.toHaveBeenCalled();
    });
});

describe('helpers', () => {
    it('only opens https links', () => {
        expect(httpsUrl('https://playit.gg/claim/abc')).toBe('https://playit.gg/claim/abc');
        expect(() => httpsUrl('file:///C:/Windows/system32/calc.exe')).toThrow();
        expect(() => httpsUrl('javascript:alert(1)')).toThrow();
    });

    it('turns a picked path into a rule inside the server folder', () => {
        const root = path.resolve('/srv/mc');
        expect(ruleFromPick(root, path.join(root, 'world', 'stats'), 'folder')).toBe('world/stats/');
        expect(ruleFromPick(root, path.join(root, 'ops.json'), 'file')).toBe('ops.json');
        expect(() => ruleFromPick(root, path.resolve('/srv/other'), 'folder')).toThrow();
        expect(() => ruleFromPick(root, root, 'folder')).toThrow();
    });
});
