import { useEffect, useState, useRef } from 'react'
import './blacklist-modal.css'
import { Plus } from 'lucide-react'
import { Folder, Trash2, CircleHelp } from 'lucide-react'
import { useServerStore } from '../../store/store'
import { useConfirm } from '../../hooks/useConfirm'


export default function BlacklistModal() {

    const { confirm, popup } = useConfirm();

    const { selectedServer } = useServerStore()
    const [blacklist, setBlacklist] = useState<Set<string>>(new Set())
    const initialized = useRef(false)
    const [rel, setRel] = useState<string>("")

    async function handleAdd() {
        if (!rel.trim()) return
        setBlacklist((prev) => new Set([...prev, rel]))
        window.ipcRenderer.invoke("mutate-tracked-files", { operation: "remove", filePath: rel })
        setRel("")
    }

    function handleDelete(file: string) {
        setBlacklist((prev) => {
            const buff = new Set(prev)
            buff.delete(file)
            window.ipcRenderer.invoke("mutate-tracked-files", { operation: "add", filePath: file })
            return buff
        })
    }

    function handleTip(){
        confirm({
            message: `If you are playing with the Distant Horizons mod, `
                    + `it is recommended to add "DistantHorizons.sqlite" to the blacklist because it can get large in size `
                    + `since synchronising Distant Horizons chunks (LODs) can already be handled in game, `
                    + `by enabling "allow downloading from the server.`
                    + `\n\nThe file can supposedly be located at: \n(ServerDirectory)\\world\\data\\DistantHorizons.sqlite`,
            confirmText: "OK",
            cancelText: "Close"
        })
    }

    async function handleBrowse() {
        const path: string = await window.ipcRenderer.invoke("choose-file-directory", selectedServer?.path)
        if (path) {
            const relP = path.slice(selectedServer!.path.length + 1)
            setBlacklist((prev) => new Set([...prev, relP]))
            window.ipcRenderer.invoke("mutate-tracked-files", { operation: "remove", filePath: relP })
        }
    }

    useEffect(() => {
        async function init() {
            const buff = await window.ipcRenderer.invoke("get-blacklist")

            if (buff)
                setBlacklist(buff)
        }
        init()
    }, [])

    useEffect(() => { 
        if (!initialized.current) {
            initialized.current = true
            return
        }
        window.ipcRenderer.invoke("set-blacklist", selectedServer?.path, [...blacklist]) 
    }, [blacklist])

    return (
        <div className="blacklist-wrapper">
            <div className='blacklist-title'>
                <h4>Files that are not being tracked: </h4>
                <button className='tip-button' onClick={()=>{handleTip()}}>
                    <CircleHelp size={16} />
                </button>
                {popup}
            </div>
            <div className='files-div'>
                <ul className='files-ul'>
                    {Array.from(blacklist).map((file: string) => (
                        <li className='files-li' key={file}>
                            <span>{file}</span>
                            {(file === "manifest.json" || file === "lock.json")
                                ?
                                <button className='delete-button' disabled={true}><Trash2 size={12} /></button>
                                :
                                <button className='delete-button' onClick={() => handleDelete(file)}><Trash2 size={12} /></button>
                            }
                        </li>
                    ))}
                </ul>
            </div>
            <div className='blacklist-buttons'>
                <input
                    className='blacklist-input'
                    type="text"
                    placeholder='Relative path e.g "logs/latest-log.txt"'
                    value={rel}
                    onChange={(e) => setRel(e.target.value)}
                />
                <button
                    onClick={() => { handleAdd() }}
                    title='Add the file to the blacklist.'
                ><Plus size={16} />
                </button>
                <button
                    onClick={() => { handleBrowse() }}
                    title='Browse the directory to add to the blacklist.'
                ><Folder size={16} />
                </button>
            </div>
        </div>
    )
}