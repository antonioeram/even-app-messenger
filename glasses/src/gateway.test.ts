import { describe, expect, it } from 'vitest'
import { createGatewayClient, GatewayError } from './gateway'

type FetchCall = { url: string; init: RequestInit | undefined }

function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init }
    calls.push(call)
    return respond(call)
  }
  return { fetchFn, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError)
    return error as GatewayError
  }
  throw new Error('expected the call to fail')
}

describe('gateway client', () => {
  it('returns the text served by /hello', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ text: 'Salut', time: '2026-11-12T09:41:07Z' }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    const hello = await client.hello()

    expect(hello).toEqual({ text: 'Salut', time: '2026-11-12T09:41:07Z' })
    expect(calls[0]?.url).toBe('https://gw.example/hello')
  })

  it('ignores a trailing slash in the base URL', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ text: 'x', time: '' }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example/', fetchFn })

    await client.hello()

    expect(calls[0]?.url).toBe('https://gw.example/hello')
  })

  it('sends the bearer token when one is configured', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ text: 'x', time: '' }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', token: 'abc', fetchFn })

    await client.hello()

    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe('Bearer abc')
  })

  it('sends no Authorization header without a token', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ text: 'x', time: '' }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    await client.hello()

    expect(new Headers(calls[0]?.init?.headers).has('Authorization')).toBe(false)
  })

  it('reports a rejected fetch as a network error', async () => {
    const { fetchFn } = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    const error = await failure(client.hello())

    expect(error.kind).toBe('network')
    expect(error.message).toContain('Failed to fetch')
  })

  it('reports 401 as unauthorized', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'missing or invalid token' }, 401))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect((await failure(client.hello())).kind).toBe('unauthorized')
  })

  it('reports other error statuses with the status code', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'boom' }, 502))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    const error = await failure(client.hello())

    expect(error.kind).toBe('http')
    expect(error.message).toContain('502')
  })

  it('reports a body without text as invalid', async () => {
    const { fetchFn } = fakeFetch(() => json({ nope: true }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect((await failure(client.hello())).kind).toBe('invalid')
  })

  it('reports a body that is not JSON as invalid', async () => {
    const { fetchFn } = fakeFetch(() => new Response('<html>nginx</html>', { status: 200 }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect((await failure(client.hello())).kind).toBe('invalid')
  })

  it('gives up with a timeout error when the gateway does not answer', async () => {
    const fetchFn = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn, timeoutMs: 20 })

    const error = await failure(client.hello())

    expect(error.kind).toBe('timeout')
    expect(error.message).toContain('no answer')
  })
})
