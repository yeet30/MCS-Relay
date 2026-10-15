import { useWatcherManifest } from "../store/store"

window.ipcRenderer.on('manifest:change', (_event, change) => {
    const { addFile, removeFile } = useWatcherManifest.getState()
    change.opertion === 'upsert' ? addFile(change.path) : removeFile(change.path)
})