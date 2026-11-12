// Page builders for the 576x288 glasses canvas.
//
// Two layouts. The inbox is a header and four bordered boxes; it is created
// at start-up and then only its texts change (textContainerUpgrade, which is
// flicker-free and proven on real glasses). A chat is a header and message
// bubbles, left for theirs and right for mine; its geometry depends on the
// messages, so each page is a rebuild.

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

/** Side of the round avatar to the left of each inbox box. */
export const AVATAR_SIZE = 56
const AVATAR_GAP = 6
const AVATAR_FIRST_ID = HEAD.id + 1 + INBOX_ROWS

export const BUBBLE_WIDTH = 440
const LINE_HEIGHT = 27
const BUBBLE_PADDING = 12
const BUBBLE_GAP = 4

// Text brightness levels (0 to 4).
const BRIGHT = 4
const DIM = 2
// Border grey level (0 to 15).
const BORDER = 9

/** One inbox box: its text and whether it is the selected one. */
export interface Row {
  text: string
  selected: boolean
  /** Initials for the avatar next to the box; empty for a row that is not a chat. */
  avatar: string
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
    borderWidth: 1,
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

/** Identity of the image container next to row index. */
export function avatarSlot(index: number): { containerID: number; containerName: string } {
  return { containerID: AVATAR_FIRST_ID + index, containerName: `avatar${index + 1}` }
}

function inboxBoxes(title: string, rows: readonly Row[], avatars: boolean): TextContainerProperty[] {
  const boxes = [head(title)]
  const left = avatars ? AVATAR_SIZE + AVATAR_GAP : 0
  for (let index = 0; index < INBOX_ROWS; index += 1) {
    const row = rows[index] ?? { text: '', selected: false, avatar: '' }
    const frame = { x: left, y: rowTop(index), width: SCREEN.width - left, height: ROW_HEIGHT }
    // Two lines of text need all the height a row has, so the padding is small.
    boxes.push(box(index, rowName(index), frame, row.text, row.selected, 2))
  }
  return boxes
}

/** Empty image containers, one per row; their pixels are sent after the page exists. */
function avatarSlots(): ImageContainerProperty[] {
  return Array.from({ length: INBOX_ROWS }, (_, index) => {
    const y = rowTop(index) + Math.floor((ROW_HEIGHT - AVATAR_SIZE) / 2)
    return new ImageContainerProperty({ xPosition: 0, yPosition: y, width: AVATAR_SIZE, height: AVATAR_SIZE, ...avatarSlot(index) })
  })
}

function inboxLayout(title: string, rows: readonly Row[], avatars: boolean) {
  const textObject = inboxBoxes(title, rows, avatars)
  const imageObject = avatars ? avatarSlots() : []
  return { containerTotalNum: textObject.length + imageObject.length, textObject, imageObject }
}

/** The inbox layout as the start-up page. avatars adds an image slot left of each box. */
export function startupInbox(title: string, rows: readonly Row[], avatars = true): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer(inboxLayout(title, rows, avatars))
}

/** The inbox layout, for coming back from a chat. */
export function inboxPage(title: string, rows: readonly Row[], avatars = true): RebuildPageContainer {
  return new RebuildPageContainer(inboxLayout(title, rows, avatars))
}

/** Changes one inbox box in place. */
export function rowUpdate(index: number, row: Row): TextContainerUpgrade {
  return new TextContainerUpgrade({
    containerID: HEAD.id + 1 + index,
    containerName: rowName(index),
    content: content(row.text),
    textColor: row.selected ? BRIGHT : DIM,
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
