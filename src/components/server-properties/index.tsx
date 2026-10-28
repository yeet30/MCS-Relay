import './server-properties.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, Save } from 'lucide-react';
import type { ServerPropertiesInfo } from '../../../shared/types';
import { invoke } from '../../api';
import { useConfirm } from '../../hooks/useConfirm';
import { isSessionBusy } from '../../lib/sync';
import { useNoticeStore } from '../../stores/noticeStore';
import { usePropertiesStore } from '../../stores/propertiesStore';
import { selectSelectedServer, useServersStore } from '../../stores/serversStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useCloseGuard } from '../modal/close-guard';

/** `legacy`: Minecraft 26.x dropped it from server.properties (it became a game rule), so it is shown only when the
 *  server's file has it, as older versions' files do. */
type Field = { key: string; label: string; hint?: string; legacy?: boolean } & (
    | { kind: 'text'; def: string }
    | { kind: 'number'; def: string; min: number; max: number }
    | { kind: 'bool'; def: 'true' | 'false' }
    | { kind: 'select'; def: string; options: Array<[string, string]> }
);

/** The settings people change most, with what MCS-Relay sets for a file that does not have them yet: Minecraft's
 *  defaults, except the whitelist, which MCS-Relay leaves off (Minecraft 26.x turns it on for a new server, so nobody
 *  could join until added to it). */
const SECTIONS: Array<{ title: string; fields: Field[] }> = [
    {
        title: 'Players',
        fields: [
            { key: 'motd', label: 'Message in the server list', kind: 'text', def: 'A Minecraft Server' },
            { key: 'max-players', label: 'Most players at once', kind: 'number', def: '20', min: 1, max: 1000 },
            { key: 'white-list', label: 'Only players on the whitelist can join', kind: 'bool', def: 'false', hint: 'Once saved, a Whitelist tab lists who may join.' },
            {
                key: 'online-mode', label: 'Check that players own Minecraft', kind: 'bool', def: 'true',
                hint: 'Off lets anyone join under any name. Leave it on unless you know why.',
            },
            { key: 'pvp', label: 'Players can hurt each other', kind: 'bool', def: 'true', legacy: true },
        ],
    },
    {
        title: 'Game',
        fields: [
            {
                key: 'gamemode', label: 'Game mode', kind: 'select', def: 'survival',
                options: [['survival', 'Survival'], ['creative', 'Creative'], ['adventure', 'Adventure'], ['spectator', 'Spectator']],
            },
            {
                key: 'difficulty', label: 'Difficulty', kind: 'select', def: 'easy',
                options: [['peaceful', 'Peaceful'], ['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']],
            },
            { key: 'hardcore', label: 'Hardcore', kind: 'bool', def: 'false' },
            { key: 'allow-flight', label: 'Allow flying', kind: 'bool', def: 'false', hint: 'Some mods need it, or players get kicked for flying.' },
            { key: 'spawn-protection', label: 'Protected blocks around spawn', kind: 'number', def: '16', min: 0, max: 1000, hint: 'Only operators can build there. 0 turns it off.' },
        ],
    },
    {
        title: 'World',
        fields: [
            { key: 'view-distance', label: 'View distance (chunks)', kind: 'number', def: '10', min: 2, max: 32, hint: 'Higher looks further and needs more memory and upload speed.' },
            { key: 'simulation-distance', label: 'Simulation distance (chunks)', kind: 'number', def: '10', min: 3, max: 32 },
            { key: 'allow-nether', label: 'The Nether', kind: 'bool', def: 'true', legacy: true },
            { key: 'level-seed', label: 'Seed', kind: 'text', def: '', hint: 'Used only when a new world is made.' },
        ],
    },
    {
        title: 'Network',
        fields: [
            { key: 'server-port', label: 'Port', kind: 'number', def: '25565', min: 1, max: 65535, hint: 'playit.gg follows it when you host.' },
        ],
    },
];
const KNOWN = new Set(SECTIONS.flatMap((s) => s.fields.map((f) => f.key)));

/** The changes that differ from the file (a key the file lacks counts once it differs from Minecraft's default). */
function changesOf(info: ServerPropertiesInfo | null, edited: Record<string, string>): Record<string, string> {
    if (!info) return {};
    return Object.fromEntries(Object.entries(edited).filter(([key, value]) => info.values[key] !== value));
}

/** Settings > Server settings > server.properties: the selected server's file on this PC, as switches and boxes
 *  for the common settings and plain text for the rest. Minecraft reads it when the server starts. */
export default function ServerPropertiesPanel() {
    const server = useServersStore(selectSelectedServer);
    const hosting = useSessionStore((s) => isSessionBusy(s.state.phase) && s.state.serverId === server?.id);
    const [info, setInfo] = useState<ServerPropertiesInfo | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [edited, setEdited] = useState<Record<string, string>>({});
    const [showOther, setShowOther] = useState(false);
    const [saving, setSaving] = useState(false);
    const { ask, popup } = useConfirm();
    const serverId = server?.id ?? null;

    useEffect(() => {
        setInfo(null);
        setEdited({});
        setLoadError(null);
        if (!serverId) return;
        void invoke('servers:properties', serverId).then((res) => {
            if (!res.ok) {
                setLoadError(res.error.message);
                return;
            }
            setInfo(res.value);
            usePropertiesStore.getState().set(serverId, res.value);
        });
    }, [serverId]);

    const changes = changesOf(info, edited);
    const dirty = Object.keys(changes).length > 0;

    const value = (field: Field | string): string => {
        const key = typeof field === 'string' ? field : field.key;
        return edited[key] ?? info?.values[key] ?? (typeof field === 'string' ? '' : field.def);
    };

    function set(key: string, next: string) {
        setEdited((e) => ({ ...e, [key]: next }));
    }

    /** true when everything was saved. */
    async function handleSave(): Promise<boolean> {
        if (!serverId || !dirty) return true;
        for (const field of SECTIONS.flatMap((s) => s.fields)) {
            if (field.kind !== 'number' || !(field.key in changes)) continue;
            const n = Number(changes[field.key]);
            if (!Number.isInteger(n) || n < field.min || n > field.max) {
                useNoticeStore.getState().error(`${field.label} must be a whole number from ${field.min} to ${field.max}.`);
                return false;
            }
        }
        // Settings the file does not have yet are written as shown, so Minecraft does not fill in other defaults.
        const shown = Object.fromEntries(SECTIONS.flatMap((s) => s.fields)
            .filter((f) => !f.legacy && f.kind !== 'text' && info && !(f.key in info.values))
            .map((f) => [f.key, value(f)]));
        setSaving(true);
        const res = await invoke('servers:setProperties', serverId, { ...shown, ...changes });
        setSaving(false);
        if (!res.ok) {
            useNoticeStore.getState().error(res.error);
            return false;
        }
        setInfo(res.value);
        setEdited({});
        usePropertiesStore.getState().set(serverId, res.value);         // the Whitelist tab follows the switch
        useNoticeStore.getState().success('Saved. Minecraft uses them the next time the server starts, and your next session shares them.');
        return true;
    }

    const saveRef = useRef(handleSave);
    saveRef.current = handleSave;
    const guard = useCallback(async (): Promise<boolean> => {
        const answer = await ask({
            message: 'You changed server.properties but did not save it.\n\nSave the changes first?',
            confirmText: 'Save',
            cancelText: 'Discard changes',
        });
        if (answer === 'no') return true;
        if (answer === 'yes') return saveRef.current();
        return false;
    }, [ask]);
    useCloseGuard(dirty && !hosting ? guard : null);

    if (!server) return <p className='props-note'>Select a server first.</p>;
    if (loadError) return <p className='props-note'>{loadError}</p>;
    if (!info) return <p className='props-note'><Loader2 size={14} className='spinner' /> Loading…</p>;

    const others = Object.keys(info.values).filter((key) => !KNOWN.has(key)).sort();
    return (
        <div className='props-wrapper'>
            {popup}
            <p className='props-intro'>
                {info.exists
                    ? <><b>{server.name}</b>&apos;s server.properties on this PC. Minecraft reads it when the server starts.</>
                    : <><b>{server.name}</b> has no server.properties yet: Minecraft makes it on the first start. What you set here is used then.</>}
            </p>
            <fieldset className='props-sections' disabled={hosting}>
                {SECTIONS.map((section) => (
                    <section key={section.title} className='props-section'>
                        <h4>{section.title}</h4>
                        {section.fields.filter((field) => !field.legacy || field.key in info.values).map((field) => (
                            <div key={field.key} className={`props-row ${field.kind}`}>
                                <label htmlFor={`prop-${field.key}`}>
                                    {field.label}
                                    {field.hint && <small>{field.hint}</small>}
                                </label>
                                {field.kind === 'bool'
                                    ? (
                                        <span className='switch'>
                                            <input
                                                id={`prop-${field.key}`}
                                                type='checkbox'
                                                checked={value(field) === 'true'}
                                                onChange={(e) => set(field.key, e.target.checked ? 'true' : 'false')}
                                            />
                                            <label className='switch-track' htmlFor={`prop-${field.key}`}><span className='switch-thumb' /></label>
                                        </span>
                                    )
                                    : field.kind === 'select'
                                        ? (
                                            <select id={`prop-${field.key}`} value={value(field)} onChange={(e) => set(field.key, e.target.value)}>
                                                {field.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                                                {!field.options.some(([v]) => v === value(field)) && <option value={value(field)}>{value(field)}</option>}
                                            </select>
                                        )
                                        : (
                                            <input
                                                id={`prop-${field.key}`}
                                                type={field.kind === 'number' ? 'number' : 'text'}
                                                min={field.kind === 'number' ? field.min : undefined}
                                                max={field.kind === 'number' ? field.max : undefined}
                                                value={value(field)}
                                                spellCheck={false}
                                                onChange={(e) => set(field.key, e.target.value)}
                                            />
                                        )}
                            </div>
                        ))}
                    </section>
                ))}
                {others.length > 0 && (
                    <section className='props-section'>
                        <button type='button' className={`props-toggle ${showOther ? 'open' : ''}`} onClick={() => setShowOther(!showOther)}>
                            <ChevronRight size={14} /> Other properties <small>{others.length}</small>
                        </button>
                        {showOther && others.map((key) => (
                            <div key={key} className='props-row raw'>
                                <label htmlFor={`prop-${key}`}>{key}</label>
                                <input id={`prop-${key}`} type='text' value={value(key)} spellCheck={false} onChange={(e) => set(key, e.target.value)} />
                            </div>
                        ))}
                    </section>
                )}
            </fieldset>
            <div className='save-bar'>
                <span className={dirty && !hosting ? 'unsaved' : ''}>
                    {hosting ? 'server.properties can be changed between sessions.' : dirty ? 'You have unsaved changes.' : 'Changes apply the next time the server starts.'}
                </span>
                <button className={`text-button save-button ${dirty && !hosting ? 'primary ready' : ''}`} onClick={() => void handleSave()} disabled={saving || hosting || !dirty}>
                    {saving ? <Loader2 size={13} className='spinner' /> : <Save size={13} />} Save changes
                </button>
            </div>
        </div>
    );
}
