// Stage 1 app: an inbox list of WhatsApp chats and a reading screen.
//
// Inbox:  scroll moves the selection (done by the firmware), click opens the
//         chat, double click asks to exit.
// Chat:   click reloads, double click goes back to the inbox.

import {
  OsEventTypeList,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { GatewayError, type Chat, type GatewayClient, type GatewayErrorKind } from './gateway'
import { gestureFromEvent, sourceFromEvent } from './gestures'
import { listPage, MAX_CREATE_CHARS, startupPage, textPage } from './screen'
import { chatText, inboxItems } from './views'

/** The part of EvenAppBridge the app uses; tests supply a fake. */
export interface GlassesBridge {
  createStartUpPageContainer(container: CreateStartUpPageContainer): Promise<StartUpPageCreateResult>
  rebuildPageContainer(container: RebuildPageContainer): Promise<boolean>
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
  /** The list is on the glasses; chats are its items, in order. */
  | { name: 'inbox'; chats: Chat[] }
  /** A text is shown instead of the list: loading, empty or failed. */
  | { name: 'inboxText' }
  | { name: 'chat'; chat: Chat }

export function createApp(options: AppOptions): App {
  const { bridge, gateway, gatewayUrl, log } = options
  const pending = new Set<Promise<unknown>>()
  let screen: Screen = { name: 'inboxText' }
  let loading: Promise<void> | null = null

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise)
    const done = () => pending.delete(promise)
    promise.then(done, done)
    return promise
  }

  async function show(page: RebuildPageContainer): Promise<void> {
    const ok = await bridge.rebuildPageContainer(page)
    if (!ok) log('rebuildPageContainer failed')
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
    await show(textPage(`Gateway unreachable\n${gatewayUrl}\n${label}: ${detail}\n\n${hint}`))
  }

  function openInbox(): Promise<void> {
    return load(async () => {
      try {
        const chats = await gateway.chats()
        if (chats.length === 0) {
          screen = { name: 'inboxText' }
          await show(textPage(`No chats yet\nLink WhatsApp at\n${gatewayUrl}/admin\n\n${INBOX_HINT}`))
        } else {
          screen = { name: 'inbox', chats }
          await show(listPage(inboxItems(chats)))
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
        await show(textPage(chatText(conversation.chat, conversation.messages, MAX_CREATE_CHARS)))
        log(`chat: ${conversation.messages.length} messages`)
      } catch (error) {
        await showFailure(error, CHAT_HINT)
      }
    })
  }

  /** The chat a list event points at; the host drops zero values, so no index means the first item. */
  function selectedChat(chats: Chat[], event: EvenHubEvent): Chat | undefined {
    const list = event.listEvent
    if (!list) return undefined
    if (list.currentSelectItemIndex !== undefined) {
      const chat = chats[list.currentSelectItemIndex]
      if (!chat) log(`no chat at index ${list.currentSelectItemIndex}`)
      return chat
    }
    if (list.currentSelectItemName) {
      const index = inboxItems(chats).indexOf(list.currentSelectItemName)
      if (index >= 0) return chats[index]
    }
    return chats[0]
  }

  function onClick(event: EvenHubEvent): void {
    switch (screen.name) {
      case 'inbox': {
        if (!event.listEvent) {
          log('click without a list selection')
          return
        }
        const chat = selectedChat(screen.chats, event)
        if (chat) void openChat(chat)
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
        onClick(event)
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
