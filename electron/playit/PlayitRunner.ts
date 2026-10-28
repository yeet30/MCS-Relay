// What a session starts for playit.gg: the agent of the link made in the app (PlayitLink), or else the playit program
// the user chose by hand, as before the link existed.
import type { AppSettings, PlayitTunnel } from '../../shared/types';
import type { PlayitProcess } from '../processes/PlayitProcess';
import { serverPort } from '../session/localAddress';
import { AGENT_SETTLE_MS, agentArgs } from './PlayitLink';
import type { PlayitLink } from './PlayitLink';
import { AppError } from '../errors';

/** The agent PlayitLink downloads: <userData>\playit\playit-<version>.exe. */
const OWN_AGENT_RE = /[\\/]mcs-relay[\\/]playit[\\/]playit-[^\\/]+\.exe$/i;

export interface PlayitStartOptions {
    serverPath: string;
    settings: Pick<AppSettings, 'playitggPath'>;
    timeoutMs: number;
    signal?: AbortSignal;
    /** A tunnel was added or removed while it runs (a playit program chosen by hand only). */
    onTunnels?: (tunnels: PlayitTunnel[]) => void;
}

export class PlayitRunner {
    constructor(
        private readonly link: Pick<PlayitLink, 'isLinked' | 'prepare' | 'openTunnel'>,
        private readonly process: Pick<PlayitProcess, 'start' | 'run' | 'stop'>,
    ) {}

    /** playit.gg starts with the server: it is switched on, and linked on this PC or a program was chosen. */
    enabled(settings: Pick<AppSettings, 'usePlayitgg' | 'playitggPath'>): boolean {
        return settings.usePlayitgg && (this.link.isLinked() || Boolean(settings.playitggPath));
    }

    async start(o: PlayitStartOptions): Promise<PlayitTunnel[]> {
        if (!this.link.isLinked()) {
            // The agent MCS-Relay downloaded runs only with a link's key; started by itself it waits for one forever.
            if (OWN_AGENT_RE.test(o.settings.playitggPath)) {
                throw new AppError('PLAYIT', 'The chosen playit.gg program is the one MCS-Relay downloaded, which only works through a link. Press "Link playit.gg" in Settings > Server settings instead.', o.settings.playitggPath);
            }
            return this.process.start(o.settings.playitggPath, o.timeoutMs, o.signal, o.onTunnels);
        }
        const { executable, secret } = await this.link.prepare();
        await this.process.run(executable, agentArgs(secret), AGENT_SETTLE_MS, o.signal);
        // The tunnel only once the agent runs: playit.gg refuses one for an agent it has not seen.
        try {
            return await this.link.openTunnel(serverPort(o.serverPath), o.signal);
        } catch (err) {
            await this.process.stop();
            throw err;
        }
    }

    stop(): Promise<void> {
        return this.process.stop();
    }
}
