/** A colour (hue) for a player's or host's initial that stays the same for that name everywhere. */
export function nameHue(name: string): number {
    let hash = 0;
    for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return hash;
}
