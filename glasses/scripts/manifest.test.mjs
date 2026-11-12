import { describe, expect, it } from 'vitest'
import { buildManifest } from './manifest.mjs'

const template = {
  package_id: 'com.example.messenger',
  edition: '202601',
  name: 'Messenger',
  version: '0.0.0',
  min_sdk_version: '0.0.16',
  entrypoint: 'index.html',
  permissions: [
    { name: 'network', desc: 'Talks to the gateway.', whitelist: ['https://gateway.example.com'] },
    { name: 'g2-microphone', desc: 'Dictation.' },
  ],
  supported_languages: ['en'],
}

function network(manifest) {
  return manifest.permissions.find((permission) => permission.name === 'network')
}

describe('buildManifest', () => {
  it('whitelists the origin of the gateway URL', () => {
    const manifest = buildManifest(template, { gatewayUrl: 'https://gw.home.example', version: '0.0.1' })
    expect(network(manifest).whitelist).toEqual(['https://gw.home.example'])
  })

  it('drops path and trailing slash, keeps a non-default port', () => {
    const manifest = buildManifest(template, { gatewayUrl: 'https://gw.home.example:8443/api/', version: '0.0.1' })
    expect(network(manifest).whitelist).toEqual(['https://gw.home.example:8443'])
  })

  it('stamps the package version', () => {
    const manifest = buildManifest(template, { gatewayUrl: 'https://gw.home.example', version: '1.2.3' })
    expect(manifest.version).toBe('1.2.3')
  })

  it('keeps the other permissions and does not modify the template', () => {
    const manifest = buildManifest(template, { gatewayUrl: 'https://gw.home.example', version: '0.0.1' })
    expect(manifest.permissions.map((permission) => permission.name)).toEqual(['network', 'g2-microphone'])
    expect(network(template).whitelist).toEqual(['https://gateway.example.com'])
  })

  it('rejects a gateway URL that is missing or not http(s)', () => {
    for (const gatewayUrl of [undefined, '', 'gw.home.example', 'ftp://gw.home.example']) {
      expect(() => buildManifest(template, { gatewayUrl, version: '0.0.1' })).toThrow(/VITE_GATEWAY_URL/)
    }
  })

  it('rejects the placeholder URL from .env.example', () => {
    expect(() => buildManifest(template, { gatewayUrl: 'https://gateway.example.com', version: '0.0.1' })).toThrow(
      /placeholder/,
    )
  })

  it('rejects a template without a network permission', () => {
    const noNetwork = { ...template, permissions: [] }
    expect(() => buildManifest(noNetwork, { gatewayUrl: 'https://gw.home.example', version: '0.0.1' })).toThrow(
      /network/,
    )
  })
})
