// Stage 1 app: an inbox list of WhatsApp chats and a reading screen.
//
// Every screen is text in one container, updated in place.
// Unread:     the home box, chats with unread messages. Scroll moves the
//             selection, click opens, double click asks to exit. Its last
//             two rows open the other boxes.
// Unanswered: read chats waiting for my reply; double click goes home.
// All chats:  every chat; double click goes home.
// Chat:       scroll turns pages (older / newer), click reloads, double
//             click goes back to the box it was opened from. Holding the
//             touchpad records a reply; releasing it transcribes; the text
//             is sent only after a click.

import {
  AudioInputSource,
  OsEventTypeList,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { GatewayError, type Chat, type ChatFilter, type GatewayClient, type GatewayErrorKind } from './gateway'
import { gestureFromEvent, sourceFromEvent } from './gestures'
import { mainTextUpdate, startupPage } from './screen'
import { chatPages, inboxText } from './views'

/** The part of EvenAppBridge the app uses; tests supply a fake. */
export interface GlassesBridge {
  createStartUpPageContainer(container: CreateStartUpPageContainer): Promise<StartUpPageCreateResult>
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
  | { name: 'chat'; box: Box; chat: Chat; pages: string[]; page: number; reply?: Reply }

export function createApp(options: AppOptions): App {
  const { bridge, gateway, gatewayUrl, log } = options
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

  async function show(text: string): Promise<void> {
    const ok = await bridge.textContainerUpgrade(mainTextUpdate(text))
    if (!ok) log('textContainerUpgrade failed')
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
    await show(`Gateway unreachable\n${gatewayUrl}\n${label}: ${detail}\n\n${hint}`)
  }

  function drawInbox(box: Box, chats: Chat[], cursor: number): Promise<void> {
    return show(inboxText(BOX_TITLE[box], chats, cursor, box === HOME ? HOME_ROWS : []))
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
        const pages = chatPages(conversation.chat, conversation.messages)
        screen = { name: 'chat', box, chat: conversation.chat, pages, page: 0 }
        await show(pages[0] ?? '')
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
      void track(show(screen.pages[page] ?? ''))
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
    return track(show(screen.pages[screen.page] ?? ''))
  }

  function notice(text: string): Promise<void> {
    if (screen.name !== 'chat') return Promise.resolve()
    screen = { ...screen, reply: { phase: 'notice' } }
    return show(`${text}\n\nHold = record again | Click = back`)
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
        await show(`Recording for ${screen.name === 'chat' ? screen.chat.name : ''}...\n\nRelease = stop | Double click = cancel`)
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
      await show('Transcribing...')
      try {
        const transcript = await gateway.transcribe(pcm)
        if (!transcript.text.trim()) {
          await notice('Nothing understood')
          return
        }
        log(`transcribed (${transcript.lang})`)
        if (screen.name !== 'chat') return
        screen = { ...screen, reply: { phase: 'confirm', text: transcript.text, display: transcript.display } }
        await show(`Reply to ${chatName}:\n${transcript.display}\n\n${CONFIRM_HINT}`)
      } catch (error) {
        const { label, detail } = describeError(error)
        log(`transcription error: ${label}: ${detail}`)
        await notice(`Transcription failed\n${label}: ${detail}`)
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
      await show(`Sending to ${chat.name}...\n${reply.display}`)
      try {
        await gateway.send(chat.id, reply.text)
        log('reply sent')
      } catch (error) {
        const { label, detail } = describeError(error)
        log(`send error: ${label}: ${detail}`)
        await show(`Not sent\n${label}: ${detail}\n\n${reply.display}\n\nClick = try again | Double click = cancel`)
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
      const result = await bridge.createStartUpPageContainer(startupPage(`Messenger\nLoading chats...\n${gatewayUrl}`))
      if (result !== StartUpPageCreateResult.success) {
        log(`createStartUpPageContainer failed: ${StartUpPageCreateResult[result] ?? result}`)
        return
      }
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
