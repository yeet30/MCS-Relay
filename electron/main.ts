import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage  } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ILocalVariables } from '../src/lib/types'
import { loginWithGoogle, getUserInfo, isAlreadyLoggedIn, logoutGoogle, isRequestAllowed, requestDriveScope } from './services/googleAuthService'
import {
	createServerFolder,
	deleteServerFolder,
	getRootWithContents,
	inviteUserToServer,
	removeUserPermission,
	getJoinedServers,
	joinServerById,
	renameServerFolder,
} from './services/googleDriveService'
import { downloadServerFolder, uploadServerFolder } from './services/fileTransferService'
import { 
	startWatcher, 
	stopWatcher, 
	manifestEvents, 
	isWatcherRunning, 
	getWatcherUpdates,
	getTrackedFiles,
	mutateTrackedFiles,
	getBlacklist,
	setWatcherBlacklist,
	writeLocalManifest,
	getFilesToDownload,
	getFilesToUpload
} from './services/watcher-manifest'
import { startServer, getServerLock, updateLockFile, stopServer, getMaxPlayers } from './services/serverService' 
import { launchServer, getServerProcess, getPlayitggProcess, killPlayitgg, killServer } from './services/childrenProcesses'
import { getServerPath, setServerPath, getLocalVariable, setLocalVariable } from './services/localServerStore'
import { IStartupOptions } from '../src/lib/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const iconPath = path.join(app.getAppPath(), './public/launcher.ico')

let heartbeatInterval: NodeJS.Timeout | null = null;
let currentHostingServerId: string | null = null;
let currentPlayers: string[] = [];
let cleanupDone = false;
let isQuitting = false;

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
let tray: Tray | null = null;
//Menu.setApplicationMenu(null)

function createWindow() {
	win = new BrowserWindow({
		resizable: false,
		width: 800,
		height: 600,
		icon: iconPath,
		webPreferences: {
			preload: path.join(__dirname, 'preload.mjs'),
		},
	})

	win.on('minimize', (event: Event) => {
		if (isQuitting || cleanupDone) return
		event.preventDefault()
		win?.hide()
	})

	win.on('close', (event) => {
		if (cleanupDone) return;
		event.preventDefault();

		if (isQuitting) {
			const hasAnythingToCleanup = !!getPlayitggProcess() || !!currentHostingServerId;
			if (hasAnythingToCleanup) {
				win?.show(); 
				safeSend('app-quitting');
				safeSend('show-progress');
				doCleanup();
			} else {
				cleanupDone = true;
				win?.show(); 
				app.quit();
			}
			return;
		}

		win!.webContents.send('confirm-quit', { isHosting: !!currentHostingServerId });
	});

	win.on('closed', () => {
		win = null;
	});

	// Test active push message to Renderer-process.
	win.webContents.on('did-finish-load', () => {
		win?.webContents.send('main-process-message', (new Date).toLocaleString())
	})

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL)
	} else {
		// win.loadFile('dist/index.html')
		win.loadFile(path.join(RENDERER_DIST, 'index.html'))
	}
}
// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (cleanupDone) {
            app.quit();
            win = null;
		}
    }
});

app.on('activate', () => {
	// On OS X it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow()
	}
})

app.whenReady().then(() => {
	const trayIconPath = path.join(process.resourcesPath, 'public/icon-16x16.png')
	const icon = nativeImage.createFromPath(trayIconPath)
	tray = new Tray(icon)
    
    tray.setToolTip('Drive Launcher')
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open', click: () => win?.show() },
        { label: 'Quit', click: () => {
			win?.show(); // show window first so confirm popup is visible
			win?.webContents.send('confirm-quit', { isHosting: !!currentHostingServerId });
		}}
    ]))

    tray.on('click', () => {
        win?.show()
    })
})

app.on('before-quit', () => {
    console.log("before-quit fired, cleanupDone:", cleanupDone);
});

app.on('will-quit', (event) => {
    if (!cleanupDone) {event.preventDefault();} // safety net, shouldn't reach here before cleanup
});

ipcMain.handle('confirm-quit-response', (_, confirmed: boolean) => {
    if (confirmed) {
        isQuitting = true;
        win?.close();
    }
});

function safeSend(channel: string, ...args: any[]) {
    if (win && !win.isDestroyed()) {
        win.webContents.send(channel, ...args);
    }
}

function sendProgress(message: string, status: 'loading' | 'done' | 'error' = 'loading', importance: 'major' | 'minor' = 'minor') {
	if (win && !win.isDestroyed()) {
    	win?.webContents.send("startup-progress", { message, status, importance });
	}
}

async function handleServerStop() {
    if (!currentHostingServerId) return null;

    win?.webContents.send("show-progress");
    const playitggProcess = getPlayitggProcess()

    if(playitggProcess){
        sendProgress("Closing down the playitgg client.", "loading", "major")
        killPlayitgg()
        sendProgress("Finished closing the playitgg client.", "done", "major")
    }

    clearInterval(heartbeatInterval!);

    const shouldUpload = getLocalVariable("checklist").upload
    const stopRes = await stopServer({ shouldUpload: shouldUpload, folderId: currentHostingServerId }, sendProgress);

    heartbeatInterval = null;
    currentHostingServerId = null;
    currentPlayers = [];

    win?.webContents.send("hide-progress");
    win?.webContents.send("server-stopped");

    return stopRes;
}

async function doCleanup() {
    const playitggProcess = getPlayitggProcess();

    if (playitggProcess) {
        sendProgress("Closing down the playitgg client.", "loading", "major");
        killPlayitgg();
        sendProgress("Finished closing the playitgg client.", "done", "major");
    }

    if (currentHostingServerId) {
        sendProgress("Closing down the server console.", "loading", "major");
        killServer();
        sendProgress("Finished closing down the server console.", "done", "major");

        const shouldUpload = getLocalVariable("checklist").upload;
        const stopRes = await stopServer({ shouldUpload, folderId: currentHostingServerId }, sendProgress);
        currentHostingServerId = null;

        safeSend("hide-progress");

        if (!stopRes.success) {
            await dialog.showMessageBox({
                type: "info",
                title: "Info",
                message: stopRes.error,
            });
        }
    }

    clearInterval(heartbeatInterval!);
    heartbeatInterval = null;
    cleanupDone = true;
    app.quit();
}

ipcMain.handle("google-login", async () => {
	return await loginWithGoogle();
});

ipcMain.handle("google-get-user", async () => {
	return await getUserInfo(); 
});

ipcMain.handle("google-is-logged-in", () => {
	return isAlreadyLoggedIn();
})

ipcMain.handle("google-logout", async () => {

	win?.webContents.send('app-quitting')

	win?.webContents.send("show-progress");
	const playitggProcess = getPlayitggProcess()
	let stopRes;

	if(playitggProcess){
		sendProgress("Closing down the playitgg client.", "loading", "major")
		killPlayitgg()
		sendProgress("Finished closing the playitgg client.", "done", "major")
	}

	if (currentHostingServerId) {
		sendProgress("Closing down the server console.", "loading", "major")
		killServer()
		sendProgress("Finished closing down the server console.", "done", "major")

		const shouldUpload = getLocalVariable("checklist").upload

		stopRes = await stopServer({ shouldUpload: shouldUpload, folderId: currentHostingServerId }, sendProgress);
		currentHostingServerId = null;
		win?.webContents.send("hide-progress");
		if(!stopRes.success)
			dialog.showMessageBox({
				type: "info",
				title: "Info",
				message: stopRes.error,
			});
    }

	clearInterval(heartbeatInterval!);
	heartbeatInterval = null;
		
    return await logoutGoogle();
})

ipcMain.handle("start-server", async (_, options: IStartupOptions) => {

	if(
		(options.checklist.download 
		|| options.checklist.upload 
		|| options.checklist.serverConsole) 
		&& !options.serverPath
	)
		return {success: false, error: "You need to set the server path."}


	win?.webContents.send("show-progress");
    const result = await startServer(options, sendProgress);

    if (!result.success) {
		return {success: false, error: result.error}
	};

	let launchRes = null
	let serverProcess= null;

    // Launch the actual MC server process
	if(options.checklist.serverConsole){
		win?.webContents.send("server-started");
		launchRes = launchServer(options.serverPath, options.RAMoptions, (msg) => {
			win?.webContents.send("server-output", msg)
		});

		if (!launchRes.success) {
			await stopServer({ shouldUpload: false, folderId: options.folderId }, sendProgress);
			win?.webContents.send("server-output", `\n[System] Failed to start: ${launchRes.error}\n`);
			return { success: false, error: launchRes.error }
		}
		serverProcess = launchRes.process!

		serverProcess.stdout?.on("data", (data) => {
			const text = data.toString();
			const listMatch = text.match(/There are \d+ of a max of \d+ players online: ?(.*)/);
			if (listMatch) {
				currentPlayers = listMatch[1] ? listMatch[1].split(", ").filter(Boolean) : [];
			} else {
				win?.webContents.send("server-output", text);
			}
		});
		serverProcess.stderr?.on("data", (data) => {
			win?.webContents.send("server-output", data.toString());
		});
		serverProcess.on("close", async (code) => {
			win?.webContents.send("server-output", `\n[System] Server exited with code ${code}\n`);
			await handleServerStop();
		});
	}

    
    // Stream playit.gg link to renderer if enabled
    if (options.checklist.playitgg && result.playitggProcess) {
        result.playitggProcess.stdout?.on("data", (data) => {
            const text = data.toString("utf-8").replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
            const match = text.match(/([a-zA-Z0-9.-]+\.joinmc\.link)\s*=>/);
            if (match) 
				win?.webContents.send("playitgg-link", match[1]);
        });
    }

    // Start heartbeat
    currentHostingServerId = options.folderId;

    heartbeatInterval = setInterval(async () => {
        const res = await updateLockFile(options.folderId, "online", currentPlayers);
		if(res.success)
			win?.webContents.send("lock-updated", res.lockData)
		serverProcess?.stdin?.write("list\n");
    }, 20000);

	win?.webContents.send("hide-progress");

    return { success: true, lockStatus: result.lockData };
});

ipcMain.handle("get-current-players", ()=>{
	return currentPlayers;
})

ipcMain.handle("stop-server", async () => {
    if(!currentHostingServerId)
        return { success: false, error: "Server is not running." }

    sendProgress("Closing down the server console.", "loading", "major")
    killServer()

    const stopRes = await handleServerStop();

    if(!stopRes?.success)
        return { success: false, error: stopRes?.error }

    return { success: true, lockData: stopRes }
});

ipcMain.handle("send-server-command", (_, command: string) => {
	const serverProcess = getServerProcess();
    if (!serverProcess)
        return { success: false, error: "Server is not running." };

    serverProcess.stdin?.write(command + "\n");

    return { success: true };
});

ipcMain.handle("is-server-running", ()=>{
	return (currentHostingServerId ? true : false)
})

ipcMain.handle("drive-create-server", async () => {
	return await createServerFolder();
});

ipcMain.handle('drive-delete-server', async (_event, folderId) => {
	return await deleteServerFolder(folderId);
})

ipcMain.handle("drive-get-root", async () => {
	return await getRootWithContents();
})

ipcMain.handle("choose-file-directory", async (_, serverPath) => {
	const result = await dialog.showOpenDialog({ 
		properties: ["openFile"],
		defaultPath: serverPath
	})

	if (result.canceled || result.filePaths.length === 0) return null;

	return  result.filePaths[0];
})

ipcMain.handle("set-server-path", async (_, serverId) => {
	const result = await dialog.showOpenDialog({ properties: ["openDirectory"] })

	if (result.canceled) return null

	setServerPath(serverId, result.filePaths[0])

	return result.filePaths[0]
})

ipcMain.handle("get-server-path", (_, serverId) => {
	return getServerPath(serverId)
})

ipcMain.handle("get-max-players", (_, serverPath) => {
	return getMaxPlayers(serverPath)
})

ipcMain.handle("sync-server", async (_, serverId) => {
	return await downloadServerFolder(serverId)
})

ipcMain.handle("upload-server-folder", async (_, serverId) => {
	return await uploadServerFolder(serverId);
})

ipcMain.handle("drive-invite-user", async (_, serverId, email, message?) => {
	return await inviteUserToServer(serverId, email, message);
});

ipcMain.handle("drive-remove-permission", async (_, serverId, permissionId, isOwner) => {
	return await removeUserPermission(serverId, permissionId, isOwner);
});

ipcMain.handle("join-by-id", async (_, folderId) => {
	return await joinServerById(folderId);
})

ipcMain.handle("get-joined-folders", async () => {
	return await getJoinedServers();
})

ipcMain.handle("open-external-link", async (_, url: string) => {
	await shell.openExternal(url);
});

ipcMain.handle("is-request-allowed", (): boolean => {
	return isRequestAllowed();
})

ipcMain.handle("request-drive-scope", async () => {
	return await requestDriveScope();
});

ipcMain.handle("rename-server", async (_, folderId, newName) => {
	return await renameServerFolder(folderId, newName);
});

ipcMain.handle("open-folder", async (_, folderPath)=> {
	return await shell.openPath(folderPath)
})

ipcMain.handle("start-watcher", async (_, folderPath)=>{
	await startWatcher(folderPath);
})

ipcMain.handle("stop-watcher", async ()=>{
	return stopWatcher();
})

ipcMain.handle('is-watcher-running', ()=> isWatcherRunning())

manifestEvents.on('change', (change)=> win?.webContents.send('manifest:change', change))

ipcMain.handle("get-watcher-updates", async (_, serverDir) => getWatcherUpdates(serverDir));

ipcMain.handle("get-tracked-files", async () => getTrackedFiles());

ipcMain.handle("mutate-tracked-files", (_, change)=> mutateTrackedFiles(change))

ipcMain.handle("get-blacklist", async () => getBlacklist());

ipcMain.handle("set-blacklist", async (_, serverDir, list) => setWatcherBlacklist(serverDir, new Set(list)));	

ipcMain.handle('write-manifest', (_, serverPath) => writeLocalManifest(serverPath))

//Temporary implemantation to test the functionality
ipcMain.handle('get-files-to-download', (_, serverDir:string, serverId: string)=>getFilesToDownload(serverDir, serverId))

//Temporary implemantation to test the functionality
ipcMain.handle('get-files-to-upload', (_, serverDir:string, serverId: string)=>getFilesToUpload(serverDir, serverId))

ipcMain.handle('open-manifest', async (_, serverPath) => {
	console.log(serverPath);
	
	const fullPath = path.join(serverPath, "manifest.json")
	return await shell.openPath(fullPath)
})

ipcMain.handle("get-server-lock", async (_, folderId) => {
	return await getServerLock(folderId);
});

ipcMain.handle("get-local-variable", async (_, variable: keyof ILocalVariables) => {
    return getLocalVariable(variable);
});

ipcMain.handle("set-local-variable", async (_, variable: keyof ILocalVariables, value: ILocalVariables[typeof variable]) => {
    setLocalVariable(variable, value);
    return true;
});

app.whenReady().then(createWindow)
