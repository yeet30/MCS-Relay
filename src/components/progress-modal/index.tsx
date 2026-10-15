import { useState } from 'react'
import './progress-modal.css'
import { useServerStore } from '../../store/store'

export default function ProgressModal(){

    const [toUpload, setToUpload] = useState<Set<string>>()
    const [toDownload, setToDownload] = useState<Set<string>>()
    const {selectedServer} = useServerStore()
    const [error,setError] = useState<string>("")

    async function handleUpload() {
        const result = await window.ipcRenderer.invoke("get-files-to-upload", selectedServer?.path, selectedServer?.id)
        if (result.success)
            setToUpload(result.filesToUpload)
        else
            setError(result.error)
    }

    async function handleDownload() {
        const result = await window.ipcRenderer.invoke("get-files-to-download", selectedServer?.path, selectedServer?.id)
        console.log(result);
        
        if (result.success)
            setToDownload(result.filesToDownload)
        else
            setError(result.error)
    }

    return (
        <div className='progress-modal-wrapper'>
            <button onClick={()=>handleDownload()}>
                To download
            </button>
            <button onClick={()=>handleUpload()}>
                To upload
            </button>
            <div>
                <h4>To Upload</h4>
                {toUpload}
            </div>
            <div>
                <h4>To Download</h4>
                {toDownload}
            </div>
            {error}
        </div>
    )
}