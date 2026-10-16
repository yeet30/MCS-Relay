import './changes-panel.css';
import { useState } from 'react';
import type { ChangeKind } from '../../../shared/types';
import { countKinds, folderLabel, groupChanges } from '../../lib/changes';
import { formatCount } from '../../lib/format';
import { useSessionStore } from '../../stores/sessionStore';
import Modal from '../modal';

const KIND_WORDS: Record<ChangeKind, string> = { added: 'new', changed: 'changed', removed: 'deleted' };

/** Files the server changed during this session, grouped by folder. For display only: the upload makes its
 *  own scan, so nothing is lost if an event was missed (F17). */
export default function ChangesPanel() {
    const changes = useSessionStore((s) => s.changes);
    const groups = groupChanges(changes);
    if (groups.length === 0) {
        return <p className='changes-empty'>No files have changed in this session yet. Changes appear here while the server runs.</p>;
    }
    return (
        <div className='changes-panel'>
            {groups.map((group) => (
                <details key={group.key} open={groups.length === 1}>
                    <summary>
                        <span className='changes-folder'>{folderLabel(group.key)}</span>
                        <span className='changes-counts'>
                            {(['added', 'changed', 'removed'] as const).filter((kind) => group[kind] > 0).map((kind) => (
                                <span key={kind} className={`kind ${kind}`}>{group[kind]} {KIND_WORDS[kind]}</span>
                            ))}
                        </span>
                    </summary>
                    <ul>
                        {group.items.map(([path, kind]) => (
                            <li key={path} className={kind} title={path}>
                                <span className='kind-dot' />
                                {path.slice(group.key.length)}
                            </li>
                        ))}
                    </ul>
                </details>
            ))}
        </div>
    );
}

/** One line under the progress while the server runs: "Files this session: 14 changed · 2 new". */
export function ChangesSummary() {
    const changes = useSessionStore((s) => s.changes);
    const [open, setOpen] = useState(false);
    const counts = countKinds(changes);
    const parts = (['changed', 'added', 'removed'] as const)
        .filter((kind) => counts[kind] > 0)
        .map((kind) => `${formatCount(counts[kind])} ${KIND_WORDS[kind]}`);

    return (
        <div className='changes-summary'>
            <Modal isOpen={open} onClose={() => setOpen(false)} width={480} height={400} items={[{ title: 'Changes', content: <ChangesPanel /> }]} />
            <span>{parts.length > 0 ? `Files this session: ${parts.join(' · ')}` : 'No files changed yet'}</span>
            {parts.length > 0 && <button className='text-button' onClick={() => setOpen(true)}>Show</button>}
        </div>
    );
}
