import './server-console.css';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { classifyLine } from '../../lib/console';
import { request } from '../../stores/request';
import { useSessionStore } from '../../stores/sessionStore';

export default function ServerConsole() {
    const lines = useSessionStore((s) => s.console);
    const javaRunning = useSessionStore((s) => s.state.javaRunning);
    const canSend = useSessionStore((s) => s.state.phase === 'running' && s.state.javaRunning);
    const [input, setInput] = useState('');
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (lines.length > 0) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [lines]);

    async function handleSend() {
        const command = input.trim();
        if (!command || !canSend) return;
        setHistory((prev) => [command, ...prev].slice(0, 100));
        setHistoryIndex(-1);
        setInput('');
        // The main process echoes the command into the console stream.
        await request('session:command', command);
    }

    function handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Enter') {
            void handleSend();
        } else if (e.key === 'ArrowUp') {
            const next = Math.min(historyIndex + 1, history.length - 1);
            setHistoryIndex(next);
            setInput(history[next] ?? '');
        } else if (e.key === 'ArrowDown') {
            const next = Math.max(historyIndex - 1, -1);
            setHistoryIndex(next);
            setInput(next === -1 ? '' : history[next]);
        }
    }

    return (
        <div id='console-wrapper' onClick={() => inputRef.current?.focus()}>
            <span className='console-status'>
                Java Console <span className={javaRunning ? 'active' : 'inactive'}>{javaRunning ? '● Running' : '● Offline'}</span>
            </span>
            <div className='console-div'>
                <div id='console-output'>
                    {lines.map((text, i) => (
                        <div key={i} className={`log-line ${text.startsWith('> ') ? 'system' : classifyLine(text)}`}>{text}</div>
                    ))}
                    <div ref={bottomRef} />
                </div>
                <div id='console-input-row'>
                    <span id='console-prompt'>&gt;</span>
                    <input
                        ref={inputRef}
                        id='console-input'
                        type='text'
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={canSend ? 'Enter command...' : 'The server is not running'}
                        disabled={!canSend}
                        spellCheck={false}
                        autoComplete='off'
                    />
                </div>
            </div>
        </div>
    );
}
