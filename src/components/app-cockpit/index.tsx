import './app-cockpit.css'
import { Loader2, Power, Square, Plus, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useServerStore, useUserStore, useLocalStore } from '../../store/store'
import { useConfirm } from '../../hooks/useConfirm';
import { IStartupOptions } from '../../lib/types';
import { DirectoryMenu } from '../directory-menu';
import Modal from '../modal';
import JoinServer from '../join-server';

export default function AppCockpit() {

    const { userEmail } = useUserStore();
    const { loadingServers, loadingHosting, servers, selectedServer, lockStatus, setLockStatus, loadServers } = useServerStore();
    const { playitggPath, allocatedRAM, checklist } = useLocalStore();
    const { confirm, popup } = useConfirm();
    const [loadingButton, setLoadingButton] = useState({ onOff: false, create: false, join: false })
    const [isModalOpen, setIsModalOpen] = useState(false)

    const isOwner = lockStatus.hostEmail === userEmail || !loadingServers;

    async function handleCreate() {
        const acceptCreate = await confirm({
            message:
                `This action creates a new folder in your Google Drive named "Minecraft Shared Servers", `
                + `where you can find the shared servers inside.`
                + `\n\nTempering with the files inside a server folder while it is being hosted is not recommended!`,
            confirmText: "Proceed",
            cancelText: "Cancel"
        })

        if (!acceptCreate) return

        setLoadingButton((prev) => ({ ...prev, create: true }))
        const result = await window.ipcRenderer.invoke("drive-create-server");

        if (!result.success) {
            alert(result.error);
            setLoadingButton((prev) => ({ ...prev, create: false }))
            return
        }

        const acceptPath = await confirm({
            message: `Choose the local folder path for your server. The files will be downloaded to and uploaded from here.`,
            confirmText: "Proceed",
            cancelText: "Cancel"
        })

        if (!acceptPath) {
            setLoadingButton((prev) => ({ ...prev, create: false }))
            alert(`Server folder created! You can monitor your drive folders through the menu on the top right corner. `
                + `Please set the path later if you want to work with it.`
            );
            await loadServers()
            return
        }

        await window.ipcRenderer.invoke("set-server-path", result.folderId);

        alert("Server folder created! You can monitor your drive folders through the menu on the top right corner.");
        setLoadingButton((prev) => ({ ...prev, create: false }))

        await loadServers();
    }

    async function handleStart() {
        if (loadingServers || !selectedServer) return
        setLoadingButton((prev) => ({ ...prev, onOff: true }))

        const options: IStartupOptions = {
            checklist: checklist,
            folderId: selectedServer.id,
            serverPath: selectedServer.path,
            playitggPath: playitggPath,
            RAMoptions: allocatedRAM,
        }

        const result = await window.ipcRenderer.invoke("start-server", options)
        setLoadingButton((prev) => ({ ...prev, onOff: false }))

        if (!result.success) {
            alert(result.error)
            return
        }

        alert("Server has been started!")
        setLockStatus(result.lockStatus)
    }

    async function handleJoin() {
        setIsModalOpen(true)
    }

    async function handleStop() {
        if (!lockStatus || !selectedServer) return
        setLoadingButton((prev) => ({ ...prev, onOff: true }))

        const options = {
            shouldUpload: checklist.upload,
            folderId: selectedServer.id
        }

        const res = await window.ipcRenderer.invoke("stop-server", options)
        setLoadingButton((prev) => ({ ...prev, onOff: false }))

        if (!res.success) {
            alert(res.error)
            return
        }
        setLockStatus(res.lockData)
    }

    useEffect(() => {
        function handleServerStopped() {
            if (!selectedServer) return; // not ready yet, ignore
            window.ipcRenderer.invoke("get-server-lock", selectedServer.id)
                .then(res => setLockStatus(res.lockData))
        }

        window.ipcRenderer.on("server-stopped", handleServerStopped);

        return () => {
            window.ipcRenderer.off("server-stopped", handleServerStopped);
        }
    }, [selectedServer]) 

    if (loadingServers) return (
        <div className='loading-div'>
            <h2><Loader2 size={32} className='spinner'/> Loading Servers...</h2>
        </div>
    )
    if (!servers.length) return (
        <div className='initial-buttons-section'>

            <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} items={[{
                    title: "Join Server",
                    content: <JoinServer />
                }
            ]}
            />
            {popup}
            <h3>You are not a member of any server, create or join one.</h3>
            <div className='buttons-div'>
                <button
                    className='initial-button'
                    onClick={handleCreate}
                    disabled={loadingButton.create}
                >
                    {loadingButton.create
                        ? <Loader2 size={120} className='spinner' />
                        : <Plus size={120} />
                    }
                </button>
                <button
                    className='initial-button'
                    onClick={handleJoin}
                    disabled={loadingButton.join}
                >
                    {loadingButton.join
                        ? <Loader2 size={120} className='spinner' />
                        : <LogIn size={120} />
                    }
                </button>
            </div>
        </div>
    )

    return (
        <div className='cockpit-wrapper'>
            {lockStatus && lockStatus.status === "online"
                ?
                <button
                    className='onOff-button'
                    title="Stop the server"
                    onClick={handleStop}
                    disabled={!isOwner}>
                    {loadingButton.onOff || loadingServers
                        ? <Loader2 size={128} className='spinner' />
                        : <Square size={120} fill="currentColor" />
                    }
                </button>
                :
                <button
                    className='onOff-button'
                    title="Start the server"
                    onClick={handleStart}
                    disabled={loadingButton.onOff || loadingServers || loadingHosting}>
                    {loadingButton.onOff || loadingServers
                        ? <Loader2 size={128} className='spinner' />
                        : <Power size={128} />
                    }
                </button>
            }
            <div className='directory-menu'>
                <DirectoryMenu isOwner/>
            </div>
        </div>
    )
}