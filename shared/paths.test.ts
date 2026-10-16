import { describe, expect, it } from 'vitest';
import {
    BUILTIN_IGNORES, DEFAULT_SHARED_IGNORES, ancestorsOf, baseName, compileRules, normalizeRule, parentOf, toPosix,
} from './paths';

describe('toPosix', () => {
    it('converts backslashes', () => {
        expect(toPosix('world\\region\\r.0.0.mca')).toBe('world/region/r.0.0.mca');
    });

    it('strips leading "./" and "/"', () => {
        expect(toPosix('./world/level.dat')).toBe('world/level.dat');
        expect(toPosix('/world/level.dat')).toBe('world/level.dat');
        expect(toPosix('.\\world')).toBe('world');
        expect(toPosix('././/a')).toBe('a');
    });

    it('collapses repeated slashes and keeps a trailing slash', () => {
        expect(toPosix('world//region///r.mca')).toBe('world/region/r.mca');
        expect(toPosix('logs/')).toBe('logs/');
    });

    it('leaves a clean path alone', () => {
        expect(toPosix('server.properties')).toBe('server.properties');
        expect(toPosix('')).toBe('');
    });
});

describe('parentOf, baseName, ancestorsOf', () => {
    it('parentOf', () => {
        expect(parentOf('world/region/r.0.0.mca')).toBe('world/region');
        expect(parentOf('server.properties')).toBe('');
        expect(parentOf('world/')).toBe('');
    });

    it('baseName', () => {
        expect(baseName('world/region/r.0.0.mca')).toBe('r.0.0.mca');
        expect(baseName('level.dat')).toBe('level.dat');
        expect(baseName('world/region/')).toBe('region');
    });

    it('ancestorsOf', () => {
        expect(ancestorsOf('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
        expect(ancestorsOf('world')).toEqual(['world']);
        expect(ancestorsOf('')).toEqual([]);
    });
});

describe('normalizeRule', () => {
    it('trims and converts to POSIX', () => {
        expect(normalizeRule('  logs\\  ')).toBe('logs/');
        expect(normalizeRule('./world\\stats')).toBe('world/stats');
        expect(normalizeRule('/crash-reports/')).toBe('crash-reports/');
    });

    it('keeps the trailing "/" of a folder rule', () => {
        expect(normalizeRule('debug/')).toBe('debug/');
        expect(normalizeRule('debug')).toBe('debug');
    });

    it('rejects empty rules', () => {
        expect(normalizeRule('')).toBeNull();
        expect(normalizeRule('   ')).toBeNull();
        expect(normalizeRule('/')).toBeNull();
        expect(normalizeRule('./')).toBeNull();
        expect(normalizeRule('**')).toBeNull();
        expect(normalizeRule('**/')).toBeNull();
    });

    it('rejects ".." anywhere', () => {
        expect(normalizeRule('..')).toBeNull();
        expect(normalizeRule('../secrets')).toBeNull();
        expect(normalizeRule('world/../../x')).toBeNull();
        expect(normalizeRule('world\\..\\x')).toBeNull();
    });

    it('keeps names that merely contain dots', () => {
        expect(normalizeRule('..hidden')).toBe('..hidden');
        expect(normalizeRule('*.tmp')).toBe('*.tmp');
    });

    it('turns "dir/**" into "dir/"', () => {
        expect(normalizeRule('logs/**')).toBe('logs/');
    });
});

describe('compileRules', () => {
    it('"dir/" matches the folder and everything below it', () => {
        const ignored = compileRules(['logs/']);
        expect(ignored('logs')).toBe(true);
        expect(ignored('logs/')).toBe(true);
        expect(ignored('logs/latest.log')).toBe(true);
        expect(ignored('logs/old/2026-10-01.log.gz')).toBe(true);
        expect(ignored('logsx/a')).toBe(false);
        expect(ignored('world/logs/a')).toBe(false);
    });

    it('"*.ext" matches any path ending in ".ext"', () => {
        const ignored = compileRules(['*.tmp']);
        expect(ignored('a.tmp')).toBe(true);
        expect(ignored('world/region/r.0.0.mca.tmp')).toBe(true);
        expect(ignored('a.tmp.bak')).toBe(false);
        expect(ignored('tmp')).toBe(false);
    });

    it('"**/name" matches any path whose last segment is "name"', () => {
        const ignored = compileRules(['**/session.lock']);
        expect(ignored('session.lock')).toBe(true);
        expect(ignored('world/session.lock')).toBe(true);
        expect(ignored('world_nether/DIM-1/session.lock')).toBe(true);
        expect(ignored('world/session.lock.bak')).toBe(false);
        expect(ignored('world/my-session.lock')).toBe(false);
    });

    it('any other rule matches that exact path (and what is below it when it is a folder)', () => {
        const ignored = compileRules(['world/stats', 'whitelist.json']);
        expect(ignored('whitelist.json')).toBe(true);
        expect(ignored('world/stats')).toBe(true);
        expect(ignored('world/stats/abc.json')).toBe(true);
        expect(ignored('other/whitelist.json')).toBe(false);
        expect(ignored('world/statsx')).toBe(false);
        expect(ignored('world')).toBe(false);
    });

    it('is case-insensitive on every platform', () => {
        const ignored = compileRules(['Logs/', '*.TMP', '**/Session.Lock', 'World/Stats']);
        expect(ignored('LOGS/latest.log')).toBe(true);
        expect(ignored('logs/latest.log')).toBe(true);
        expect(ignored('a.tmp')).toBe(true);
        expect(ignored('world/SESSION.LOCK')).toBe(true);
        expect(ignored('world/stats/x.json')).toBe(true);
    });

    it('accepts paths with backslashes or a leading "./"', () => {
        const ignored = compileRules(['logs/']);
        expect(ignored('logs\\latest.log')).toBe(true);
        expect(ignored('./logs/latest.log')).toBe(true);
    });

    it('drops invalid rules and never matches the empty path', () => {
        const ignored = compileRules(['', '..', '../x', '   ']);
        expect(ignored('x')).toBe(false);
        expect(ignored('')).toBe(false);
        expect(compileRules(['logs/'])('')).toBe(false);
    });

    it('applies the builtin and default rules', () => {
        const ignored = compileRules([...BUILTIN_IGNORES, ...DEFAULT_SHARED_IGNORES]);
        for (const path of [
            '.launcher/lock.json', 'manifest.json', 'manifest.tmp', 'lock.json', 'world/region/r.0.0.mca.part',
            'world/session.lock', 'logs/latest.log', 'crash-reports/c.txt', 'debug/profile.txt', 'eula.tmp',
        ]) {
            expect(ignored(path), path).toBe(true);
        }
        for (const path of ['world/level.dat', 'world/manifest.json', 'server.properties', 'world/lock.json']) {
            expect(ignored(path), path).toBe(false);
        }
    });

    it('no rules ignore nothing', () => {
        expect(compileRules([])('world/level.dat')).toBe(false);
    });
});
