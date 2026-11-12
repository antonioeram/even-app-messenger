// Turns gateway data into what the glasses show.
//
// All text arrives from the gateway already reduced to ASCII: the firmware
// font drops glyphs it does not have, without any error.

import type { Chat, Message } from './gateway'
import { fitText } from './screen'

// The inbox is drawn as text, one chat per line, with a marker on the
// selected one. A native list container did not render on real glasses
// (build 0.1.0), while text updates are proven there.
/** Chats visible at once; with the header they fill most of the 288 px screen. */
export const INBOX_ROWS = 7
/** Longest row, marker included; short enough not to wrap. */
export const INBOX_ROW_CHARS = 44

/** The inbox screen: a position header, then a window of rows around the cursor. */
export function inboxText(chats: readonly Chat[], cursor: number): string {
  const first = Math.max(0, Math.min(cursor - Math.floor(INBOX_ROWS / 2), chats.length - INBOX_ROWS))
  const rows = chats.slice(first, first + INBOX_ROWS).map((chat, offset) => {
    const marker = first + offset === cursor ? '> ' : '  '
    const unread = chat.unread > 0 ? `(${chat.unread}) ` : ''
    const preview = oneLine(chat.preview)
    return fitText(`${marker}${unread}${chat.name}${preview ? `: ${preview}` : ''}`, INBOX_ROW_CHARS)
  })
  return [`Inbox ${cursor + 1}/${chats.length}`, ...rows].join('\n')
}

/**
 * The reading screen: chat name, then messages with the newest on top, so the
 * latest one is visible without scrolling. Older messages that do not fit in
 * maxChars are left out.
 */
export function chatText(chat: Chat, messages: readonly Message[], maxChars: number): string {
  if (messages.length === 0) return `${chat.name}\nNo messages`
  const lines = [chat.name]
  let used = chat.name.length
  for (const message of [...messages].reverse()) {
    const line = messageLine(chat, message)
    const room = maxChars - used - 1
    if (line.length > room) {
      // Always show the newest message, cut if it is longer than the screen budget.
      if (lines.length === 1 && room > 3) lines.push(fitText(line, room))
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

function messageLine(chat: Chat, message: Message): string {
  const who = message.fromMe ? 'Me: ' : chat.group ? `${message.sender}: ` : ''
  return `${message.clock} ${who}${oneLine(message.text)}`
}

function oneLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ')
}
