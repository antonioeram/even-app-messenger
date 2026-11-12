// Turns gateway data into what the glasses show.
//
// All text arrives from the gateway already reduced to ASCII: the firmware
// font drops glyphs it does not have, without any error.
//
// Every screen is plain text in one container. A native list container did
// not render on real glasses (build 0.1.0), while text updates are proven.

import type { Chat, Message } from './gateway'
import { fitText } from './screen'

/** Rows visible at once in a chat list; with the header they fill most of the 288 px screen. */
export const INBOX_ROWS = 7
/** Longest list row, marker included; short enough not to wrap. */
export const INBOX_ROW_CHARS = 48

/** Lines of messages on one reading page, below the header. */
export const CHAT_PAGE_LINES = 8
/** Line length used to wrap messages; the font is proportional, so this is kept conservative. */
export const CHAT_LINE_CHARS = 48

/**
 * A chat list: a titled header, then a window of rows around the cursor.
 * Each row is time, name and newest text. extraRow, when given, is a last
 * selectable row (index chats.length).
 */
export function inboxText(title: string, chats: readonly Chat[], cursor: number, extraRow?: string): string {
  const rows = chats.map((chat) => {
    const unread = chat.unread > 0 ? `(${chat.unread}) ` : ''
    const preview = oneLine(chat.preview)
    return `${chat.clock} ${unread}${chat.name}${preview ? `: ${preview}` : ''}`
  })
  if (extraRow) rows.push(extraRow)
  const first = Math.max(0, Math.min(cursor - Math.floor(INBOX_ROWS / 2), rows.length - INBOX_ROWS))
  const visible = rows
    .slice(first, first + INBOX_ROWS)
    .map((row, offset) => fitText(`${first + offset === cursor ? '> ' : '  '}${row}`, INBOX_ROW_CHARS))
  return [`${title} (${chats.length})`, ...visible].join('\n')
}

/**
 * The reading screen, as pages that each fit the display, so one swipe is one
 * page. Page 1 holds the newest messages, newest on top. Each message shows
 * time, name and text.
 */
export function chatPages(chat: Chat, messages: readonly Message[]): string[] {
  if (messages.length === 0) return [`${chat.name}\nNo messages`]
  const pages: string[][] = [[]]
  for (const message of [...messages].reverse()) {
    let lines = wrap(`${message.clock} ${message.fromMe ? 'Me' : message.sender}: ${oneLine(message.text)}`)
    // Keep a message whole when it fits on a fresh page.
    if (lines.length <= CHAT_PAGE_LINES && lastOf(pages).length + lines.length > CHAT_PAGE_LINES) pages.push([])
    while (lines.length > 0) {
      const page = lastOf(pages)
      const room = CHAT_PAGE_LINES - page.length
      if (room === 0) {
        pages.push([])
        continue
      }
      page.push(...lines.slice(0, room))
      lines = lines.slice(room)
    }
  }
  return pages.map((lines, index) => [`${chat.name} ${index + 1}/${pages.length}`, ...lines].join('\n'))
}

function lastOf(pages: string[][]): string[] {
  const last = pages[pages.length - 1]
  if (!last) throw new Error('no page')
  return last
}

/** Wraps text at word boundaries; a word longer than a line is cut. */
function wrap(text: string): string[] {
  const lines: string[] = []
  let line = ''
  for (let word of text.split(' ')) {
    while (word.length > CHAT_LINE_CHARS) {
      if (line) lines.push(line)
      lines.push(word.slice(0, CHAT_LINE_CHARS))
      word = word.slice(CHAT_LINE_CHARS)
      line = ''
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= CHAT_LINE_CHARS) line += ` ${word}`
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
