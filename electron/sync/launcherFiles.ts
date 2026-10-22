// Access to the app's own files inside a server folder:
//   <server folder>/.launcher/{lock.json, manifest.json, sync-rules.json, pending-delete/}
// Drive allows several files with the same name in one folder, and two members can create one at the
// same moment. Every lookup therefore takes the OLDEST match, and after creating a file or folder we
// re-list and trash our own copy if an older one already existed.
import { DriveError, FOLDER_MIME } from '../drive/types';
import type { DriveApi } from '../drive/types';

export const LAUNCHER_FOLDER = '.launcher';
export type LauncherFileName = 'lock.json' | 'manifest.json' | 'sync-rules.json';
export type LauncherSubfolder = 'pending-delete';

function isNotFound(err: unknown): boolean {
    return err instanceof DriveError && err.status === 404;
}

export class LauncherFiles {
    private readonly folderIds = new Map<string, string>();
    private readonly ids = new Map<string, string>();
    private readonly inflight = new Map<string, Promise<{ id: string; createdHere: boolean }>>();

    constructor(private readonly drive: DriveApi) {}

    /** The .launcher folder of a server, or null when it does not exist yet. Read-only. */
    async findFolder(serverId: string): Promise<string | null> {
        const cached = this.folderIds.get(serverId);
        if (cached) return cached;
        const matches = await this.drive.listChildren(serverId, { name: LAUNCHER_FOLDER, foldersOnly: true });
        if (matches.length === 0) return null;
        this.folderIds.set(serverId, matches[0].id);
        return matches[0].id;
    }

    async ensureFolder(serverId: string): Promise<string> {
        const result = await this.once(`folder:${serverId}`, async () => {
            const existing = await this.findFolder(serverId);
            if (existing) return { id: existing, createdHere: false };
            const created = await this.drive.createFolder(LAUNCHER_FOLDER, serverId);
            const id = await this.keepOldest(serverId, LAUNCHER_FOLDER, created.id, true);
            return { id, createdHere: id === created.id };
        });
        this.folderIds.set(serverId, result.id);
        return result.id;
    }

    /** For a server folder created a moment ago, which no other app can know yet: creates .launcher and the
     *  files in it without first looking for older copies, the files side by side. */
    async createFresh(serverId: string, files: Partial<Record<LauncherFileName, string>>): Promise<void> {
        const folder = await this.drive.createFolder(LAUNCHER_FOLDER, serverId);
        this.folderIds.set(serverId, folder.id);
        await Promise.all((Object.entries(files) as Array<[LauncherFileName, string]>).map(async ([name, text]) => {
            const created = await this.drive.createFile(name, folder.id, { kind: 'bytes', data: new TextEncoder().encode(text) });
            this.ids.set(`${serverId}/${name}`, created.id);
        }));
    }

    /** A file inside .launcher, or null when it (or the folder) does not exist. Read-only. */
    async findFile(serverId: string, name: LauncherFileName): Promise<string | null> {
        const key = `${serverId}/${name}`;
        const cached = this.ids.get(key);
        if (cached) return cached;
        const folder = await this.findFolder(serverId);
        if (!folder) return null;
        const matches = (await this.drive.listChildren(folder, { name })).filter((m) => m.mimeType !== FOLDER_MIME);
        if (matches.length === 0) return null;
        this.ids.set(key, matches[0].id);
        return matches[0].id;
    }

    /** Creates the file with `initial` content when it is missing and returns its id. */
    async ensureFile(serverId: string, name: LauncherFileName, initial: string): Promise<string> {
        return (await this.ensureFileInternal(serverId, name, initial)).id;
    }

    /** A folder inside .launcher (for example pending-delete), created when missing. */
    async ensureSubfolder(serverId: string, name: LauncherSubfolder): Promise<string> {
        const key = `${serverId}/${name}/`;
        const cached = this.ids.get(key);
        if (cached) return cached;
        const result = await this.once(key, async () => {
            const parent = await this.ensureFolder(serverId);
            const existing = await this.drive.listChildren(parent, { name, foldersOnly: true });
            if (existing.length > 0) return { id: existing[0].id, createdHere: false };
            const created = await this.drive.createFolder(name, parent);
            const id = await this.keepOldest(parent, name, created.id, true);
            return { id, createdHere: id === created.id };
        });
        this.ids.set(key, result.id);
        return result.id;
    }

    /** Reads a .launcher file. null when it does not exist. */
    async readText(serverId: string, name: LauncherFileName): Promise<{ id: string; text: string } | null> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const id = await this.findFile(serverId, name);
            if (!id) return null;
            try {
                return { id, text: await this.drive.readText(id) };
            } catch (err) {
                if (!isNotFound(err)) throw err;
                this.forget(serverId);              // the cached id went away; look it up once more
            }
        }
        return null;
    }

    /** Writes a .launcher file, creating it (and the folder) when missing. Returns the file id. */
    async writeText(serverId: string, name: LauncherFileName, text: string): Promise<string> {
        const data = new TextEncoder().encode(text);
        for (let attempt = 0; attempt < 2; attempt++) {
            const { id, createdHere } = await this.ensureFileInternal(serverId, name, text);
            if (createdHere) return id;
            try {
                await this.drive.updateContent(id, { kind: 'bytes', data });
                return id;
            } catch (err) {
                if (!isNotFound(err)) throw err;
                this.forget(serverId);
            }
        }
        throw new DriveError(`Could not write ${name}`, 404, 'notFound');
    }

    /** Drops cached ids for a server (after a 404, or when a server is removed). */
    forget(serverId: string): void {
        this.folderIds.delete(serverId);
        for (const key of [...this.ids.keys()]) {
            if (key.startsWith(`${serverId}/`)) this.ids.delete(key);
        }
    }

    private async ensureFileInternal(serverId: string, name: LauncherFileName, initial: string): Promise<{ id: string; createdHere: boolean }> {
        const key = `${serverId}/${name}`;
        const result = await this.once(`file:${key}`, async () => {
            const existing = await this.findFile(serverId, name);
            if (existing) return { id: existing, createdHere: false };
            const folder = await this.ensureFolder(serverId);
            const created = await this.drive.createFile(name, folder, { kind: 'bytes', data: new TextEncoder().encode(initial) });
            const id = await this.keepOldest(folder, name, created.id, false);
            return { id, createdHere: id === created.id };
        });
        this.ids.set(key, result.id);
        return result;
    }

    /** After creating `createdId`, keep the oldest item with that name and trash ours if it lost. */
    private async keepOldest(parentId: string, name: string, createdId: string, folders: boolean): Promise<string> {
        const all = (await this.drive.listChildren(parentId, { name, foldersOnly: folders }))
            .filter((m) => folders || m.mimeType !== FOLDER_MIME);
        const oldest = all[0]?.id ?? createdId;
        if (oldest !== createdId) {
            try {
                await this.drive.trash(createdId);
            } catch (err) {
                console.warn(`[launcher] could not trash duplicate ${name}:`, err);
            }
        }
        return oldest;
    }

    /** Runs `task` once per key at a time; concurrent callers share the same promise. */
    private once(key: string, task: () => Promise<{ id: string; createdHere: boolean }>): Promise<{ id: string; createdHere: boolean }> {
        const running = this.inflight.get(key);
        if (running) return running.then((r) => ({ id: r.id, createdHere: false }));
        const promise = task().finally(() => this.inflight.delete(key));
        this.inflight.set(key, promise);
        return promise;
    }
}
