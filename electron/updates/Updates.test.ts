import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../shared/types';
import { Updates } from './Updates';
import type { UpdaterLike } from './Updates';

/** Plays electron-updater: events in the order it sends them. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
    autoDownload = false;
    autoInstallOnAppQuit = false;
    checkForUpdates = vi.fn(async () => undefined);
    quitAndInstall = vi.fn();
}

function setup(updater: FakeUpdater | null = new FakeUpdater()) {
    const states: UpdateState[] = [];
    const updates = new Updates({ updater, current: '1.0.0', emit: (s) => states.push(s), firstCheckMs: 10, checkEveryMs: 50 });
    return { updater, updates, states };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('Updates', () => {
    it('downloads a newer version on its own and installs it when the app quits', () => {
        const { updater } = setup();
        expect(updater?.autoDownload).toBe(true);
        expect(updater?.autoInstallOnAppQuit).toBe(true);
    });

    it('follows the check, the download and the ready update', () => {
        const { updater, updates } = setup();
        updater!.emit('checking-for-update');
        expect(updates.get()).toMatchObject({ status: 'checking' });
        updater!.emit('update-available', { version: '1.1.0' });
        updater!.emit('download-progress', { percent: 41.6 });
        expect(updates.get()).toMatchObject({ status: 'downloading', version: '1.1.0', percent: 42 });
        updater!.emit('update-downloaded', { version: '1.1.0' });
        expect(updates.get()).toEqual({ current: '1.0.0', status: 'ready', version: '1.1.0', percent: 100, error: null });
        expect(updates.install()).toBe(true);
        expect(updater!.quitAndInstall).toHaveBeenCalledWith(true, true);
    });

    it('says when it is up to date, and keeps only the first line of an error', async () => {
        const { updater, updates } = setup();
        updater!.emit('update-not-available', { version: '1.0.0' });
        expect(updates.get().status).toBe('up-to-date');
        updater!.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED\n<html>long page</html>'));
        expect(await updates.check()).toMatchObject({ status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
    });

    it('does not check again while downloading or with an update waiting, and installs only a ready one', async () => {
        const { updater, updates } = setup();
        expect(updates.install()).toBe(false);
        updater!.emit('update-available', { version: '1.1.0' });
        await updates.check();
        expect(updater!.checkForUpdates).not.toHaveBeenCalled();
    });

    it('checks a little after startup and then again later', async () => {
        vi.useFakeTimers();
        const { updater, updates } = setup();
        updates.start();
        await vi.advanceTimersByTimeAsync(10);
        expect(updater!.checkForUpdates).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(50);
        expect(updater!.checkForUpdates).toHaveBeenCalledTimes(2);
        updates.dispose();
    });

    it('does nothing in development', async () => {
        const { updates } = setup(null);
        updates.start();
        expect(await updates.check()).toMatchObject({ status: 'unavailable', current: '1.0.0' });
        expect(updates.install()).toBe(false);
    });
});
