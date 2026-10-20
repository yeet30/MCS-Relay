// The one writer of this PC's settings. Values arriving over IPC are unknown at runtime, so every
// setter validates before anything is stored.
import path from 'node:path';
import type { AppSettings, JavaFlags, ServerSettings } from '../../shared/types';
import { AppError } from '../errors';
import { RAM_LIMITS, isValidServerId } from '../store/appData';
import type { AppData } from '../store/appData';

export interface Dialogs {
    chooseFolder(title: string, defaultPath?: string): Promise<string | null>;
    chooseFile(title: string, filters?: Array<{ name: string; extensions: string[] }>, defaultPath?: string): Promise<string | null>;
    openPath(p: string): Promise<void>;
}

export type SettingsPatch = Partial<Omit<AppSettings, 'joinedServerIds'>>;
export type ServerSettingsPatch = { javaFlags?: Partial<JavaFlags> };

const MAX_CUSTOM_FLAGS = 2000;

export class SettingsService {
    private readonly appData: AppData;
    private readonly dialogs: Dialogs;
    private readonly platform: NodeJS.Platform;

    /** `platform` exists for tests (path comparison and the playit.gg file filter). */
    constructor(deps: { appData: AppData; dialogs: Dialogs; platform?: NodeJS.Platform }) {
        this.appData = deps.appData;
        this.dialogs = deps.dialogs;
        this.platform = deps.platform ?? process.platform;
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
        if ('notifications' in patch) next.notifications = requireBoolean(patch.notifications, 'notifications');
        if ('notificationSound' in patch) next.notificationSound = requireBoolean(patch.notificationSound, 'notificationSound');
        this.appData.writeSettings(next);
        return next;
    }

    getServer(id: string): ServerSettings {
        return this.appData.readServerSettings(requireId(id));
    }

    /** Only javaFlags can be changed here; the local path goes through setLocalPath. */
    setServer(id: string, patch: ServerSettingsPatch): ServerSettings {
        const current = this.getServer(id);
        if (!isObject(patch)) throw invalid('The server settings change is not valid.');
        if (patch.javaFlags !== undefined) {
            if (!isObject(patch.javaFlags)) throw invalid('The Java settings are not valid.');
            current.javaFlags = validateJavaFlags({ ...current.javaFlags, ...patch.javaFlags });
        }
        this.appData.writeServerSettings(id, current);
        return current;
    }

    setLocalPath(id: string, localPath: string | null): void {
        const current = this.getServer(id);
        if (localPath === null) {
            current.localPath = null;
        } else {
            if (typeof localPath !== 'string' || localPath.trim() === '' || !path.isAbsolute(localPath.trim())) {
                throw invalid('Choose the server folder with the folder picker.');
            }
            const chosen = path.resolve(localPath.trim());
            const clash = this.serverUsingFolder(id, chosen);
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

    /** Asks for the playit.gg program and stores it. null when cancelled. */
    async choosePlayitPath(): Promise<string | null> {
        const filters = this.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : undefined;
        const chosen = await this.dialogs.chooseFile('Choose the playit.gg program', filters);
        if (!chosen) return null;
        this.set({ playitggPath: chosen });
        return this.get().playitggPath;
    }

    /** Two servers syncing the same folder (or one inside the other) would overwrite each other's worlds. */
    private serverUsingFolder(id: string, chosen: string): string | null {
        const key = (p: string) => {
            const resolved = path.resolve(p);
            return this.platform === 'win32' || this.platform === 'darwin' ? resolved.toLowerCase() : resolved;
        };
        const a = key(chosen);
        for (const other of this.appData.serverIds()) {
            if (other === id) continue;
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
