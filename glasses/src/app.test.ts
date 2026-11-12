import { describe, expect, it } from 'vitest'
import {
  AudioEvent,
  EventSourceType,
  List_ItemEvent,
  OsEventTypeList,
  StartUpPageCreateResult,
  Sys_ItemEvent,
  Text_ItemEvent,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { createApp, type GlassesBridge } from './app'
import { GatewayError, type Chat, type Conversation, type GatewayClient, type Message } from './gateway'
import { INBOX_CONTAINER, MAIN_CONTAINER } from './screen'

type Page = { kind: 'list'; items: string[] } | { kind: 'text'; content: string }

type PageInput = {
  containerTotalNum?: number
  textObject?: { content?: string; isEventCapture?: number; containerID?: number; containerName?: string }[]
  listObject?: {
    isEventCapture?: number
    containerID?: number
    containerName?: string
    itemContainer?: { itemCount?: number; itemName?: string[] }
  }[]
}

class FakeBridge implements GlassesBridge {
  pages: Page[] = []
  shutdowns: number[] = []
  createResult = StartUpPageCreateResult.success
  private listener: ((event: EvenHubEvent) => void) | null = null

  private record(container: PageInput) {
    expect(container.containerTotalNum).toBe(1)
    const list = container.listObject?.[0]
    if (list) {
      expect(list.isEventCapture).toBe(1)
      expect(list.containerID).toBe(INBOX_CONTAINER.id)
      expect(list.containerName).toBe(INBOX_CONTAINER.name)
      expect(list.itemContainer?.itemCount).toBe(list.itemContainer?.itemName?.length)
      this.pages.push({ kind: 'list', items: list.itemContainer?.itemName ?? [] })
      return
    }
    const text = container.textObject?.[0]
    expect(text?.isEventCapture).toBe(1)
    expect(text?.containerID).toBe(MAIN_CONTAINER.id)
    expect(text?.containerName).toBe(MAIN_CONTAINER.name)
    this.pages.push({ kind: 'text', content: text?.content ?? '' })
  }

  async createStartUpPageContainer(container: PageInput) {
    this.record(container)
    return this.createResult
  }

  async rebuildPageContainer(container: PageInput) {
    this.record(container)
    return true
  }

  async shutDownPageContainer(exitMode?: number) {
    this.shutdowns.push(exitMode ?? -1)
    return true
  }

  onEvenHubEvent(callback: (event: EvenHubEvent) => void) {
    this.listener = callback
    return () => {
      this.listener = null
    }
  }

  emit(event: EvenHubEvent) {
    this.listener?.(event)
  }

  get page(): Page {
    const last = this.pages.at(-1)
    if (!last) throw new Error('no page was shown')
    return last
  }

  /** Text of the current page; fails the test when a list is shown. */
  get text(): string {
    const page = this.page
    if (page.kind !== 'text') throw new Error(`expected a text page, got a list: ${page.items.join(' | ')}`)
    return page.content
  }

  get items(): string[] {
    const page = this.page
    if (page.kind !== 'list') throw new Error(`expected a list page, got text: ${page.content}`)
    return page.items
  }
}

const ana: Chat = { id: 'ana@s.whatsapp.net', name: 'Ana Pop', group: false, unread: 2, clock: '09:36', preview: 'Vii maine?' }
const family: Chat = { id: '123@g.us', name: 'Familia', group: true, unread: 0, clock: '11.11', preview: 'ok' }

const message = (text: string, over: Partial<Message> = {}): Message => ({
  id: text,
  sender: 'Ana Pop',
  fromMe: false,
  clock: '09:35',
  text,
  ...over,
})

type Step<T> = T | GatewayError

function fakeGateway(options: { chats?: Step<Chat[]>[]; messages?: Step<Message[]>[] } = {}) {
  const chatSteps = options.chats ?? [[ana, family]]
  const messageSteps = options.messages ?? [[message('Buna')]]
  const gateway = {
    chatCalls: 0,
    messageCalls: [] as string[],
    async chats(): Promise<Chat[]> {
      const step = chatSteps[Math.min(gateway.chatCalls, chatSteps.length - 1)]
      gateway.chatCalls += 1
      if (step instanceof GatewayError) throw step
      return step ?? []
    },
    async messages(chatId: string): Promise<Conversation> {
      const step = messageSteps[Math.min(gateway.messageCalls.length, messageSteps.length - 1)]
      gateway.messageCalls.push(chatId)
      if (step instanceof GatewayError) throw step
      const chat = [ana, family].find((c) => c.id === chatId) ?? ana
      return { chat, messages: step ?? [] }
    },
  }
  return gateway satisfies GatewayClient
}

const select = (index?: number, name?: string): EvenHubEvent => ({
  listEvent: new List_ItemEvent({ currentSelectItemIndex: index, currentSelectItemName: name }),
})
const listDoubleClick: EvenHubEvent = {
  listEvent: new List_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }),
}
const click: EvenHubEvent = { textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT }) }
const doubleClick: EvenHubEvent = {
  textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }),
}
const foregroundEnter: EvenHubEvent = {
  sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }),
}
const ringClick: EvenHubEvent = {
  sysEvent: new Sys_ItemEvent({ eventSource: EventSourceType.TOUCH_EVENT_FROM_RING }),
}
const ringDoubleClick: EvenHubEvent = {
  sysEvent: new Sys_ItemEvent({
    eventType: OsEventTypeList.DOUBLE_CLICK_EVENT,
    eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
  }),
}

function setup(gateway: GatewayClient = fakeGateway()) {
  const bridge = new FakeBridge()
  const logs: string[] = []
  const app = createApp({ bridge, gateway, gatewayUrl: 'https://gw.example', log: (line) => logs.push(line) })
  return { bridge, app, logs }
}

async function openChat(index = 0, gateway = fakeGateway()) {
  const context = setup(gateway)
  await context.app.start()
  context.bridge.emit(select(index))
  await context.app.idle()
  return { ...context, gateway }
}

describe('start-up', () => {
  it('creates the start-up page before it calls the gateway', async () => {
    const { bridge, app } = setup()

    await app.start()

    expect(bridge.pages[0]).toEqual({ kind: 'text', content: expect.stringContaining('Loading') })
    expect(bridge.pages[0]).toEqual({ kind: 'text', content: expect.stringContaining('gw.example') })
  })

  it('stops with a log line when the start-up page cannot be created', async () => {
    const gateway = fakeGateway()
    const { bridge, app, logs } = setup(gateway)
    bridge.createResult = StartUpPageCreateResult.invalid

    await app.start()

    expect(gateway.chatCalls).toBe(0)
    expect(logs.join('\n')).toContain('createStartUpPageContainer')
  })
})

describe('inbox', () => {
  it('shows the chats as a list', async () => {
    const { bridge, app } = setup()

    await app.start()

    expect(bridge.items).toEqual(['(2) Ana Pop: Vii maine?', 'Familia: ok'])
  })

  it('shows the reason on the glasses when the gateway call fails', async () => {
    const { bridge, app } = setup(fakeGateway({ chats: [new GatewayError('network', 'Load failed')] }))

    await app.start()

    expect(bridge.text).toContain('Gateway unreachable')
    expect(bridge.text).toContain('Load failed')
    expect(bridge.text).toContain('gw.example')
  })

  it('retries on click after a failure', async () => {
    const { bridge, app } = setup(fakeGateway({ chats: [new GatewayError('network', 'Load failed'), [ana]] }))
    await app.start()

    bridge.emit(click)
    await app.idle()

    expect(bridge.items).toEqual(['(2) Ana Pop: Vii maine?'])
  })

  it('explains an empty inbox', async () => {
    const { bridge, app } = setup(fakeGateway({ chats: [[]] }))

    await app.start()

    expect(bridge.text).toContain('No chats yet')
  })

  it('reloads the list when the app returns to the foreground', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()

    bridge.emit(foregroundEnter)
    await app.idle()

    expect(gateway.chatCalls).toBe(2)
    expect(bridge.page.kind).toBe('list')
  })

  it('asks to exit on double click', async () => {
    const { bridge, app } = setup()
    await app.start()

    bridge.emit(listDoubleClick)
    await app.idle()

    expect(bridge.shutdowns).toEqual([1])
  })

  it('asks to exit on a double click that arrives as a system event', async () => {
    const { bridge, app } = setup()
    await app.start()

    bridge.emit(ringDoubleClick)
    await app.idle()

    expect(bridge.shutdowns).toEqual([1])
  })
})

describe('opening a chat', () => {
  it('opens the chat selected in the list', async () => {
    const { bridge, gateway } = await openChat(1)

    expect(gateway.messageCalls).toEqual(['123@g.us'])
    expect(bridge.text).toContain('Familia')
    expect(bridge.text).toContain('Buna')
  })

  it('opens the first chat when the event carries no index', async () => {
    // The host drops zero values, so index 0 arrives as "no index".
    const context = setup()
    await context.app.start()

    context.bridge.emit(select(undefined))
    await context.app.idle()

    expect(context.bridge.text).toContain('Ana Pop')
  })

  it('falls back to the item name when the index is missing', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()

    bridge.emit(select(undefined, 'Familia: ok'))
    await app.idle()

    expect(gateway.messageCalls).toEqual(['123@g.us'])
  })

  it('ignores a selection outside the list', async () => {
    const gateway = fakeGateway()
    const { bridge, app, logs } = setup(gateway)
    await app.start()

    bridge.emit(select(7))
    await app.idle()

    expect(gateway.messageCalls).toEqual([])
    expect(logs.join('\n')).toContain('no chat at index 7')
  })

  it('shows the newest message first', async () => {
    const gateway = fakeGateway({ messages: [[message('older', { clock: '09:30' }), message('newer', { clock: '09:40' })]] })
    const { bridge } = await openChat(0, gateway)

    expect(bridge.text.indexOf('newer')).toBeLessThan(bridge.text.indexOf('older'))
  })

  it('shows the reason when the messages cannot be loaded', async () => {
    const gateway = fakeGateway({ messages: [new GatewayError('timeout', 'no answer in 8 s')] })
    const { bridge } = await openChat(0, gateway)

    expect(bridge.text).toContain('Gateway unreachable')
    expect(bridge.text).toContain('no answer in 8 s')
  })
})

describe('inside a chat', () => {
  it('reloads the messages on click', async () => {
    const gateway = fakeGateway({ messages: [[message('first')], [message('first'), message('second')]] })
    const { bridge, app } = await openChat(0, gateway)

    bridge.emit(click)
    await app.idle()

    expect(gateway.messageCalls).toEqual(['ana@s.whatsapp.net', 'ana@s.whatsapp.net'])
    expect(bridge.text).toContain('second')
  })

  it('reloads the messages on a ring click', async () => {
    const { bridge, app, gateway } = await openChat()

    bridge.emit(ringClick)
    await app.idle()

    expect(gateway.messageCalls).toHaveLength(2)
  })

  it('reloads the messages when the app returns to the foreground', async () => {
    const { bridge, app, gateway } = await openChat()

    bridge.emit(foregroundEnter)
    await app.idle()

    expect(gateway.messageCalls).toHaveLength(2)
    expect(gateway.chatCalls).toBe(1)
  })

  it('goes back to the inbox on double click, without asking to exit', async () => {
    const { bridge, app, gateway } = await openChat()

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.shutdowns).toEqual([])
    expect(gateway.chatCalls).toBe(2)
    expect(bridge.page.kind).toBe('list')
  })

  it('goes back to the inbox from a failed chat', async () => {
    const gateway = fakeGateway({ messages: [new GatewayError('network', 'Load failed')] })
    const { bridge, app } = await openChat(0, gateway)

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.page.kind).toBe('list')
  })
})

describe('loading', () => {
  it('runs one gateway call at a time', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()

    bridge.emit(foregroundEnter)
    bridge.emit(foregroundEnter)
    bridge.emit(foregroundEnter)
    await app.idle()

    expect(gateway.chatCalls).toBe(2)
  })
})

describe('diagnostics', () => {
  it('logs each gesture so its arrival can be read on the phone', async () => {
    const { bridge, app, logs } = await openChat()

    bridge.emit(click)
    await app.idle()

    expect(logs).toContain('gesture: click')
  })

  it('logs where a gesture came from, so ring input can be told from the temples', async () => {
    const { bridge, app, logs } = await openChat()

    bridge.emit(ringClick)
    await app.idle()

    expect(logs).toContain('gesture: click (ring)')
  })

  it('logs the raw shape of an event it does not recognise', async () => {
    const { bridge, app, logs } = setup()
    await app.start()

    bridge.emit({ jsonData: { eventType: 99, somethingNew: true } })

    expect(logs.join('\n')).toContain('unknown event: {"eventType":99,"somethingNew":true}')
  })

  it('logs a click in the inbox that names no list item', async () => {
    const { bridge, app, logs } = setup()
    await app.start()

    bridge.emit(ringClick)
    await app.idle()

    expect(logs.join('\n')).toContain('click without a list selection')
  })

  it('does not log audio frames', async () => {
    const { bridge, app, logs } = setup()
    await app.start()
    const before = logs.length

    bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1, 2, 3]) }) })

    expect(logs).toHaveLength(before)
  })
})
