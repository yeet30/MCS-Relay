import path from "path";
import fs, { existsSync } from "fs";
import { IManifest, IFileEntry } from "../../src/lib/types";
import { getOAuthClient, authorizedFetch, refreshIfNeeded } from "./googleAuthService";
import { OAuth2Client } from "google-auth-library";
import { getServerPath } from "./localServerStore";
import { createFolder } from "./googleDriveService";
import { PROTECTED_DIRECTORIES, applyManifestChanges, getFilesToDownload, getFilesToUpload, localManifest } from "./watcher-manifest";
import { unlink } from 'node:fs/promises';

const DRIVE_BASE_URL = "https://www.googleapis.com/drive/v3/files";

type TFolderNode = { type: "folder", children: Map<string, TDirectoryNode> }
type TDirectoryNode = { type: "file", stats: IFileEntry} | TFolderNode
interface IDriveItem {
    id: string,
    name: string,
    mimeType: string
}

export async function readDriveManifest(folderId: string): Promise<null | IManifest> {
    const client = getOAuthClient();

    const query = `'${folderId}' in parents and name='manifest.json' and trashed=false`;
    const url = `${DRIVE_BASE_URL}?q=${encodeURIComponent(query)}&fields=files(id)`;
    const data = await authorizedFetch(client, url);

    if (!data?.files || data.files.length === 0) return null

    const manifestFileId = data.files[0].id
    const manifestData = await authorizedFetch(
        client,
        `${DRIVE_BASE_URL}/${manifestFileId}?alt=media`,
        { method: "GET" },
        {}
    );

    return manifestData
}

function buildTransferMap(filesToBeTransfered: Map<string, IFileEntry>): TFolderNode {
    const root: TFolderNode = { type: "folder", children: new Map<string, TDirectoryNode>() }

    for (const [filePath, fileEntry] of Object.entries(filesToBeTransfered)) {
        const parts = filePath.split(/[\\/]+/).filter(Boolean);
        const length = parts.length
        let currentNode: TDirectoryNode  = root

        for (let i = 0; i < length; i++) {
            const currentPart = parts[i]
            const isLast = (i === length - 1)

            if (currentNode.type !== "folder") break

            if (!currentNode.children.has(currentPart))
                currentNode.children.set(
                    currentPart,
                    isLast ? 
                        { type: "file" , stats: {
                            version: fileEntry.version,
                            size: fileEntry.size,
                            modifiedAt: fileEntry.modifiedAt
                        }} : 
                        { type: "folder", children: new Map() }
                )

            if (!isLast) currentNode = currentNode.children.get(currentPart)! //descends into the newly created directory
        }
    }

    return root
}

async function listFolderIDs(client: OAuth2Client, folderId: string): Promise<IDriveItem[]> {
    const query = `'${folderId}' in parents and trashed=false`;
    let pageToken: string | undefined;
    const items: IDriveItem[] = []

    do {
        const url =
        `${DRIVE_BASE_URL}?q=${encodeURIComponent(query)}`
        + `&fields=files(id,name,mimeType),nextPageToken`
        + `&supportsAllDrives=true`
        + `&includeItemsFromAllDrives=true`
        + `&pageSize=1000`
        + (pageToken ? `&pageToken=${pageToken}`: "")

        const data = await authorizedFetch(client, url);
        items.push(...(data.files || []))
        pageToken = data.nextPageToken;
    }
    while (pageToken)
    
    return items
}

async function deleteLocalFiles(localPath: string, files: Map<string,IFileEntry>): Promise<Map<string,string>>{
    const results = await Promise.allSettled(
        [...files.keys()].map(async file => {
            await unlink(path.join(localPath, file));
            return file;
        }
    ))

    const failedDeletions = new Map<string,string>()

    results.forEach((result, index) => {
        if (result.status === "rejected") failedDeletions.set([...files.keys()][index], result.reason);
    })
    return failedDeletions
}

async function downloadFile(client: OAuth2Client, fileId: string, localItemPath: string) {
    await refreshIfNeeded(client);
    const accessToken = client.credentials.access_token;

    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) 
        return{
            success: false,
            error: await res.text()
        }

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localItemPath, buffer)

    return { success: true }
}

async function downloadFolderRecursive( client: OAuth2Client, folderId: string, localPath: string, fileMap: TFolderNode):
Promise<{succesfulDownloads: Map<string,IFileEntry>, failedDownloads: Map<string,IFileEntry>}>
{
    const driveItems: IDriveItem[] = await listFolderIDs(client, folderId);
    const driveItemsByName = new Map(driveItems.map(item=>[item.name, item]))

    let succesfulDownloads = new Map<string,IFileEntry>()
    let failedDownloads= new Map<string,IFileEntry>()

    for (const [fileName, node] of fileMap.children) {
        if (PROTECTED_DIRECTORIES.has(fileName)) continue;

        const driveItem = driveItemsByName.get(fileName)
        if (!driveItem) {
            console.warn("In manifest but not found in Drive:", path.join(localPath, fileName));
            continue;
        }

        const localItemPath = path.join(localPath, fileName);

        if(node.type === "folder"){
            if (driveItem.mimeType !== "application/vnd.google-apps.folder") {
                console.warn("Manifest expected a folder but Drive has a file:", fileName);
                continue;
            }
            
            try {
                const info = fs.statSync(localItemPath)
                if(!info.isDirectory()){
                    console.warn("Manifest expected a folder but found a file:", localItemPath);
                    continue
                }
            } catch (error) {
                if(!existsSync(localItemPath))
                    fs.mkdirSync(localItemPath);
            }

            const recursiveRes = await downloadFolderRecursive(client, driveItem.id, localItemPath, node);
            for (const [k, v] of recursiveRes.succesfulDownloads) succesfulDownloads.set(k, v);
            for (const [k, v] of recursiveRes.failedDownloads) failedDownloads.set(k, v);
        }
        else {
            try {
                const info = fs.statSync(localItemPath)
                if(!info.isFile()){
                    console.warn("Manifest expected a file but found a directory:", localItemPath);
                    continue
                }
            } catch (error) {
                console.warn(error)
            }
            
            const downloadRes = await downloadFile(client, driveItem.id, localItemPath);
            if (downloadRes.success) {
                succesfulDownloads.set(fileName, node.stats)
                localManifest.files[fileName] = node.stats
            }
            else failedDownloads.set(fileName, node.stats)
        }
    }
    return {
        succesfulDownloads: succesfulDownloads, 
        failedDownloads: failedDownloads 
    }
}

export async function downloadServerFolder(serverId: string, overrideWarning: boolean = false) {
    const client = getOAuthClient();
    const localPath = getServerPath(serverId);

    if (!localPath) return { success: false, error: "No local path set." };

    try {
        if (!fs.existsSync(localPath)) fs.mkdirSync(localPath, { recursive: true });

        const diffRes = await getFilesToDownload(localPath, serverId, overrideWarning)
        if(!diffRes.success)
            return {
            success: false,
            error: diffRes.error
        }
        await deleteLocalFiles(localPath, diffRes.filesToRemove!)

        const fileTransferMap = buildTransferMap(diffRes.filesToDownload!)
        const downloadRes = await downloadFolderRecursive(client, serverId, localPath, fileTransferMap);
        if(!downloadRes.failedDownloads.size)
            localManifest.version = diffRes.driveVersion as number
        applyManifestChanges(localPath)
        return { success: true };
    } 
    catch (err: any) {
        return { 
            success: false, 
            error: err.message 
        }
    }

}

async function uploadFile( client: OAuth2Client, localFilePath: string, fileName: string, parentId: string, existing?: IDriveItem) {
    await refreshIfNeeded(client);
    const accessToken = client.credentials.access_token;

    try {
        const metadata = { name: fileName, parents: existing ? undefined : [parentId] };
        const initUrl = existing
            ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=resumable`
            : `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`;

        const initRes = await fetch(initUrl, {
            method: existing ? "PATCH" : "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json; charset=UTF-8"
            },
            body: JSON.stringify(metadata)
        });

        if (!initRes.ok) throw new Error(await initRes.text());

        const sessionUrl = initRes.headers.get("Location");
        if (!sessionUrl) throw new Error("No resumable session URL returned by Drive.");

        const fileBuffer = fs.readFileSync(localFilePath);

        const uploadRes = await fetch(sessionUrl, {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(fileBuffer.length)
            },
            body: fileBuffer
        });

        if (!uploadRes.ok) return {success: false, error: await uploadRes.text()}
        return {success: true, data: await uploadRes.json()}
    } catch (error: any) {
        return { success: false, error: error.message };
    }
    
}

async function uploadFolderRecursive(client: OAuth2Client, localPath: string, parentId: string, fileMap: TFolderNode):
Promise<{succesfulUploads: Map<string,IFileEntry>, failedUploads: Map<string,IFileEntry>}> 
{
    const driveItems = await listFolderIDs(client, parentId);
    const driveItemsByName = new Map(driveItems.map(item=>[item.name, item]))

    let succesfulUploads = new Map<string,IFileEntry>()
    let failedUploads= new Map<string,IFileEntry>()

    for (const [fileName, node] of fileMap.children) {
        if (PROTECTED_DIRECTORIES.has(fileName)) continue;

        const localItemPath = path.join(localPath, fileName)
        const driveItem = driveItemsByName.get(fileName)

        if (node.type === "folder") {
            try {
                const info = fs.statSync(localItemPath)
                if(!info.isDirectory()){
                    console.warn("Manifest expected a folder but found a file:", localItemPath);
                    continue
                }
            } catch (error) {
                console.warn("In manifest but not found in Local:", localItemPath, " Error: ", error);
                continue;
            }
            
            let folderId: string;

            if(driveItem?.mimeType==="application/vnd.google-apps.folder")
                folderId = driveItem.id;
            else if(driveItem){
                console.warn("Manifest expected a folder but the Drive has a file: ", driveItem?.name)
                continue
            }
            else
                folderId = await createFolder(client, path.basename(fileName), parentId);

            const recursiveRes = await uploadFolderRecursive(client, localItemPath, folderId, node);
            for (const [k, v] of recursiveRes.succesfulUploads) succesfulUploads.set(k, v);
            for (const [k, v] of recursiveRes.failedUploads) failedUploads.set(k, v);
        } 
        else {
            try {
                const info = fs.statSync(localItemPath)
                if(!info.isFile()){
                    console.warn("Manifest expected a file but found a directory:", localItemPath);
                    continue
                }
            } catch (error) {
                console.warn("In manifest but not found in Local:", localItemPath, " Error: ", error);
                continue;
            }

            const uploadRes = await uploadFile(client, localItemPath, fileName, parentId, driveItem);
            if (uploadRes.success) {
                succesfulUploads.set(fileName, node.stats)
                localManifest.files[fileName] = node.stats
            }
            else failedUploads.set(fileName, node.stats)
        }
    }
    return { 
        succesfulUploads: succesfulUploads, 
        failedUploads: failedUploads 
    }
}

export async function uploadServerFolder(serverId: string,) {
    const client = getOAuthClient();
    const localPath = getServerPath(serverId)

    if (!localPath) return { success: false, error: "No local path set." };

    try {
        const diffRes = await getFilesToUpload(localPath, serverId)

        const fileTransferMap = buildTransferMap(diffRes.filesToUpload!) 
        const uploadRes = await uploadFolderRecursive(client, localPath, serverId, fileTransferMap);

        if (!uploadRes.failedUploads.size)
            localManifest.version++
        applyManifestChanges(localPath)
        return { success: true };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}


