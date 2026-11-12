// A small persistent log for the phone page.
//
// It shows what the app did and what happened to it while the phone was
// locked: lines survive a WebView restart, and late heartbeats show for how
// long JavaScript was paused.

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface DiagnosticsOptions {
  store: KeyValueStore
  now?: () => number
  maxLines?: number
  /** Expected interval between heartbeat() calls. */
  heartbeatMs?: number
  onChange?: (lines: readonly string[]) => void
}

export interface Diagnostics {
  log(line: string): void
  lines(): readonly string[]
  /** Call on a fixed timer; logs a line when the previous call is overdue. */
  heartbeat(): void
  /** Call once at boot; logs how long ago the previous run was last alive. */
  markColdStart(): void
}

const LOG_KEY = 'messenger.diag'
const HEARTBEAT_KEY = 'messenger.heartbeat'

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const { store } = options
  const now = options.now ?? Date.now
  const maxLines = options.maxLines ?? 60
  const heartbeatMs = options.heartbeatMs ?? 5000

  let lines = readLines(store)
  let lastBeat: number | null = null

  function write(key: string, value: string): void {
    try {
      store.setItem(key, value)
    } catch {
      // Storage full or unavailable: the log is best effort.
    }
  }

  function log(line: string): void {
    lines = [...lines, `${clockTime(now())} ${line}`].slice(-maxLines)
    write(LOG_KEY, JSON.stringify(lines))
    options.onChange?.(lines)
  }

  return {
    log,
    lines: () => lines,

    heartbeat() {
      const current = now()
      if (lastBeat !== null && current - lastBeat > heartbeatMs * 3) {
        log(`JavaScript paused ${seconds(current - lastBeat)} s`)
      }
      lastBeat = current
      write(HEARTBEAT_KEY, String(current))
    },

    markColdStart() {
      const previous = Number(readItem(store, HEARTBEAT_KEY))
      if (Number.isFinite(previous) && previous > 0) {
        log(`cold start; previous run was alive ${seconds(now() - previous)} s ago`)
      } else {
        log('first start')
      }
    },
  }
}

function readItem(store: KeyValueStore, key: string): string | null {
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

function readLines(store: KeyValueStore): string[] {
  try {
    const parsed: unknown = JSON.parse(readItem(store, LOG_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === 'string') : []
  } catch {
    return []
  }
}

function seconds(ms: number): number {
  return Math.round(ms / 1000)
}

function clockTime(ms: number): string {
  const date = new Date(ms)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}
