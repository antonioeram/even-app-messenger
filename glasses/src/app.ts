// Stage 0 app: shows a text fetched from the gateway on the glasses.

import {
  OsEventTypeList,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { GatewayError, type GatewayClient, type GatewayErrorKind } from './gateway'
import { gestureFromEvent } from './gestures'
import { mainTextUpdate, startupPage } from './screen'

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
const HINT = 'Click = reload | Double click = exit'

const ERROR_LABEL: Record<GatewayErrorKind, string> = {
  network: 'Network / CORS / whitelist',
  timeout: 'No answer',
  unauthorized: 'Token rejected (401)',
  http: 'Server error',
  invalid: 'Unexpected response',
}

export function createApp(options: AppOptions): App {
  const { bridge, gateway, gatewayUrl, log } = options
  const pending = new Set<Promise<unknown>>()
  let refreshing: Promise<void> | null = null

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

  function refresh(): Promise<void> {
    refreshing ??= track(
      (async () => {
        try {
          const hello = await gateway.hello()
          await show(`${hello.text}\n\n${HINT}`)
          log('gateway ok')
        } catch (error) {
          const { label, detail } = describeError(error)
          await show(`Gateway unreachable\n${gatewayUrl}\n${label}: ${detail}\n\n${HINT}`)
          log(`gateway error: ${label}: ${detail}`)
        } finally {
          refreshing = null
        }
      })(),
    )
    return refreshing
  }

  function onEvent(event: EvenHubEvent): void {
    const gesture = gestureFromEvent(event)
    if (!gesture) {
      // Stage 0 needs to learn what real hardware sends; audio and IMU would flood the log.
      if (!isStream(event)) log(`unknown event: ${rawShape(event)}`)
      return
    }
    log(`gesture: ${gesture}`)
    switch (gesture) {
      case 'click':
      case 'foregroundEnter':
        void refresh()
        break
      case 'doubleClick':
        // Mode 1 shows the system exit dialog, which the root page must use.
        void track(bridge.shutDownPageContainer(1)).catch((error) => log(`exit failed: ${String(error)}`))
        break
      default:
        break
    }
  }

  return {
    async start() {
      const result = await bridge.createStartUpPageContainer(
        startupPage(`Messenger\nConnecting to gateway...\n${gatewayUrl}`),
      )
      if (result !== StartUpPageCreateResult.success) {
        log(`createStartUpPageContainer failed: ${StartUpPageCreateResult[result] ?? result}`)
        return
      }
      bridge.onEvenHubEvent(onEvent)
      await refresh()
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
