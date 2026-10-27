// The players in a server's whitelist.json on this PC, the file Minecraft checks while "white-list" is on in
// server.properties. Minecraft keys players by account id, not by name, so a name added here is looked up at Mojang
// (what the game's own "/whitelist add" does). A server with online-mode off uses offline ids, made from the name
// alone the way Minecraft makes them. The next upload shares the file with the other members like any server file.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WhitelistPlayer } from '../../shared/types';
import { AppError } from '../errors';
import type { FetchFn } from '../installer/ServerInstaller';
import type { SettingsService } from '../settings/SettingsService';
import { parseProperties, PROPERTIES_FILE } from './ServerProperties';

export const WHITELIST_FILE = 'whitelist.json';
const MOJANG_PROFILE = 'https://api.mojang.com/users/profiles/minecraft/';
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

/** "069a79f4..." -> "069a79f4-44e9-4726-a5be-fca90e38aaf5" */
const dashed = (hex: string): string => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** The id Minecraft gives a player on a server with online-mode off: Java's UUID.nameUUIDFromBytes("OfflinePlayer:<name>"). */
export function offlineUuid(name: string): string {
    const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
    bytes[6] = (bytes[6] & 0x0f) | 0x30;                // version 3
    bytes[8] = (bytes[8] & 0x3f) | 0x80;                // IETF variant
    return dashed(bytes.toString('hex'));
}

export interface WhitelistDeps {
    settings: Pick<SettingsService, 'getServer'>;
    appVersion: string;
    fetchImpl?: FetchFn;
}

export class Whitelist {
    private readonly fetchImpl: FetchFn;

    constructor(private readonly d: WhitelistDeps) {
        this.fetchImpl = d.fetchImpl ?? ((url, init) => fetch(url, init));
    }

    async list(serverId: string): Promise<WhitelistPlayer[]> {
        return this.read(this.folder(serverId));
    }

    /** Adds a player by name; the name comes back as Mojang spells it. */
    async add(serverId: string, rawName: string): Promise<WhitelistPlayer[]> {
        const name = rawName.trim();
        if (!NAME_RE.test(name)) throw new AppError('INVALID', 'A Minecraft name has 1 to 16 letters, digits and underscores.');
        const folder = this.folder(serverId);
        const players = await this.read(folder);
        if (players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return players;
        const player = (await this.onlineMode(folder)) ? await this.lookUp(name) : { uuid: offlineUuid(name), name };
        if (!players.some((p) => p.uuid === player.uuid)) players.push(player);
        await this.write(folder, players);
        console.log(`[whitelist] ${serverId}: added ${player.name}`);
        return players;
    }

    async remove(serverId: string, uuid: string): Promise<WhitelistPlayer[]> {
        const folder = this.folder(serverId);
        const players = await this.read(folder);
        const left = players.filter((p) => p.uuid !== uuid);
        if (left.length !== players.length) {
            await this.write(folder, left);
            console.log(`[whitelist] ${serverId}: removed ${players.find((p) => p.uuid === uuid)?.name ?? uuid}`);
        }
        return left;
    }

    private async lookUp(name: string): Promise<WhitelistPlayer> {
        let response: Response;
        try {
            response = await this.fetchImpl(`${MOJANG_PROFILE}${encodeURIComponent(name)}`, {
                headers: { 'User-Agent': `MCS-Relay/${this.d.appVersion} (https://mcs-relay.com)` },
            });
        } catch (err) {
            throw new AppError('NETWORK', 'Mojang could not be reached to look the player up. Check your internet connection.', err instanceof Error ? err.message : String(err));
        }
        if (response.status === 404 || response.status === 204) throw new AppError('NOT_FOUND', `No Minecraft account is called "${name}".`);
        if (response.status === 429) throw new AppError('RATE_LIMITED', 'Mojang asked to slow down. Try again in a minute.');
        if (!response.ok) throw new AppError('NETWORK', `Mojang answered ${response.status}. Try again later.`);
        const profile = (await response.json()) as { id?: string; name?: string };
        if (!profile.id || !/^[0-9a-f]{32}$/i.test(profile.id)) throw new AppError('NETWORK', 'Mojang sent an answer MCS-Relay does not understand.');
        return { uuid: dashed(profile.id.toLowerCase()), name: profile.name ?? name };
    }

    /** online-mode in server.properties; Minecraft's default (on) when the file or the line is missing. */
    private async onlineMode(folder: string): Promise<boolean> {
        const file = path.join(folder, PROPERTIES_FILE);
        if (!existsSync(file)) return true;
        return parseProperties(await fs.readFile(file, 'latin1'))['online-mode'] !== 'false';
    }

    private async read(folder: string): Promise<WhitelistPlayer[]> {
        const file = path.join(folder, WHITELIST_FILE);
        if (!existsSync(file)) return [];
        try {
            const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
            if (!Array.isArray(raw)) return [];
            return raw
                .filter((p): p is { uuid: string; name: string } => typeof p?.uuid === 'string' && typeof p?.name === 'string')
                .map((p) => ({ uuid: p.uuid, name: p.name }));
        } catch {
            throw new AppError('INVALID', 'whitelist.json in the server folder is damaged. Fix or delete it, then try again.');
        }
    }

    /** As Minecraft writes it: a JSON list, two-space indents. */
    private async write(folder: string, players: WhitelistPlayer[]): Promise<void> {
        const file = path.join(folder, WHITELIST_FILE);
        await fs.writeFile(`${file}.tmp`, `${JSON.stringify(players.map((p) => ({ uuid: p.uuid, name: p.name })), null, 2)}\n`);
        await fs.rename(`${file}.tmp`, file);
    }

    private folder(serverId: string): string {
        const folder = this.d.settings.getServer(serverId).localPath;
        if (!folder) throw new AppError('NO_LOCAL_PATH', 'Choose a folder on this PC for this server first.');
        return folder;
    }
}
