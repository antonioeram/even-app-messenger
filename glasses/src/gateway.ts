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

export interface GatewayClient {
  chats(): Promise<Chat[]>
  messages(chatId: string): Promise<Conversation>
}

// A list on the glasses holds 20 items; one screen of text holds fewer
// messages than this, so one page of each is enough for stage 1.
const CHAT_LIMIT = 20
const MESSAGE_LIMIT = 30

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
      if (timedOut) throw new GatewayError('timeout', `no answer in ${Math.round(timeoutMs / 1000)} s`)
      // A blocked whitelist entry, a CORS failure, DNS and "offline" all end here:
      // the WebView does not say which one it was.
      throw new GatewayError('network', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401) throw new GatewayError('unauthorized', 'missing or wrong token')
    if (!response.ok) throw new GatewayError('http', `HTTP ${response.status}`)

    try {
      return await response.json()
    } catch {
      throw new GatewayError('invalid', 'response is not JSON')
    }
  }

  return {
    async chats() {
      const body = await getJson(`/chats?limit=${CHAT_LIMIT}`)
      if (!isRecord(body) || !Array.isArray(body.chats)) {
        throw new GatewayError('invalid', 'response has no chats list')
      }
      return body.chats.map(parseChat)
    },

    async messages(chatId) {
      const body = await getJson(`/chats/${encodeURIComponent(chatId)}/messages?limit=${MESSAGE_LIMIT}`)
      if (!isRecord(body) || !isRecord(body.chat) || !Array.isArray(body.messages)) {
        throw new GatewayError('invalid', 'response has no chat or messages')
      }
      return { chat: parseChat(body.chat), messages: body.messages.map(parseMessage) }
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
