// Where the app keeps its data: %APPDATA%\mcs-relay. Builds before 1.0.0 used %APPDATA%\minecraft-distributed-hosting
// (the project's first name); that folder is moved over once, so sign-ins, server folders and unfinished uploads stay.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_FOLDER = 'mcs-relay';
export const PREVIOUS_DATA_FOLDER = 'minecraft-distributed-hosting';

type FolderFs = Pick<typeof fs, 'existsSync' | 'renameSync'>;

/** The data folder inside `appDataDir`, moving the previous one there first when only that one exists. */
export function resolveDataFolder(appDataDir: string, fsImpl: FolderFs = fs): string {
    const current = path.join(appDataDir, DATA_FOLDER);
    const previous = path.join(appDataDir, PREVIOUS_DATA_FOLDER);
    if (fsImpl.existsSync(current) || !fsImpl.existsSync(previous)) return current;
    try {
        fsImpl.renameSync(previous, current);
        console.log(`[data] moved the app's data from ${previous} to ${current}`);
        return current;
    } catch (err) {
        // A file in it is still open (an older copy of the app is running, for example): use it where it is this time.
        console.warn(`[data] could not move ${previous} to ${current}, using it where it is for now:`, err);
        return previous;
    }
}
