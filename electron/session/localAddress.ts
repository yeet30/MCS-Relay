// The address friends on the same network join with when the server runs without playit.gg: this PC's address on
// the local network and the server's port. It only works inside that network, so it is shown on this PC and never
// written to the lock.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 25565;

type Interfaces = ReturnType<typeof os.networkInterfaces>;

// Adapters that are not the PC's own network: virtual machines, WSL, VPNs and the like.
const VIRTUAL_RE = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|vpn|tap-|tun/i;

/** server-port from server.properties; 25565 when it is missing or not a port. */
export function serverPort(serverPath: string): number {
    try {
        const text = readFileSync(path.join(serverPath, 'server.properties'), 'utf8');
        const m = /^[ \t]*server-port[ \t]*[=:][ \t]*(\d+)[ \t]*\r?$/m.exec(text);
        const port = m ? Number(m[1]) : NaN;
        return port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
    } catch {
        return DEFAULT_PORT;
    }
}

function isPrivate(ip: string): boolean {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** This PC's IPv4 address on its local network: a private address of a real adapter first, then any private one. */
export function lanIp(interfaces: Interfaces = os.networkInterfaces()): string | null {
    const candidates: Array<{ name: string; ip: string }> = [];
    for (const [name, list] of Object.entries(interfaces)) {
        for (const info of list ?? []) {
            if (info.family === 'IPv4' && !info.internal && isPrivate(info.address)) candidates.push({ name, ip: info.address });
        }
    }
    return (candidates.find((c) => !VIRTUAL_RE.test(c.name)) ?? candidates[0])?.ip ?? null;
}

/** "192.168.1.23:25565", or null when this PC is on no local network. */
export function localJoinAddress(serverPath: string, interfaces?: Interfaces): string | null {
    const ip = lanIp(interfaces);
    return ip ? `${ip}:${serverPort(serverPath)}` : null;
}
