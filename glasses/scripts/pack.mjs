// Builds the app and packs it into an .ehpk for one gateway.
//
// Usage: npm run pack
// Reads VITE_GATEWAY_URL (and optionally VITE_GATEWAY_TOKEN) from the
// environment or from .env.local, stamps the gateway origin into the Even Hub
// network whitelist, runs the production build and calls `evenhub pack`.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { buildManifest } from './manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const env = { ...loadEnv('production', root, 'VITE_'), ...process.env }
const pkg = readJson('package.json')
const sdkVersion = readJson('node_modules/@evenrealities/even_hub_sdk/package.json').version

let manifest
try {
  manifest = buildManifest(readJson('app.json'), { gatewayUrl: env.VITE_GATEWAY_URL, version: pkg.version })
} catch (error) {
  console.error(`pack: ${error.message}`)
  process.exit(1)
}

const whitelist = manifest.permissions.find((permission) => permission.name === 'network').whitelist
if (whitelist[0].startsWith('http://')) {
  console.warn('pack: the gateway URL is plain http; Even Hub documents http only for LAN development')
}
if (env.VITE_GATEWAY_TOKEN) {
  console.warn('pack: VITE_GATEWAY_TOKEN is compiled into this package; keep the .ehpk and its beta channel private')
}

const manifestPath = join(mkdtempSync(join(tmpdir(), 'messenger-pack-')), 'app.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

const output = `messenger-${pkg.version}.ehpk`
run('npm', ['run', 'build'])
run('npx', ['evenhub', 'pack', manifestPath, 'dist', '-o', output, '--sdk-ver', sdkVersion])

console.log(`pack: ${output} for ${whitelist[0]} (SDK ${sdkVersion})`)
