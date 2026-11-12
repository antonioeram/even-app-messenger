// Turns gateway data into what the glasses show.
//
// All text arrives from the gateway already reduced to ASCII: the firmware
// font drops glyphs it does not have, without any error.

import type { Chat, Message } from './gateway'
import { fitText, INBOX_ROWS, type BubbleBox, type Row } from './screen'

/** Longest line in an inbox box; short enough not to wrap in the proportional font. */
export const INBOX_LINE_CHARS = 46

/** Line length used to wrap text inside a bubble; kept conservative for the same reason. */
export const BUBBLE_LINE_CHARS = 40
/** Bubbles on one chat page. */
export const MAX_BUBBLES = 3
/** Text lines on one chat page, over all its bubbles: what fits under the title. */
export const PAGE_LINE_BUDGET = 7

/**
 * The boxes of a chat list: a window of INBOX_ROWS rows around the cursor.
 * A chat box has marker, name and time on its first line and the newest text
 * on the second. links are selectable rows after the chats (indexes
 * chats.length and up).
 */
export function inboxRows(chats: readonly Chat[], cursor: number, links: readonly string[] = []): Row[] {
  const total = chats.length + links.length
  // One screenful at a time: the boxes, and the avatars beside them, are
  // redrawn only when the selection crosses to another page.
  const first = Math.floor(Math.max(0, cursor) / INBOX_ROWS) * INBOX_ROWS
  const rows: Row[] = []
  for (let index = first; index < Math.min(total, first + INBOX_ROWS); index += 1) {
    const selected = index === cursor
    const chat = chats[index]
    if (!chat) {
      rows.push({ text: `${selected ? '>' : ' '} ${links[index - chats.length] ?? ''}`, selected, avatar: '' })
      continue
    }
    const marker = selected ? '>' : chat.unread > 0 ? '*' : ' '
    const name = fitText(chat.name, INBOX_LINE_CHARS - 4 - chat.clock.length)
    const count = chat.unread > 0 ? ` (${chat.unread})` : ''
    const preview = fitText(oneLine(chat.preview), INBOX_LINE_CHARS - count.length) + count
    rows.push({ text: `${marker} ${name}  ${chat.clock}${preview ? `\n${preview}` : ''}`, selected, avatar: initials(chat.name) })
  }
  return rows
}

/**
 * Up to two capital letters for an avatar: the first letters of the first
 * and last word of a name. A name without letters (a phone number) gives '#'.
 */
export function initials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => /[A-Za-z]/.test(word))
  const first = words[0]
  if (!first) return '#'
  const last = words.length > 1 ? words[words.length - 1] : undefined
  return (first.charAt(0) + (last?.charAt(0) ?? '')).toUpperCase()
}

/** A message (loading, empty, failure) laid out in the inbox boxes, two lines per box. */
export function noteRows(text: string): Row[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const rows: Row[] = []
  for (let index = 0; index < lines.length && rows.length < INBOX_ROWS; index += 2) {
    const last = rows.length === INBOX_ROWS - 1
    const pair = last ? [lines[index], lines.slice(index + 1).join(' ')] : lines.slice(index, index + 2)
    rows.push({ text: pair.filter(Boolean).join('\n'), selected: true, avatar: '' })
  }
  return rows
}

/**
 * A chat as pages of bubbles, oldest message first; the last page holds the
 * newest messages. Each bubble starts with sender and time. Pages are filled
 * from the end, so the newest page is always a full one.
 */
export function chatBubbles(_chat: Chat, messages: readonly Message[]): BubbleBox[][] {
  const bubbles: BubbleBox[] = []
  for (const message of messages) {
    const heading = `${message.fromMe ? 'Me' : message.sender} - ${message.clock}`
    const body = wrap(oneLine(message.text), BUBBLE_LINE_CHARS)
    // A message taller than a page continues in further bubbles.
    const perBubble = PAGE_LINE_BUDGET - 1
    for (let start = 0; start === 0 || start < body.length; start += perBubble) {
      const lines = [heading, ...body.slice(start, start + perBubble)]
      bubbles.push({ mine: message.fromMe, text: lines.join('\n'), lines: lines.length })
    }
  }

  const pages: BubbleBox[][] = []
  let page: BubbleBox[] = []
  let used = 0
  for (const bubble of [...bubbles].reverse()) {
    if (page.length === MAX_BUBBLES || used + bubble.lines > PAGE_LINE_BUDGET) {
      pages.unshift(page)
      page = []
      used = 0
    }
    page.unshift(bubble)
    used += bubble.lines
  }
  if (page.length > 0) pages.unshift(page)
  return pages
}

/** Wraps text at word boundaries; a word longer than a line is cut. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (let word of text.split(' ')) {
    while (word.length > width) {
      if (line) lines.push(line)
      lines.push(word.slice(0, width))
      word = word.slice(width)
      line = ''
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

function oneLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ')
}
