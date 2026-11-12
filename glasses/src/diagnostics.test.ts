import { describe, expect, it } from 'vitest'
import { createDiagnostics, type KeyValueStore } from './diagnostics'

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

function clock(start: number) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

const T0 = Date.UTC(2026, 10, 12, 9, 0, 0)

describe('diagnostics', () => {
  it('keeps log lines with a time prefix, newest last', () => {
    const time = clock(T0)
    const diag = createDiagnostics({ store: memoryStore(), now: time.now })

    diag.log('boot')
    time.advance(1000)
    diag.log('gateway ok')

    expect(diag.lines()).toHaveLength(2)
    expect(diag.lines()[0]).toMatch(/^\d{2}:\d{2}:\d{2} boot$/)
    expect(diag.lines()[1]).toMatch(/gateway ok$/)
  })

  it('restores earlier lines from storage after a cold start', () => {
    const store = memoryStore()
    createDiagnostics({ store, now: () => T0 }).log('before suspend')

    const restarted = createDiagnostics({ store, now: () => T0 + 60_000 })

    expect(restarted.lines().join('\n')).toContain('before suspend')
  })

  it('caps the stored log', () => {
    const diag = createDiagnostics({ store: memoryStore(), now: () => T0, maxLines: 3 })

    for (const line of ['a', 'b', 'c', 'd']) diag.log(line)

    expect(diag.lines().map((line) => line.slice(-1))).toEqual(['b', 'c', 'd'])
  })

  it('survives corrupt stored data', () => {
    const store = memoryStore({ 'messenger.diag': '{not json' })

    const diag = createDiagnostics({ store, now: () => T0 })

    expect(diag.lines()).toEqual([])
  })

  it('logs nothing for heartbeats that arrive on time', () => {
    const time = clock(T0)
    const diag = createDiagnostics({ store: memoryStore(), now: time.now, heartbeatMs: 5000 })

    diag.heartbeat()
    time.advance(5000)
    diag.heartbeat()

    expect(diag.lines()).toEqual([])
  })

  it('logs how long JavaScript was paused when a heartbeat is late', () => {
    const time = clock(T0)
    const diag = createDiagnostics({ store: memoryStore(), now: time.now, heartbeatMs: 5000 })

    diag.heartbeat()
    time.advance(5 * 60_000)
    diag.heartbeat()

    expect(diag.lines().join('\n')).toContain('JavaScript paused 300 s')
  })

  it('reports the gap since the last heartbeat of the previous run after a cold start', () => {
    const store = memoryStore()
    const first = createDiagnostics({ store, now: () => T0, heartbeatMs: 5000 })
    first.heartbeat()

    const restarted = createDiagnostics({ store, now: () => T0 + 120_000, heartbeatMs: 5000 })
    restarted.markColdStart()

    expect(restarted.lines().join('\n')).toContain('cold start; previous run was alive 120 s ago')
  })
})
