import './playit-setup.css';
import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, ExternalLink, FileCog, FolderInput, Link2, Loader2, Unlink } from 'lucide-react';
import { useConfirm } from '../../hooks/useConfirm';
import { formatBytesPair } from '../../lib/format';
import { usePlayitStore } from '../../stores/playitStore';
import CopyButton from '../playitgg-link/copy-button';

interface Props {
    /** A playit program chosen by hand (the way before linking); '' for none. */
    ownPath: string;
    onPickOwn: () => void;
    /** Linking finished here: switch playit.gg on. */
    onLinked?: () => void;
    /** Unlinking is refused during a session. */
    busy?: boolean;
}

/** playit.gg for this PC: link an account (the agent, the approval in the browser and the tunnel are handled by the
 *  app), or see the link and its address. A playit program chosen by hand still works without a link. */
export default function PlayitSetup({ ownPath, onPickOwn, onLinked, busy = false }: Props) {
    const state = usePlayitStore((s) => s.state);
    const [showOwn, setShowOwn] = useState(false);
    const { confirm, popup } = useConfirm();

    useEffect(() => {
        if (!usePlayitStore.getState().state) void usePlayitStore.getState().load();
    }, []);

    async function link() {
        if (await usePlayitStore.getState().link()) onLinked?.();
    }

    async function unlink() {
        const yes = await confirm({
            message: 'Unlink playit.gg from this PC?\n\nIts tunnel is deleted, so friends cannot join through it any more. You can link again at any time.',
            confirmText: 'Unlink',
            cancelText: 'Keep it',
        });
        if (yes) await usePlayitStore.getState().unlink();
    }

    if (!state) return <p className='playit-setup-note'><Loader2 size={13} className='spinner' /> Loading…</p>;

    const { linking } = state;
    if (linking) {
        return (
            <div className='playit-setup linking'>
                {linking.step === 'download' && (
                    <>
                        <span className='playit-setup-line'><Loader2 size={14} className='spinner' /> Getting playit.gg ready…
                            <small>{linking.total > 0 ? formatBytesPair(linking.done, linking.total) : ''}</small>
                        </span>
                        <div className='playit-setup-bar'><span style={{ width: `${linking.total > 0 ? (linking.done / linking.total) * 100 : 0}%` }} /></div>
                    </>
                )}
                {linking.step === 'browser' && (
                    <>
                        <span className='playit-setup-line'><ExternalLink size={14} /> <b>Finish in your browser</b></span>
                        <ol className='playit-setup-steps'>
                            <li>Sign in to playit.gg, or create a free account.</li>
                            <li>Approve the new agent on the page that opened.</li>
                            <li>That&apos;s it: MCS-Relay notices by itself and tells you when everything is set.</li>
                        </ol>
                        <span className='playit-setup-line muted'><Loader2 size={13} className='spinner' /> Waiting for playit.gg…</span>
                    </>
                )}
                {linking.step === 'finishing' && (
                    <span className='playit-setup-line'><Loader2 size={14} className='spinner' /> Approved. Making your Minecraft tunnel…</span>
                )}
                <div className='playit-setup-buttons'>
                    {linking.step === 'browser' && (
                        <button className='text-button' onClick={() => void usePlayitStore.getState().reopen()}>
                            <ExternalLink size={12} /> Open the page again
                        </button>
                    )}
                    {linking.step !== 'finishing' && (
                        <button className='text-button' onClick={() => void usePlayitStore.getState().cancel()}>Cancel</button>
                    )}
                </div>
            </div>
        );
    }

    if (state.linked) {
        return (
            <div className='playit-setup linked'>
                {popup}
                <span className='playit-setup-line good'><CircleCheck size={14} /> Linked to your playit.gg account</span>
                {state.address
                    ? (
                        <div className='playit-setup-address'>
                            <span title={state.address}>{state.address}</span>
                            <CopyButton text={state.address} size={14} />
                        </div>
                    )
                    : <p className='playit-setup-note'>Your Minecraft tunnel is made the first time you host.</p>}
                <p className='playit-setup-note'>
                    While you host, MCS-Relay starts playit.gg for you and shows this address to everyone in the server.
                </p>
                <div className='playit-setup-buttons'>
                    <button className='text-button' disabled={busy} title={busy ? 'You can unlink between sessions' : undefined} onClick={() => void unlink()}>
                        <Unlink size={12} /> Unlink
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className='playit-setup'>
            <button className='text-button primary playit-setup-link' onClick={() => void link()}>
                <Link2 size={13} /> Link playit.gg
            </button>
            <p className='playit-setup-note'>
                You sign in to playit.gg (or create a free account) once, in your browser. MCS-Relay then downloads playit.gg,
                makes your Minecraft tunnel and starts it with the server.
            </p>
            {state.error && <div className='playit-setup-error'><CircleAlert size={13} /> {state.error.message}</div>}
            {ownPath || showOwn
                ? (
                    <div className='playit-setup-own'>
                        <FileCog size={14} />
                        <span className={`path-text ${ownPath ? '' : 'missing'}`} title={ownPath || undefined}>
                            {ownPath || 'No playit.gg program chosen yet'}
                        </span>
                        <button className='text-button' onClick={onPickOwn}>
                            <FolderInput size={12} /> {ownPath ? 'Change' : 'Choose'}
                        </button>
                    </div>
                )
                : (
                    <button className='playit-setup-alt' onClick={() => setShowOwn(true)}>
                        I already set up playit.gg&apos;s own program
                    </button>
                )}
        </div>
    );
}
