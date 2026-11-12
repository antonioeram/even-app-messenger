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
  it('ignores a trailing slash in the base URL', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ chats: [] }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example/', fetchFn })

    await client.chats()

    expect(calls[0]?.url).toBe('https://gw.example/chats?limit=20')
  })

  it('sends the bearer token when one is configured', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ chats: [] }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', token: 'abc', fetchFn })

    await client.chats()

    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe('Bearer abc')
  })

  it('sends no Authorization header without a token', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ chats: [] }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    await client.chats()

    expect(new Headers(calls[0]?.init?.headers).has('Authorization')).toBe(false)
  })

  it('reports a rejected fetch as a network error', async () => {
    const { fetchFn } = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    const error = await failure(client.chats())

    expect(error.kind).toBe('network')
    expect(error.message).toContain('Failed to fetch')
  })

  it('reports 401 as unauthorized', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'missing or invalid token' }, 401))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect((await failure(client.chats())).kind).toBe('unauthorized')
  })

  it('reports other error statuses with the status code', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'boom' }, 502))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    const error = await failure(client.chats())

    expect(error.kind).toBe('http')
    expect(error.message).toContain('502')
  })

  it('reports a body that is not JSON as invalid', async () => {
    const { fetchFn } = fakeFetch(() => new Response('<html>nginx</html>', { status: 200 }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect((await failure(client.chats())).kind).toBe('invalid')
  })

  it('gives up with a timeout error when the gateway does not answer', async () => {
    const fetchFn = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn, timeoutMs: 20 })

    const error = await failure(client.chats())

    expect(error.kind).toBe('timeout')
    expect(error.message).toContain('no answer')
  })

  it('lists chats from /chats', async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      json({
        chats: [
          { id: 'a@s.whatsapp.net', name: 'Ana', group: false, unread: 2, time: 't', clock: '09:36', preview: 'Vii?' },
        ],
      }),
    )
    const client = createGatewayClient({ baseUrl: 'https://gw.example', token: 'tok', fetchFn })

    const chats = await client.chats()

    expect(chats).toEqual([{ id: 'a@s.whatsapp.net', name: 'Ana', group: false, unread: 2, clock: '09:36', preview: 'Vii?', lastFromMe: false }])
    expect(calls[0]?.url).toBe('https://gw.example/chats?limit=20')
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe('Bearer tok')
  })

  it('rejects a /chats response without a chats array', async () => {
    const { fetchFn } = fakeFetch(() => json({ nope: true }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect((await failure(client.chats())).kind).toBe('invalid')
  })

  it('reads the messages of a chat, escaping its id', async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      json({
        chat: { id: '123@g.us', name: 'Familia', group: true, unread: 0, clock: '09:36', preview: 'ok' },
        messages: [{ id: 'm1', sender: 'Ana', from_me: false, time: 't', clock: '09:35', text: 'Buna', kind: 'text' }],
      }),
    )
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    const conversation = await client.messages('123@g.us')

    expect(calls[0]?.url).toBe('https://gw.example/chats/123%40g.us/messages?limit=30')
    expect(conversation.chat.name).toBe('Familia')
    expect(conversation.messages).toEqual([{ id: 'm1', sender: 'Ana', fromMe: false, clock: '09:35', text: 'Buna' }])
  })

  it('reports an unknown chat as an http error', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'unknown chat' }, 404))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect((await failure(client.messages('nope'))).kind).toBe('http')
  })

  it('asks for unanswered chats only when told to', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ chats: [] }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    await client.chats('unanswered')

    expect(calls[0]?.url).toBe('https://gw.example/chats?limit=20&filter=unanswered')
  })

  it('marks a chat read with a POST', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ status: 'read' }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', token: 'tok', fetchFn })

    await client.markRead('123@g.us')

    expect(calls[0]?.url).toBe('https://gw.example/chats/123%40g.us/read')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe('Bearer tok')
  })

  it('uploads a recording as raw bytes and returns both texts', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ text: 'Ajung în zece minute', display: 'Ajung in zece minute', lang: 'ro' }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })
    const pcm = new Uint8Array([1, 2, 3, 4])

    const transcript = await client.transcribe(pcm)

    expect(transcript).toEqual({ text: 'Ajung în zece minute', display: 'Ajung in zece minute', lang: 'ro' })
    expect(calls[0]?.url).toBe('https://gw.example/transcribe')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(new Headers(calls[0]?.init?.headers).get('Content-Type')).toBe('application/octet-stream')
    expect(calls[0]?.init?.body).toBe(pcm)
  })

  it('sends a reply as JSON, keeping the text exactly', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ status: 'sent' }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    await client.send('ana@s.whatsapp.net', 'Ajung în zece minute')

    expect(calls[0]?.url).toBe('https://gw.example/chats/ana%40s.whatsapp.net/send')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: 'Ajung în zece minute' })
  })

  it('reports a failed send with the reason from the gateway', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'message was not sent: WhatsApp is not connected' }, 502))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    const error = await failure(client.send('ana@s.whatsapp.net', 'x'))

    expect(error.kind).toBe('http')
    expect(error.message).toContain('WhatsApp is not connected')
  })

  it('reads the number of chats in each box', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ unread: 1, unanswered: 12, all: 437 }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect(await client.counts()).toEqual({ unread: 1, unanswered: 12, all: 437 })
    expect(calls[0]?.url).toBe('https://gw.example/counts')
  })

  it('rejects counts that are not numbers', async () => {
    const { fetchFn } = fakeFetch(() => json({ unread: 'many' }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect((await failure(client.counts())).kind).toBe('invalid')
  })

  it('reads who wrote the newest message of a chat', async () => {
    const { fetchFn } = fakeFetch(() => json({ chats: [{ id: 'a', name: 'Ana', last_from_me: true }] }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    expect((await client.chats())[0]?.lastFromMe).toBe(true)
  })

  it('asks for a further page of chats with an offset', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ chats: [] }))
    const client = createGatewayClient({ baseUrl: 'https://gw.example', fetchFn })

    await client.chats('unanswered', 40)

    expect(calls[0]?.url).toBe('https://gw.example/chats?limit=20&filter=unanswered&offset=40')
  })
})
