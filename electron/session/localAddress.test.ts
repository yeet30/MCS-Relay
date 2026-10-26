import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { lanIp, localJoinAddress, serverPort } from './localAddress';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null });

let dir: string | null = null;
afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
});

describe('local address', () => {
    test('picks the real adapter\'s private address over virtual ones and public ones', () => {
        expect(lanIp({
            'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
            'vEthernet (WSL)': [v4('172.20.16.1')],
            'Ethernet 2': [v4('84.12.3.4')],
            'Wi-Fi': [v4('192.168.1.23')],
        })).toBe('192.168.1.23');
        expect(lanIp({ 'vEthernet (WSL)': [v4('172.20.16.1')] })).toBe('172.20.16.1');
        expect(lanIp({ 'Ethernet': [v4('84.12.3.4')] })).toBeNull();
    });

    test('uses server-port from server.properties, 25565 otherwise', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-port-'));
        expect(serverPort(dir)).toBe(25565);
        fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=x\r\nserver-port=25570\r\n');
        expect(serverPort(dir)).toBe(25570);
        expect(localJoinAddress(dir, { 'Wi-Fi': [v4('10.0.0.5')] })).toBe('10.0.0.5:25570');
        fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=99999\n');
        expect(serverPort(dir)).toBe(25565);
    });
});
