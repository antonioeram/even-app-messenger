import { describe, expect, it } from 'vitest'
import {
  AudioEvent,
  EventSourceType,
  OsEventTypeList,
  StartUpPageCreateResult,
  Sys_ItemEvent,
  Text_ItemEvent,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { createApp, type GlassesBridge } from './app'
import { GatewayError, type Chat, type Conversation, type GatewayClient, type Message } from './gateway'
import { MAIN_CONTAINER, MAX_UPGRADE_CHARS } from './screen'

class FakeBridge implements GlassesBridge {
  created: string[] = []
  upgrades: string[] = []
  shutdowns: number[] = []
  createResult = StartUpPageCreateResult.success
  private listener: ((event: EvenHubEvent) => void) | null = null

  async createStartUpPageContainer(container: {
    containerTotalNum?: number
    textObject?: { content?: string; isEventCapture?: number; containerID?: number; containerName?: string }[]
  }) {
    const text = container.textObject?.[0]
    expect(container.containerTotalNum).toBe(1)
    expect(text?.isEventCapture).toBe(1)
    expect(text?.containerID).toBe(MAIN_CONTAINER.id)
    expect(text?.containerName).toBe(MAIN_CONTAINER.name)
    this.created.push(text?.content ?? '')
    return this.createResult
  }

  async textContainerUpgrade(upgrade: { containerID?: number; containerName?: string; content?: string }) {
    expect(upgrade.containerID).toBe(MAIN_CONTAINER.id)
    expect(upgrade.containerName).toBe(MAIN_CONTAINER.name)
    expect((upgrade.content ?? '').length).toBeLessThanOrEqual(MAX_UPGRADE_CHARS)
    this.upgrades.push(upgrade.content ?? '')
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

  /** What the glasses show now. */
  get text(): string {
    return this.upgrades.at(-1) ?? this.created.at(-1) ?? ''
  }

  get lines(): string[] {
    return this.text.split('\n')
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

const scrollDown: EvenHubEvent = { textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT }) }
const scrollUp: EvenHubEvent = { textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.SCROLL_TOP_EVENT }) }
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

/** Starts the app, moves the cursor down `index` times and clicks. */
async function openChat(index = 0, gateway = fakeGateway()) {
  const context = setup(gateway)
  await context.app.start()
  for (let i = 0; i < index; i += 1) context.bridge.emit(scrollDown)
  context.bridge.emit(click)
  await context.app.idle()
  return { ...context, gateway }
}

describe('start-up', () => {
  it('creates the start-up page before it calls the gateway', async () => {
    const { bridge, app } = setup()

    await app.start()

    expect(bridge.created).toHaveLength(1)
    expect(bridge.created[0]).toContain('Loading')
    expect(bridge.created[0]).toContain('gw.example')
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
  it('shows the chats with the first one selected', async () => {
    const { bridge, app } = setup()

    await app.start()

    expect(bridge.lines).toEqual(['Inbox 1/2', '> (2) Ana Pop: Vii maine?', '  Familia: ok'])
  })

  it('moves the selection down and up on scroll, without calling the gateway', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()

    bridge.emit(scrollDown)
    await app.idle()
    expect(bridge.lines).toEqual(['Inbox 2/2', '  (2) Ana Pop: Vii maine?', '> Familia: ok'])

    bridge.emit(scrollUp)
    await app.idle()
    expect(bridge.lines[1]).toBe('> (2) Ana Pop: Vii maine?')
    expect(gateway.chatCalls).toBe(1)
  })

  it('stops at the ends of the list', async () => {
    const { bridge, app } = setup()
    await app.start()

    bridge.emit(scrollUp)
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    await app.idle()

    expect(bridge.lines[0]).toBe('Inbox 2/2')
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

    expect(bridge.lines).toEqual(['Inbox 1/1', '> (2) Ana Pop: Vii maine?'])
  })

  it('explains an empty inbox', async () => {
    const { bridge, app } = setup(fakeGateway({ chats: [[]] }))

    await app.start()

    expect(bridge.text).toContain('No chats yet')
  })

  it('reloads the list when the app returns to the foreground, keeping the selection', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()
    bridge.emit(scrollDown)

    bridge.emit(foregroundEnter)
    await app.idle()

    expect(gateway.chatCalls).toBe(2)
    expect(bridge.lines.at(-1)).toBe('> Familia: ok')
  })

  it('asks to exit on double click', async () => {
    const { bridge, app } = setup()
    await app.start()

    bridge.emit(doubleClick)
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
  it('opens the selected chat on click', async () => {
    const { bridge, gateway } = await openChat(1)

    expect(gateway.messageCalls).toEqual(['123@g.us'])
    expect(bridge.lines[0]).toBe('Familia')
    expect(bridge.text).toContain('Buna')
  })

  it('opens the selected chat on a ring click', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()

    bridge.emit(ringClick)
    await app.idle()

    expect(gateway.messageCalls).toEqual(['ana@s.whatsapp.net'])
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
    expect(bridge.lines[0]).toBe('Inbox 1/2')
  })

  it('goes back to the inbox from a failed chat', async () => {
    const gateway = fakeGateway({ messages: [new GatewayError('network', 'Load failed')] })
    const { bridge, app } = await openChat(0, gateway)

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.lines[0]).toBe('Inbox 1/2')
  })

  it('returns to the inbox with the chat it came from still selected', async () => {
    const { bridge, app } = await openChat(1)

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.lines.at(-1)).toBe('> Familia: ok')
  })

  it('does not move the inbox selection while a chat is open', async () => {
    const { bridge, app } = await openChat(0)

    bridge.emit(scrollDown)
    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.lines[1]).toBe('> (2) Ana Pop: Vii maine?')
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

  it('does not log audio frames', async () => {
    const { bridge, app, logs } = setup()
    await app.start()
    const before = logs.length

    bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1, 2, 3]) }) })

    expect(logs).toHaveLength(before)
  })
})
