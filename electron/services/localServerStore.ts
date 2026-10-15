import { app } from "electron";
import path from "path";
import fs from "fs";
import { ILocalVariables } from "../../src/lib/types";

type Store = {
    paths: Record<string, string>;
    joinedServerIds: string[];
    localVariables: ILocalVariables
}

const defaultStore: Store = {
    paths: {},
    joinedServerIds: [],
    localVariables: {
        selectedIndex: 0,
        playitggPath: "",
        watcherBlacklist: [],
        allocatedRAM: {
            MIN: 2048,
            MAX: 4096
        },
        checklist: {
            download: true,
            upload: true,
            serverConsole: true,
            playitgg: true
        }
    }
};

function getStorePath() {
    return path.join(app.getPath("userData"), "localStore.json");
}

function readStore(): Store {
    const storePath = getStorePath();

    if (!fs.existsSync(storePath)) {
        writeStore(defaultStore);
        return defaultStore;
    }

    try {
        return JSON.parse(fs.readFileSync(storePath, "utf-8"));
    } catch {
        writeStore(defaultStore);
        return defaultStore;
    }
}

function writeStore(data: Store) {
    const storePath = getStorePath();
    const dir = path.dirname(storePath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(storePath, JSON.stringify(data, null, 4), "utf-8");
}

export function setServerPath(serverId: string, localPath: string) {
    const store = readStore();
    store.paths[serverId] = localPath;
    writeStore(store);
}

export function removeServerPath(serverId: string) {
    const store = readStore();
    if (store.paths && serverId in store.paths) {
        delete store.paths[serverId];
        writeStore(store)
    }
}

export function getServerPath(serverId: string) {
    const store = readStore();
    return store.paths[serverId] || null;
}

export function addJoinedServer(serverId: string) {
    const store = readStore();
    if (!store.joinedServerIds.includes(serverId))
        store.joinedServerIds.push(serverId);
    writeStore(store);
}

export function getJoinedServerIds(): string[] {
    const store = readStore();
    return store.joinedServerIds || [];
}

export function removeJoinedServer(serverId: string) {
    const store = readStore();
    if (store.joinedServerIds.includes(serverId)) {
        store.joinedServerIds = store.joinedServerIds.filter(id => id !== serverId);
        writeStore(store);
    }
}

export function getLocalVariable<K extends keyof ILocalVariables>(variable: K): ILocalVariables[K] {
    const store = readStore()
    return store.localVariables[variable];
}

export function setLocalVariable<K extends keyof ILocalVariables>(variable: K, value: ILocalVariables[K]) {
  const store = readStore();
  store.localVariables[variable] = value;
  writeStore(store);
}