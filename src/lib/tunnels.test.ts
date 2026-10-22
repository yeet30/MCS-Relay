import { describe, expect, test } from 'vitest';
import { describeTunnel, localPort } from './tunnels';

const tunnel = (type: string, local: string) => ({ address: 'x.ply.gg:1', type, local });

describe('describeTunnel', () => {
    test('names playit.gg game types, known ports and plain ports', () => {
        expect(describeTunnel(tunnel('minecraft-java', '127.0.0.1:25565')).name).toBe('Minecraft Java');
        expect(describeTunnel(tunnel('udp', '127.0.0.1:24454')).name).toBe('Simple Voice Chat');
        expect(describeTunnel(tunnel('udp', '127.0.0.1:19132')).name).toBe('Minecraft Bedrock (Geyser)');
        expect(describeTunnel(tunnel('tcp+udp', '127.0.0.1:7777')).name).toBe('TCP and UDP port 7777');
        expect(describeTunnel(tunnel('terraria', '127.0.0.1:7777')).name).toBe('terraria');
    });

    test('the local port comes after the last colon', () => {
        expect(localPort(tunnel('udp', '127.0.0.1:24454'))).toBe('24454');
        expect(localPort(tunnel('udp', '[::1]:24454'))).toBe('24454');
    });
});
