// Stage 1 app: an inbox list of WhatsApp chats and a reading screen.
//
// The lists are a title and four bordered boxes whose texts change in place;
// a chat is a title and message bubbles, theirs left and mine right.
// Unread:     the home box, chats with unread messages. Scroll moves the
//             selection, click opens, double click asks to exit. Its last
//             two rows open the other boxes.
// Unanswered: read chats waiting for my reply; double click goes home.
// All chats:  every chat; double click goes home.
// Chat:       opens on the newest page; scroll turns pages, click reloads, double
//             click goes back to the box it was opened from. Holding the
//             touchpad records a reply; releasing it transcribes; the text
//             is sent only after a click.

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
import { GatewayError, type Chat, type ChatFilter, type GatewayClient, type GatewayErrorKind } from './gateway'
import { gestureFromEvent, sourceFromEvent } from './gestures'
import {
  avatarSlot,
  chatPage,
  headUpdate,
  inboxPage,
  INBOX_ROWS,
  notePage,
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
  /** Sends the pixels of an image container. */
  updateImageRawData(data: ImageRawDataUpdate): Promise<ImageRawDataUpdateResult>
  /** Changes the text of one container in place, without flicker. */
  textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean>
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
   * Draws a round avatar with the given initials and returns it as an encoded
   * image; an empty string asks for a blank one. Without it the lists have no
   * avatars.
   */
  renderAvatar?: (initials: string) => Promise<Uint8Array>
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
const HOME_ROWS = HOME_LINKS.map((box) => `[${BOX_TITLE[box]}]`)

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
  | { name: 'inbox'; box: Box; chats: Chat[]; cursor: number }
  /** A message is shown instead of the list: loading or failed. */
  | { name: 'inboxText'; box: Box }
  /** pages is empty while the chat is loading or after a failure. */
  | { name: 'chat'; box: Box; chat: Chat; pages: BubbleBox[][]; page: number; reply?: Reply }

export function createApp(options: AppOptions): App {
  const { bridge, gateway, gatewayUrl, log, renderAvatar } = options
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

  const BLANK: Row = { text: '', selected: false, avatar: '' }
  /** False without a renderer, and after the glasses refused a page with image containers. */
  let avatarsOn = Boolean(renderAvatar)
  /** The initials each avatar slot shows on the current inbox page. */
  let avatarShown: string[] = []

  /** Sends the avatars that differ from what the slots show. Images go one at a time. */
  async function drawAvatars(rows: readonly Row[]): Promise<void> {
    if (!avatarsOn || !renderAvatar) return
    for (const [index, row] of rows.entries()) {
      if ((avatarShown[index] ?? '') === row.avatar) continue
      // Recorded before sending: a failed image is not retried on every redraw.
      avatarShown[index] = row.avatar
      try {
        const imageData = Array.from(await renderAvatar(row.avatar))
        const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ ...avatarSlot(index), imageData }))
        if (result !== ImageRawDataUpdateResult.success) log(`avatar not shown: ${result}`)
      } catch (error) {
        log(`avatar not shown: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  /** What the inbox layout shows now; null while another layout is on the glasses. */
  let inboxShown: { title: string; rows: Row[] } | null = null
  /** Draw calls run one after another, so each sees what the previous one left on the glasses. */
  let drawing: Promise<void> = Promise.resolve()

  function draw(work: () => Promise<void>): Promise<void> {
    drawing = drawing.then(work, work)
    return drawing
  }

  async function upgrade(update: TextContainerUpgrade): Promise<void> {
    const ok = await bridge.textContainerUpgrade(update)
    if (!ok) log('textContainerUpgrade failed')
  }

  /** Shows a title and rows in the inbox layout, changing only the boxes that differ. */
  function showInbox(title: string, rows: readonly Row[]): Promise<void> {
    return draw(async () => {
      const next = Array.from({ length: INBOX_ROWS }, (_, index) => rows[index] ?? BLANK)
      if (!inboxShown) {
        let ok = await bridge.rebuildPageContainer(inboxPage(title, next, avatarsOn))
        if (!ok && avatarsOn) {
          avatarsOn = false
          log('avatars off: the glasses refused a page with images')
          ok = await bridge.rebuildPageContainer(inboxPage(title, next, false))
        }
        if (!ok) log('rebuildPageContainer failed')
        avatarShown = []
      } else {
        if (inboxShown.title !== title) await upgrade(headUpdate(title))
        for (const [index, row] of next.entries()) {
          const shown = inboxShown.rows[index]
          if (shown?.text !== row.text || shown.selected !== row.selected) await upgrade(rowUpdate(index, row))
        }
      }
      inboxShown = { title, rows: next }
      await drawAvatars(next)
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
    const { chat, pages, page } = screen
    if (pages.length === 0) return showPage(notePage(chat.name, 'No messages'))
    return showPage(chatPage(`${chat.name} ${page + 1}/${pages.length}`, pages[page] ?? []))
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

  function drawInbox(box: Box, chats: Chat[], cursor: number): Promise<void> {
    return showInbox(`${BOX_TITLE[box]} (${chats.length})`, inboxRows(chats, cursor, box === HOME ? HOME_ROWS : []))
  }

  function openInbox(box: Box): Promise<void> {
    return load(async () => {
      try {
        const chats = await gateway.chats(BOX_FILTER[box])
        const cursor = Math.max(0, chats.findIndex((chat) => chat.id === selectedId))
        screen = { name: 'inbox', box, chats, cursor }
        await drawInbox(box, chats, cursor)
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
    {
      screen = { name: 'chat', box, chat, pages: [], page: 0 }
      try {
        const conversation = await gateway.messages(chat.id)
        const pages = chatBubbles(conversation.chat, conversation.messages)
        // The last page holds the newest messages.
        screen = { name: 'chat', box, chat: conversation.chat, pages, page: Math.max(0, pages.length - 1) }
        await showChat()
        log(`chat: ${conversation.messages.length} messages, ${pages.length} pages`)
        if (conversation.chat.unread > 0) {
          // Read on the glasses: it leaves the Unread box. WhatsApp is not told.
          await gateway.markRead(chat.id).catch((error) => log(`mark read failed: ${describeError(error).detail}`))
        }
      } catch (error) {
        await showFailure(error, CHAT_HINT)
      }
    }
  }

  /** Scroll: moves the selection in a list, turns the page in a chat. No gateway call. */
  function move(step: number): void {
    if (screen.name === 'inbox') {
      const last = screen.chats.length - 1 + (screen.box === HOME ? HOME_LINKS.length : 0)
      const cursor = Math.max(0, Math.min(last, screen.cursor + step))
      if (cursor === screen.cursor) return
      screen = { ...screen, cursor }
      selectedId = screen.chats[cursor]?.id ?? null
      void track(drawInbox(screen.box, screen.chats, cursor))
    } else if (screen.name === 'chat' && !screen.reply) {
      const page = Math.max(0, Math.min(screen.pages.length - 1, screen.page + step))
      if (page === screen.page) return
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
      let result = await bridge.createStartUpPageContainer(startupInbox('Messenger', rows, avatarsOn))
      if (result !== StartUpPageCreateResult.success && avatarsOn) {
        avatarsOn = false
        log('avatars off: the glasses refused a start-up page with images')
        result = await bridge.createStartUpPageContainer(startupInbox('Messenger', rows, false))
      }
      if (result !== StartUpPageCreateResult.success) {
        log(`createStartUpPageContainer failed: ${StartUpPageCreateResult[result] ?? result}`)
        return
      }
      inboxShown = { title: 'Messenger', rows: Array.from({ length: INBOX_ROWS }, (_, index) => rows[index] ?? BLANK) }
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
