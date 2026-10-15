import { spawn, ChildProcess, exec, execSync } from "child_process";
import fs from "fs";
import path from "path";

let serverProcess: ChildProcess | null = null;
let playitggProcess: ChildProcess | null = null;

export function getServerProcess() { return serverProcess; }
export function isServerProcess() { return serverProcess ? true : false; }
export function getPlayitggProcess() { return playitggProcess; }

export function launchPlayitgg(playitggPath: string): ChildProcess | null {
    if (!fs.existsSync(playitggPath)) return null;
    playitggProcess = spawn(playitggPath, [], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });
    return playitggProcess;
}

export function launchServer(serverPath: string, ram: {MIN: number, MAX: number}, onError?: (msg: string) => void) {
    const files = fs.readdirSync(serverPath);
    const jarFiles = files.filter(f => f.endsWith(".jar"));

    if(jarFiles.length === 0)
        return {
            success : false,
            error: "Error: No .jar file found in the directory."
        }
    if(jarFiles.length > 1)
        return {
            success : false,
            error: "Error: Multiple .jar files are present in the directory."
        }

    try {
        execSync("java -version", { stdio: "ignore" });
    } catch {
        return { success: false, error: "Java not installed" };
    }

    const jarFile = jarFiles[0]

    fs.writeFileSync(path.join(serverPath, "eula.txt"), "eula=true\n")

    serverProcess = spawn(
        "java",
        [`-Xmx${ram.MAX}M`, `-Xms${ram.MIN}M`, "-jar", jarFile, "nogui"],
        { cwd: serverPath, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );

    serverProcess.on("close", (code) => {
        if (code !== 0)
            onError?.(`[System] Java exited with code ${code}`)
    })

    return { success: true, process: serverProcess }
}

export function killServer() {
    serverProcess?.stdin?.write("stop\n");
}

export function killPlayitgg() {
    if (!playitggProcess?.pid) return;
    exec(`taskkill /PID ${playitggProcess.pid} /T /F`);
    playitggProcess = null;
}

export function waitForPlayitLink(process: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
        let resolved = false;
        process.stdout?.on("data", (data) => {
            const text = data.toString("utf-8").replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
            const match = text.match(/([a-zA-Z0-9.-]+\.joinmc\.link)\s*=>/);
            if (match && !resolved) {
                resolved = true;
                resolve(match[1]);
            }
        });
        process.on("error", reject);
        process.on("close", () => { if (!resolved) reject(new Error("playit.gg closed before link was found")); });
    });
}