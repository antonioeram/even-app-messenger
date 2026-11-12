// Turns gateway data into what the glasses show.
//
// All text arrives from the gateway already reduced to ASCII: the firmware
// font drops glyphs it does not have, without any error.

import type { Chat, Message } from './gateway'
import { fitText } from './screen'

// Limits of a list container, from the Even Hub display docs.
export const LIST_MAX_ITEMS = 20
export const LIST_ITEM_CHARS = 64

/** One line per chat for the inbox list, in the order given. */
export function inboxItems(chats: readonly Chat[]): string[] {
  return chats.slice(0, LIST_MAX_ITEMS).map((chat) => {
    const unread = chat.unread > 0 ? `(${chat.unread}) ` : ''
    const preview = oneLine(chat.preview)
    return fitText(`${unread}${chat.name}${preview ? `: ${preview}` : ''}`, LIST_ITEM_CHARS)
  })
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
