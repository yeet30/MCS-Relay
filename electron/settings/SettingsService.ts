// The one writer of this PC's settings. Values arriving over IPC are unknown at runtime, so every
// setter validates before anything is stored.
import path from 'node:path';
import { TERMS_VERSION, THEMES } from '../../shared/types';
import type { AppSettings, JavaFlags, ServerSettings, ServerSettingsPatch, ThemeName } from '../../shared/types';
import { AppError } from '../errors';
import { RAM_LIMITS, isAutoBackupMinutes, isValidServerId } from '../store/appData';
import type { AppData } from '../store/appData';

export interface Dialogs {
    chooseFolder(title: string, defaultPath?: string): Promise<string | null>;
    chooseFile(title: string, filters?: Array<{ name: string; extensions: string[] }>, defaultPath?: string): Promise<string | null>;
    openPath(p: string): Promise<void>;
}

export type SettingsPatch = Partial<Omit<AppSettings, 'joinedServerIds'>>;

const MAX_CUSTOM_FLAGS = 2000;

export class SettingsService {
    private readonly appData: AppData;
    private readonly dialogs: Dialogs;
    private readonly platform: NodeJS.Platform;

    /** `platform` exists for tests (path comparison and the playit.gg file filter). */
    private readonly onChange?: (settings: AppSettings) => void;

    /** onChange: after every successful set (the window follows the theme). */
    constructor(deps: { appData: AppData; dialogs: Dialogs; platform?: NodeJS.Platform; onChange?: (settings: AppSettings) => void }) {
        this.appData = deps.appData;
        this.dialogs = deps.dialogs;
        this.platform = deps.platform ?? process.platform;
        this.onChange = deps.onChange;
    }

    get(): AppSettings {
        return this.appData.readSettings();
    }

    set(patch: SettingsPatch): AppSettings {
        if (!isObject(patch)) throw invalid('The settings change is not valid.');
        const next = this.get();
        if ('selectedServerId' in patch) {
            const id: unknown = patch.selectedServerId;
            if (id !== null && !isValidServerId(id)) throw invalid('The selected server id is not valid.');
            next.selectedServerId = id;
        }
        if ('playitggPath' in patch) {
            const p: unknown = patch.playitggPath;
            if (typeof p !== 'string') throw invalid('The playit.gg path must be text.');
            const trimmed = p.trim();
            if (trimmed !== '' && !path.isAbsolute(trimmed)) throw invalid('Choose the playit.gg program with the file picker.');
            next.playitggPath = trimmed;
        }
        if ('usePlayitgg' in patch) next.usePlayitgg = requireBoolean(patch.usePlayitgg, 'usePlayitgg');
        if ('launchServer' in patch) next.launchServer = requireBoolean(patch.launchServer, 'launchServer');
        if ('eulaAccepted' in patch) next.eulaAccepted = requireBoolean(patch.eulaAccepted, 'eulaAccepted');
        if ('termsAccepted' in patch) {
            const version: unknown = patch.termsAccepted;
            if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > TERMS_VERSION) {
                throw invalid('That version of the terms of use does not exist.');
            }
            next.termsAccepted = version;
        }
        if ('autoBackupMinutes' in patch) {
            if (!isAutoBackupMinutes(patch.autoBackupMinutes)) throw invalid('The automatic backup runs every 5 to 30 minutes, or not at all.');
            next.autoBackupMinutes = patch.autoBackupMinutes;
        }
        if ('tourDone' in patch) next.tourDone = requireBoolean(patch.tourDone, 'tourDone');
        if ('serversFolder' in patch) {
            const p: unknown = patch.serversFolder;
            if (typeof p !== 'string' || (p.trim() !== '' && !path.isAbsolute(p.trim()))) throw invalid('Choose the folder with the folder picker.');
            next.serversFolder = p.trim();
        }
        if ('notifications' in patch) next.notifications = requireBoolean(patch.notifications, 'notifications');
        if ('notificationSound' in patch) next.notificationSound = requireBoolean(patch.notificationSound, 'notificationSound');
        if ('minimizeToTray' in patch) next.minimizeToTray = requireBoolean(patch.minimizeToTray, 'minimizeToTray');
        if ('playitPrimary' in patch) {
            const address: unknown = patch.playitPrimary;
            if (address !== null && (typeof address !== 'string' || address === '' || address.length > 300)) throw invalid('That playit.gg tunnel is not valid.');
            next.playitPrimary = address;
        }
        if ('theme' in patch) {
            if (!THEMES.includes(patch.theme as ThemeName)) throw invalid('That theme does not exist.');
            next.theme = patch.theme as ThemeName;
        }
        this.appData.writeSettings(next);
        this.onChange?.(next);
        return next;
    }

    getServer(id: string): ServerSettings {
        return this.appData.readServerSettings(requireId(id));
    }

    /** The Java flags and program; the local path goes through setLocalPath. */
    setServer(id: string, patch: ServerSettingsPatch): ServerSettings {
        const current = this.getServer(id);
        if (!isObject(patch)) throw invalid('The server settings change is not valid.');
        if (patch.javaFlags !== undefined) {
            if (!isObject(patch.javaFlags)) throw invalid('The Java settings are not valid.');
            current.javaFlags = validateJavaFlags({ ...current.javaFlags, ...patch.javaFlags });
        }
        if (patch.javaPath !== undefined) {
            if (patch.javaPath === null) delete current.javaPath;
            else current.javaPath = this.validateJavaPath(patch.javaPath, current.localPath);
        }
        this.appData.writeServerSettings(id, current);
        return current;
    }

    /** `listed`: the servers that exist for this account right now. A folder still remembered for a server that
     *  was deleted on Drive does not block another server (without `listed`, every remembered server counts). */
    setLocalPath(id: string, localPath: string | null, listed?: ReadonlySet<string>): void {
        const current = this.getServer(id);
        if (localPath === null) {
            current.localPath = null;
        } else {
            if (typeof localPath !== 'string' || localPath.trim() === '' || !path.isAbsolute(localPath.trim())) {
                throw invalid('Choose the server folder with the folder picker.');
            }
            const chosen = path.resolve(localPath.trim());
            const clash = this.folderInUse(chosen, id, listed);
            if (clash) {
                throw invalid('This folder is already used by another server (or contains it). Choose a separate folder for each server.', `${chosen} overlaps ${clash}`);
            }
            current.localPath = chosen;
        }
        this.appData.writeServerSettings(id, current);
    }

    addJoined(id: string): void {
        const settings = this.get();
        if (settings.joinedServerIds.includes(requireId(id))) return;
        settings.joinedServerIds.push(id);
        this.appData.writeSettings(settings);
    }

    removeJoined(id: string): void {
        const settings = this.get();
        if (!settings.joinedServerIds.includes(id)) return;
        settings.joinedServerIds = settings.joinedServerIds.filter((joined) => joined !== id);
        this.appData.writeSettings(settings);
    }

    /** Asks for the Java program a server starts with; null when cancelled. Saved with setServer. */
    async pickJavaPath(): Promise<string | null> {
        const filters = this.platform === 'win32' ? [{ name: 'Java (java.exe)', extensions: ['exe'] }] : undefined;
        const chosen = await this.dialogs.chooseFile('Choose the Java program (java.exe in the bin folder of a Java installation)', filters);
        return chosen ? chosen.trim() : null;
    }

    /** Asks for the playit.gg program; null when cancelled. Nothing is stored: the Hosting tab saves it with
     *  its other changes (settings:set validates it then). */
    async pickPlayitPath(): Promise<string | null> {
        const filters = this.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : undefined;
        const chosen = await this.dialogs.chooseFile('Choose the playit.gg program', filters);
        return chosen ? chosen.trim() : null;
    }

    /** A java program installed on this PC. One inside the server folder is refused: every member can replace the
     *  files there. */
    private validateJavaPath(value: unknown, serverFolder: string | null): string {
        if (typeof value !== 'string' || !path.isAbsolute(value.trim())) throw invalid('Choose the Java program with the file picker.');
        const chosen = path.resolve(value.trim());
        if (!/^java(\.exe)?$/i.test(path.basename(chosen))) throw invalid('Choose java.exe, in the bin folder of a Java installation.');
        if (serverFolder) {
            const key = (p: string) => (this.platform === 'win32' || this.platform === 'darwin' ? path.resolve(p).toLowerCase() : path.resolve(p));
            if (isInside(key(chosen), key(serverFolder))) {
                throw invalid('Choose a Java installed on this PC, not one inside the server folder: every member can change the files there.');
            }
        }
        return chosen;
    }

    /** Two servers syncing the same folder (or one inside the other) would overwrite each other's worlds. */
    folderInUse(chosen: string, id: string | null, listed?: ReadonlySet<string>): string | null {
        const key = (p: string) => {
            const resolved = path.resolve(p);
            return this.platform === 'win32' || this.platform === 'darwin' ? resolved.toLowerCase() : resolved;
        };
        const a = key(chosen);
        for (const other of this.appData.serverIds()) {
            if (other === id || (listed && !listed.has(other))) continue;
            const otherPath = this.appData.readServerSettings(other).localPath;
            if (!otherPath) continue;
            const b = key(otherPath);
            if (a === b || isInside(a, b) || isInside(b, a)) return otherPath;
        }
        return null;
    }
}

export function validateJavaFlags(flags: { minRAM?: unknown; maxRAM?: unknown; customFlags?: unknown }): JavaFlags {
    const { minRAM, maxRAM, customFlags } = flags;
    const inRange = (n: unknown): n is number =>
        typeof n === 'number' && Number.isInteger(n) && n >= RAM_LIMITS.min && n <= RAM_LIMITS.max;
    if (!inRange(minRAM) || !inRange(maxRAM)) {
        throw invalid(`Memory must be a whole number of MB between ${RAM_LIMITS.min} and ${RAM_LIMITS.max}.`);
    }
    if (minRAM > maxRAM) throw invalid('The minimum memory cannot be larger than the maximum.');
    if (typeof customFlags !== 'string') throw invalid('The extra Java flags must be text.');
    if (customFlags.length > MAX_CUSTOM_FLAGS || /[\r\n]/.test(customFlags)) {
        throw invalid('The extra Java flags must fit on one line.');
    }
    return { minRAM, maxRAM, customFlags: customFlags.trim() };
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function requireId(id: unknown): string {
    if (!isValidServerId(id)) throw invalid('Invalid server id.');
    return id;
}

function requireBoolean(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') throw invalid(`The setting "${name}" must be on or off.`);
    return value;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function invalid(message: string, detail?: string): AppError {
    return new AppError('INVALID', message, detail);
}
