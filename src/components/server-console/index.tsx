import { useEffect, useRef, useState } from "react";
import "./server-console.css";
import { useServerStore } from "../../store/store";

type LogLine = {
    text: string;
    type: "info" | "warn" | "error" | "success" | "system";
};

function classifyLine(text: string): LogLine["type"] {
    if (/\[WARN\]|Warning/i.test(text)) return "warn";
    if (/\[ERROR\]|Exception|FATAL|failed/i.test(text)) return "error";
    if (/Done|started|logged in|joined/i.test(text)) return "success";
    if (/\[System\]/.test(text)) return "system";
    return "info";
}

export default function ServerConsole() {
    const [lines, setLines] = useState<LogLine[]>([]);
    const [input, setInput] = useState("");
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const {serverRunning, setServerRunning} = useServerStore();

    useEffect(() => {
        function handleOutput (_: any, data: string) {
            const newLines = data.split("\n").filter(Boolean).map(text => ({
                text,
                type: classifyLine(text)
            }));
            setLines(prev => [...prev, ...newLines]);
        };

        function handleStopped() {
            setLines(prev => [...prev, { text: "— Server stopped —", type: "system" }]);
        };

        window.ipcRenderer.on("server-output", handleOutput);
        window.ipcRenderer.on("server-stopped", handleStopped);

        return () => {
            window.ipcRenderer.off("server-output", handleOutput);
            window.ipcRenderer.off("server-stopped", handleStopped);
        };
    }, []);

    useEffect(()=> {
        async function init() {
            const isRunning = await window.ipcRenderer.invoke("is-server-running");
            setServerRunning(isRunning)
        };

        init();

        window.ipcRenderer.on("server-started", () => setServerRunning(true));
        window.ipcRenderer.on("server-stopped", () => setServerRunning(false));
    }, [])

    useEffect(() => {
        if(!bottomRef.current) return
        if(lines.length === 0) return 
        bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }, [lines]);

    async function handleSend() {
        if (!input.trim()) return;
        setHistory(prev => [input, ...prev]);
        setHistoryIndex(-1);
        await window.ipcRenderer.invoke("send-server-command", input);
        setLines(prev => [...prev, { text: `> ${input}`, type: "system" }]);
        setInput("");
    }

    function handleKeyDown(e: React.KeyboardEvent) {
        if (e.key === "Enter") {
            handleSend();
        } else if (e.key === "ArrowUp") {
            const next = Math.min(historyIndex + 1, history.length - 1);
            setHistoryIndex(next);
            setInput(history[next] ?? "");
        } else if (e.key === "ArrowDown") {
            const next = Math.max(historyIndex - 1, -1);
            setHistoryIndex(next);
            setInput(next === -1 ? "" : history[next]);
        }
    }

    return (
        <div id="console-wrapper" onClick={() => inputRef.current?.focus()}>
            <span className="console-status">
                Java Console <span className={serverRunning ? "active" : "inactive"}>{serverRunning ? "● Running" : "● Offline"}</span>
            </span>

            <div className="console-div">
                <div id="console-output">
                    {lines.map((line, i) => (
                        <div key={i} className={`log-line ${line.type}`}>
                            {line.text}
                        </div>
                    ))}
                    <div ref={bottomRef} />
                </div>
                <div id="console-input-row">
                    <span id="console-prompt">&gt;</span>
                    <input
                        ref={inputRef}
                        id="console-input"
                        type="text"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Enter command..."
                        spellCheck={false}
                        autoComplete="off"
                    />
                </div>
            </div>  
        </div>
    );
}