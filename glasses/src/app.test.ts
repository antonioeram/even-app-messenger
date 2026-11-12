import { describe, expect, it, vi } from 'vitest'
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
import {
  GatewayError,
  type Chat,
  type Conversation,
  type Counts,
  type GatewayClient,
  type Message,
  type Transcript,
} from './gateway'

type BoxInput = {
  xPosition?: number
  yPosition?: number
  width?: number
  height?: number
  containerID?: number
  containerName?: string
  content?: string
  isEventCapture?: number
  textColor?: number
}
type PageInput = { containerTotalNum?: number; textObject?: BoxInput[] }

/** Models the glasses: a page of text containers that can be replaced or updated in place. */
class FakeBridge implements GlassesBridge {
  private boxes: BoxInput[] = []
  /** Text of the start-up page. */
  startText = ''
  /** Pages drawn with a full rebuild. */
  rebuilds = 0
  /** In-place text updates. */
  upgrades = 0
  shutdowns: number[] = []
  /** Microphone switch history: true = on. */
  mic: boolean[] = []
  createResult = StartUpPageCreateResult.success
  private listener: ((event: EvenHubEvent) => void) | null = null

  private setPage(page: PageInput): boolean {
    const boxes = page.textObject ?? []
    // What the Even app validates before a page reaches the glasses.
    expect(page.containerTotalNum).toBe(boxes.length)
    expect(boxes.filter((box) => box.isEventCapture === 1)).toHaveLength(1)
    expect(new Set(boxes.map((box) => box.containerID)).size).toBe(boxes.length)
    for (const box of boxes) {
      expect((box.content ?? '').length).toBeGreaterThan(0)
      expect((box.xPosition ?? 0) + (box.width ?? 0)).toBeLessThanOrEqual(576)
      expect((box.yPosition ?? 0) + (box.height ?? 0)).toBeLessThanOrEqual(288)
    }
    this.boxes = boxes.map((box) => ({ ...box }))
    return true
  }

  async createStartUpPageContainer(page: PageInput) {
    if (this.createResult !== StartUpPageCreateResult.success) return this.createResult
    if (!this.setPage(page)) return StartUpPageCreateResult.invalid
    this.startText = this.text
    return this.createResult
  }

  async rebuildPageContainer(page: PageInput) {
    if (!this.setPage(page)) return false
    this.rebuilds += 1
    return true
  }

  async textContainerUpgrade(upgrade: { containerID?: number; containerName?: string; content?: string; textColor?: number }) {
    const box = this.boxes.find((candidate) => candidate.containerID === upgrade.containerID)
    // An update for a container that is not on the page is lost on real glasses.
    if (!box) throw new Error(`no container ${upgrade.containerID} on the current page`)
    expect(upgrade.containerName).toBe(box.containerName)
    expect((upgrade.content ?? '').length).toBeGreaterThan(0)
    box.content = upgrade.content
    if (upgrade.textColor !== undefined) box.textColor = upgrade.textColor
    this.upgrades += 1
    return true
  }

  async audioControl(isOpen: boolean) {
    this.mic.push(isOpen)
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

  /** Everything the glasses show now, top to bottom. */
  get text(): string {
    return this.boxes.map((box) => box.content ?? '').join('\n')
  }

  /** The non-blank lines on the glasses. */
  get lines(): string[] {
    return this.text.split('\n').filter((line) => line.trim() !== '')
  }

  /** Brightness of each box below the title. */
  get brightness(): (number | undefined)[] {
    return this.boxes.slice(1).map((box) => box.textColor)
  }

  /** Horizontal position of each box below the title. */
  get lefts(): (number | undefined)[] {
    return this.boxes.slice(1).map((box) => box.xPosition)
  }
}

const ana: Chat = { id: 'ana@s.whatsapp.net', name: 'Ana Pop', group: false, unread: 2, clock: '09:36', preview: 'Vii maine?', lastFromMe: false }
const family: Chat = { id: '123@g.us', name: 'Familia', group: true, unread: 0, clock: '11.11', preview: 'ok', lastFromMe: false }

const message = (text: string, over: Partial<Message> = {}): Message => ({
  id: text,
  sender: 'Ana Pop',
  fromMe: false,
  clock: '09:35',
  text,
  ...over,
})

type Step<T> = T | GatewayError

function fakeGateway(
  options: {
    chats?: Step<Chat[]>[]
    messages?: Step<Message[]>[]
    transcripts?: Step<Transcript>[]
    counts?: Step<Counts>
    /** What each call for a further page returns, in order. */
    more?: Chat[][]
    sends?: (GatewayError | undefined)[]
  } = {},
) {
  const chatSteps = options.chats ?? [[ana, family]]
  const messageSteps = options.messages ?? [[message('Buna')]]
  const gateway = {
    chatCalls: 0,
    filters: [] as (string | undefined)[],
    messageCalls: [] as string[],
    readCalls: [] as string[],
    countCalls: 0,
    async counts(): Promise<Counts> {
      gateway.countCalls += 1
      if (options.counts instanceof GatewayError) throw options.counts
      return options.counts ?? { unread: gateway.lastUnread, unanswered: 5, all: 9 }
    },
    recordings: [] as Uint8Array[],
    sent: [] as { chatId: string; text: string }[],
    async markRead(chatId: string): Promise<void> {
      gateway.readCalls.push(chatId)
    },
    async transcribe(pcm: Uint8Array): Promise<Transcript> {
      gateway.recordings.push(pcm)
      const step = options.transcripts?.[Math.min(gateway.recordings.length - 1, options.transcripts.length - 1)]
      if (step instanceof GatewayError) throw step
      return step ?? { text: 'Ajung în zece minute', display: 'Ajung in zece minute', lang: 'ro' }
    },
    sendAttempts: 0,
    async send(chatId: string, text: string): Promise<void> {
      const step = options.sends?.[Math.min(gateway.sendAttempts, options.sends.length - 1)]
      gateway.sendAttempts += 1
      if (step instanceof GatewayError) throw step
      gateway.sent.push({ chatId, text })
    },
    /** Offsets of the calls that asked for a further page. */
    offsets: [] as number[],
    lastUnread: 0,
    async chats(filter?: 'unread' | 'unanswered', offset = 0): Promise<Chat[]> {
      if (offset > 0) {
        gateway.offsets.push(offset)
        return options.more?.[gateway.offsets.length - 1] ?? []
      }
      gateway.filters.push(filter)
      const step = chatSteps[Math.min(gateway.chatCalls, chatSteps.length - 1)]
      gateway.chatCalls += 1
      if (step instanceof GatewayError) throw step
      if (filter === 'unread') gateway.lastUnread = (step ?? []).length
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
const holdStart: EvenHubEvent = { sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.LONG_PRESS_EVENT }) }
const holdEnd: EvenHubEvent = { sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT }) }
/** One second of audio, in ten frames. */
function speak(bridge: FakeBridge, seconds = 1) {
  for (let i = 0; i < seconds * 10; i += 1) {
    bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(3200).fill(i + 1) }) })
  }
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

    expect(bridge.startText).toContain('Loading')
    expect(bridge.startText).toContain('gw.example')
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

    expect(bridge.lines).toEqual(['Unread (2)', '> Ana Pop  09:36', 'Vii maine? (2)', '  Familia  11.11', 'ok', '  Unanswered (5)', '  All chats (9)'])
    expect(bridge.brightness).toEqual([4, 2, 2, 2])
  })

  it('moves the selection down and up on scroll, without calling the gateway', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()

    const rebuilds = bridge.rebuilds
    bridge.emit(scrollDown)
    await app.idle()
    expect(bridge.lines).toEqual(['Unread (2)', '* Ana Pop  09:36', 'Vii maine? (2)', '> Familia  11.11', 'ok', '  Unanswered (5)', '  All chats (9)'])
    expect(bridge.brightness).toEqual([2, 4, 2, 2])

    bridge.emit(scrollUp)
    await app.idle()
    expect(bridge.lines[1]).toBe('> Ana Pop  09:36')
    expect(gateway.chatCalls).toBe(1)
    // Moving the selection never redraws the whole page.
    expect(bridge.rebuilds).toBe(rebuilds)
  })

  it('stops at the ends of the list', async () => {
    const { bridge, app } = setup()
    await app.start()

    bridge.emit(scrollUp)
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    await app.idle()

    expect(bridge.lines.at(-1)).toBe('> All chats (9)')
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

    expect(bridge.lines).toEqual(['Unread (1)', '> Ana Pop  09:36', 'Vii maine? (2)', '  Unanswered (5)', '  All chats (9)'])
  })

  it('asks the gateway for unread chats first', async () => {
    const gateway = fakeGateway()
    const { app } = setup(gateway)

    await app.start()

    expect(gateway.filters).toEqual(['unread'])
  })

  it('shows an empty box with the way to all chats', async () => {
    const { bridge, app } = setup(fakeGateway({ chats: [[]] }))

    await app.start()

    expect(bridge.lines).toEqual(['Unread (0)', '> Unanswered (5)', '  All chats (9)'])
  })

  it('opens the box with all chats from the extra row', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)

    bridge.emit(click)
    await app.idle()

    expect(gateway.filters).toEqual(['unread', undefined])
    expect(bridge.lines).toEqual(['All chats (9)', '> Ana Pop  09:36', 'Vii maine? (2)', '  Familia  11.11', 'ok'])
  })

  it('goes back from all chats to the unread box on double click, without asking to exit', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    bridge.emit(click)
    await app.idle()

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.shutdowns).toEqual([])
    expect(gateway.filters).toEqual(['unread', undefined, 'unread'])
    expect(bridge.lines[0]).toBe('Unread (2)')
  })

  it('reloads the list when the app returns to the foreground, keeping the selection', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()
    bridge.emit(scrollDown)

    bridge.emit(foregroundEnter)
    await app.idle()

    expect(gateway.chatCalls).toBe(2)
    expect(bridge.lines).toContain('> Familia  11.11')
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
    expect(bridge.lines[0]).toBe('Familia 1/1')
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

  it('shows messages as bubbles in time order: theirs on the left, mine on the right', async () => {
    const gateway = fakeGateway({
      messages: [[message('older', { clock: '09:30' }), message('newer', { clock: '09:40', fromMe: true, sender: 'Me' })]],
    })
    const { bridge } = await openChat(0, gateway)

    expect(bridge.lines).toEqual(['Ana Pop 1/1', 'Ana Pop - 09:30', 'older', 'Me - 09:40', 'newer'])
    expect(bridge.lefts[0]).toBe(0)
    expect(bridge.lefts[1]).toBeGreaterThan(0)
  })

  it('says so when the chat has no messages', async () => {
    const { bridge } = await openChat(0, fakeGateway({ messages: [[]] }))

    expect(bridge.text).toContain('No messages')
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
    expect(bridge.lines[0]).toBe('Unread (2)')
  })

  it('goes back to the inbox from a failed chat', async () => {
    const gateway = fakeGateway({ messages: [new GatewayError('network', 'Load failed')] })
    const { bridge, app } = await openChat(0, gateway)

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.lines[0]).toBe('Unread (2)')
  })

  it('returns to the inbox with the chat it came from still selected', async () => {
    const { bridge, app } = await openChat(1)

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.lines).toContain('> Familia  11.11')
  })

  it('does not move the inbox selection while a chat is open', async () => {
    const { bridge, app } = await openChat(0)

    bridge.emit(scrollDown)
    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.lines[1]).toBe('> Ana Pop  09:36')
  })

  it('pages back to older messages on scroll up, without calling the gateway', async () => {
    const many = Array.from({ length: 20 }, (_, i) => message(`message number ${i}`))
    const gateway = fakeGateway({ messages: [many] })
    const { bridge, app } = await openChat(0, gateway)
    // Opens on the last page, which holds the newest messages.
    expect(bridge.lines[0]).toBe('Ana Pop 7/7')
    expect(bridge.text).toContain('message number 19')

    bridge.emit(scrollUp)
    await app.idle()
    expect(bridge.lines[0]).toBe('Ana Pop 6/7')

    for (let i = 0; i < 9; i += 1) bridge.emit(scrollUp)
    await app.idle()
    expect(bridge.lines[0]).toBe('Ana Pop 1/7')
    expect(bridge.text).toContain('message number 0')

    bridge.emit(scrollDown)
    await app.idle()
    expect(bridge.lines[0]).toBe('Ana Pop 2/7')
    expect(gateway.messageCalls).toHaveLength(1)
  })

  it('returns to all chats when the chat was opened from there', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)
    bridge.emit(click)
    await app.idle()
    bridge.emit(click)
    await app.idle()

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.lines[0]).toBe('All chats (9)')
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

describe('boxes', () => {
  it('opens the unanswered box from its row and goes back on double click', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()
    bridge.emit(scrollDown)
    bridge.emit(scrollDown)

    bridge.emit(click)
    await app.idle()
    expect(gateway.filters).toEqual(['unread', 'unanswered'])
    expect(bridge.lines[0]).toBe('Unanswered (5)')

    bridge.emit(doubleClick)
    await app.idle()
    expect(bridge.shutdowns).toEqual([])
    expect(bridge.lines[0]).toBe('Unread (2)')
  })

  it('marks an unread chat as read on the gateway when it is opened', async () => {
    const { gateway } = await openChat(0)

    expect(gateway.readCalls).toEqual(['ana@s.whatsapp.net'])
  })

  it('does not mark a chat that has nothing unread', async () => {
    const { gateway } = await openChat(1)

    expect(gateway.readCalls).toEqual([])
  })
})

describe('voice reply', () => {
  async function dictate(gateway = fakeGateway()) {
    const context = await openChat(0, gateway)
    context.bridge.emit(holdStart)
    await context.app.idle()
    speak(context.bridge)
    context.bridge.emit(holdEnd)
    await context.app.idle()
    return context
  }

  it('turns the glasses microphone on while the touchpad is held', async () => {
    const { bridge, app } = await openChat()

    bridge.emit(holdStart)
    await app.idle()
    expect(bridge.mic).toEqual([true])
    expect(bridge.text).toContain('Recording')

    bridge.emit(holdEnd)
    await app.idle()
    expect(bridge.mic).toEqual([true, false])
  })

  it('sends the recording to the gateway as one piece', async () => {
    const { gateway } = await dictate()

    expect(gateway.recordings).toHaveLength(1)
    expect(gateway.recordings[0]).toHaveLength(32000)
    expect(gateway.recordings[0]?.[0]).toBe(1)
    expect(gateway.recordings[0]?.[31999]).toBe(10)
  })

  it('shows the transcript and waits: nothing is sent without a click', async () => {
    const { bridge, gateway } = await dictate()

    expect(bridge.text).toContain('Reply to Ana Pop')
    expect(bridge.text).toContain('Ajung in zece minute')
    expect(bridge.text).toContain('Click = send')
    expect(gateway.sent).toEqual([])
  })

  it('sends the original text, with diacritics, on click and reloads the chat', async () => {
    const { bridge, app, gateway } = await dictate()

    bridge.emit(click)
    await app.idle()

    expect(gateway.sent).toEqual([{ chatId: 'ana@s.whatsapp.net', text: 'Ajung în zece minute' }])
    expect(gateway.messageCalls).toHaveLength(2)
    expect(bridge.lines[0]).toBe('Ana Pop 1/1')
  })

  it('sends only once when click is repeated', async () => {
    const { bridge, app, gateway } = await dictate()

    bridge.emit(click)
    bridge.emit(click)
    bridge.emit(ringClick)
    await app.idle()

    expect(gateway.sent).toHaveLength(1)
  })

  it('cancels on double click and returns to the chat without sending', async () => {
    const { bridge, app, gateway } = await dictate()

    bridge.emit(doubleClick)
    await app.idle()

    expect(gateway.sent).toEqual([])
    expect(bridge.lines[0]).toBe('Ana Pop 1/1')
    // Still in the chat: another double click goes back to the list.
    bridge.emit(doubleClick)
    await app.idle()
    expect(bridge.lines[0]).toBe('Unread (2)')
  })

  it('keeps the transcript when sending fails, so click can retry', async () => {
    const gateway = fakeGateway({ sends: [new GatewayError('http', 'HTTP 502'), undefined] })
    const { bridge, app } = await dictate(gateway)

    bridge.emit(click)
    await app.idle()
    expect(bridge.text).toContain('Not sent')
    expect(bridge.text).toContain('Ajung in zece minute')
    expect(gateway.sent).toEqual([])

    bridge.emit(click)
    await app.idle()
    expect(gateway.sent).toHaveLength(1)
  })

  it('says so when nothing was understood, and sends nothing on click', async () => {
    const gateway = fakeGateway({ transcripts: [{ text: '', display: '', lang: 'ro' }] })
    const { bridge, app } = await dictate(gateway)
    expect(bridge.text).toContain('Nothing understood')

    bridge.emit(click)
    await app.idle()
    expect(gateway.sent).toEqual([])
    expect(bridge.lines[0]).toBe('Ana Pop 1/1')
  })

  it('shows the reason when transcription fails', async () => {
    const gateway = fakeGateway({ transcripts: [new GatewayError('http', 'HTTP 503')] })
    const { bridge } = await dictate(gateway)

    expect(bridge.text).toContain('HTTP 503')
    expect(gateway.sent).toEqual([])
  })

  it('ignores a hold that recorded almost nothing', async () => {
    const { bridge, app, gateway } = await openChat()

    bridge.emit(holdStart)
    await app.idle()
    bridge.emit(holdEnd)
    await app.idle()

    expect(gateway.recordings).toEqual([])
    expect(bridge.text).toContain('Nothing recorded')
  })

  it('cancels a recording on double click and turns the microphone off', async () => {
    const { bridge, app, gateway } = await openChat()
    bridge.emit(holdStart)
    await app.idle()
    speak(bridge)

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.mic).toEqual([true, false])
    expect(gateway.recordings).toEqual([])
    expect(bridge.lines[0]).toBe('Ana Pop 1/1')
  })

  it('does not record outside a chat', async () => {
    const { bridge, app } = setup()
    await app.start()

    bridge.emit(holdStart)
    speak(bridge)
    bridge.emit(holdEnd)
    await app.idle()

    expect(bridge.mic).toEqual([])
    expect(bridge.lines[0]).toBe('Unread (2)')
  })

  it('stops a recording that runs past the limit', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, app, gateway } = await openChat()
      bridge.emit(holdStart)
      await app.idle()
      speak(bridge)

      await vi.advanceTimersByTimeAsync(60_000)
      await app.idle()

      expect(bridge.mic).toEqual([true, false])
      expect(gateway.recordings).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the transcript when the app returns to the foreground', async () => {
    const { bridge, app } = await dictate()

    bridge.emit(foregroundEnter)
    await app.idle()

    expect(bridge.text).toContain('Click = send')
  })
})

describe('home links', () => {
  it('shows how many chats each other box holds', async () => {
    const { bridge, app } = setup(fakeGateway({ counts: { unread: 2, unanswered: 12, all: 437 } }))

    await app.start()

    expect(bridge.lines[0]).toBe('Unread (2)')
    expect(bridge.lines.slice(-2)).toEqual(['  Unanswered (12)', '  All chats (437)'])
  })

  it('shows the links without numbers when the counts cannot be read', async () => {
    const { bridge, app } = setup(fakeGateway({ counts: new GatewayError('http', 'HTTP 404') }))

    await app.start()

    expect(bridge.lines.slice(-2)).toEqual(['  Unanswered', '  All chats'])
    // Without the counts, the title falls back to what was loaded.
    expect(bridge.lines[0]).toBe('Unread (2)')
  })

  it('reads the counts again for each box it opens', async () => {
    const gateway = fakeGateway()
    const { bridge, app } = setup(gateway)
    await app.start()
    for (let i = 0; i < 3; i += 1) bridge.emit(scrollDown)
    bridge.emit(click)
    await app.idle()

    expect(bridge.lines[0]).toBe('All chats (9)')
    expect(gateway.countCalls).toBe(2)
  })
})

describe('boxes on screen', () => {
  const boxCount = (bridge: FakeBridge) => bridge.brightness.length

  it('draws one box per row and no empty ones', async () => {
    const { bridge, app } = setup(fakeGateway({ chats: [[]] }))

    await app.start()

    expect(bridge.lines).toEqual(['Unread (0)', '> Unanswered (5)', '  All chats (9)'])
    expect(boxCount(bridge)).toBe(2)
  })

  it('lays the page out again when the number of rows changes', async () => {
    const { bridge, app } = setup(fakeGateway({ chats: [[ana, family], [ana]] }))
    await app.start()
    expect(boxCount(bridge)).toBe(4)

    bridge.emit(foregroundEnter)
    await app.idle()

    expect(boxCount(bridge)).toBe(3)
  })

  it('says so when another box has no chats', async () => {
    const { bridge, app } = setup(fakeGateway({ chats: [[ana], []], counts: { unread: 1, unanswered: 0, all: 1 } }))
    await app.start()
    bridge.emit(scrollDown)
    bridge.emit(click)
    await app.idle()

    expect(bridge.lines[0]).toBe('Unanswered (0)')
    expect(bridge.text).toContain('No chats here')
    expect(boxCount(bridge)).toBe(1)
  })
})

describe('list totals and paging', () => {
  const chat = (i: number): Chat => ({ id: `c${i}@s.whatsapp.net`, name: `Chat ${i}`, group: false, unread: 0, clock: '10:00', preview: 'hi', lastFromMe: false })
  const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => chat(from + i))

  /** Opens the All chats box of a gateway that holds `all` chats and serves them in pages. */
  async function openAll(all: number, more: Chat[][]) {
    const gateway = fakeGateway({ chats: [[], page(0, Math.min(all, 20))], counts: { unread: 0, unanswered: 0, all }, more })
    const context = setup(gateway)
    await context.app.start()
    context.bridge.emit(scrollDown)
    context.bridge.emit(click)
    await context.app.idle()
    return { ...context, gateway }
  }

  it('shows the real total in the title, not the number of chats loaded so far', async () => {
    const { bridge } = await openAll(437, [])

    expect(bridge.lines[0]).toBe('All chats (437)')
  })

  it('loads the next page when the selection reaches the last loaded chat', async () => {
    const { bridge, app, gateway } = await openAll(45, [page(20, 20), page(40, 5)])

    for (let i = 0; i < 19; i += 1) bridge.emit(scrollDown)
    await app.idle()
    expect(gateway.offsets).toEqual([20])

    bridge.emit(scrollDown)
    await app.idle()
    expect(bridge.lines).toContain('> Chat 20  10:00')
  })

  it('reaches the last chat of a long list and then stops asking', async () => {
    const { bridge, app, gateway } = await openAll(45, [page(20, 20), page(40, 5)])

    for (let i = 0; i < 60; i += 1) {
      bridge.emit(scrollDown)
      await app.idle()
    }

    expect(bridge.lines).toContain('> Chat 44  10:00')
    expect(gateway.offsets).toEqual([20, 40])
  })

  it('does not ask for more when everything is loaded', async () => {
    const { bridge, app, gateway } = await openAll(3, [])

    for (let i = 0; i < 5; i += 1) bridge.emit(scrollDown)
    await app.idle()

    expect(gateway.offsets).toEqual([])
  })

  it('does not list a chat twice when it moved between pages', async () => {
    const { bridge, app } = await openAll(22, [[chat(19), chat(20), chat(21)]])

    for (let i = 0; i < 30; i += 1) {
      bridge.emit(scrollDown)
      await app.idle()
    }

    // 22 chats: the last page holds chats 20 and 21 only.
    expect(bridge.lines).toEqual(['All chats (22)', '  Chat 20  10:00', 'hi', '> Chat 21  10:00', 'hi'])
  })

  it('stops asking when the gateway has no more chats than it promised', async () => {
    const { bridge, app, gateway } = await openAll(50, [[]])

    for (let i = 0; i < 40; i += 1) {
      bridge.emit(scrollDown)
      await app.idle()
    }

    expect(gateway.offsets).toEqual([20])
  })
})
