// Composition root: creates every service once, wires them together, and owns the window, the tray
// and the quit flow. No business logic lives here.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TITLE_BAR_HEIGHT, WINDOW_COLORS } from '../shared/types';
import type { LogoState, ThemeName } from '../shared/types';
import { GoogleAuth } from './auth/GoogleAuth';
import { DriveClient } from './drive/DriveClient';
import { DriveFiles } from './drive/DriveFiles';
import { AppError } from './errors';
import { createDialogs } from './ipc/dialogs';
import { createEventSink, createHandle } from './ipc/handle';
import { registerHandlers } from './ipc/handlers';
import { LockService } from './lock/LockService';
import { MinecraftProcess } from './processes/MinecraftProcess';
import { PlayitProcess } from './processes/PlayitProcess';
import { ServersService } from './servers/ServersService';
import { SessionController } from './session/SessionController';
import { SettingsService } from './settings/SettingsService';
import { AppData } from './store/appData';
import { ChangeTracker } from './sync/changeTracker';
import { LauncherFiles } from './sync/launcherFiles';
import { SyncEngine } from './sync/SyncEngine';
import { TransferEngine } from './transfer/TransferEngine';

const DATA_FOLDER = 'minecraft-distributed-hosting';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ├─┬ dist            the renderer
// └─┬ dist-electron   main.js, preload.mjs
process.env.APP_ROOT = path.join(__dirname, '..');
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let logoState: LogoState = 'off';

/* ------------------------------------------------------------------ services (created once) */

// The data folder keeps the name it had before the app was called MCS-Relay: logins, server folders, sync state
// and unfinished uploads stay where they are. Set before anything (the single-instance lock too) uses it.
app.setPath('userData', path.join(app.getPath('appData'), DATA_FOLDER));
const userData = app.getPath('userData');
const appData = new AppData(userData);
const dialogs = createDialogs(() => win);
const events = createEventSink(() => win);
const settings = new SettingsService({ appData, dialogs, onChange: (s) => applyWindowTheme(s.theme) });
const auth = new GoogleAuth({
    userDataDir: userData,
    credentialsPath: path.join(app.getAppPath(), 'config', 'client_secret.json'),
    openExternal: (url) => shell.openExternal(url),
    safeStorage,
    // Server folders, bases and journals are kept per Google account.
    onUserChanged: (user) => appData.setAccount(user?.email ?? null),
});
const drive = new DriveFiles(new DriveClient({ auth }));
const launcher = new LauncherFiles(drive);
const me = () => auth.me();

// The callbacks below use `session`, declared further down; services call them later, never in constructors.
const lock = new LockService({
    drive, launcher, me,
    onLost: (serverId, reason) => session.onLockLost(serverId, reason),
    remember: {
        // An upload journal names its session too, which covers journals written before lock-session.json existed.
        read: (serverId) => appData.readLockSession(serverId) ?? appData.readJournal(serverId)?.sessionId ?? null,
        write: (serverId, sessionId) => appData.writeLockSession(serverId, sessionId),
    },
});
const transfers = new TransferEngine({
    drive, me,
    emit: (snapshot) => {
        events.emit('transfer:progress', snapshot);
        session.onTransfer(snapshot);
    },
});
const sync = new SyncEngine({
    drive, launcher, lock, transfers, appData, settings, me,
    step: (message, status, importance) => session.step(message, status, importance),
});
const changes = new ChangeTracker({
    emit: (batch) => events.emit('changes:batch', batch),
    reset: () => events.emit('changes:reset', null),
});
const minecraft = new MinecraftProcess({
    onOutput: (lines) => session.onMinecraftOutput(lines),
    onPlayers: (players) => session.onPlayers(players),
    onExit: (code, expected) => session.onMinecraftExit(code, expected),
});
const playit = new PlayitProcess();
const session: SessionController = new SessionController({
    lock, sync, changes, minecraft, playit, settings, events, me,
    notify: (n) => notifyUser(n),
    serverName: (serverId) => servers.nameOf(serverId),
});
const servers = new ServersService({
    drive, launcher, auth, settings, appData, dialogs,
    beforeDelete: async (serverId) => {
        const view = await lock.inspect(serverId);
        if (view.state === 'held' || view.state === 'mine') {
            throw new AppError('LOCK_HELD', `${view.lock.host.name} is using this server right now. Delete it when they have finished.`);
        }
        return sync.markForeignFilesDeleted(serverId, (done, total) => events.emit('servers:deleting', { serverId, done, total }));
    },
});

/* ------------------------------------------------------------------ notifications */

/** A start or stop finished: a chime (if on), and a desktop notification (if on) when the window is not in front. */
function notifyUser(n: { title: string; body: string; outcome: 'done' | 'failed' }): void {
    const prefs = settings.get();
    if (prefs.notificationSound) events.emit('app:chime', { outcome: n.outcome });
    const inFront = win !== null && win.isVisible() && win.isFocused();
    if (!prefs.notifications || inFront || !Notification.isSupported()) return;
    // silent: the chime above is the sound, so Windows does not play its own on top of it.
    const notification = new Notification({ title: n.title, body: n.body, silent: true, icon: path.join(process.env.VITE_PUBLIC, 'launcher.ico') });
    notification.on('click', showWindow);
    notification.show();
}

/* ------------------------------------------------------------------ quit flow */

let quitAllowed = false;
let quitting = false;
let quitPending = false;

function showWindow(): void {
    if (!win) createWindow();
    win?.show();
    win?.focus();
}

/** Close button, tray "Quit" and OS quit all come here. A busy session asks the user first. */
function requestQuit(): void {
    if (quitting) return;
    if (!session.isBusy()) {
        void quit();
        return;
    }
    showWindow();
    quitPending = true;
    events.emit('app:confirmQuit', { phase: session.getState().phase, sessionActive: true });
}

function quitResponse(confirmed: boolean): void {
    if (!quitPending) return;
    quitPending = false;
    if (confirmed) void quit();
}

async function quit(): Promise<void> {
    if (quitting) return;
    quitting = true;
    events.emit('app:quitting', null);
    try {
        await session.shutdown();          // a running server is stopped and uploaded first
    } catch (err) {
        console.error('[main] shutdown failed:', err);
    }
    session.dispose();
    lock.dispose();
    quitAllowed = true;
    app.quit();
}

/* ------------------------------------------------------------------ window and tray */

function isTrustedUrl(url: string): boolean {
    if (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) return true;
    return url.startsWith('file://') && decodeURIComponent(new URL(url).pathname).includes('/dist/');
}

/** The title bar and the window's background follow the theme (the page draws the bar's left part itself). */
function applyWindowTheme(theme: ThemeName): void {
    if (!win) return;
    const colors = WINDOW_COLORS[theme];
    win.setBackgroundColor(colors.page);
    if (process.platform === 'win32') {
        win.setTitleBarOverlay({ color: colors.titleBar, symbolColor: colors.titleText, height: TITLE_BAR_HEIGHT });
    }
}

function createWindow(): void {
    const colors = WINDOW_COLORS[settings.get().theme];
    win = new BrowserWindow({
        width: 800,
        height: 600,
        resizable: false,
        maximizable: false,
        backgroundColor: colors.page,
        // Windows draws only the minimise and close buttons, in the theme's colours; the page draws the rest.
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: colors.titleBar, symbolColor: colors.titleText, height: TITLE_BAR_HEIGHT },
        icon: stateIcon(logoState, 'ico'),
        // The chime is played by the page, also while the window is hidden in the tray.
        webPreferences: { preload: path.join(__dirname, 'preload.mjs'), autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
    });
    win.removeMenu();                                 // no File / Edit / View bar: the app has its own menu
    win.on('minimize', () => win?.hide());            // minimised to the tray
    win.on('close', (event) => {
        if (quitAllowed) return;
        event.preventDefault();
        requestQuit();
    });
    win.on('closed', () => {
        win = null;
    });
    // Links never open inside the app; https links open in the browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://')) void shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (!isTrustedUrl(url)) event.preventDefault();
    });

    if (VITE_DEV_SERVER_URL) void win.loadURL(VITE_DEV_SERVER_URL);
    else void win.loadFile(path.join(RENDERER_DIST, 'index.html'));
}

const LOGO_TOOLTIPS: Record<LogoState, string> = {
    off: 'MCS-Relay',
    here: 'MCS-Relay: you are hosting the selected server',
    elsewhere: 'MCS-Relay: someone else is hosting the selected server',
};

/** public/state/<state>.ico (taskbar) or .png (tray; Electron picks the @2x file on scaled displays). */
function stateIcon(state: LogoState, kind: 'ico' | 'png'): string {
    return path.join(process.env.VITE_PUBLIC, 'state', `${state}.${kind}`);
}

/** The taskbar and tray icons follow the comparator in the title bar; the desktop icon (launcher.ico) stays. */
function applyLogoState(state: LogoState): void {
    if (state === logoState) return;
    logoState = state;
    win?.setIcon(nativeImage.createFromPath(stateIcon(state, 'ico')));
    tray?.setImage(nativeImage.createFromPath(stateIcon(state, 'png')));
    tray?.setToolTip(LOGO_TOOLTIPS[state]);
}

function createTray(): void {
    tray = new Tray(nativeImage.createFromPath(stateIcon(logoState, 'png')));
    tray.setToolTip(LOGO_TOOLTIPS[logoState]);
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open', click: showWindow },
        { label: 'Quit', click: requestQuit },
    ]));
    tray.on('click', showWindow);
}

/* ------------------------------------------------------------------ app lifecycle */

// Two copies of the app would share the same base and journal files and fight over the lock.
if (!app.requestSingleInstanceLock()) {
    quitAllowed = true;
    app.quit();
} else {
    app.on('second-instance', showWindow);

    app.on('before-quit', (event) => {
        if (quitAllowed) return;
        event.preventDefault();
        requestQuit();
    });

    app.on('window-all-closed', () => {
        if (quitAllowed) app.quit();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Windows shows notifications only for an app with an id (in development: the Electron binary).
    if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.yeet.mcsrelay' : process.execPath);

    void app.whenReady().then(async () => {
        appData.migrateLegacy();
        registerHandlers(createHandle(ipcMain, isTrustedUrl), {
            auth, servers, session, settings, sync, transfers, changes, dialogs,
            app: { quitResponse, openExternal: (url) => shell.openExternal(url), setLogoState: applyLogoState },
        });
        createTray();
        createWindow();
        try {
            const status = await auth.status();
            if (status.loggedIn) await session.resumeUnfinishedUploads();
        } catch (err) {
            console.warn('[main] could not resume unfinished uploads at startup:', err);
        }
    });
}
