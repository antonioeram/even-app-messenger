import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  // The .ehpk is served from a local path inside the Even app, so asset URLs must be relative.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    // Reachable from the phone for `evenhub qr` sideloading.
    host: true,
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
})
