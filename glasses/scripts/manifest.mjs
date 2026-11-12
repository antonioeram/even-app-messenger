// Builds the Even Hub manifest for one gateway.
//
// The Even app only lets the WebView reach origins listed in the `network`
// permission whitelist, and the whitelist takes exact origins (no wildcards).
// The gateway address differs per installation, so the committed app.json
// carries a placeholder and the real origin is stamped at pack time.

export const PLACEHOLDER_ORIGIN = 'https://gateway.example.com'

export function buildManifest(template, { gatewayUrl, version }) {
  const origin = gatewayOrigin(gatewayUrl)
  const manifest = structuredClone(template)
  const network = manifest.permissions?.find((permission) => permission.name === 'network')
  if (!network) {
    throw new Error('app.json has no "network" permission to stamp the gateway origin into')
  }
  network.whitelist = [origin]
  manifest.version = version
  return manifest
}

export function gatewayOrigin(gatewayUrl) {
  let url
  try {
    url = new URL(gatewayUrl)
  } catch {
    throw new Error(`VITE_GATEWAY_URL must be a full URL such as https://gateway.home.example (got ${JSON.stringify(gatewayUrl)})`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`VITE_GATEWAY_URL must start with https:// or http:// (got ${JSON.stringify(gatewayUrl)})`)
  }
  if (url.origin === PLACEHOLDER_ORIGIN) {
    throw new Error('VITE_GATEWAY_URL still holds the placeholder from .env.example; set your gateway address in .env.local')
  }
  return url.origin
}
