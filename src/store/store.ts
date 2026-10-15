import { create } from "zustand";
import { IServerFolder, ILockStatus, IChecklist } from "../lib/types";

type UserStore = {
    userName: string;
    userEmail: string;
    userPicture: string;
    loadingUser: boolean;
    driveScopeAllowed: false;

    checkDriveScope: () => Promise<void>;
    loadUser: () => Promise<void>;
}

type ServerStore = {
    servers: IServerFolder[];
    selectedServer: IServerFolder | null;
    loadingServers: boolean;
    serversErrors: string;
    lockStatus: ILockStatus;
    loadingHosting: boolean;
    serverRunning: boolean;
    
    setLoadingHosting: (loading: boolean) => void,
    setLockStatus: (status: ILockStatus) => void;
    setServerById: (id: string) => void;
    setServerRunning: (isRunning: boolean) => void,
    setServerByIndex: (index:number) => void
    loadServers: () => Promise<void>;
}

interface LocalVariables{
    selectedIndex: number;
    checklist: {
        download: boolean;
        upload: boolean;
        serverConsole: boolean;
        playitgg: boolean;
    }
    playitggPath: string;
    allocatedRAM: {
        MIN: number,
        MAX: number
    }

    loadLocalVariables: () => Promise<void>
    setSelectedIndex: (index: number) => Promise<void>
    setAllocatedRAM: (min: number, max: number) => Promise<void>
    setPlayitggPath: (path: string) => void
    setChecklist: (list: IChecklist) => void
};

interface WatcherManifet {
    trackedFiles: Set<string>

    addFile: (path: string) => void
    removeFile: (path: string) => void
    setTrackedFiles: (trackedFiles: Set<string> )=> void
}

const useServerStore = create<ServerStore>((set,get) => ({
    servers: [],
    selectedServer: null,
    loadingServers: true,
    serversErrors: "",
    lockStatus: {
        hostName: "",
        hostEmail: "",
        publicIp: "",
        startedAt: "",
        expiresAt: "",
        status:  "offline" 
    },
    loadingHosting: true,
    serverRunning: false,

    setLoadingHosting: (loading: boolean) => set({loadingHosting: loading}),
    setLockStatus: (status: ILockStatus) => set({lockStatus: status}),
    setServerRunning: (isRunning: boolean) => set({serverRunning: isRunning}),
    setServerById: (id:string) => set({ selectedServer: get().servers.find(server=> server.id === id) }),
    setServerByIndex: (index:number) => set({ selectedServer: get().servers[index] ?? get().servers[0] ?? null }),

    loadServers : 
        async function() {
            set({ loadingServers: true });

            const ownedResult = await window.ipcRenderer.invoke("drive-get-root");
            const joinedResult = await window.ipcRenderer.invoke("get-joined-folders");

            const owned = ownedResult.success ? ownedResult.servers : [];
            const joined = joinedResult.success ? joinedResult.servers : [];
            const servers = [...owned, ...joined];

            set({
                servers: servers,
                selectedServer: servers[0],
                serversErrors: (!ownedResult.success ? ownedResult.error : '') + (!joinedResult.success ? joinedResult.error : ''),
                loadingServers: false
            });
        },

    
}));

const useUserStore = create<UserStore>((set) => ({
    userName: "", 
    userEmail: "", 
    userPicture: "",
    loadingUser: true,
    driveScopeAllowed: false,

    loadUser : 
        async function() {
            set({ loadingUser: true });
            const user = await window.ipcRenderer.invoke("google-get-user");
            set({
                userName: user.name,
                userEmail: user.email,
                userPicture: user.picture,
            });
        },

    checkDriveScope: 
        async function() {
            const res = await window.ipcRenderer.invoke("is-request-allowed")
            set({driveScopeAllowed: res, loadingUser: false})
        },
}))

const useLocalStore = create<LocalVariables>((set) => ({
    selectedIndex: 0,
    checklist: {
        download: true,
        upload: true,
        serverConsole: true,
        playitgg: true
    },
    playitggPath: "",
    allocatedRAM: {
        MIN: 2048,
        MAX: 4096,
    },

    loadLocalVariables:
        async function() {
            const path = await window.ipcRenderer.invoke("get-local-variable", "playitggPath")
            const index = await window.ipcRenderer.invoke("get-local-variable", "selectedIndex")
            const allocatedRAM = await window.ipcRenderer.invoke("get-local-variable", "allocatedRAM")
            const checkList = await window.ipcRenderer.invoke("get-local-variable", "checklist")
            
            set({
                playitggPath: path,
                selectedIndex: index,
                allocatedRAM: allocatedRAM || {MIN: 2048, MAX: 4096},
                checklist: checkList
            })
        },

    setSelectedIndex:
        async function(index:number) {
            await window.ipcRenderer.invoke("set-local-variable", "selectedIndex" ,index)
        },

    setAllocatedRAM:
        async function (min: number, max: number){
            const allocatedRAM = {
                MIN: min,
                MAX: max
            }
            set({allocatedRAM: allocatedRAM})
            await window.ipcRenderer.invoke("set-local-variable", "allocatedRAM", allocatedRAM)
        },
    
    setPlayitggPath: 
        async function (path: string) {
            await window.ipcRenderer.invoke("set-local-variable", "playitggPath", path)
            set({playitggPath:path})
        },

    setChecklist:
        async function (list: IChecklist) {
            await window.ipcRenderer.invoke("set-local-variable", "checklist", list)
            set({checklist: list})
        }
}))

const useWatcherManifest = create<WatcherManifet>((set,get)=>({
    trackedFiles: new Set<string>(),

    addFile: (path) => {
        const buffTracked = new Set<string>(get().trackedFiles)
        buffTracked.add(path)
        set({trackedFiles: buffTracked})
    },
    removeFile(path) {
        const buff = new Set<string>(get().trackedFiles)
        buff.delete(path)
        set({trackedFiles: buff})
    },
    setTrackedFiles: (tracked: Set<string>) => set({trackedFiles: tracked})
}))

export {useServerStore, useUserStore, useLocalStore, useWatcherManifest};