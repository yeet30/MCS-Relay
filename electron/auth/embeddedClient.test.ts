import { describe, expect, it } from 'vitest';
import { scrambleClientFile, unscrambleClient } from './embeddedClient';

const FILE = JSON.stringify({
    installed: { client_id: '123-abc.apps.googleusercontent.com', project_id: 'some-project', client_secret: 'GOCSPX-not-a-real-one' },
});

describe('the built-in sign-in client', () => {
    it('comes back as it went in, and is not readable in between', () => {
        const blob = scrambleClientFile(FILE);
        expect(blob).not.toContain('GOCSPX');
        expect(Buffer.from(blob, 'base64').toString('latin1')).not.toContain('GOCSPX');
        expect(unscrambleClient(blob)).toEqual({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-not-a-real-one' });
    });

    it('keeps only the id and the secret, not the project details', () => {
        const blob = scrambleClientFile(FILE);
        expect(JSON.stringify(unscrambleClient(blob))).not.toContain('some-project');
    });

    it('is missing, not broken, when the build had no client file', () => {
        expect(scrambleClientFile(null)).toBe('');
        expect(scrambleClientFile('not json')).toBe('');
        expect(scrambleClientFile(JSON.stringify({ web: { client_id: 'x' } }))).toBe('');
        expect(unscrambleClient('')).toBeNull();
        expect(unscrambleClient('bm9pc2U=')).toBeNull();
    });
});
