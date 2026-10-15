// Separate from vite.config.ts on purpose: that config runs vite-plugin-electron, which would start Electron.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['electron/**/*.test.ts', 'shared/**/*.test.ts', 'test/**/*.test.ts', 'src/**/*.test.ts'],
        testTimeout: 20000,
    },
});
