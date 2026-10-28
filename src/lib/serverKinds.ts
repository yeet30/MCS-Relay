// The server programs the app can download, as the window names them.
import type { ServerKind } from '../../shared/types';

export const KINDS: Array<{ kind: ServerKind; name: string; text: string }> = [
    { kind: 'vanilla', name: 'Vanilla', text: 'Minecraft as Mojang makes it' },
    { kind: 'paper', name: 'Paper', text: 'Runs faster, and runs plugins' },
    { kind: 'fabric', name: 'Fabric', text: 'Runs Fabric mods' },
    { kind: 'forge', name: 'Forge', text: 'Runs Forge mods' },
    { kind: 'neoforge', name: 'NeoForge', text: 'Runs NeoForge mods' },
];

export const kindName = (kind: ServerKind): string => KINDS.find((k) => k.kind === kind)?.name ?? kind;
