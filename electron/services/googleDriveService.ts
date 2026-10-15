import { OAuth2Client } from "google-auth-library";
import { addJoinedServer, removeJoinedServer, getJoinedServerIds, getServerPath, removeServerPath } from "./localServerStore";
import { getOAuthClient, refreshIfNeeded, authorizedFetch, debugUser } from "./googleAuthService";

const DRIVE_BASE_URL = "https://www.googleapis.com/drive/v3/files";
const ROOT_FOLDER_NAME = "Minecraft Shared Servers";
const MAX_SERVERS = 3;

async function findRootFolder(client: OAuth2Client) { //gets the root folder's id
	const query = `name='${ROOT_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

	const url = `${DRIVE_BASE_URL}?q=${encodeURIComponent(query)}&fields=files(id,name)`;

	const data = await authorizedFetch(client, url, { method: "GET" });

	if (data.files && data.files.length > 0)
		return data.files[0].id;

	return null;
}

async function countServerFolders(client: OAuth2Client, rootId: string) {
	const query = `'${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;

	const url = `${DRIVE_BASE_URL}?q=${encodeURIComponent(query)}&fields=files(id,name)`;

	const data = await authorizedFetch(client, url, { method: "GET" });

	return data.files || [];
}

export async function createFolder(client: OAuth2Client, name: string, parentId?: string) {

	const body: any = {name, mimeType: "application/vnd.google-apps.folder"};

	if (parentId)
		body.parents = [parentId];

	const data = await authorizedFetch(client, DRIVE_BASE_URL, {
		method: "POST",
		body: JSON.stringify(body)
	});

	return data.id;
}

export async function createServerFolder() {
	try {
		const client = getOAuthClient();
		let rootId = await findRootFolder(client);
		if (!rootId) {
			rootId = await createFolder(client, ROOT_FOLDER_NAME);
		}
		const servers = await countServerFolders(client, rootId);
		if (servers.length >= MAX_SERVERS) {
			return {
				success: false,
				error: "Maximum 3 servers reached"
			};
		}
		const newServerName = `Server-${servers.length + 1}`;
		const id = await createFolder(client, newServerName, rootId);

		return { success: true, folderId: id };

	} catch (err: any) {
		return {
			success: false,
			error: err.message
		};
	}
}

export async function deleteServerFolder(folderId: string) {
	try {
		const client = getOAuthClient();
		const url = `https://www.googleapis.com/drive/v3/files/${folderId}`;
		await authorizedFetch(client, url, {
			method: "DELETE"
		});
		removeServerPath(folderId)
		return { success: true };
	} catch (err: any) {
		return {
			success: false,
			error: err.message
		};
	}
}

async function listServerFolders(client: OAuth2Client, folderId: string) {
	const query = `'${folderId}' in parents and trashed=false`;
	const url = `${DRIVE_BASE_URL}?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType)`;
	const data = await authorizedFetch(client, url);
	const servers = await Promise.all(
		data.files
			.filter((f: any) => f.mimeType === "application/vnd.google-apps.folder")
			.map(async (f: any) => ({
				type: 'owned',
				id: f.id,
				name: f.name,
				path: getServerPath(f.id) || "",
				permittedUsers: await getFolderPermissions(f.id)
			}))
	)
	return servers;
}

export async function getRootWithContents() {
	try {
		const client = getOAuthClient();
		const rootId = await findRootFolder(client);
		if (!rootId) {
			return {
				success: true,
				rootId: null,
				rootName: ROOT_FOLDER_NAME,
				servers: []
			};
		}
		const servers = await listServerFolders(client, rootId);
		return {
			success: true,
			rootId,
			rootName: ROOT_FOLDER_NAME,
			servers: JSON.parse(JSON.stringify(servers))
		};

	} catch (err: any) {
		return {
			success: false,
			error: err.message
		};
	}
}

export async function getJoinedServers() {
	const client = getOAuthClient();
	await refreshIfNeeded(client);
	const accessToken = client.credentials.access_token;

	const ids = getJoinedServerIds()

	const servers = (await Promise.all(
		ids.map(async (folderId) => {
			const res = await fetch(
				`${DRIVE_BASE_URL}/${folderId}?fields=id,name`,
				{ headers: { Authorization: `Bearer ${accessToken}` } }
			)

			if (!res.ok)
				return null

			const data = await res.json()
			const permissions = await getFolderPermissions(folderId);

			const user = await debugUser(client)
			const currentUserPermission = permissions.find((p: any) => p.emailAddress === user.email);

			if (currentUserPermission?.role === 'owner') 
				return null;

			return {
				type: 'joined' as const,
				id: data.id,
				name: data.name,
				path: getServerPath(data.id) || '',
				permittedUsers: await getFolderPermissions(data.id)
			}
		})
	)).filter(s => s !== null)

	if (!servers.length)
		return { success: false, error: "No joined servers found." }

	return { success: true, servers: JSON.parse(JSON.stringify(servers)) };
}

export async function getFolderPermissions(folderId: string) {

	const client = getOAuthClient();
	await refreshIfNeeded(client);
	const accessToken = client.credentials.access_token;

	const res = await fetch(
		`https://www.googleapis.com/drive/v3/files/${folderId}/permissions?fields=permissions(id,emailAddress,role,type,displayName,photoLink)`,
		{
			headers: {
				Authorization: `Bearer ${accessToken}`
			}
		}
	);

	if (!res.ok)
		return []

	const data = await res.json();

	return data.permissions || [];
}

export async function inviteUserToServer(serverId: string, email: string, message?: string) {
	const client = getOAuthClient();
	await refreshIfNeeded(client);

	const accessToken = client.credentials.access_token;

	let defaultMessage = `You have been invited to a shared Minecraft server folder. To join, copy the link below and paste it in the app.

  ➜ ${serverId}`

	if (message)
		defaultMessage = message + '\n\n' + defaultMessage

	const params = new URLSearchParams({ sendNotificationEmail: "true", emailMessage: defaultMessage });

	const res = await fetch(
		`https://www.googleapis.com/drive/v3/files/${serverId}/permissions?${params}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				type: "user",
				role: "writer",
				emailAddress: email
			})
		}
	);

	if (!res.ok)
		throw new Error(await res.text());

	return { success: true };
}

export async function removeUserPermission(serverId: string, permissionId: string, isOwner: boolean) {
	const client = getOAuthClient();
	await refreshIfNeeded(client);

	const accessToken = client.credentials.access_token;

	const res = await fetch(
		`https://www.googleapis.com/drive/v3/files/${serverId}/permissions/${permissionId}`,
		{
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${accessToken}`
			}
		}
	);

	if(!isOwner){
		removeJoinedServer(serverId)
		removeServerPath(serverId)
	}

	if (!res.ok)
		throw new Error(await res.text());

	return { success: true };
}

export async function joinServerById(folderId: string) {
	const client = getOAuthClient();

	try {
		await refreshIfNeeded(client)
		const accessToken = client.credentials.access_token

		const res = await fetch(
			`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name`,
			{ headers: { Authorization: `Bearer ${accessToken}` } }
		)

		if (!res.ok) {
			if(res.status === 404)
				throw new Error("File not found. Either the folder ID is wrong or you haven't been invited to this server.")
			throw new Error(await res.text())
		}

		const data = await res.json()

		addJoinedServer(data.id)

		return {
			success: true,
			folder: {
				type: 'joined' as const,
				id: data.id,
				name: data.name,
				path: getServerPath(data.id) || null,
				permittedUsers: await getFolderPermissions(data.id)
			}
		}
	} catch (err: any) {
		return { success: false, error: err.message || err }
	}
}

export async function renameServerFolder(folderId: string, newName: string) {
    const client = getOAuthClient();
    await refreshIfNeeded(client);
    const accessToken = client.credentials.access_token;

    const res = await fetch(`${DRIVE_BASE_URL}/${folderId}`, {
        method: "PATCH",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: newName })
    });

    if (!res.ok)
        throw new Error(await res.text());

    return { success: true };
}
