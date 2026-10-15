import { useEffect, useState } from 'react'
import './manifest-modal.css'
import { IWatcherUpdates } from '../../lib/types'
import { useWatcherManifest, useServerStore } from '../../store/store'
import { FileJson } from 'lucide-react'

export default function ManifestModal({bufferType}: {bufferType: "upsert" | "remove"}){

    const {selectedServer} = useServerStore()
    const {trackedFiles} = useWatcherManifest();
    const [now, setNow] = useState(Date.now());
    const [expandedFile, setExpandedFile] = useState<string | null>(null);

    const [watcherUpdates,setwatcherUpdates] = useState<IWatcherUpdates>()

    async function saveManifest(){
        await window.ipcRenderer.invoke("write-manifest", selectedServer?.path)
        getWatcherUpdates()
    }

    async function getWatcherUpdates() {
        const buff = await window.ipcRenderer.invoke("get-watcher-updates", selectedServer?.path)
        setwatcherUpdates(buff)
    }

    function formatFileSize(bytes: number): string {
        if (bytes < 1024)
            return `${bytes} B`;

        const units = ['KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unitIndex = -1;

        do {
            size /= 1024;
            unitIndex++;
        } while (size >= 1024 && unitIndex < units.length - 1);

        return `${new Intl.NumberFormat(undefined, {
            maximumFractionDigits: 1,
        }).format(size)}${units[unitIndex]}`;
    }

    function formatModifiedTime(changedAt: number): string {
        const diff = now - changedAt;

        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;

        if (diff < minute) return '< 1m';
        if (diff < hour) return `${Math.floor(diff / minute)}m`;
        if (diff < day) return `${Math.floor(diff / hour)}h`;

        return `${Math.floor(diff / day)}d`;
    }

    useEffect(() => {
        const update = () => setNow(Date.now());
        const delay = 60_000 - (Date.now() % 60_000);
        const timeout = setTimeout(() => {
            update();

            const interval = setInterval(update, 60_000);

            return () => clearInterval(interval);
        }, delay);

        return () => clearTimeout(timeout);
    }, []);

    useEffect(()=>{getWatcherUpdates()},[trackedFiles])

    if(bufferType === "upsert")
        return(
            <div className='manifest-modal-wrapper'>
                <div className='manifest-title'>
                    <h4>Files to be updated in manifest.json:</h4>
                </div>
                <div className='files-div'>
                    <ul className="files-ul">
                        {watcherUpdates && [...watcherUpdates.toAdd].map(([filePath, value]) => (
                            <li
                                className={`files-li ${expandedFile === filePath ? 'expanded' : ''}`}
                                key={filePath}
                                onClick={() =>
                                    setExpandedFile(
                                        expandedFile === filePath ? null : filePath
                                    )
                                }
                            >
                                <div className="file-name">{filePath}</div>
                                <div className="file-size">{formatFileSize(value.size)}</div>
                                <div className="file-time">{formatModifiedTime(value.modifiedAt)}</div>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className='manifest-buttons'>
                    <button 
                        onClick={()=> saveManifest()} 
                        title='Writes the changes to the manifest.json file'
                    >Write to Manifest
                    </button>
                    <button 
                        title='Open the manifest.json file'
                        onClick={()=>window.ipcRenderer.invoke("open-manifest", selectedServer?.path)}
                        >
                        <FileJson size={16}/>
                    </button>
                </div>
            </div>
        )
    else if(bufferType === "remove")
        return (
            <div className='manifest-modal-wrapper'>
                <div className='manifest-title'>
                    <h4>Files to be removed from manifest.json:</h4>
                </div>
                <div className='files-div'>
                    <ul className='files-ul'>
                        {watcherUpdates && [...watcherUpdates.toRemove].map(([filePath, value]) => (
                            <li
                                className={`files-li ${expandedFile === filePath ? 'expanded' : ''}`}
                                key={filePath}
                                onClick={() =>
                                    setExpandedFile(
                                        expandedFile === filePath ? null : filePath
                                    )
                                }
                            >
                                <div className="file-name">{filePath}</div>
                                <div className="file-size">{formatFileSize(value.size)}</div>
                                <div className="file-time">{formatModifiedTime(value.modifiedAt)}</div>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className='manifest-buttons'>
                    <button 
                        onClick={()=> saveManifest()} 
                        title='Writes the changes to the manifest.json file'
                    >Write to Manifest
                    </button>
                    <button 
                        title='Open the manifest.json file'
                        onClick={()=>window.ipcRenderer.invoke("open-manifest", selectedServer?.path)}
                        >
                        <FileJson size={16}/>
                    </button>
                </div>
            </div>
    )
}