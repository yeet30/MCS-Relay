// What a playit.gg tunnel is for, in words for players. playit.gg names the game of its own tunnel types; a plain
// port tunnel is recognised by the port it forwards to on the host's PC.
import type { PlayitTunnel } from '../../shared/types';

export interface TunnelInfo {
    name: string;
    help: string;
}

const KNOWN_PORTS: Record<string, TunnelInfo> = {
    24454: {
        name: 'Simple Voice Chat',
        help: 'For the Simple Voice Chat mod. Players do not type it in: their mod connects to it once the server\'s '
            + 'voicechat-server.properties has this address as voice_host.',
    },
    19132: {
        name: 'Minecraft Bedrock (Geyser)',
        help: 'For Bedrock players (phones, consoles, Windows) when the server runs Geyser: they add a server with this '
            + 'address and port.',
    },
    8123: { name: 'Dynmap web map', help: 'The server\'s web map: open http:// followed by this address in a browser.' },
    8100: { name: 'BlueMap web map', help: 'The server\'s web map: open http:// followed by this address in a browser.' },
};

const PROTOCOLS: Record<string, string> = { tcp: 'TCP', udp: 'UDP', 'tcp+udp': 'TCP and UDP' };

/** The port on the host's PC: "127.0.0.1:24454" -> "24454". */
export function localPort(tunnel: PlayitTunnel): string {
    return tunnel.local.slice(tunnel.local.lastIndexOf(':') + 1);
}

export function describeTunnel(tunnel: PlayitTunnel): TunnelInfo {
    if (tunnel.type === 'minecraft-java') {
        return { name: 'Minecraft Java', help: 'Players add this address in Minecraft under Multiplayer > Add Server.' };
    }
    if (tunnel.type === 'minecraft-bedrock') {
        return { name: 'Minecraft Bedrock', help: 'For Bedrock players (phones, consoles, Windows): they add a server with this address and port.' };
    }
    const port = localPort(tunnel);
    const known = KNOWN_PORTS[port];
    if (known) return known;
    const protocol = PROTOCOLS[tunnel.type];
    if (protocol) {
        return {
            name: `${protocol} port ${port}`,
            help: `Goes to port ${port} on the host's PC. What it is for depends on the program that listens there.`,
        };
    }
    return { name: tunnel.type, help: `A playit.gg "${tunnel.type}" tunnel to port ${port} on the host's PC.` };
}
