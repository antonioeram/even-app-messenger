// Entry point: runs in the Even app WebView on the phone.
// The HTML page is the phone-side view; the glasses are driven through the bridge.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { createApp } from './app'
import { renderAvatar } from './avatar'
import { createDiagnostics } from './diagnostics'
import { createGatewayClient, GatewayError, type GatewayClient } from './gateway'

const HEARTBEAT_MS = 5000

const gatewayUrl = (import.meta.env.VITE_GATEWAY_URL ?? '').trim()
const gatewayToken = (import.meta.env.VITE_GATEWAY_TOKEN ?? '').trim()

function element(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (!found) throw new Error(`missing #${id} in index.html`)
  return found
}

const logView = element('log')
element('gateway-url').textContent = gatewayUrl || '(not set)'
element('build').textContent = `v${__APP_VERSION__}${gatewayToken ? ' · with token' : ' · no token'}`

const diagnostics = createDiagnostics({
  store: window.localStorage,
  heartbeatMs: HEARTBEAT_MS,
  onChange: render,
})

function render(lines: readonly string[]): void {
  logView.textContent = [...lines].reverse().join('\n')
}

function log(line: string): void {
  console.log(`[messenger] ${line}`)
  diagnostics.log(line)
}

const gateway: GatewayClient = gatewayUrl
  ? createGatewayClient({ baseUrl: gatewayUrl, token: gatewayToken || undefined })
  : {
      async chats() {
        throw new GatewayError('invalid', 'VITE_GATEWAY_URL was not set at build time')
      },
      async messages() {
        throw new GatewayError('invalid', 'VITE_GATEWAY_URL was not set at build time')
      },
      async markRead() {
        throw new GatewayError('invalid', 'VITE_GATEWAY_URL was not set at build time')
      },
      async transcribe() {
        throw new GatewayError('invalid', 'VITE_GATEWAY_URL was not set at build time')
      },
      async send() {
        throw new GatewayError('invalid', 'VITE_GATEWAY_URL was not set at build time')
      },
    }

async function main(): Promise<void> {
  render(diagnostics.lines())
  diagnostics.markColdStart()
  setInterval(() => diagnostics.heartbeat(), HEARTBEAT_MS)
  document.addEventListener('visibilitychange', () => log(`page ${document.visibilityState}`))

  log('waiting for the Even bridge')
  const bridge = await waitForEvenAppBridge()
  log('bridge ready')

  const app = createApp({ bridge, gateway, gatewayUrl: gatewayUrl || '(gateway not set)', log, renderAvatar })
  await app.start()
  log('ready')
}

main().catch((error: unknown) => {
  log(`start-up error: ${error instanceof Error ? error.message : String(error)}`)
})
