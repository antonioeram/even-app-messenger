import { describe, expect, it } from 'vitest'
import {
  BUBBLE_WIDTH,
  chatPage,
  headUpdate,
  HEAD,
  inboxPage,
  INBOX_ROWS,
  notePage,
  rowUpdate,
  SCREEN,
  startupInbox,
  type BubbleBox,
} from './screen'

type Box = {
  xPosition?: number
  yPosition?: number
  width?: number
  height?: number
  borderWidth?: number
  containerID?: number
  containerName?: string
  content?: string
  isEventCapture?: number
  textColor?: number
}

/** The checks the Even app applies before a page reaches the glasses. */
function expectValidPage(page: { containerTotalNum?: number; textObject?: Box[] }) {
  const boxes = page.textObject ?? []
  expect(page.containerTotalNum).toBe(boxes.length)
  expect(boxes.length).toBeLessThanOrEqual(8)
  expect(boxes.filter((box) => box.isEventCapture === 1)).toHaveLength(1)
  expect(new Set(boxes.map((box) => box.containerID)).size).toBe(boxes.length)
  expect(new Set(boxes.map((box) => box.containerName)).size).toBe(boxes.length)
  for (const box of boxes) {
    expect((box.containerName ?? '').length).toBeLessThanOrEqual(16)
    expect(box.xPosition ?? -1).toBeGreaterThanOrEqual(0)
    expect(box.yPosition ?? -1).toBeGreaterThanOrEqual(0)
    expect((box.xPosition ?? 0) + (box.width ?? 0)).toBeLessThanOrEqual(SCREEN.width)
    expect((box.yPosition ?? 0) + (box.height ?? 0)).toBeLessThanOrEqual(SCREEN.height)
    expect((box.content ?? '').length).toBeGreaterThan(0)
    expect((box.content ?? '').length).toBeLessThanOrEqual(1000)
  }
  return boxes
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `row ${i}`, selected: i === 1 }))

describe('inbox page', () => {
  it('has a header and one bordered box per row, stacked without overlap', () => {
    const boxes = expectValidPage(inboxPage('Unread (3)', rows(INBOX_ROWS)))
    expect(boxes).toHaveLength(1 + INBOX_ROWS)
    expect(boxes[0]?.content).toBe('Unread (3)')
    expect(boxes[0]?.borderWidth).toBe(0)
    let bottom = (boxes[0]?.yPosition ?? 0) + (boxes[0]?.height ?? 0)
    for (const box of boxes.slice(1)) {
      expect(box.borderWidth).toBeGreaterThan(0)
      expect(box.width).toBe(SCREEN.width)
      expect(box.yPosition ?? 0).toBeGreaterThanOrEqual(bottom)
      bottom = (box.yPosition ?? 0) + (box.height ?? 0)
    }
  })

  it('captures input in the header, whose short text makes every swipe an event', () => {
    const boxes = expectValidPage(inboxPage('Unread (3)', rows(INBOX_ROWS)))
    expect(boxes[0]?.isEventCapture).toBe(1)
    expect(boxes[0]?.containerID).toBe(HEAD.id)
  })

  it('shows the selected row brighter than the others', () => {
    const boxes = expectValidPage(inboxPage('Unread (3)', rows(INBOX_ROWS))).slice(1)
    expect(boxes[1]?.textColor).toBeGreaterThan(boxes[0]?.textColor ?? 99)
  })

  it('keeps unused rows as valid, blank boxes', () => {
    const boxes = expectValidPage(inboxPage('Unread (1)', rows(1)))
    expect(boxes).toHaveLength(1 + INBOX_ROWS)
    expect(boxes.at(-1)?.content).toBe(' ')
  })

  it('builds the same layout for start-up, so the inbox needs no rebuild', () => {
    const start = expectValidPage(startupInbox('Messenger', rows(2)))
    const later = expectValidPage(inboxPage('Messenger', rows(2)))
    expect(start).toEqual(later)
  })

  it('updates one row or the header in place', () => {
    const [, first] = expectValidPage(inboxPage('Unread (3)', rows(INBOX_ROWS)))
    const update = rowUpdate(0, { text: 'changed', selected: true })
    expect(update.containerID).toBe(first?.containerID)
    expect(update.containerName).toBe(first?.containerName)
    expect(update.content).toBe('changed')
    expect(update.textColor).toBe(4)
    expect(headUpdate('All chats (9)').containerID).toBe(HEAD.id)
  })
})

describe('chat page', () => {
  const bubble = (over: Partial<BubbleBox> = {}): BubbleBox => ({ mine: false, text: 'Ana - 09:35\nBuna', lines: 2, ...over })

  it('puts their messages on the left and mine on the right', () => {
    const boxes = expectValidPage(chatPage('Ana Pop 1/1', [bubble(), bubble({ mine: true, text: 'Me - 09:36\nDa' })])).slice(1)
    expect(boxes[0]?.xPosition).toBe(0)
    expect(boxes[1]?.xPosition).toBe(SCREEN.width - BUBBLE_WIDTH)
    expect(boxes[0]?.width).toBe(BUBBLE_WIDTH)
    expect(boxes.every((box) => (box.borderWidth ?? 0) > 0)).toBe(true)
  })

  it('makes a bubble taller when it has more lines, and stacks them without overlap', () => {
    const boxes = expectValidPage(chatPage('Ana Pop 1/1', [bubble({ lines: 2 }), bubble({ lines: 4 })])).slice(1)
    expect(boxes[1]?.height ?? 0).toBeGreaterThan(boxes[0]?.height ?? 0)
    expect(boxes[1]?.yPosition ?? 0).toBeGreaterThanOrEqual((boxes[0]?.yPosition ?? 0) + (boxes[0]?.height ?? 0))
  })

  it('still builds a valid page for a chat without messages', () => {
    expect(expectValidPage(chatPage('Ana Pop', []))).toHaveLength(1)
  })
})

describe('note page', () => {
  it('shows a title and one large bordered box', () => {
    const boxes = expectValidPage(notePage('Reply to Ana Pop', 'Ajung in zece minute\n\nClick = send'))
    expect(boxes).toHaveLength(2)
    expect(boxes[1]?.borderWidth).toBeGreaterThan(0)
    expect(boxes[1]?.content).toContain('Click = send')
  })
})
