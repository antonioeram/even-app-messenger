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
import { GatewayError, type GatewayClient } from './gateway'
import { MAIN_CONTAINER, MAX_UPGRADE_CHARS } from './screen'

class FakeBridge implements GlassesBridge {
  created: string[] = []
  upgrades: string[] = []
  shutdowns: number[] = []
  createResult = StartUpPageCreateResult.success
  private listener: ((event: EvenHubEvent) => void) | null = null

  async createStartUpPageContainer(container: { textObject?: { content?: string; isEventCapture?: number; containerID?: number; containerName?: string }[] }) {
    const text = container.textObject?.[0]
    expect(text?.isEventCapture).toBe(1)
    expect(text?.containerID).toBe(MAIN_CONTAINER.id)
    expect(text?.containerName).toBe(MAIN_CONTAINER.name)
    this.created.push(text?.content ?? '')
    return this.createResult
  }

  async textContainerUpgrade(upgrade: { containerID?: number; containerName?: string; content?: string }) {
    expect(upgrade.containerID).toBe(MAIN_CONTAINER.id)
    expect(upgrade.containerName).toBe(MAIN_CONTAINER.name)
    this.upgrades.push(upgrade.content ?? '')
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

  get shown(): string {
    return this.upgrades.at(-1) ?? this.created.at(-1) ?? ''
  }
}

function gatewayReturning(...results: (string | GatewayError)[]): GatewayClient & { calls: number } {
  const client = {
    calls: 0,
    async hello() {
      const result = results[Math.min(client.calls, results.length - 1)]
      client.calls += 1
      if (result instanceof GatewayError) throw result
      return { text: result ?? '', time: '2026-11-12T09:41:07Z' }
    },
  }
  return client
}

const click: EvenHubEvent = { textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT }) }
const doubleClick: EvenHubEvent = {
  textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }),
}
const foregroundEnter: EvenHubEvent = {
  sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }),
}

function setup(gateway: GatewayClient) {
  const bridge = new FakeBridge()
  const logs: string[] = []
  const app = createApp({ bridge, gateway, gatewayUrl: 'https://gw.example', log: (line) => logs.push(line) })
  return { bridge, app, logs }
}

describe('glasses app', () => {
  it('creates the start-up page before it calls the gateway', async () => {
    const gateway = gatewayReturning('Salut de la gateway!')
    const { bridge, app } = setup(gateway)

    await app.start()

    expect(bridge.created).toHaveLength(1)
    expect(bridge.created[0]).toContain('Connecting')
    expect(bridge.created[0]).toContain('gw.example')
  })

  it('shows the gateway text on the glasses', async () => {
    const { bridge, app } = setup(gatewayReturning('Salut de la gateway!\nOra: 09:41:07'))

    await app.start()

    expect(bridge.shown).toContain('Salut de la gateway!\nOra: 09:41:07')
  })

  it('shows the reason on the glasses when the gateway call fails', async () => {
    const { bridge, app } = setup(gatewayReturning(new GatewayError('network', 'Failed to fetch')))

    await app.start()

    expect(bridge.shown).toContain('Gateway unreachable')
    expect(bridge.shown).toContain('Failed to fetch')
    expect(bridge.shown).toContain('gw.example')
  })

  it('stops with a log line when the start-up page cannot be created', async () => {
    const gateway = gatewayReturning('never shown')
    const { bridge, app, logs } = setup(gateway)
    bridge.createResult = StartUpPageCreateResult.invalid

    await app.start()

    expect(gateway.calls).toBe(0)
    expect(logs.join('\n')).toContain('createStartUpPageContainer')
  })

  it('reloads the text on click', async () => {
    const gateway = gatewayReturning('first', 'second')
    const { bridge, app } = setup(gateway)
    await app.start()

    bridge.emit(click)
    await app.idle()

    expect(gateway.calls).toBe(2)
    expect(bridge.shown).toContain('second')
  })

  it('recovers on click after a failed call', async () => {
    const gateway = gatewayReturning(new GatewayError('timeout', 'no answer'), 'back online')
    const { bridge, app } = setup(gateway)
    await app.start()

    bridge.emit(click)
    await app.idle()

    expect(bridge.shown).toContain('back online')
  })

  it('reloads the text when the app returns to the foreground', async () => {
    const gateway = gatewayReturning('first', 'second')
    const { bridge, app } = setup(gateway)
    await app.start()

    bridge.emit(foregroundEnter)
    await app.idle()

    expect(bridge.shown).toContain('second')
  })

  it('asks for the system exit dialog on double click', async () => {
    const { bridge, app } = setup(gatewayReturning('Salut'))
    await app.start()

    bridge.emit(doubleClick)
    await app.idle()

    expect(bridge.shutdowns).toEqual([1])
  })

  it('does not start a second request while one is in flight', async () => {
    let release: (value: { text: string; time: string }) => void = () => {}
    const gateway = {
      calls: 0,
      hello() {
        gateway.calls += 1
        return new Promise<{ text: string; time: string }>((resolve) => {
          release = resolve
        })
      },
    }
    const { bridge, app } = setup(gateway)
    const started = app.start()
    await vi.waitFor(() => expect(gateway.calls).toBe(1))

    bridge.emit(click)
    bridge.emit(click)
    release({ text: 'done', time: '' })
    await started
    await app.idle()

    expect(gateway.calls).toBe(1)
  })

  it('logs each gesture so its arrival can be read on the phone', async () => {
    const { bridge, app, logs } = setup(gatewayReturning('Salut'))
    await app.start()

    bridge.emit(click)
    await app.idle()

    expect(logs).toContain('gesture: click')
  })

  it('logs where a gesture came from, so ring input can be told from the temples', async () => {
    const { bridge, app, logs } = setup(gatewayReturning('Salut'))
    await app.start()

    bridge.emit({ sysEvent: new Sys_ItemEvent({ eventSource: EventSourceType.TOUCH_EVENT_FROM_RING }) })
    await app.idle()

    expect(logs).toContain('gesture: click (ring)')
  })

  it('shows the last input and its source on the glasses', async () => {
    const { bridge, app } = setup(gatewayReturning('Salut'))
    await app.start()
    expect(bridge.shown).not.toContain('Input:')

    bridge.emit({ sysEvent: new Sys_ItemEvent({ eventSource: EventSourceType.TOUCH_EVENT_FROM_RING }) })
    await app.idle()

    expect(bridge.shown).toContain('Input: click (ring)')
  })

  it('logs the raw shape of an event it does not recognise', async () => {
    const { bridge, app, logs } = setup(gatewayReturning('Salut'))
    await app.start()

    bridge.emit({ jsonData: { eventType: 99, somethingNew: true } })

    expect(logs.join('\n')).toContain('unknown event: {"eventType":99,"somethingNew":true}')
  })

  it('does not log audio frames', async () => {
    const { bridge, app, logs } = setup(gatewayReturning('Salut'))
    await app.start()
    const before = logs.length

    bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(4) }) })

    expect(logs).toHaveLength(before)
  })

  it('shows only ASCII text of its own on the glasses', async () => {
    const { bridge, app } = setup(gatewayReturning(new GatewayError('timeout', 'no answer in 8 s')))

    await app.start()

    expect([...bridge.created, ...bridge.upgrades].join('')).toMatch(/^[\x00-\x7F]*$/)
  })

  it('never sends more text than textContainerUpgrade accepts', async () => {
    const { bridge, app } = setup(gatewayReturning('x'.repeat(5000)))

    await app.start()

    expect(bridge.shown.length).toBeLessThanOrEqual(MAX_UPGRADE_CHARS)
  })
})
