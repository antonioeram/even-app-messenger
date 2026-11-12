// The app on the glasses: lists of WhatsApp chats, a reading screen and a
// voice reply.
//
// A list is a title and up to four bordered boxes whose texts change in
// place, with an arrowhead beside the selected one; a chat is a title and
// message bubbles, theirs left and mine right.
// Unread:     the home box, chats with unread messages. Scroll moves the
//             selection, click opens, double click asks to exit. Its last
//             two rows open the other boxes.
// Unanswered: read chats waiting for my reply; double click goes home.
// All chats:  every chat; double click goes home.
// Chat:       opens on the newest page; scroll turns pages and, past the
//             first one, loads older messages; click reloads; double click
//             goes back to the box it was opened from. Holding the touchpad
//             records a reply; releasing it transcribes; the text is sent
//             only after a click.

import {
  AudioInputSource,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  OsEventTypeList,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type RebuildPageContainer,
  type TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import {
  GatewayError,
  MESSAGE_LIMIT,
  type Chat,
  type ChatFilter,
  type Counts,
  type GatewayClient,
  type GatewayErrorKind,
  type Message,
} from './gateway'
import { gestureFromEvent, sourceFromEvent } from './gestures'
import {
  chatPage,
  headUpdate,
  inboxPage,
  INBOX_ROWS,
  markerSlot,
  notePage,
  rowLayout,
  rowUpdate,
  startupInbox,
  type BubbleBox,
  type Row,
} from './screen'
import { chatBubbles, inboxRows, noteRows } from './views'

/** The part of EvenAppBridge the app uses; tests supply a fake. */
export interface GlassesBridge {
  createStartUpPageContainer(container: CreateStartUpPageContainer): Promise<StartUpPageCreateResult>
  /** Replaces the whole page; needed when the layout changes. */
  rebuildPageContainer(container: RebuildPageContainer): Promise<boolean>
  /** Changes the text of one container in place, without flicker. */
  textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean>
  /** Sends the pixels of an image container. */
  updateImageRawData(data: ImageRawDataUpdate): Promise<ImageRawDataUpdateResult>
  /** Switches the microphone; audio then arrives as audioEvent frames. */
  audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>
  shutDownPageContainer(exitMode?: number): Promise<boolean>
  onEvenHubEvent(callback: (event: EvenHubEvent) => void): () => void
}

export interface AppOptions {
  bridge: GlassesBridge
  gateway: GatewayClient
  /** Shown on the glasses so a wrong build-time URL is visible at once. */
  gatewayUrl: string
  /** Diagnostic lines for the phone page. */
  log: (line: string) => void
  /**
   * Draws the selection marker (lit) or an empty image and returns it
   * encoded. Without it the selected row is marked in its text.
   */
  renderMarker?: (lit: boolean) => Promise<Uint8Array>
}

export interface App {
  start(): Promise<void>
  /** Resolves when no gateway call or bridge call is pending. */
  idle(): Promise<void>
}

// The app speaks English and its own strings stay ASCII: the firmware font
// drops glyphs it does not have, without any error.
const INBOX_HINT = 'Click = retry | Double click = exit'
const CHAT_HINT = 'Click = retry | Double click = back'

const ERROR_LABEL: Record<GatewayErrorKind, string> = {
  network: 'Network / CORS / whitelist',
  timeout: 'No answer',
  unauthorized: 'Token rejected (401)',
  http: 'Server error',
  invalid: 'Unexpected response',
}

type Box = 'unread' | 'unanswered' | 'all'

const HOME: Box = 'unread'
const BOX_TITLE: Record<Box, string> = { unread: 'Unread', unanswered: 'Unanswered', all: 'All chats' }
const BOX_FILTER: Record<Box, ChatFilter | undefined> = { unread: 'unread', unanswered: 'unanswered', all: undefined }
/** Rows after the chats of the home box; selecting one opens that box. */
const HOME_LINKS: readonly Box[] = ['unanswered', 'all']
const BOX_COUNT: Record<Box, keyof Counts> = { unread: 'unread', unanswered: 'unanswered', all: 'all' }

// 16 kHz, 16 bit, mono.
const BYTES_PER_SECOND = 32_000
/** Shorter recordings are an accidental hold. */
const MIN_RECORDING_BYTES = BYTES_PER_SECOND / 2
const MAX_RECORDING_MS = 60_000
const CONFIRM_HINT = 'Click = send | Double click = cancel'

/** A reply in progress inside a chat. */
type Reply =
  | { phase: 'recording'; chunks: Uint8Array[]; timer: ReturnType<typeof setTimeout> }
  /** The transcript is on the glasses, waiting for click (send) or double click (cancel). */
  | { phase: 'confirm'; text: string; display: string }
  /** A note is shown (nothing recorded, nothing understood, failure); any click returns to the chat. */
  | { phase: 'notice' }

type Screen =
  /** A chat list is shown; cursor is the selected row (chats.length and up = the home links). */
  /** total is the number of chats in the box; chats holds the ones loaded so far. */
  | { name: 'inbox'; box: Box; chats: Chat[]; total: number; cursor: number; links: string[] }
  /** A message is shown instead of the list: loading or failed. */
  | { name: 'inboxText'; box: Box }
  /**
   * messages are the ones loaded so far, oldest first, and pages is what they
   * fill; both are empty while the chat is loading or after a failure. more
   * says that the gateway may hold older messages.
   */
  | {
      name: 'chat'
      box: Box
      chat: Chat
      messages: Message[]
      more: boolean
      pages: BubbleBox[][]
      page: number
      reply?: Reply
    }

export function createApp(options: AppOptions): App {
  const { bridge, gateway, gatewayUrl, log, renderMarker } = options
  const pending = new Set<Promise<unknown>>()
  let screen: Screen = { name: 'inboxText', box: HOME }
  let loading: Promise<void> | null = null
  /** The chat to select when the inbox is shown again. */
  let selectedId: string | null = null

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise)
    const done = () => pending.delete(promise)
    promise.then(done, done)
    return promise
  }

  /** What the inbox layout shows now; null while another layout is on the glasses. */
  let inboxShown: { title: string; rows: Row[]; markers: boolean } | null = null
  /** False without a renderer, and once the glasses or the canvas failed to show a marker. */
  let markersOn = Boolean(renderMarker)
  /** Whether the marker beside each row is lit; a new page starts with all of them empty. */
  let markerLit: boolean[] = []
  /** The lit and the empty marker image, each drawn once. */
  const markerImages = new Map<boolean, Promise<number[]>>()
  /** Draw calls run one after another, so each sees what the previous one left on the glasses. */
  let drawing: Promise<void> = Promise.resolve()
  /** Number of the newest draw call. */
  let drawn = 0

  /**
   * Queues a draw of the whole screen. One that a newer call has replaced by
   * the time its turn comes is skipped: gestures can arrive faster than the
   * glasses draw, and only the last state matters.
   */
  function draw(work: () => Promise<void>): Promise<void> {
    drawn += 1
    const turn = drawn
    const run = () => (turn === drawn ? work() : Promise.resolve())
    drawing = drawing.then(run, run)
    return drawing
  }

  async function upgrade(update: TextContainerUpgrade): Promise<void> {
    const ok = await bridge.textContainerUpgrade(update)
    if (!ok) log('textContainerUpgrade failed')
  }

  function markerImage(lit: boolean): Promise<number[]> {
    let image = markerImages.get(lit)
    if (!image && renderMarker) {
      image = renderMarker(lit).then((bytes) => Array.from(bytes))
      markerImages.set(lit, image)
    }
    return image ?? Promise.reject(new Error('no marker renderer'))
  }

  /** Lights the marker of the selected row and clears the one that was lit. Images go one at a time. */
  async function drawMarkers(rows: readonly Row[]): Promise<void> {
    if (!markersOn) return
    // The selected row first, so the marker is on its new row as early as possible.
    const order = [...rows.keys()].sort((a, b) => Number(rows[b]?.selected) - Number(rows[a]?.selected))
    for (const index of order) {
      const lit = rows[index]?.selected === true
      if ((markerLit[index] ?? false) === lit) continue
      try {
        const imageData = await markerImage(lit)
        const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ ...markerSlot(index), imageData }))
        if (result !== ImageRawDataUpdateResult.success) throw new Error(`the glasses answered ${result}`)
        markerLit[index] = lit
      } catch (error) {
        // The selection must stay visible: from here on it is marked in the text.
        markersOn = false
        log(`markers off: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
  }

  /** Lays the inbox page out; image containers come back empty. */
  async function rebuildInbox(title: string, rows: readonly Row[]): Promise<void> {
    let ok = await bridge.rebuildPageContainer(inboxPage(title, rows, markersOn))
    if (!ok && markersOn) {
      markersOn = false
      log('markers off: the glasses refused a page with images')
      ok = await bridge.rebuildPageContainer(inboxPage(title, rows, false))
    }
    if (!ok) log('rebuildPageContainer failed')
    markerLit = []
  }

  /** Puts title and rows on the glasses, changing in place whatever the page on screen allows. */
  async function paintInbox(title: string, rows: Row[]): Promise<void> {
    const shown = inboxShown
    if (!shown || shown.markers !== markersOn || rowLayout(shown.rows) !== rowLayout(rows)) {
      await rebuildInbox(title, rows)
    } else {
      if (shown.title !== title) await upgrade(headUpdate(title))
      for (const [index, row] of rows.entries()) {
        const old = shown.rows[index]
        if (old?.text !== row.text || old.selected !== row.selected || old.note !== row.note) {
          await upgrade(rowUpdate(index, row, markersOn))
        }
      }
    }
    inboxShown = { title, rows, markers: markersOn }
  }

  /** Shows a title and rows in the inbox layout. */
  function showInbox(title: string, rows: readonly Row[]): Promise<void> {
    return draw(async () => {
      const next = rows.slice(0, INBOX_ROWS)
      await paintInbox(title, next)
      await drawMarkers(next)
      // The markers were given up while drawing: lay the page out for a marker in the text.
      if (inboxShown?.markers !== markersOn) await paintInbox(title, next)
    })
  }

  /** Shows a page with its own layout (a chat or a note). */
  function showPage(page: RebuildPageContainer): Promise<void> {
    return draw(async () => {
      inboxShown = null
      const ok = await bridge.rebuildPageContainer(page)
      if (!ok) log('rebuildPageContainer failed')
    })
  }

  /** Draws the current page of the open chat. */
  function showChat(): Promise<void> {
    if (screen.name !== 'chat') return Promise.resolve()
    const { chat, pages, page, more } = screen
    if (pages.length === 0) return showPage(notePage(chat.name, 'No messages'))
    // The plus says that scrolling up past the first page brings older messages.
    return showPage(chatPage(`${chat.name} ${page + 1}/${pages.length}${more ? '+' : ''}`, pages[page] ?? []))
  }

  /** Runs one gateway round trip at a time; a gesture during one is dropped. */
  function load(work: () => Promise<void>): Promise<void> {
    loading ??= track(
      work().finally(() => {
        loading = null
      }),
    )
    return loading
  }

  async function showFailure(error: unknown, hint: string): Promise<void> {
    const { label, detail } = describeError(error)
    log(`gateway error: ${label}: ${detail}`)
    if (screen.name === 'chat') {
      await showPage(notePage('Gateway unreachable', `${gatewayUrl}\n${label}: ${detail}\n\n${hint}`))
    } else {
      await showInbox('Messenger', noteRows(`Gateway unreachable\n${gatewayUrl}\n${label}: ${detail}\n${hint}`))
    }
  }

  function drawInbox(list: Extract<Screen, { name: 'inbox' }>): Promise<void> {
    const rows = inboxRows(list.chats, list.cursor, list.links)
    const title = `${BOX_TITLE[list.box]} (${list.total})`
    return showInbox(title, rows.length > 0 ? rows : noteRows('No chats here\nDouble click = back'))
  }

  /** Loads the next page of the open list, when the selection reached the last loaded chat. */
  function loadMore(): void {
    if (screen.name !== 'inbox' || loading || screen.chats.length >= screen.total) return
    const box = screen.box
    void load(async () => {
      if (screen.name !== 'inbox' || screen.box !== box) return
      try {
        const page = await gateway.chats(BOX_FILTER[box], screen.chats.length)
        if (screen.name !== 'inbox' || screen.box !== box) return
        // A chat can move between pages while the list is read; it is listed once.
        const known = new Set(screen.chats.map((chat) => chat.id))
        const fresh = page.filter((chat) => !known.has(chat.id))
        // Nothing new means the list ended earlier than the count said.
        const chats = [...screen.chats, ...fresh]
        screen = { ...screen, chats, total: fresh.length > 0 ? Math.max(screen.total, chats.length) : chats.length }
        log(`${box}: ${chats.length} of ${screen.total} chats loaded`)
        await drawInbox(screen)
      } catch (error) {
        log(`loading more chats failed: ${describeError(error).detail}`)
      }
    })
  }

  function openInbox(box: Box): Promise<void> {
    return load(async () => {
      try {
        // The counts give the real size of the box, for its title and for
        // knowing when the list ends. A gateway without that answer leaves
        // the title counting what is loaded.
        const [chats, counts] = await Promise.all([gateway.chats(BOX_FILTER[box]), gateway.counts().catch(() => null)])
        const links = box === HOME ? HOME_LINKS.map((link) => BOX_TITLE[link]) : []
        const total = Math.max(chats.length, counts ? counts[BOX_COUNT[box]] : 0)
        const cursor = Math.max(0, chats.findIndex((chat) => chat.id === selectedId))
        screen = { name: 'inbox', box, chats, total, cursor, links }
        await drawInbox(screen)
        log(`${box}: ${chats.length} chats`)
      } catch (error) {
        screen = { name: 'inboxText', box }
        await showFailure(error, box === HOME ? INBOX_HINT : CHAT_HINT)
      }
    })
  }

  function openChat(box: Box, chat: Chat): Promise<void> {
    return load(() => loadChat(box, chat))
  }

  async function loadChat(box: Box, chat: Chat): Promise<void> {
    screen = { name: 'chat', box, chat, messages: [], more: false, pages: [], page: 0 }
    try {
      const conversation = await gateway.messages(chat.id)
      const { messages } = conversation
      const pages = chatBubbles(messages)
      // A full answer may have left older messages behind. The last page holds the newest ones.
      const more = messages.length >= MESSAGE_LIMIT
      screen = { name: 'chat', box, chat: conversation.chat, messages, more, pages, page: Math.max(0, pages.length - 1) }
      await showChat()
      log(`chat: ${messages.length} messages, ${pages.length} pages`)
      if (conversation.chat.unread > 0) {
        // Read on the glasses: it leaves the Unread box. WhatsApp is not told.
        await gateway.markRead(chat.id).catch((error) => log(`mark read failed: ${describeError(error).detail}`))
      }
    } catch (error) {
      await showFailure(error, CHAT_HINT)
    }
  }

  /** Loads the messages before the oldest one loaded, when the selection scrolls up past the first page. */
  function loadOlder(): void {
    if (screen.name !== 'chat' || screen.reply || loading || !screen.more) return
    const chatId = screen.chat.id
    const oldest = screen.messages[0]
    if (!oldest) return
    void load(async () => {
      try {
        const { messages: older } = await gateway.messages(chatId, oldest)
        if (screen.name !== 'chat' || screen.chat.id !== chatId || screen.reply) return
        const known = new Set(screen.messages.map((message) => message.id))
        const fresh = older.filter((message) => !known.has(message.id))
        if (fresh.length === 0) {
          screen = { ...screen, more: false }
        } else {
          const messages = [...fresh, ...screen.messages]
          const pages = chatBubbles(messages)
          // Pages fill from the end, so the ones already read keep their content,
          // except that the first of them may have grown. Show that one if it
          // did, the page before it otherwise.
          const same = pages.length - screen.pages.length
          const grown = JSON.stringify(pages[same]) !== JSON.stringify(screen.pages[0])
          const page = Math.max(0, grown ? same : same - 1)
          screen = { ...screen, messages, pages, page, more: older.length >= MESSAGE_LIMIT }
        }
        await showChat()
        log(`chat: ${fresh.length} older messages, ${screen.pages.length} pages`)
      } catch (error) {
        log(`loading older messages failed: ${describeError(error).detail}`)
      }
    })
  }

  /** Scroll: moves the selection in a list, turns the page in a chat. No gateway call. */
  function move(step: number): void {
    if (screen.name === 'inbox') {
      const last = Math.max(0, screen.chats.length + screen.links.length - 1)
      const cursor = Math.max(0, Math.min(last, screen.cursor + step))
      if (cursor === screen.cursor) return
      screen = { ...screen, cursor }
      selectedId = screen.chats[cursor]?.id ?? null
      void track(drawInbox(screen))
      if (cursor >= screen.chats.length - 1) loadMore()
    } else if (screen.name === 'chat' && !screen.reply) {
      const page = Math.max(0, Math.min(screen.pages.length - 1, screen.page + step))
      if (page === screen.page) {
        if (step < 0) loadOlder()
        return
      }
      screen = { ...screen, page }
      void track(showChat())
    }
  }

  function onClick(): void {
    switch (screen.name) {
      case 'inbox': {
        const chat = screen.chats[screen.cursor]
        if (chat) {
          selectedId = chat.id
          void openChat(screen.box, chat)
        } else if (screen.box === HOME) {
          const link = HOME_LINKS[screen.cursor - screen.chats.length]
          if (link) void openInbox(link)
        }
        return
      }
      case 'inboxText':
        void openInbox(screen.box)
        return
      case 'chat':
        if (screen.reply?.phase === 'confirm') void sendReply(screen.reply)
        else if (screen.reply?.phase === 'notice') void closeReply()
        else if (!screen.reply) void openChat(screen.box, screen.chat)
        return
    }
  }

  /** Shows the page of the chat again and drops any reply in progress. */
  function closeReply(): Promise<void> {
    if (screen.name !== 'chat') return Promise.resolve()
    const { reply: _dropped, ...chat } = screen
    screen = chat
    return track(showChat())
  }

  function notice(title: string, detail = ''): Promise<void> {
    if (screen.name !== 'chat') return Promise.resolve()
    screen = { ...screen, reply: { phase: 'notice' } }
    return showPage(notePage(title, `${detail ? `${detail}\n\n` : ''}Hold = record again | Click = back`))
  }

  function startRecording(): void {
    if (screen.name !== 'chat' || loading) return
    if (screen.reply && screen.reply.phase !== 'notice') return
    const timer = setTimeout(stopRecording, MAX_RECORDING_MS)
    screen = { ...screen, reply: { phase: 'recording', chunks: [], timer } }
    void track(
      (async () => {
        const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
        if (!ok) log('audioControl(on) failed')
        const name = screen.name === 'chat' ? screen.chat.name : ''
        await showPage(notePage(`Recording for ${name}`, 'Speak now\n\nRelease = stop | Double click = cancel'))
      })(),
    )
  }

  /** Switches the microphone off and returns what was recorded. */
  async function endRecording(reply: Extract<Reply, { phase: 'recording' }>): Promise<Uint8Array> {
    clearTimeout(reply.timer)
    const ok = await bridge.audioControl(false)
    if (!ok) log('audioControl(off) failed')
    const pcm = new Uint8Array(reply.chunks.reduce((total, chunk) => total + chunk.length, 0))
    let offset = 0
    for (const chunk of reply.chunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    return pcm
  }

  function stopRecording(): void {
    if (screen.name !== 'chat' || screen.reply?.phase !== 'recording') return
    const reply = screen.reply
    const chatName = screen.chat.name
    void load(async () => {
      const pcm = await endRecording(reply)
      log(`recorded ${(pcm.length / BYTES_PER_SECOND).toFixed(1)} s`)
      if (pcm.length < MIN_RECORDING_BYTES) {
        await notice('Nothing recorded')
        return
      }
      await showPage(notePage(`Reply to ${chatName}`, 'Transcribing...'))
      try {
        const transcript = await gateway.transcribe(pcm)
        if (!transcript.text.trim()) {
          await notice('Nothing understood')
          return
        }
        log(`transcribed (${transcript.lang})`)
        if (screen.name !== 'chat') return
        screen = { ...screen, reply: { phase: 'confirm', text: transcript.text, display: transcript.display } }
        await showPage(notePage(`Reply to ${chatName}`, `${transcript.display}\n\n${CONFIRM_HINT}`))
      } catch (error) {
        const { label, detail } = describeError(error)
        log(`transcription error: ${label}: ${detail}`)
        await notice('Transcription failed', `${label}: ${detail}`)
      }
    })
  }

  function cancelRecording(): void {
    if (screen.name !== 'chat' || screen.reply?.phase !== 'recording') return
    const reply = screen.reply
    void track(endRecording(reply).then(() => closeReply()))
  }

  /** Sends a confirmed transcript. A second click while it is on its way does nothing. */
  function sendReply(reply: Extract<Reply, { phase: 'confirm' }>): Promise<void> {
    if (screen.name !== 'chat' || loading) return Promise.resolve()
    const { box, chat } = screen
    return load(async () => {
      await showPage(notePage(`Sending to ${chat.name}`, reply.display))
      try {
        await gateway.send(chat.id, reply.text)
        log('reply sent')
      } catch (error) {
        const { label, detail } = describeError(error)
        log(`send error: ${label}: ${detail}`)
        await showPage(
          notePage('Not sent', `${label}: ${detail}\n\n${reply.display}\n\nClick = try again | Double click = cancel`),
        )
        return
      }
      // Reload, so the sent message shows up.
      await loadChat(box, chat)
    })
  }

  function onDoubleClick(): void {
    if (screen.name === 'chat' && screen.reply) {
      if (screen.reply.phase === 'recording') cancelRecording()
      else void closeReply()
    } else if (screen.name === 'chat') {
      void openInbox(screen.box)
    } else if (screen.box !== HOME) {
      void openInbox(HOME)
    } else {
      // Mode 1 shows the system exit dialog, which the root page must use.
      void track(bridge.shutDownPageContainer(1)).catch((error) => log(`exit failed: ${String(error)}`))
    }
  }

  function onEvent(event: EvenHubEvent): void {
    if (event.audioEvent) {
      if (screen.name === 'chat' && screen.reply?.phase === 'recording') screen.reply.chunks.push(event.audioEvent.audioPcm)
      return
    }
    const gesture = gestureFromEvent(event)
    if (!gesture) {
      // Real hardware may send shapes the docs do not list; audio and IMU would flood the log.
      if (!isStream(event)) log(`unknown event: ${rawShape(event)}`)
      return
    }
    const source = sourceFromEvent(event)
    log(`gesture: ${source ? `${gesture} (${source})` : gesture}`)
    switch (gesture) {
      case 'click':
        onClick()
        break
      case 'scrollDown':
        move(1)
        break
      case 'scrollUp':
        move(-1)
        break
      case 'doubleClick':
        onDoubleClick()
        break
      case 'longPressStart':
        startRecording()
        break
      case 'longPressEnd':
        stopRecording()
        break
      case 'foregroundEnter':
        // A reply in progress stays on screen; a reload would discard it.
        if (screen.name === 'chat') {
          if (!screen.reply) void openChat(screen.box, screen.chat)
        } else void openInbox(screen.box)
        break
      default:
        break
    }
  }

  return {
    async start() {
      const rows = noteRows(`Loading chats...\n${gatewayUrl}`)
      let result = await bridge.createStartUpPageContainer(startupInbox('Messenger', rows, markersOn))
      if (result !== StartUpPageCreateResult.success && markersOn) {
        markersOn = false
        log('markers off: the glasses refused a start-up page with images')
        result = await bridge.createStartUpPageContainer(startupInbox('Messenger', rows, false))
      }
      if (result !== StartUpPageCreateResult.success) {
        log(`createStartUpPageContainer failed: ${StartUpPageCreateResult[result] ?? result}`)
        return
      }
      inboxShown = { title: 'Messenger', rows, markers: markersOn }
      bridge.onEvenHubEvent(onEvent)
      await openInbox(HOME)
    },

    async idle() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending])
      }
    },
  }
}

function isStream(event: EvenHubEvent): boolean {
  const sys = event.sysEvent
  return Boolean(event.audioEvent || sys?.imuData || sys?.eventType === OsEventTypeList.IMU_DATA_REPORT)
}

function rawShape(event: EvenHubEvent): string {
  return JSON.stringify(event.jsonData ?? event).slice(0, 160)
}

function describeError(error: unknown): { label: string; detail: string } {
  if (error instanceof GatewayError) return { label: ERROR_LABEL[error.kind], detail: error.message }
  return { label: 'Error', detail: error instanceof Error ? error.message : String(error) }
}
