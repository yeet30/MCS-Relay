import './watcher-modal.css'
import { useServerStore, useWatcherManifest } from '../../store/store'
import { useEffect, useState } from 'react'

export default function WatcherModal(){

    const {selectedServer} = useServerStore()
    const {trackedFiles, setTrackedFiles} = useWatcherManifest()
    const [watcherRunning,setWatcherRunning] = useState<boolean>(false)

    async function startWatcher(){
        try {
            await window.ipcRenderer.invoke("start-watcher", selectedServer?.path)
            setWatcherRunning(true)
        } catch (error) {
            console.error(error);
        }
    }

    async function stopWatcher(){
        setTrackedFiles(new Set<string>())
        window.ipcRenderer.invoke("stop-watcher")
        setWatcherRunning(false)
    }

    async function checkWatcher(){
        const running = await window.ipcRenderer.invoke("is-watcher-running", selectedServer?.path)
        setWatcherRunning(running)
        if(running){
            const buff = await window.ipcRenderer.invoke("get-tracked-files")
            setTrackedFiles(buff)
        }
    }

    useEffect(()=>{checkWatcher()}, [])

    return (
        <div className="file-watcher-wrapper">
            <div className='files-title'>
                {watcherRunning 
                    ? <h4>Currently tracking the directory:</h4>
                    : <h4>Set to track the directory:</h4>
                }
                <code>{selectedServer?.path}</code>
            </div>
            <div className='files-div'>
                <ul className='files-ul'>
                    {Array.from(trackedFiles).map((file)=>(
                        <li className='files-li' key={file}>{file}</li>
                    ))}
                </ul>
            </div>
            <div className='watcher-buttons'>
                <button 
                    onClick={()=> startWatcher()} 
                    disabled={watcherRunning} 
                    title='Manually starts the file watcher to track the changes in the directory.'
                    >Start
                </button>
                <button 
                    onClick={()=> stopWatcher()} 
                    disabled={!watcherRunning}
                    title='Manually stops the file watcher that is tracking the changes in the directory.'
                    >Stop
                </button>
            </div>
        </div>
    )
}