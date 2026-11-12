// Turns raw Even Hub events into the few gestures the app cares about.

import { EventSourceType, OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type Gesture =
  | 'click'
  | 'doubleClick'
  | 'scrollUp'
  | 'scrollDown'
  | 'longPressStart'
  | 'longPressEnd'
  | 'foregroundEnter'
  | 'foregroundExit'

const BY_TYPE: Partial<Record<OsEventTypeList, Gesture>> = {
  [OsEventTypeList.CLICK_EVENT]: 'click',
  [OsEventTypeList.DOUBLE_CLICK_EVENT]: 'doubleClick',
  [OsEventTypeList.SCROLL_TOP_EVENT]: 'scrollUp',
  [OsEventTypeList.SCROLL_BOTTOM_EVENT]: 'scrollDown',
  [OsEventTypeList.LONG_PRESS_EVENT]: 'longPressStart',
  [OsEventTypeList.LONG_PRESS_RELEASE_EVENT]: 'longPressEnd',
  [OsEventTypeList.FOREGROUND_ENTER_EVENT]: 'foregroundEnter',
  [OsEventTypeList.FOREGROUND_EXIT_EVENT]: 'foregroundExit',
}

export function gestureFromEvent(event: EvenHubEvent): Gesture | null {
  // The docs route touch events to the container that captures input (text or list).
  const captured = event.textEvent ?? event.listEvent
  if (captured) {
    // The SDK drops eventType 0 (click) in some cases; a bare event is a click.
    if (captured.eventType === undefined) return 'click'
    return BY_TYPE[captured.eventType] ?? null
  }
  // Long press and foreground changes always arrive as system events. With
  // SDK 0.0.16 the simulator also reports clicks and double clicks this way,
  // tagged with the touch source (temple or ring).
  const sys = event.sysEvent
  if (!sys) return null
  if (sys.eventType !== undefined) return BY_TYPE[sys.eventType] ?? null
  // eventType 0 (click) is dropped on the way; a touch source marks the click.
  return sys.eventSource && !sys.imuData ? 'click' : null
}

export type InputSource = 'ring' | 'right temple' | 'left temple'

const BY_SOURCE: Partial<Record<EventSourceType, InputSource>> = {
  [EventSourceType.TOUCH_EVENT_FROM_RING]: 'ring',
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_R]: 'right temple',
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_L]: 'left temple',
}

/** Which touchpad produced the event; only system events carry it. */
export function sourceFromEvent(event: EvenHubEvent): InputSource | null {
  const source = event.sysEvent?.eventSource
  return source === undefined ? null : (BY_SOURCE[source] ?? null)
}
