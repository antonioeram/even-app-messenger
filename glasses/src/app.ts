// Stage 1 app: an inbox list of WhatsApp chats and a reading screen.
//
// Every screen is text in one container, updated in place.
// Inbox:  scroll moves the selection, click opens the chat, double click
//         asks to exit.
// Chat:   click reloads, double click goes back to the inbox.

import {
  OsEventTypeList,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { GatewayError, type Chat, type GatewayClient, type GatewayErrorKind } from './gateway'
import { gestureFromEvent, sourceFromEvent } from './gestures'
import { mainTextUpdate, MAX_UPGRADE_CHARS, startupPage } from './screen'
import { chatText, inboxText } from './views'

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

type Screen =
  /** The chat list is shown; cursor is the index of the selected chat. */
  | { name: 'inbox'; chats: Chat[]; cursor: number }
  /** A message is shown instead of the list: loading, empty or failed. */
  | { name: 'inboxText' }
  | { name: 'chat'; chat: Chat }

export function createApp(options: AppOptions): App {
  const { bridge, gateway, gatewayUrl, log } = options
  const pending = new Set<Promise<unknown>>()
  let screen: Screen = { name: 'inboxText' }
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

  function openInbox(): Promise<void> {
    return load(async () => {
      try {
        const chats = await gateway.chats()
        if (chats.length === 0) {
          screen = { name: 'inboxText' }
          await show(`No chats yet\nLink WhatsApp at\n${gatewayUrl}/admin\n\n${INBOX_HINT}`)
        } else {
          const cursor = Math.max(0, chats.findIndex((chat) => chat.id === selectedId))
          screen = { name: 'inbox', chats, cursor }
          await show(inboxText(chats, cursor))
        }
        log(`inbox: ${chats.length} chats`)
      } catch (error) {
        screen = { name: 'inboxText' }
        await showFailure(error, INBOX_HINT)
      }
    })
  }

  function openChat(chat: Chat): Promise<void> {
    return load(async () => {
      screen = { name: 'chat', chat }
      try {
        const conversation = await gateway.messages(chat.id)
        screen = { name: 'chat', chat: conversation.chat }
        await show(chatText(conversation.chat, conversation.messages, MAX_UPGRADE_CHARS))
        log(`chat: ${conversation.messages.length} messages`)
      } catch (error) {
        await showFailure(error, CHAT_HINT)
      }
    })
  }

  /** Moves the inbox selection; a redraw only, no gateway call. */
  function moveCursor(step: number): void {
    if (screen.name !== 'inbox') return
    const cursor = Math.max(0, Math.min(screen.chats.length - 1, screen.cursor + step))
    if (cursor === screen.cursor) return
    screen = { ...screen, cursor }
    selectedId = screen.chats[cursor]?.id ?? null
    void track(show(inboxText(screen.chats, cursor)))
  }

  function onClick(): void {
    switch (screen.name) {
      case 'inbox': {
        const chat = screen.chats[screen.cursor]
        if (chat) {
          selectedId = chat.id
          void openChat(chat)
        }
        return
      }
      case 'inboxText':
        void openInbox()
        return
      case 'chat':
        void openChat(screen.chat)
        return
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
        moveCursor(1)
        break
      case 'scrollUp':
        moveCursor(-1)
        break
      case 'doubleClick':
        if (screen.name === 'chat') {
          void openInbox()
        } else {
          // Mode 1 shows the system exit dialog, which the root page must use.
          void track(bridge.shutDownPageContainer(1)).catch((error) => log(`exit failed: ${String(error)}`))
        }
        break
      case 'foregroundEnter':
        if (screen.name === 'chat') void openChat(screen.chat)
        else void openInbox()
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
      await openInbox()
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
