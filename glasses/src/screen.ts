// Page builders for the 576x288 glasses canvas.
//
// Two layouts. The inbox is a header and up to four bordered boxes, with a
// small image beside each that lights up for the selected one. It is created
// at start-up and then only its texts and images change (flicker-free, and
// proven on real glasses); the page is laid out again only when the boxes
// themselves change. A chat is a header and message bubbles, left for theirs
// and right for mine; its geometry depends on the messages, so each page is
// a rebuild.

import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

export const SCREEN = { width: 576, height: 288 } as const

/** Limit of the page calls, from the Even Hub display docs. */
export const MAX_CREATE_CHARS = 1000

/** Title strip at the top of every page. It captures input: its text always fits, so every swipe arrives as an event. */
export const HEAD = { id: 1, name: 'head' } as const
const HEAD_HEIGHT = 30

/** Boxes on the inbox page. */
export const INBOX_ROWS = 4
// Two lines of text need 60 px; what is left of the screen goes to the gaps.
const ROW_HEIGHT = 60
const ROW_PITCH = 66

const LINE_HEIGHT = 27
const BORDER_WIDTH = 1
// Two lines fill a row; one line is pushed down to the middle of it. The
// padding must leave the line its full height inside the border, or the
// firmware treats the box as scrollable.
const ROW_PADDING = 2
const CENTERED_PADDING = Math.floor((ROW_HEIGHT - 2 * BORDER_WIDTH - LINE_HEIGHT) / 2)

/** The selection marker: an image as tall as a row, in a column left of the boxes. */
export const MARKER = { width: 24, height: ROW_HEIGHT } as const
const MARKER_GAP = 4
const MARKER_FIRST_ID = HEAD.id + 1 + INBOX_ROWS

export const BUBBLE_WIDTH = 440
const BUBBLE_PADDING = 12
const BUBBLE_GAP = 4

// Text brightness levels (0 to 4).
const BRIGHT = 4
const DIM = 2
// Border grey level (0 to 15).
const BORDER = 9

/** One inbox box. */
export interface Row {
  text: string
  /** The row under the cursor: bright, and marked. */
  selected: boolean
  /** One line of text, centred in the box: a link to another list. */
  centered?: boolean
  /** Bright without being selectable: loading, empty and failure notes. */
  note?: boolean
}

/** One message bubble. lines is the number of text lines, which sets its height. */
export interface BubbleBox {
  mine: boolean
  text: string
  lines: number
}

/** Cuts text to the limit. Uses ASCII dots: the firmware font drops unknown glyphs. */
export function fitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, Math.max(0, maxChars - 3)) + '...'
}

/** A container must have content; a space keeps an unused box valid. */
function content(text: string): string {
  return text === '' ? ' ' : fitText(text, MAX_CREATE_CHARS)
}

function head(title: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN.width,
    height: HEAD_HEIGHT,
    borderWidth: 0,
    // No padding: with any, one line of text overflows the strip, the firmware
    // scrolls it internally and swallows swipes instead of reporting them.
    paddingLength: 0,
    containerID: HEAD.id,
    containerName: HEAD.name,
    content: content(title),
    isEventCapture: 1,
    textColor: BRIGHT,
  })
}

function box(
  index: number,
  name: string,
  frame: { x: number; y: number; width: number; height: number },
  text: string,
  bright: boolean,
  padding = 4,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: frame.x,
    yPosition: frame.y,
    width: frame.width,
    height: frame.height,
    borderWidth: BORDER_WIDTH,
    borderColor: BORDER,
    borderRadius: 6,
    paddingLength: padding,
    containerID: HEAD.id + 1 + index,
    containerName: name,
    content: content(text),
    isEventCapture: 0,
    textColor: bright ? BRIGHT : DIM,
  })
}

const rowName = (index: number) => `row${index + 1}`

const rowTop = (index: number) => HEAD_HEIGHT + index * ROW_PITCH

/**
 * What a row box shows. Without marker images the selection is marked in the
 * text, in a two-character column that keeps the rows aligned.
 */
function rowText(row: Row, markers: boolean): string {
  if (markers || row.note) return row.text
  return `${row.selected ? '>' : ' '} ${row.text}`
}

const rowBright = (row: Row) => row.selected || row.note === true

/** Identity of the marker image beside row index. */
export function markerSlot(index: number): { containerID: number; containerName: string } {
  return { containerID: MARKER_FIRST_ID + index, containerName: `mark${index + 1}` }
}

/**
 * What cannot change in place: the number of rows and which of them are
 * centred. Two sets of rows with the same value fit the same page.
 */
export function rowLayout(rows: readonly Row[]): string {
  return rows
    .slice(0, INBOX_ROWS)
    .map((row) => (row.centered ? 'c' : 'r'))
    .join('')
}

function inboxLayout(title: string, rows: readonly Row[], markers: boolean) {
  const shown = rows.slice(0, INBOX_ROWS)
  const left = markers ? MARKER.width + MARKER_GAP : 0
  // One box per row: a list shorter than the screen leaves the rest empty.
  const textObject = [
    head(title),
    ...shown.map((row, index) => {
      const frame = { x: left, y: rowTop(index), width: SCREEN.width - left, height: ROW_HEIGHT }
      const padding = row.centered ? CENTERED_PADDING : ROW_PADDING
      return box(index, rowName(index), frame, rowText(row, markers), rowBright(row), padding)
    }),
  ]
  // Image containers start empty; their pixels are sent once the page exists.
  const imageObject = markers
    ? shown.map(
        (_, index) =>
          new ImageContainerProperty({
            xPosition: 0,
            yPosition: rowTop(index),
            width: MARKER.width,
            height: MARKER.height,
            ...markerSlot(index),
          }),
      )
    : []
  return { containerTotalNum: textObject.length + imageObject.length, textObject, imageObject }
}

/** The inbox layout as the start-up page. markers adds the image column for the selection marker. */
export function startupInbox(title: string, rows: readonly Row[], markers = false): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer(inboxLayout(title, rows, markers))
}

/** The inbox layout, for coming back from a chat or for a different set of boxes. */
export function inboxPage(title: string, rows: readonly Row[], markers = false): RebuildPageContainer {
  return new RebuildPageContainer(inboxLayout(title, rows, markers))
}

/** Changes one inbox box in place. markers must be what the page was built with. */
export function rowUpdate(index: number, row: Row, markers: boolean): TextContainerUpgrade {
  return new TextContainerUpgrade({
    containerID: HEAD.id + 1 + index,
    containerName: rowName(index),
    content: content(rowText(row, markers)),
    textColor: rowBright(row) ? BRIGHT : DIM,
  })
}

/** Changes the title in place. */
export function headUpdate(title: string): TextContainerUpgrade {
  return new TextContainerUpgrade({ containerID: HEAD.id, containerName: HEAD.name, content: content(title) })
}

/** A chat page: title, then bubbles from top to bottom, theirs on the left and mine on the right. */
export function chatPage(title: string, bubbles: readonly BubbleBox[]): RebuildPageContainer {
  const textObject = [head(title)]
  let y = HEAD_HEIGHT
  bubbles.forEach((bubble, index) => {
    // Never draw past the screen, even if a caller exceeds the line budget.
    const height = Math.min(bubble.lines * LINE_HEIGHT + BUBBLE_PADDING, SCREEN.height - y)
    if (height <= BUBBLE_PADDING) return
    const frame = { x: bubble.mine ? SCREEN.width - BUBBLE_WIDTH : 0, y, width: BUBBLE_WIDTH, height }
    textObject.push(box(index, `msg${index + 1}`, frame, bubble.text, true))
    y += height + BUBBLE_GAP
  })
  return new RebuildPageContainer({ containerTotalNum: textObject.length, textObject })
}

/** A title and one large box: recording, transcript to confirm, errors inside a chat. */
export function notePage(title: string, text: string): RebuildPageContainer {
  const frame = { x: 0, y: HEAD_HEIGHT, width: SCREEN.width, height: SCREEN.height - HEAD_HEIGHT }
  const textObject = [head(title), box(0, 'note', frame, text, true)]
  return new RebuildPageContainer({ containerTotalNum: textObject.length, textObject })
}
