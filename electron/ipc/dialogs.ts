// Native dialogs, behind the Dialogs interface so services can be tested without Electron.
import { dialog, shell } from 'electron';
import type { BrowserWindow, OpenDialogOptions } from 'electron';
import { AppError } from '../errors';
import type { Dialogs } from '../settings/SettingsService';

/** Where to save a file; null when cancelled. Only main.ts uses it, so it is not part of Dialogs. */
export type ChooseSaveFile = (title: string, defaultName: string) => Promise<string | null>;

export function createDialogs(getWindow: () => BrowserWindow | null): Dialogs & { chooseSaveFile: ChooseSaveFile } {
    const open = async (options: OpenDialogOptions): Promise<string | null> => {
        const win = getWindow();
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    };
    return {
        chooseFolder: (title, defaultPath) => open({ title, defaultPath, properties: ['openDirectory', 'createDirectory'] }),
        chooseFile: (title, filters, defaultPath) => open({ title, defaultPath, filters, properties: ['openFile'] }),
        async chooseSaveFile(title, defaultName) {
            const win = getWindow();
            const options = { title, defaultPath: defaultName, filters: [{ name: 'Text', extensions: ['txt'] }] };
            const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
            return result.canceled || !result.filePath ? null : result.filePath;
        },
        async openPath(p) {
            const error = await shell.openPath(p);
            if (error) throw new AppError('NOT_FOUND', 'The folder could not be opened.', error);
        },
    };
}
