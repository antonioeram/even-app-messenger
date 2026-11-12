// Stage 1 app: an inbox list of WhatsApp chats and a reading screen.
//
// Every screen is text in one container, updated in place.
// Unanswered: the home box, chats waiting for my reply. Scroll moves the
//             selection, click opens, double click asks to exit. Its last
//             row opens the box with all chats.
// All chats:  the same list without the filter; double click goes back.
// Chat:       scroll turns pages (older / newer), click reloads, double
//             click goes back to the box it was opened from.

import {
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

type Box = 'unanswered' | 'all'

const BOX_TITLE: Record<Box, string> = { unanswered: 'Unanswered', all: 'All chats' }
const BOX_FILTER: Record<Box, ChatFilter | undefined> = { unanswered: 'unanswered', all: undefined }
/** Last row of the unanswered box; selecting it opens all chats. */
const ALL_CHATS_ROW = '[All chats]'

type Screen =
  /** A chat list is shown; cursor is the selected row (chats.length = the extra row). */
  | { name: 'inbox'; box: Box; chats: Chat[]; cursor: number }
  /** A message is shown instead of the list: loading or failed. */
  | { name: 'inboxText'; box: Box }
  /** pages is empty while the chat is loading or after a failure. */
  | { name: 'chat'; box: Box; chat: Chat; pages: string[]; page: number }

export function createApp(options: AppOptions): App {
  const { bridge, gateway, gatewayUrl, log } = options
  const pending = new Set<Promise<unknown>>()
  let screen: Screen = { name: 'inboxText', box: 'unanswered' }
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
    return show(inboxText(BOX_TITLE[box], chats, cursor, box === 'unanswered' ? ALL_CHATS_ROW : undefined))
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
        await showFailure(error, box === 'unanswered' ? INBOX_HINT : CHAT_HINT)
      }
    })
  }

  function openChat(box: Box, chat: Chat): Promise<void> {
    return load(async () => {
      screen = { name: 'chat', box, chat, pages: [], page: 0 }
      try {
        const conversation = await gateway.messages(chat.id)
        const pages = chatPages(conversation.chat, conversation.messages)
        screen = { name: 'chat', box, chat: conversation.chat, pages, page: 0 }
        await show(pages[0] ?? '')
        log(`chat: ${conversation.messages.length} messages, ${pages.length} pages`)
      } catch (error) {
        await showFailure(error, CHAT_HINT)
      }
    })
  }

  /** Scroll: moves the selection in a list, turns the page in a chat. No gateway call. */
  function move(step: number): void {
    if (screen.name === 'inbox') {
      const last = screen.chats.length - (screen.box === 'unanswered' ? 0 : 1)
      const cursor = Math.max(0, Math.min(last, screen.cursor + step))
      if (cursor === screen.cursor) return
      screen = { ...screen, cursor }
      selectedId = screen.chats[cursor]?.id ?? null
      void track(drawInbox(screen.box, screen.chats, cursor))
    } else if (screen.name === 'chat') {
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
        } else if (screen.box === 'unanswered') {
          void openInbox('all')
        }
        return
      }
      case 'inboxText':
        void openInbox(screen.box)
        return
      case 'chat':
        void openChat(screen.box, screen.chat)
        return
    }
  }

  function onDoubleClick(): void {
    if (screen.name === 'chat') {
      void openInbox(screen.box)
    } else if (screen.box === 'all') {
      void openInbox('unanswered')
    } else {
      // Mode 1 shows the system exit dialog, which the root page must use.
      void track(bridge.shutDownPageContainer(1)).catch((error) => log(`exit failed: ${String(error)}`))
    }
  }

  function onEvent(event: EvenHubEvent): void {
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
      case 'foregroundEnter':
        if (screen.name === 'chat') void openChat(screen.box, screen.chat)
        else void openInbox(screen.box)
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
      await openInbox('unanswered')
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
