import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyChanges, escapeValue, parseProperties, ServerProperties } from './ServerProperties';

/** The start of a file as Minecraft writes it. */
const MINECRAFT = [
    '#Minecraft server properties',
    '#Sat Oct 26 18:00:00 CEST 2026',
    'allow-flight=false',
    'difficulty=easy',
    'motd=\\u00A7aSurvival \\: with friends',
    'max-players=20',
    'level-seed=',
    'server-port=25565',
    '',
].join('\r\n');

describe('parseProperties', () => {
    it('reads values as Minecraft does, with escapes and without comments', () => {
        expect(parseProperties(MINECRAFT)).toEqual({
            'allow-flight': 'false', difficulty: 'easy', motd: '§aSurvival : with friends', 'max-players': '20', 'level-seed': '', 'server-port': '25565',
        });
    });

    it('accepts the other separators and continued lines', () => {
        expect(parseProperties('a: 1\nb 2\n  c=three \\\n    words\n! comment\n')).toEqual({ a: '1', b: '2', c: 'three words' });
    });
});

describe('applyChanges', () => {
    it('rewrites only the changed lines and keeps comments, order and line endings', () => {
        const out = applyChanges(MINECRAFT, { difficulty: 'hard', 'max-players': '20', pvp: 'false' });
        expect(out).toBe(MINECRAFT.replace('difficulty=easy', 'difficulty=hard') + 'pvp=false\r\n');
    });

    it('leaves the file untouched when nothing changed', () => {
        expect(applyChanges(MINECRAFT, { difficulty: 'easy' })).toBe(MINECRAFT);
    });

    it('writes values Minecraft reads back exactly', () => {
        const motd = '§6Gold & Co: "the best" = yes #1 é';
        const out = applyChanges('', { motd });
        expect(out).toBe(`motd=${escapeValue(motd)}\n`);
        expect(out).toMatch(/^[\x20-\x7e\n]*$/);                    // plain ASCII, as Minecraft writes it
        expect(parseProperties(out).motd).toBe(motd);
    });

    it('replaces a value that was continued over several lines', () => {
        expect(applyChanges('motd=one \\\n  two\nx=1\n', { motd: 'three' })).toBe('motd=three\nx=1\n');
    });
});

describe('ServerProperties', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });
    const setup = (localPath: string | null) => new ServerProperties({ settings: { getServer: () => ({ localPath }) } as never });

    it('reads the file in the server folder, and changes it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-props-'));
        dirs.push(dir);
        fs.writeFileSync(path.join(dir, 'server.properties'), MINECRAFT, 'latin1');
        const props = setup(dir);
        expect((await props.read('s1')).values.difficulty).toBe('easy');
        const after = await props.write('s1', { difficulty: 'normal' });
        expect(after).toMatchObject({ exists: true, values: { difficulty: 'normal', motd: '§aSurvival : with friends' } });
        expect(fs.readFileSync(path.join(dir, 'server.properties'), 'latin1')).toContain('#Minecraft server properties\r\n');
    });

    it('makes the file when the server never started yet', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-props-'));
        dirs.push(dir);
        const props = setup(dir);
        expect(await props.read('s1')).toEqual({ exists: false, values: {} });
        await props.write('s1', { 'max-players': '8' });
        expect(fs.readFileSync(path.join(dir, 'server.properties'), 'latin1')).toBe('max-players=8\n');
    });

    it('refuses odd names and values on several lines', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-props-'));
        dirs.push(dir);
        await expect(setup(dir).write('s1', { 'bad key': 'x' })).rejects.toMatchObject({ code: 'INVALID' });
        await expect(setup(dir).write('s1', { motd: 'a\nb' })).rejects.toMatchObject({ code: 'INVALID' });
    });

    it('needs the server\'s folder on this PC', async () => {
        await expect(setup(null).read('s1')).rejects.toMatchObject({ code: 'NO_LOCAL_PATH' });
    });
});
