import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { scrambleClientFile } from './electron/auth/embeddedClient'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// The Google sign-in client is built into the main process code (scrambled) instead of shipped as a readable file.
// Locally it comes from config/client_secret.json; the release workflow writes that file from a repository secret.
function clientFile(): string | null {
  try {
    return fs.readFileSync(path.join(__dirname, 'config', 'client_secret.json'), 'utf8')
  } catch {
    return null
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          define: { __MCS_RELAY_CLIENT__: JSON.stringify(scrambleClientFile(clientFile())) },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      renderer: {},
    })
  ],
})
