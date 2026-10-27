// Composition root: creates every service once, wires them together, and owns the window, the tray
// and the quit flow. No business logic lives here.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { format } from 'node:util';
import type { EventName, Events } from '../shared/ipc';
import { TERMS_VERSION, TITLE_BAR_HEIGHT, WINDOW_COLORS } from '../shared/types';
import type { LogoState, SessionPhase, ThemeName } from '../shared/types';
import { unscrambleClient } from './auth/embeddedClient';
import { GoogleAuth } from './auth/GoogleAuth';
import { BackupService } from './backups/BackupService';
import { ServerInstaller } from './installer/ServerInstaller';
import { DriveClient } from './drive/DriveClient';
import { DriveFiles } from './drive/DriveFiles';
import { AppError } from './errors';
import { createDialogs } from './ipc/dialogs';
import { createEventSink, createHandle } from './ipc/handle';
import { registerHandlers } from './ipc/handlers';
import { LockService } from './lock/LockService';
import { AppLog } from './log/AppLog';
import { MinecraftProcess } from './processes/MinecraftProcess';
import { PlayitLink } from './playit/PlayitLink';
import { JavaInstaller } from './installer/JavaInstaller';
import { ServerProperties } from './servers/ServerProperties';
import { PlayitRunner } from './playit/PlayitRunner';
import { PlayitProcess } from './processes/PlayitProcess';
import { ReportService } from './report/ReportService';
import { ServersService } from './servers/ServersService';
import { SessionController } from './session/SessionController';
import { SettingsService } from './settings/SettingsService';
import { AppData } from './store/appData';
import { resolveDataFolder } from './store/dataFolder';
import { ChangeTracker } from './sync/changeTracker';
import { LauncherFiles } from './sync/launcherFiles';
import { SyncEngine } from './sync/SyncEngine';
import { TransferEngine } from './transfer/TransferEngine';
import { Updates } from './updates/Updates';
import type { UpdaterLike } from './updates/Updates';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ├─┬ dist            the renderer
// └─┬ dist-electron   main.js, preload.mjs
process.env.APP_ROOT = path.join(__dirname, '..');
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let logoState: LogoState = 'off';
/** The theme the window was last painted in: other settings changes (a selected server, ...) leave it alone. */
let windowTheme: ThemeName | null = null;

/* ------------------------------------------------------------------ services (created once) */

// %APPDATA%\mcs-relay (the folder of earlier builds is moved there once, see dataFolder.ts). Set before anything (the
// single-instance lock too) uses it.
app.setPath('userData', resolveDataFolder(app.getPath('appData')));
const userData = app.getPath('userData');

// The log a problem report carries: everything below that is written to the console, and what the user sees happen.
const appLog = new AppLog(path.join(userData, 'logs'));
appLog.captureConsole();
console.log(`[main] MCS-Relay ${app.getVersion()}${app.isPackaged ? '' : ' (development build)'} starting; ${aboutPc()}`);
process.on('uncaughtExceptionMonitor', (err, origin) => appLog.write('error', `[main] ${origin}: ${format(err)}`));

const appData = new AppData(userData);
const dialogs = createDialogs(() => win);
const events = loggedEvents(createEventSink(() => win));
const settings = new SettingsService({
    appData, dialogs,
    onChange: (s) => {
        applyWindowTheme(s.theme);
        updateTrayMenu();                       // the selected server may have changed
    },
});
const auth = new GoogleAuth({
    userDataDir: userData,
    client: unscrambleClient(__MCS_RELAY_CLIENT__),
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
    onChange: (serverId, view) => session.lockChanged(serverId, view),
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
// playit.gg linked in the app (Settings > Server settings), or a playit program chosen by hand.
const playitProcess = new PlayitProcess();
const playitLink = new PlayitLink({
    dir: path.join(userData, 'playit'),
    agentName: `MCS-Relay (${os.hostname()})`,
    openExternal: (url) => shell.openExternal(url),
    safeStorage,
    emit: (state) => events.emit('playit:state', state),
    agentProcess: playitProcess,
    onLinked: (address) => {
        // The link replaces a playit program chosen by hand (which may since have been uninstalled).
        settings.set({ usePlayitgg: true, playitggPath: '' });
        playitLinked(address);
    },
});
const playit = new PlayitRunner(playitLink, playitProcess);
const session: SessionController = new SessionController({
    lock, sync, changes, minecraft, playit, settings, events, me,
    notify: (n) => notifyUser(n),
    serverName: (serverId) => servers.nameOf(serverId),
});
/** electron-updater, loaded at run time instead of bundled: it reads the update settings electron-builder puts next to
 *  the installed app. A development build has none, so it gets no updater. */
function loadUpdater(): UpdaterLike | null {
    if (!app.isPackaged) return null;
    const { autoUpdater } = createRequire(import.meta.url)('electron-updater') as { autoUpdater: UpdaterLike };
    return autoUpdater;
}
const updates = new Updates({ updater: loadUpdater(), current: app.getVersion(), emit: (state) => events.emit('app:update', state) });

const backups = new BackupService({
    settings, drive, launcher, session, me, appVersion: app.getVersion(),
    hasUnfinishedUpload: (serverId) => appData.readJournal(serverId) !== null,
    emit: (progress) => events.emit('backups:progress', progress),
});

/** The automatic backup while this PC hosts: every autoBackupMinutes, the first one that long after the start, into
 *  the one copy that is kept up to date (see BackupService.autoBackup). */
let hostingSince: { serverId: string; lastBackup: number } | null = null;
setInterval(() => {
    const state = session.getState();
    if (state.phase !== 'running' || !state.javaRunning || !state.serverId) {
        hostingSince = null;
        return;
    }
    if (hostingSince?.serverId !== state.serverId) hostingSince = { serverId: state.serverId, lastBackup: Date.now() };
    const minutes = settings.get().autoBackupMinutes;
    if (!minutes || backups.isBusy() || Date.now() - hostingSince.lastBackup < minutes * 60_000) return;
    hostingSince.lastBackup = Date.now();
    void backups.autoBackup(state.serverId).catch((err: unknown) => console.warn('[backups] the automatic backup failed:', err));
}, 30_000);

const installer = new ServerInstaller({
    settings, appVersion: app.getVersion(),
    isBusy: (serverId) => session.isBusy() && session.getState().serverId === serverId,
    emit: (progress) => events.emit('installer:progress', progress),
});

// Java for a server that needs a newer one than this PC has (Eclipse Temurin from Adoptium).
const java = new JavaInstaller({
    dir: path.join(userData, 'java'), settings, appVersion: app.getVersion(),
    emit: (progress) => events.emit('installer:progress', progress),
});

const properties = new ServerProperties({ settings });

const reports = new ReportService({
    log: appLog, drive, me, chooseSaveFile: dialogs.chooseSaveFile,
    about: () => {
        const s = settings.get();
        const state = session.getState();
        const name = (id: string | null) => (id ? `"${servers.nameOf(id) ?? '?'}" (${id})` : 'none');
        return [
            `MCS-Relay ${app.getVersion()}${app.isPackaged ? '' : ' (development build)'}`,
            aboutPc(),
            `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}`,
            `Selected server: ${name(s.selectedServerId)}`,
            `Session: ${state.phase}, server ${name(state.serverId)}${state.error ? `, error: ${state.error.message}` : ''}`,
            `Settings: Minecraft server ${s.launchServer ? 'on' : 'off'}, playit.gg ${s.usePlayitgg ? 'on' : 'off'} (${playitLink.isLinked() ? 'linked in the app' : s.playitggPath ? 'own program' : 'not set up'}), theme ${s.theme}`,
            `Update: ${updates.get().status}`,
        ];
    },
});

const servers = new ServersService({
    drive, launcher, auth, settings, appData, dialogs, homeDir: app.getPath('home'),
    writeShortcut: (link, target) => shell.writeShortcutLink(link, 'create', { target }),
    moveToTrash: (target) => shell.trashItem(target),
    beforeDelete: async (serverId) => {
        const view = await lock.inspect(serverId);
        if (view.state === 'held' || view.state === 'mine') {
            throw new AppError('LOCK_HELD', `${view.lock.host.name} is using this server right now. Delete it when they have finished.`);
        }
        return sync.markForeignFilesDeleted(serverId, (done, total) => events.emit('servers:deleting', { serverId, done, total }));
    },
});

/* ------------------------------------------------------------------ log */

function aboutPc(): string {
    return `Windows ${os.release()} (${os.version()}), ${process.arch}, ${Math.round(os.totalmem() / 2 ** 30)} GB memory`;
}

/** The events the window gets, with what the user sees happen also written to the log: every progress line, phase
 *  change and update status. Transfers and the Minecraft console are left out (too many lines, and players' chat). */
function loggedEvents(sink: ReturnType<typeof createEventSink>): ReturnType<typeof createEventSink> {
    let phase: SessionPhase | null = null;
    let updateStatus: string | null = null;
    return {
        emit<E extends EventName>(event: E, payload: Events[E]): void {
            if (event === 'session:step') {
                const step = payload as Events['session:step'];
                console.log(`[step] ${step.status}: ${step.message}`);
            } else if (event === 'session:state') {
                const state = payload as Events['session:state'];
                if (state.phase !== phase) {
                    phase = state.phase;
                    setImmediate(updateTrayMenu);
                    const error = state.error ? `: ${state.error.message}${state.error.detail ? ` (${state.error.detail})` : ''}` : '';
                    console.log(`[state] ${state.phase}${state.serverId ? ` on ${state.serverId}` : ''}${error}`);
                }
            } else if (event === 'app:update') {
                const update = payload as Events['app:update'];
                if (update.status !== updateStatus) {
                    updateStatus = update.status;
                    console.log(`[update] ${update.status}`);
                }
            }
            sink.emit(event, payload);
        },
    };
}

/* ------------------------------------------------------------------ notifications */

/** A run finished: a chime (if on), and a desktop notification (if on). Success is only notified when the window is
 *  not in front; a failure always is, so it is not missed. */
function notifyUser(n: { title: string; body: string; outcome: 'done' | 'failed' }): void {
    const prefs = settings.get();
    if (prefs.notificationSound) events.emit('app:chime', { outcome: n.outcome });
    const inFront = win !== null && win.isVisible() && win.isFocused();
    if (!prefs.notifications || (inFront && n.outcome === 'done') || !Notification.isSupported()) return;
    // silent: the chime above is the sound, so Windows does not play its own on top of it.
    const notification = new Notification({ title: n.title, body: n.body, silent: true, icon: path.join(process.env.VITE_PUBLIC, 'launcher.ico') });
    notification.on('click', showWindow);
    notification.show();
}

/** playit.gg was approved in the browser. The user is still looking at playit.gg's page, which does not say to come
 *  back, so a notification does (always, whatever the notification setting: they are waiting for it), and the
 *  window comes forward. Windows may only flash its taskbar button while another app is in front. */
function playitLinked(address: string | null): void {
    if (Notification.isSupported()) {
        const notification = new Notification({
            title: 'playit.gg is linked',
            body: address
                ? `Everything is set. You can close the browser tab and go back to MCS-Relay. Friends will join at ${address}.`
                : 'Everything is set. You can close the browser tab and go back to MCS-Relay.',
            icon: path.join(process.env.VITE_PUBLIC, 'launcher.ico'),
        });
        notification.on('click', showWindow);
        notification.show();
    }
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.moveTop();
    win.focus();
    if (!win.isFocused()) {
        win.flashFrame(true);
        win.once('focus', () => win?.flashFrame(false));
    }
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

/** Close button, tray "Quit" and OS quit all come here. A busy session or a backup task asks the user first; quitting
 *  then waits for them (see quit). */
function requestQuit(): void {
    if (quitting) return;
    const sessionActive = session.isBusy();
    const backup = backups.isBusy();
    // Nothing to interrupt, or no page that could ask (it crashed): quit, which still stops and uploads first.
    if ((!sessionActive && !backup) || !win || win.webContents.isCrashed()) {
        void quit();
        return;
    }
    showWindow();
    quitPending = true;
    events.emit('app:confirmQuit', { phase: session.getState().phase, sessionActive, backup });
}

function quitResponse(confirmed: boolean): void {
    if (!quitPending) return;
    quitPending = false;
    if (confirmed) void quit();
}

/** With `install`, the downloaded update is installed and the app starts again (see installUpdate). */
async function quit(opts: { install?: boolean } = {}): Promise<void> {
    if (quitting) return;
    quitting = true;
    updateTrayMenu();
    events.emit('app:quitting', null);
    console.log(`[main] quitting${opts.install ? ' to install an update' : ''}`);
    try {
        await backups.whenIdle();          // a restore cut short would leave half a world
        await session.shutdown();          // a running server is stopped and uploaded first
    } catch (err) {
        console.error('[main] shutdown failed:', err);
    }
    session.dispose();
    lock.dispose();
    updates.dispose();
    quitAllowed = true;
    // A plain quit installs a downloaded update too (autoInstallOnAppQuit), just without starting the app again.
    if (opts.install && updates.install()) return;
    app.quit();
}

/** "Restart to update": only between sessions, so a running server is never cut off. */
function installUpdate(): void {
    if (session.isBusy() || backups.isBusy()) {
        throw new AppError('BUSY', 'Stop the server and let the upload finish first. The update also installs by itself when you quit MCS-Relay.');
    }
    if (updates.get().status !== 'ready') throw new AppError('INVALID', 'No update has been downloaded yet.');
    void quit({ install: true });
}

/* ------------------------------------------------------------------ window and tray */

function isTrustedUrl(url: string): boolean {
    if (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) return true;
    return url.startsWith('file://') && decodeURIComponent(new URL(url).pathname).includes('/dist/');
}

/** The title bar and the window's background follow the theme (the page draws the bar's left part itself). */
function applyWindowTheme(theme: ThemeName): void {
    if (!win || theme === windowTheme) return;
    windowTheme = theme;
    const colors = WINDOW_COLORS[theme];
    win.setBackgroundColor(colors.page);
    if (process.platform === 'win32') {
        win.setTitleBarOverlay({ color: colors.titleBar, symbolColor: colors.titleText, height: TITLE_BAR_HEIGHT });
    }
}

function createWindow(): void {
    windowTheme = settings.get().theme;
    const colors = WINDOW_COLORS[windowTheme];
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
    // Windows is shutting down or signing out: there is no time to upload, and holding the shutdown up would only get
    // the app killed. Java saves the world as it is ended; the next start of MCS-Relay sees that this PC left the server
    // reserved and offers to upload what changed.
    win.on('session-end', () => {
        console.warn(`[main] Windows is ending the session (phase ${session.getState().phase})`);
        quitAllowed = true;
    });
    applyWindowIcon();
    // Links never open inside the app; https links open in the browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://')) void shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (!isTrustedUrl(url)) event.preventDefault();
    });
    // The page's warnings and errors (a React error, a failed request) go into the log too.
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        if (level >= 2) appLog.write(level >= 3 ? 'error' : 'warn', `[window] ${message} (${path.basename(sourceId)}:${line})`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
        console.error(`[window] the page stopped: ${details.reason} (exit code ${details.exitCode})`);
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
    applyWindowIcon();
    tray?.setImage(nativeImage.createFromPath(stateIcon(state, 'png')));
    tray?.setToolTip(LOGO_TOOLTIPS[state]);
    updateTrayMenu();
}

/** The installed app runs under the app id of its Start menu shortcut (notifications need that), and Windows draws a
 *  taskbar button with that id using the shortcut's icon, whatever icon the window sets. So the window gets an id
 *  of its own, with the state icon as its taskbar icon (a real file: the shell cannot read inside app.asar), and a
 *  relaunch command, so pinning it still starts MCS-Relay. */
const WINDOW_APP_ID = 'com.yeet.mcsrelay.window';

function applyWindowIcon(): void {
    if (!win) return;
    win.setIcon(nativeImage.createFromPath(stateIcon(logoState, 'ico')));
    if (process.platform !== 'win32') return;
    const folder = app.isPackaged ? path.join(process.resourcesPath, 'public', 'state') : path.join(process.env.APP_ROOT ?? '', 'public', 'state');
    win.setAppDetails({
        appId: WINDOW_APP_ID,
        appIconPath: path.join(folder, `${logoState}.ico`),
        appIconIndex: 0,
        relaunchCommand: `"${process.execPath}"`,
        relaunchDisplayName: 'MCS-Relay',
    });
}

const PHASE_LABELS: Partial<Record<SessionPhase, string>> = {
    checking: 'Starting…', claiming: 'Starting…', downloading: 'Downloading the world…', launching: 'Starting the server…',
    stopping: 'Stopping…', uploading: 'Uploading the world…', releasing: 'Freeing the server…', 'upload-pending': 'Upload paused: open to continue',
};

/** Open, Start or Stop the selected server, Quit. Rebuilt whenever the session, the selection or the logo changes. */
function updateTrayMenu(): void {
    if (!tray) return;
    const state = session.getState();
    const selected = settings.get().selectedServerId;
    const nameOf = (id: string | null) => (id ? servers.nameOf(id) : null);
    let action: MenuItemConstructorOptions;
    if (quitting) {
        action = { label: 'Quitting…', enabled: false };
    } else if (state.phase === 'running') {
        action = { label: `Stop ${nameOf(state.serverId) ?? 'the server'}`, click: () => void trayStop() };
    } else if (session.isBusy()) {
        action = { label: PHASE_LABELS[state.phase] ?? 'Busy…', enabled: false };
    } else if (!selected) {
        action = { label: 'Start', enabled: false };
    } else if (logoState === 'elsewhere') {
        action = { label: `${nameOf(selected) ?? 'The server'} is hosted by someone else`, enabled: false };
    } else {
        action = { label: `Start ${nameOf(selected) ?? 'the server'}`, click: () => void trayStart(selected) };
    }
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open MCS-Relay', click: showWindow },
        { type: 'separator' },
        action,
        { type: 'separator' },
        { label: 'Quit', click: requestQuit, enabled: !quitting },
    ]));
}

/** Start from the tray. Anything that needs a question first (the terms, the Minecraft EULA, a version saved from a
 *  cancelled upload) opens the window instead, where the power button asks it. A failure is notified. */
async function trayStart(serverId: string): Promise<void> {
    const s = settings.get();
    const report = session.lastReport();
    const incomplete = report?.serverId === serverId && report.remoteIncomplete;
    if (s.termsAccepted < TERMS_VERSION || (s.launchServer && !s.eulaAccepted) || incomplete || backups.isBusy()) {
        showWindow();
        return;
    }
    try {
        await session.start(serverId);
    } catch (err) {
        console.warn('[tray] start failed:', err);
    }
}

async function trayStop(): Promise<void> {
    try {
        await session.stop();
    } catch (err) {
        console.warn('[tray] stop failed:', err);
    }
}

function createTray(): void {
    tray = new Tray(nativeImage.createFromPath(stateIcon(logoState, 'png')));
    tray.setToolTip(LOGO_TOOLTIPS[logoState]);
    updateTrayMenu();
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

    app.on('child-process-gone', (_event, details) => {
        console.warn(`[main] a helper process stopped: ${details.type} ${details.reason} (exit code ${details.exitCode})`);
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Windows shows notifications only for an app with an id (in development: the Electron binary).
    if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.yeet.mcsrelay' : process.execPath);

    void app.whenReady().then(async () => {
        appData.migrateLegacy();
        registerHandlers(createHandle(ipcMain, isTrustedUrl), {
            auth, servers, session, settings, sync, transfers, changes, dialogs, report: reports, backups, installer, java, properties, playit: playitLink,
            app: {
                quitResponse, openExternal: (url) => shell.openExternal(url), setLogoState: applyLogoState,
                updateState: () => updates.get(), checkForUpdates: () => updates.check(), installUpdate,
                openLogFolder: () => dialogs.openPath(appLog.folder),
            },
        });
        createTray();
        createWindow();
        updates.start();
        try {
            const status = await auth.status();
            if (status.loggedIn) await session.resumeUnfinishedUploads();
        } catch (err) {
            console.warn('[main] could not resume unfinished uploads at startup:', err);
        }
    });
}
