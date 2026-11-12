// HTTP client for the home gateway.

export type GatewayErrorKind = 'network' | 'timeout' | 'unauthorized' | 'http' | 'invalid'

export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

export interface Hello {
  text: string
  time: string
}

export interface GatewayClient {
  hello(): Promise<Hello>
}

export interface GatewayClientOptions {
  baseUrl: string
  /** Bearer token; omitted when the gateway runs without one. */
  token?: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 8000

  async function getJson(path: string): Promise<unknown> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.token) headers.Authorization = `Bearer ${options.token}`

    let response: Response
    try {
      response = await fetchFn(`${baseUrl}${path}`, { headers, signal: controller.signal, cache: 'no-store' })
    } catch (error) {
      if (timedOut) throw new GatewayError('timeout', `fara raspuns in ${Math.round(timeoutMs / 1000)} s`)
      // A blocked whitelist entry, a CORS failure, DNS and "offline" all end here:
      // the WebView does not say which one it was.
      throw new GatewayError('network', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401) throw new GatewayError('unauthorized', 'token lipsa sau gresit')
    if (!response.ok) throw new GatewayError('http', `HTTP ${response.status}`)

    try {
      return await response.json()
    } catch {
      throw new GatewayError('invalid', 'raspunsul nu este JSON')
    }
  }

  return {
    async hello() {
      const body = await getJson('/hello')
      if (!isRecord(body) || typeof body.text !== 'string') {
        throw new GatewayError('invalid', 'raspuns fara camp text')
      }
      return { text: body.text, time: typeof body.time === 'string' ? body.time : '' }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
