import './report-problem.css';
import { useState } from 'react';
import { FolderOpen, Loader2, Save, Send } from 'lucide-react';
import { REPORT_INBOX } from '../../../shared/types';
import { invoke } from '../../api';
import { useNoticeStore } from '../../stores/noticeStore';
import { request } from '../../stores/request';

const ISSUES_URL = 'https://github.com/yeet30/MCS-Relay/issues';

/** Tells the developer about a problem: the user's own words, and the app's log if they agree. Sent through the
 *  user's Google Drive when signed in, or saved as a file. */
export default function ReportProblem({ signedIn, onDone }: { signedIn: boolean; onDone: () => void }) {
    const [description, setDescription] = useState('');
    const [includeLog, setIncludeLog] = useState(true);
    const [busy, setBusy] = useState<'send' | 'save' | null>(null);
    const canSend = REPORT_INBOX !== '' && signedIn;
    const empty = description.trim() === '';

    async function send() {
        setBusy('send');
        const res = await request('report:send', description, includeLog);
        setBusy(null);
        if (!res.ok) return;
        useNoticeStore.getState().success('Thank you! Your report was sent to the developer.');
        onDone();
    }

    async function save() {
        setBusy('save');
        const res = await request('report:save', description, includeLog);
        setBusy(null);
        if (!res.ok || res.value === null) return;
        useNoticeStore.getState().success('The report was saved.');
        onDone();
    }

    return (
        <div className='report-form'>
            <label className='field'>
                <span className='field-label'>What happened?</span>
                <textarea
                    rows={5}
                    autoFocus
                    maxLength={20_000}
                    placeholder='What you did, what you expected, and what happened instead. The exact error message helps too.'
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                />
            </label>
            <label className='report-check'>
                <input type='checkbox' checked={includeLog} onChange={(e) => setIncludeLog(e.target.checked)} />
                <span>Attach the app&apos;s log <small>(recommended)</small></span>
            </label>
            <p className='report-note'>
                The log lists what MCS-Relay did on this PC: server names, folder paths, members&apos; email addresses and
                errors. Never your password or your Google sign-in.
                <button className='report-link' onClick={() => void invoke('report:openLogFolder')}>
                    <FolderOpen size={12} /> Open the log folder
                </button>
            </p>
            <p className='report-note'>
                {canSend
                    ? 'Sending saves the report in your Google Drive (in "MCS-Relay problem reports") and shares it with the developer, who gets an email about it and may write back to you.'
                    : REPORT_INBOX !== ''
                        ? `Without signing in, save the report as a file and email it to ${REPORT_INBOX}.`
                        : 'Save the report as a file and attach it to a new issue on GitHub. Issues there are public, so leave the log out or look through it first.'}
                {!canSend && REPORT_INBOX === '' && (
                    <button className='report-link' onClick={() => void invoke('app:openExternal', ISSUES_URL)}>GitHub issues</button>
                )}
            </p>
            <div className='form-buttons'>
                <button className='text-button' disabled={busy !== null || empty} onClick={() => void save()}>
                    {busy === 'save' ? <Loader2 size={13} className='spinner' /> : <Save size={13} />} Save as a file
                </button>
                {canSend && (
                    <button className='text-button primary' disabled={busy !== null || empty} onClick={() => void send()}>
                        {busy === 'send' ? <Loader2 size={13} className='spinner' /> : <Send size={13} />} Send report
                    </button>
                )}
            </div>
        </div>
    );
}
