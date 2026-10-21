import '../repair-dialog/repair-dialog.css';
import { useState } from 'react';
import { Ban, TriangleAlert } from 'lucide-react';
import { invoke } from '../../api';
import { formatCount } from '../../lib/format';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { useSessionStore } from '../../stores/sessionStore';
import Modal from '../modal';

interface Props {
    onClose: () => void;
    /** The upload is running (Pause is offered as the safer choice); false while it is already paused. */
    running: boolean;
}

/** Everything the uploader should know before cancelling for good: the next player gets a mixed world. */
function CancelExplanation({ onClose, running }: Props) {
    const [understood, setUnderstood] = useState(false);
    const transfer = useSessionStore((s) => (s.transfer?.active ? s.transfer : null));
    const sentSoFar = transfer && transfer.filesTotal > 0
        ? ` (about ${formatCount(transfer.filesDone)} of ${formatCount(transfer.filesTotal)} files of this attempt)`
        : '';

    async function handleCancel() {
        onClose();
        const result = await invoke('session:abandonUpload');
        // A failure leaves the upload waiting, with the error under the power button.
        if (!result.ok && result.error.code !== 'NOT_SIGNED_IN' && useSessionStore.getState().state.phase !== 'upload-pending') {
            useNoticeStore.getState().error(result.error);
        }
    }

    async function handlePause() {
        onClose();
        await request('session:cancel');
    }

    return (
        <div className='repair-dialog'>
            <section className='repair-danger'>
                <h5><TriangleAlert size={14} /> This leaves an incomplete world in the cloud</h5>
                <p>
                    Minecraft keeps a world in many files that belong together. When only part of your session reaches
                    the cloud, the next player gets a mix of your session and the one before: broken or regenerated
                    chunks, lost or duplicated items, players back in old places. What they build on it is kept.
                </p>
            </section>

            <section>
                <h5>What happens</h5>
                <ol>
                    <li>The upload stops now.</li>
                    <li>What already reached Google Drive{sentSoFar} is saved as the next version, marked incomplete.</li>
                    <li>The server is freed. Everyone sees a red warning and has to confirm before they start it.</li>
                    <li>Everything else stays on this PC and goes up with your next upload, which makes the version complete again.</li>
                </ol>
            </section>

            <section>
                <h5>{running ? 'Pause instead?' : 'Continue instead?'}</h5>
                <p>
                    {running
                        ? 'Pausing keeps the server reserved for you and sends the rest when you continue, even after closing the app. Nothing breaks.'
                        : 'Continuing sends the rest, and nothing breaks.'}
                    {' '}Cancel only when you cannot finish the upload.
                </p>
            </section>

            <label className='repair-ack'>
                <input type='checkbox' checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                <span>I understand that the next player gets an incomplete world.</span>
            </label>

            <div className='repair-buttons'>
                <button className='text-button' onClick={onClose}>{running ? 'Keep uploading' : 'Keep it paused'}</button>
                {running && <button className='text-button' onClick={handlePause}>Pause instead</button>}
                <button className='text-button danger' disabled={!understood} onClick={handleCancel}>
                    <Ban size={12} /> Cancel upload
                </button>
            </div>
        </div>
    );
}

export default function CancelUploadDialog({ isOpen, ...props }: Props & { isOpen: boolean }) {
    return (
        <Modal
            isOpen={isOpen}
            onClose={props.onClose}
            width={540}
            height={440}
            items={[{ title: 'Cancel the upload', content: <CancelExplanation {...props} /> }]}
        />
    );
}
