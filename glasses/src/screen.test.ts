import { describe, expect, it } from 'vitest'
import {
  BUBBLE_WIDTH,
  chatPage,
  headUpdate,
  HEAD,
  inboxPage,
  INBOX_ROWS,
  markerSlot,
  MARKER,
  notePage,
  rowLayout,
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
  paddingLength?: number
  containerID?: number
  containerName?: string
  content?: string
  isEventCapture?: number
  textColor?: number
}

/** The checks the Even app applies before a page reaches the glasses. */
function expectValidPage(page: { containerTotalNum?: number; textObject?: Box[]; imageObject?: Box[] }) {
  const boxes = page.textObject ?? []
  const images = page.imageObject ?? []
  expect(page.containerTotalNum).toBe(boxes.length + images.length)
  expect(images.length).toBeLessThanOrEqual(4)
  expect(new Set([...boxes, ...images].map((box) => box.containerID)).size).toBe(boxes.length + images.length)
  for (const image of images) {
    // Limits of an image container, from the Even Hub display docs.
    expect(image.width ?? 0).toBeGreaterThanOrEqual(20)
    expect(image.height ?? 0).toBeGreaterThanOrEqual(20)
    expect(image.height ?? 0).toBeLessThanOrEqual(144)
    expect((image.yPosition ?? 0) + (image.height ?? 0)).toBeLessThanOrEqual(SCREEN.height)
  }
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
      expect(box.yPosition ?? 0).toBeGreaterThanOrEqual(bottom)
      bottom = (box.yPosition ?? 0) + (box.height ?? 0)
    }
  })

  it('leaves a clear gap between boxes', () => {
    const boxes = expectValidPage(inboxPage('Unread (3)', rows(INBOX_ROWS))).slice(1)
    const gaps = boxes.slice(1).map((box, index) => (box.yPosition ?? 0) - ((boxes[index]?.yPosition ?? 0) + (boxes[index]?.height ?? 0)))
    // Twice the 2 px of version 0.4.0, or more.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(4)
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

  it('draws one box per row across the whole width, and none for rows that do not exist', () => {
    const boxes = expectValidPage(inboxPage('Unread (1)', rows(1)))
    expect(boxes).toHaveLength(2)
    expect(boxes[1]?.width).toBe(SCREEN.width)
    expect(expectValidPage(inboxPage('Unread (0)', []))).toHaveLength(1)
  })

  it('builds the same layout for start-up, so the inbox needs no rebuild', () => {
    const start = expectValidPage(startupInbox('Messenger', rows(2)))
    const later = expectValidPage(inboxPage('Messenger', rows(2)))
    expect(start).toEqual(later)
  })

  it('updates one row or the header in place', () => {
    const [, first] = expectValidPage(inboxPage('Unread (3)', rows(INBOX_ROWS)))
    const update = rowUpdate(0, { text: 'changed', selected: true }, true)
    expect(update.containerID).toBe(first?.containerID)
    expect(update.containerName).toBe(first?.containerName)
    expect(update.content).toBe('changed')
    expect(update.textColor).toBe(4)
    expect(headUpdate('All chats (9)').containerID).toBe(HEAD.id)
  })
})

describe('selection marker', () => {
  it('reserves a column left of the boxes, with one image slot beside each row', () => {
    const page = inboxPage('Unread (3)', rows(3), true)
    const boxes = expectValidPage(page).slice(1)
    const images = (page.imageObject ?? []) as Box[]
    expect(images).toHaveLength(3)
    images.forEach((image, index) => {
      expect(image.xPosition).toBe(0)
      expect(image.width).toBe(MARKER.width)
      expect(image.height).toBe(MARKER.height)
      // Centred on its row.
      const row = boxes[index]
      expect((image.yPosition ?? 0) + MARKER.height / 2).toBe((row?.yPosition ?? 0) + (row?.height ?? 0) / 2)
      expect(row?.xPosition ?? 0).toBeGreaterThanOrEqual(MARKER.width)
      expect((row?.xPosition ?? 0) + (row?.width ?? 0)).toBe(SCREEN.width)
      expect({ containerID: image.containerID, containerName: image.containerName }).toEqual(markerSlot(index))
    })
  })

  it('has no image slots and marks the selected row in its text when images are off', () => {
    const page = inboxPage('Unread (3)', rows(3))
    expect(page.imageObject ?? []).toHaveLength(0)
    expect(expectValidPage(page).slice(1).map((box) => box.content)).toEqual(['  row 0', '> row 1', '  row 2'])
    expect(rowUpdate(1, { text: 'row 1', selected: false }, false).content).toBe('  row 1')
  })

  it('leaves the text unmarked when images mark the selection', () => {
    expect(expectValidPage(inboxPage('Unread (3)', rows(3), true)).slice(1).map((box) => box.content)).toEqual(['row 0', 'row 1', 'row 2'])
  })

  it('shows a note bright and without a marker', () => {
    const [, note] = expectValidPage(inboxPage('Messenger', [{ text: 'Loading', selected: false, note: true }]))
    expect(note?.content).toBe('Loading')
    expect(note?.textColor).toBe(4)
  })
})

describe('centred rows', () => {
  const link = { text: 'All chats', selected: false, centered: true }

  it('pads a one-line row so that its text sits in the middle of the box', () => {
    const [, chatBox, linkBox] = expectValidPage(inboxPage('Unread (1)', [{ text: 'Ana\nhi', selected: true }, link], true))
    expect(linkBox?.height).toBe(chatBox?.height)
    expect(linkBox?.paddingLength ?? 0).toBeGreaterThan((chatBox?.paddingLength ?? 0) + 8)
    // One line of text and the padding above and below it fill the box.
    expect(2 * (linkBox?.paddingLength ?? 0) + 27).toBeLessThanOrEqual(linkBox?.height ?? 0)
    expect((linkBox?.height ?? 0) - (2 * (linkBox?.paddingLength ?? 0) + 27)).toBeLessThan(4)
  })

  it('tells layouts apart by which rows are centred, since padding cannot change in place', () => {
    expect(rowLayout([link, link])).toBe(rowLayout([{ ...link, text: 'x', selected: true }, link]))
    expect(rowLayout([link, link])).not.toBe(rowLayout([{ text: 'Ana\nhi', selected: true }, link]))
    expect(rowLayout([link])).not.toBe(rowLayout([link, link]))
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
