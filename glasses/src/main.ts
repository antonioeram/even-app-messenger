// Entry point: runs in the Even app WebView on the phone.
// The HTML page is the phone-side view; the glasses are driven through the bridge.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { createApp } from './app'
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
element('gateway-url').textContent = gatewayUrl || '(nesetat)'
element('build').textContent = `v${__APP_VERSION__}${gatewayToken ? ' · cu token' : ' · fara token'}`

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
      async hello() {
        throw new GatewayError('invalid', 'VITE_GATEWAY_URL nu a fost setat la build')
      },
    }

async function main(): Promise<void> {
  render(diagnostics.lines())
  diagnostics.markColdStart()
  setInterval(() => diagnostics.heartbeat(), HEARTBEAT_MS)
  document.addEventListener('visibilitychange', () => log(`pagina ${document.visibilityState}`))

  log('astept bridge-ul Even')
  const bridge = await waitForEvenAppBridge()
  log('bridge pregatit')

  const app = createApp({ bridge, gateway, gatewayUrl: gatewayUrl || '(gateway nesetat)', log })
  await app.start()
  log('ready')
}

main().catch((error: unknown) => {
  log(`eroare la pornire: ${error instanceof Error ? error.message : String(error)}`)
})
