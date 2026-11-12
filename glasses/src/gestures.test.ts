import { describe, expect, it } from 'vitest'
import {
  AudioEvent,
  EventSourceType,
  IMU_Report_Data,
  List_ItemEvent,
  OsEventTypeList,
  Sys_ItemEvent,
  Text_ItemEvent,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { gestureFromEvent, sourceFromEvent } from './gestures'

const text = (eventType?: OsEventTypeList): EvenHubEvent => ({ textEvent: new Text_ItemEvent({ eventType }) })
const list = (eventType?: OsEventTypeList): EvenHubEvent => ({ listEvent: new List_ItemEvent({ eventType }) })
const sys = (eventType?: OsEventTypeList): EvenHubEvent => ({ sysEvent: new Sys_ItemEvent({ eventType }) })

describe('gestureFromEvent', () => {
  it('maps a text-container click to click', () => {
    expect(gestureFromEvent(text(OsEventTypeList.CLICK_EVENT))).toBe('click')
  })

  it('treats a text event without eventType as click', () => {
    // The SDK drops eventType 0 in some cases, so a bare text event is a click.
    expect(gestureFromEvent(text())).toBe('click')
  })

  it('maps a double click', () => {
    expect(gestureFromEvent(text(OsEventTypeList.DOUBLE_CLICK_EVENT))).toBe('doubleClick')
  })

  it('maps scroll events', () => {
    expect(gestureFromEvent(text(OsEventTypeList.SCROLL_TOP_EVENT))).toBe('scrollUp')
    expect(gestureFromEvent(text(OsEventTypeList.SCROLL_BOTTOM_EVENT))).toBe('scrollDown')
  })

  it('reads gestures that arrive as list events', () => {
    expect(gestureFromEvent(list(OsEventTypeList.DOUBLE_CLICK_EVENT))).toBe('doubleClick')
  })

  it('maps long press start and release from system events', () => {
    expect(gestureFromEvent(sys(OsEventTypeList.LONG_PRESS_EVENT))).toBe('longPressStart')
    expect(gestureFromEvent(sys(OsEventTypeList.LONG_PRESS_RELEASE_EVENT))).toBe('longPressEnd')
  })

  it('maps foreground enter and exit from system events', () => {
    expect(gestureFromEvent(sys(OsEventTypeList.FOREGROUND_ENTER_EVENT))).toBe('foregroundEnter')
    expect(gestureFromEvent(sys(OsEventTypeList.FOREGROUND_EXIT_EVENT))).toBe('foregroundExit')
  })

  it('maps a system-level double click', () => {
    expect(gestureFromEvent(sys(OsEventTypeList.DOUBLE_CLICK_EVENT))).toBe('doubleClick')
  })

  it('ignores audio, IMU and empty events', () => {
    const audio: EvenHubEvent = { audioEvent: new AudioEvent({ audioPcm: new Uint8Array(2) }) }
    const imu: EvenHubEvent = {
      sysEvent: new Sys_ItemEvent({
        eventType: OsEventTypeList.IMU_DATA_REPORT,
        imuData: new IMU_Report_Data({ x: 1, y: 0, z: 0 }),
      }),
    }
    expect(gestureFromEvent(audio)).toBeNull()
    expect(gestureFromEvent(imu)).toBeNull()
    expect(gestureFromEvent({})).toBeNull()
  })

  it('treats a system event from a touch source without eventType as click', () => {
    // Seen in simulator 0.9.5 with SDK 0.0.16: a click on a text container arrives as
    // {"sysEvent":{"eventSource":1}}; eventType 0 is dropped on the way.
    const event: EvenHubEvent = {
      sysEvent: new Sys_ItemEvent({ eventSource: EventSourceType.TOUCH_EVENT_FROM_GLASSES_R }),
    }
    expect(gestureFromEvent(event)).toBe('click')
  })

  it('does not treat a system event without eventType and without touch source as a click', () => {
    expect(gestureFromEvent(sys())).toBeNull()
    const noSource: EvenHubEvent = {
      sysEvent: new Sys_ItemEvent({ eventSource: EventSourceType.TOUCH_EVENT_FORM_DUMMY_NULL }),
    }
    expect(gestureFromEvent(noSource)).toBeNull()
  })
})

describe('sourceFromEvent', () => {
  const from = (eventSource: EventSourceType): EvenHubEvent => ({
    sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, eventSource }),
  })

  it('names the ring', () => {
    expect(sourceFromEvent(from(EventSourceType.TOUCH_EVENT_FROM_RING))).toBe('ring')
  })

  it('names each temple', () => {
    expect(sourceFromEvent(from(EventSourceType.TOUCH_EVENT_FROM_GLASSES_R))).toBe('right temple')
    expect(sourceFromEvent(from(EventSourceType.TOUCH_EVENT_FROM_GLASSES_L))).toBe('left temple')
  })

  it('returns null when the event carries no source', () => {
    expect(sourceFromEvent(sys(OsEventTypeList.FOREGROUND_ENTER_EVENT))).toBeNull()
    expect(sourceFromEvent(text(OsEventTypeList.CLICK_EVENT))).toBeNull()
  })
})
