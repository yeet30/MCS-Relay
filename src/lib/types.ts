import { ReactNode } from "react";

export interface IModalItems {
    title: string,
    content: ReactNode
}

export interface IPermittedUser{
    id:string,
    type:string, 
    emailAddress:string, 
    role:string, 
    displayName:string
}

export interface IServerFolder { 
    type: 'owned' | 'joined',
    id: string; 
    name: string; 
    path: string; 
    permittedUsers: IPermittedUser[]
}

export interface ILockStatus {
    hostName: string;
    hostEmail: string;
    publicIp: string;
    startedAt: string;
    expiresAt: string;
    status: "starting" | "online" | "stopping" | "offline",
    onlinePlayers?: string[]
};

export interface ILocalVariables{
    selectedIndex: number;
    playitggPath: string;
    watcherBlacklist: string[];
    allocatedRAM: {
        MIN: number,
        MAX: number
    },
    checklist: {
        download: boolean,
        upload: boolean,
        serverConsole: boolean,
        playitgg: boolean
    },
}

export interface IChecklist {
    download: boolean;
    upload: boolean;
    serverConsole: boolean;
    playitgg: boolean;
}

export interface IStartupOptions {
    checklist: IChecklist;
    folderId: string;
    serverPath: string,
    playitggPath: string;
    RAMoptions: {
        MIN: number;
        MAX: number;
    };
}

export interface IWatcherUpdates {
    changedFiles: Map<string,IFileEntry>
    removedFiles: Map<string,IFileEntry>
}

export interface IFileEntry {
    version: number,
    size: number,
    modifiedAt: number
}

export interface IManifest {
    version: number,
    updatedAt: number,
    authorName: string,
    authorEmail: string,
    files: Record<string, IFileEntry>
}