import './file-groups.css';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { folderLabel, groupPaths } from '../../lib/changes';

const SHOWN_PER_GROUP = 200;

/** A list of paths grouped by folder ("world/region/ - 412 files"), each group collapsible. */
export default function FileGroups({ paths, empty = 'No files.' }: { paths: readonly string[]; empty?: string }) {
    const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
    const groups = groupPaths(paths);
    if (groups.length === 0) return <p className='file-groups-empty'>{empty}</p>;

    function toggle(key: string) {
        setOpenKeys((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }

    return (
        <ul className='file-groups'>
            {groups.map((group) => {
                const isOpen = openKeys.has(group.key) || groups.length === 1;
                return (
                    <li key={group.key}>
                        <button className='file-group-head' onClick={() => toggle(group.key)}>
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span className='file-group-name'>{folderLabel(group.key)}</span>
                            <span className='file-group-count'>{group.paths.length}</span>
                        </button>
                        {isOpen && (
                            <ul className='file-group-items'>
                                {group.paths.slice(0, SHOWN_PER_GROUP).map((path) => (
                                    <li key={path} title={path}>{path.slice(group.key.length)}</li>
                                ))}
                                {group.paths.length > SHOWN_PER_GROUP && (
                                    <li className='more'>…and {group.paths.length - SHOWN_PER_GROUP} more</li>
                                )}
                            </ul>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
