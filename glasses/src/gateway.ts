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

export interface Chat {
  id: string
  name: string
  group: boolean
  unread: number
  /** Hour of the newest message for today, its date otherwise. */
  clock: string
  /** Text of the newest message. */
  preview: string
}

export interface Message {
  id: string
  sender: string
  fromMe: boolean
  clock: string
  text: string
}

export interface Conversation {
  chat: Chat
  /** Oldest first. */
  messages: Message[]
}

/**
 * 'unread': chats with unread messages.
 * 'unanswered': read direct chats whose newest message is not mine.
 */
export type ChatFilter = 'unread' | 'unanswered'

export interface Transcript {
  /** What was said; this is what gets sent. */
  text: string
  /** The same text in ASCII, for the glasses. */
  display: string
  lang: string
}

/** Number of chats in each box. */
export interface Counts {
  unread: number
  unanswered: number
  all: number
}

export interface GatewayClient {
  chats(filter?: ChatFilter): Promise<Chat[]>
  counts(): Promise<Counts>
  messages(chatId: string): Promise<Conversation>
  /** Clears the gateway's unread counter; sends no read receipt to WhatsApp. */
  markRead(chatId: string): Promise<void>
  /** pcm: 16 kHz, 16 bit, mono, little endian. */
  transcribe(pcm: Uint8Array): Promise<Transcript>
  send(chatId: string, text: string): Promise<void>
}

// A list on the glasses holds 20 items; one screen of text holds fewer
// messages than this, so one page of each is enough for stage 1.
const CHAT_LIMIT = 20
const MESSAGE_LIMIT = 30
const TRANSCRIBE_TIMEOUT_MS = 45_000
const SEND_TIMEOUT_MS = 20_000

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

  interface Post {
    body: BodyInit
    contentType: string
    /** Speech-to-text takes longer than a read. */
    timeoutMs?: number
  }

  async function getJson(path: string, post?: Post): Promise<unknown> {
    const limitMs = post?.timeoutMs ?? timeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, limitMs)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    const init: RequestInit = { headers, signal: controller.signal, cache: 'no-store' }
    if (post) {
      headers['Content-Type'] = post.contentType
      init.method = 'POST'
      init.body = post.body
    }

    let response: Response
    try {
      response = await fetchFn(`${baseUrl}${path}`, init)
    } catch (error) {
      if (timedOut) throw new GatewayError('timeout', `no answer in ${Math.round(limitMs / 1000)} s`)
      // A blocked whitelist entry, a CORS failure, DNS and "offline" all end here:
      // the WebView does not say which one it was.
      throw new GatewayError('network', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401) throw new GatewayError('unauthorized', 'missing or wrong token')
    if (!response.ok) {
      // The gateway explains failures in an "error" field.
      const reason = await response
        .json()
        .then((body: unknown) => (isRecord(body) && typeof body.error === 'string' ? body.error : ''))
        .catch(() => '')
      throw new GatewayError('http', reason ? `HTTP ${response.status}: ${reason}` : `HTTP ${response.status}`)
    }

    try {
      return await response.json()
    } catch {
      throw new GatewayError('invalid', 'response is not JSON')
    }
  }

  return {
    async chats(filter) {
      const body = await getJson(`/chats?limit=${CHAT_LIMIT}${filter ? `&filter=${filter}` : ''}`)
      if (!isRecord(body) || !Array.isArray(body.chats)) {
        throw new GatewayError('invalid', 'response has no chats list')
      }
      return body.chats.map(parseChat)
    },

    async counts() {
      const body = await getJson('/counts')
      if (
        !isRecord(body) ||
        typeof body.unread !== 'number' ||
        typeof body.unanswered !== 'number' ||
        typeof body.all !== 'number'
      ) {
        throw new GatewayError('invalid', 'response has no counts')
      }
      return { unread: body.unread, unanswered: body.unanswered, all: body.all }
    },

    async messages(chatId) {
      const body = await getJson(`/chats/${encodeURIComponent(chatId)}/messages?limit=${MESSAGE_LIMIT}`)
      if (!isRecord(body) || !isRecord(body.chat) || !Array.isArray(body.messages)) {
        throw new GatewayError('invalid', 'response has no chat or messages')
      }
      return { chat: parseChat(body.chat), messages: body.messages.map(parseMessage) }
    },

    async markRead(chatId) {
      await getJson(`/chats/${encodeURIComponent(chatId)}/read`, { body: '{}', contentType: 'application/json' })
    },

    async transcribe(pcm) {
      const body = await getJson('/transcribe', {
        body: pcm as BodyInit,
        contentType: 'application/octet-stream',
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      })
      if (!isRecord(body) || typeof body.text !== 'string') {
        throw new GatewayError('invalid', 'response has no text')
      }
      return { text: body.text, display: text(body.display) || body.text, lang: text(body.lang) }
    },

    async send(chatId, message) {
      await getJson(`/chats/${encodeURIComponent(chatId)}/send`, {
        body: JSON.stringify({ text: message }),
        contentType: 'application/json',
        timeoutMs: SEND_TIMEOUT_MS,
      })
    },
  }
}

function parseChat(raw: unknown): Chat {
  if (!isRecord(raw) || typeof raw.id !== 'string') throw new GatewayError('invalid', 'chat without id')
  return {
    id: raw.id,
    name: text(raw.name),
    group: raw.group === true,
    unread: typeof raw.unread === 'number' ? raw.unread : 0,
    clock: text(raw.clock),
    preview: text(raw.preview),
  }
}

function parseMessage(raw: unknown): Message {
  if (!isRecord(raw) || typeof raw.id !== 'string') throw new GatewayError('invalid', 'message without id')
  return {
    id: raw.id,
    sender: text(raw.sender),
    fromMe: raw.from_me === true,
    clock: text(raw.clock),
    text: text(raw.text),
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
