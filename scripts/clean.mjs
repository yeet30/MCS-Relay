// Removes the build output before a release build. The dev server writes new hashed files into dist-electron on every
// restart and never deletes the old ones, and the installer packs that whole folder.
// Run: node scripts/clean.mjs
import { rmSync } from 'node:fs';

for (const dir of ['dist', 'dist-electron', 'release']) {
    rmSync(new URL(`../${dir}`, import.meta.url), { recursive: true, force: true });
}
console.log('removed dist, dist-electron and release');
