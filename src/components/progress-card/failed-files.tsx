import type { TransferFailure } from '../../../shared/types';

const SHOWN = 8;
const KIND_WORDS: Record<TransferFailure['kind'], string> = {
    download: 'download', upload: 'upload', 'delete-remote': 'delete in the cloud', 'delete-local': 'delete on this PC',
    'create-folder': 'create the folder',
};

/** The files of the last transfer that failed, with Google's (or the disk's) reason. */
export default function FailedFiles({ failures, open = false }: { failures: readonly TransferFailure[]; open?: boolean }) {
    if (failures.length === 0) return null;
    return (
        <details className='failed-files' open={open}>
            <summary>{failures.length === 1 ? '1 file failed' : `${failures.length} files failed`}</summary>
            <ul>
                {failures.slice(0, SHOWN).map((failure) => (
                    <li key={`${failure.kind}:${failure.path}`}>
                        <span className='failed-path' title={failure.path}>{failure.path}</span>
                        <span className='failed-reason'>{KIND_WORDS[failure.kind]}: {failure.message}</span>
                    </li>
                ))}
                {failures.length > SHOWN && <li className='failed-more'>…and {failures.length - SHOWN} more</li>}
            </ul>
        </details>
    );
}
