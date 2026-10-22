import './sync-rules.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { File, Folder, Loader2, Plus, X } from 'lucide-react';
import type { SyncRules as Rules } from '../../../shared/types';
import { invoke } from '../../api';
import { useConfirm } from '../../hooks/useConfirm';
import { DISTANT_HORIZONS_RULE, RULE_HELP, addRule, cleanRuleInput, hasRule, sameRules } from '../../lib/rules';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';
import { useSessionStore } from '../../stores/sessionStore';
import { useCloseGuard } from '../modal/close-guard';

/** The files every member's app leaves out of the sync. Stored in the server's .launcher/sync-rules.json,
 *  so it is the same list on every PC. */
export default function SyncRules({ serverId }: { serverId: string }) {
    const [rules, setRules] = useState<Rules | null>(null);
    const [draft, setDraft] = useState<string[]>([]);
    const [input, setInput] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const { ask, popup } = useConfirm();
    const changed = rules !== null && !sameRules(draft, rules.ignore);

    useEffect(() => {
        let cancelled = false;
        void invoke('rules:get', serverId).then((res) => {
            if (cancelled) return;
            if (res.ok) {
                setRules(res.value);
                setDraft(res.value.ignore);
            } else {
                setError(res.error.message);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [serverId]);

    function add(text: string) {
        const rule = cleanRuleInput(text);
        if (!rule) {
            setError('That rule is empty or points outside the server folder.');
            return;
        }
        setError(null);
        setDraft((current) => addRule(current, rule));
        setInput('');
    }

    async function pick(kind: 'file' | 'folder') {
        const res = await request('rules:pickPath', serverId, kind);
        if (res.ok && res.value) add(res.value);
    }

    /** true when the rules were saved. */
    async function save(): Promise<boolean> {
        setSaving(true);
        const res = await request('rules:set', serverId, draft);
        setSaving(false);
        if (!res.ok) return false;
        setRules(res.value);
        setDraft(res.value.ignore);
        useNoticeStore.getState().success('Saved. Every member\'s app uses these rules from its next sync.');
        void useSessionStore.getState().preflight(serverId);
        return true;
    }

    // Closing with unsaved rules asks first: save them, throw them away, or keep editing.
    const saveRef = useRef(save);
    saveRef.current = save;
    const guard = useCallback(async (): Promise<boolean> => {
        const answer = await ask({
            message: 'You changed the ignored files but did not save them.\n\nSave them for everyone before closing?',
            confirmText: 'Save and close',
            cancelText: 'Discard changes',
        });
        if (answer === 'no') return true;
        if (answer === 'yes') return saveRef.current();
        return false;
    }, [ask]);
    useCloseGuard(changed ? guard : null);

    if (!rules) {
        return <div className='sync-rules'>{error ? <p className='rules-error'>{error}</p> : <Loader2 size={18} className='spinner' />}</div>;
    }

    return (
        <div className='sync-rules'>
            {popup}
            <p className='rules-help'>{RULE_HELP}</p>
            <ul className='rules-list'>
                {draft.map((rule) => (
                    <li key={rule}>
                        <code>{rule}</code>
                        <button className='rule-remove' title='Remove' onClick={() => setDraft(draft.filter((r) => r !== rule))}><X size={12} /></button>
                    </li>
                ))}
                {draft.length === 0 && <li className='rules-empty'>Nothing is left out except the app's own files.</li>}
            </ul>
            <form className='rules-add' onSubmit={(e) => {
                e.preventDefault();
                add(input);
            }}
            >
                <input value={input} onChange={(e) => setInput(e.target.value)} placeholder='e.g. backups/ or *.zip' spellCheck={false} />
                <button type='submit' className='text-button' title='Add rule' disabled={!input.trim()}><Plus size={12} /></button>
                <button type='button' className='text-button' title='Pick a file' onClick={() => pick('file')}><File size={12} /></button>
                <button type='button' className='text-button' title='Pick a folder' onClick={() => pick('folder')}><Folder size={12} /></button>
            </form>
            {!hasRule(draft, DISTANT_HORIZONS_RULE) && (
                <button className='text-button suggestion' onClick={() => add(DISTANT_HORIZONS_RULE)}>
                    + Leave out the Distant Horizons cache (large, rebuilt on every PC)
                </button>
            )}
            {error && <p className='rules-error'>{error}</p>}
            <details className='rules-builtin'>
                <summary>Always left out</summary>
                <p>{rules.builtin.join('  ')}</p>
            </details>
            <div className='rules-save'>
                <button className='text-button' disabled={!changed || saving} onClick={() => setDraft(rules.ignore)}>Undo</button>
                <button className='text-button primary' disabled={!changed || saving} onClick={save}>
                    {saving && <Loader2 size={12} className='spinner' />} Save for everyone
                </button>
            </div>
        </div>
    );
}
