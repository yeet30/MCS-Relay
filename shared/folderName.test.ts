import { describe, expect, test } from 'vitest';
import { folderNameFor, serverFolderPath } from './folderName';

describe('folderNameFor', () => {
    test('keeps ordinary names and replaces what Windows refuses', () => {
        expect(folderNameFor('Survival with friends')).toBe('Survival with friends');
        expect(folderNameFor('Survival: Season 2?')).toBe('Survival- Season 2-');
        expect(folderNameFor('  The End.  ')).toBe('The End');
        expect(folderNameFor('CON')).toBe('CON-server');
        expect(folderNameFor('...')).toBe('Minecraft server');
    });

    test('puts the folder inside the parent with its separator', () => {
        expect(serverFolderPath('C:\\Users\\Steve\\MCS-Relay Servers\\', 'Survival')).toBe('C:\\Users\\Steve\\MCS-Relay Servers\\Survival');
        expect(serverFolderPath('/home/steve/servers', 'A/B')).toBe('/home/steve/servers/A-B');
    });
});
