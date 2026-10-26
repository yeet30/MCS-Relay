// A server's name as the name of its folder on this PC, shared by the main process (which makes the folder) and the
// window (which shows where it will be).

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** "Survival: Season 2?" -> "Survival- Season 2-": characters Windows refuses in a folder name are replaced, and a
 *  trailing dot or space (which Windows drops) is removed. */
export function folderNameFor(name: string): string {
    // eslint-disable-next-line no-control-regex
    let folder = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
    if (RESERVED.test(folder)) folder = `${folder}-server`;
    return folder.slice(0, 80).trim() || 'Minecraft server';
}

/** The folder a new server gets inside `parent`, with the separator `parent` already uses. */
export function serverFolderPath(parent: string, name: string): string {
    const separator = parent.includes('\\') || !parent.includes('/') ? '\\' : '/';
    return `${parent.replace(/[\\/]+$/, '')}${separator}${folderNameFor(name)}`;
}
