/// <reference types="vite-plugin-electron/electron-env" />

/** The app's Google OAuth client, scrambled, set at build time by vite.config.ts (see electron/auth/embeddedClient.ts). */
declare const __MCS_RELAY_CLIENT__: string;

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.mjs
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}
