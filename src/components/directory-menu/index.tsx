import './directory-menu.css'
import { FolderCog, FolderOpen } from 'lucide-react'
import { useState, useRef } from 'react'
import { useServerStore } from '../../store/store'
import { IModalItems } from '../../lib/types'
import Modal from '../modal'
import FileWatcher from '../watcher-modal'
import ManifestModal from '../manifest-modal'
import BlacklistModal from '../blacklist-modal'

export function DirectoryMenu({isOwner}:{isOwner: boolean}){

    const [open, setOpen] = useState(false)
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const {loadingServers, loadingHosting, selectedServer} = useServerStore();
    const [isModalOpen, setIsModalOpen] = useState(false)
    const [modalItems, setModalItems] = useState<IModalItems[]>([])

    function openFileWatcher(){
        setModalItems([{
            title: "File Watcher",
            content: <FileWatcher/>
        },
            {
            title: "Blacklist",
            content: <BlacklistModal/>
        }])
        setIsModalOpen(true)
    }

    function openManifest(){
        setModalItems([{
            title: "Upsert",
            content: <ManifestModal bufferType='upsert'/>
        },{
            title: "Remove",
            content: <ManifestModal bufferType='remove'/>
        }])
        setIsModalOpen(true)
    }

    function cancelClose() {
        if(closeTimer.current) clearTimeout(closeTimer.current);
    }
    const scheduleClose = () => closeTimer.current = setTimeout(()=> setOpen(false),500)

    return (
        <div className='directory-menu-wrapper'>
            <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} height={400} items={modalItems}
            />
            <button className={`folder-cog ${open ? 'open': 'closed'}`}
                disabled = {!isOwner || loadingServers || loadingHosting}
                onClick={()=> setOpen((val) =>!val)}
                onMouseEnter={cancelClose}
                onMouseLeave={scheduleClose}
            >
                <FolderCog/>
            </button>
            {open && (
                <div className='directory-options'
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                >
                    <div 
                        className='dir-option'
                        onClick={()=>openFileWatcher()}    
                    >File Watcher
                    </div>
                    <div 
                        className='dir-option'
                        onClick={()=>openManifest()} 
                    >Manifest
                    </div>
                    <div 
                        className='dir-option'
                        onClick={()=> window.ipcRenderer.invoke("open-folder", selectedServer?.path)}
                    >Directory <FolderOpen className='folder-open' size={16}/></div>
                </div>
            )}
        </div>
    )
}