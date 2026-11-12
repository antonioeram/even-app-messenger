import { describe, expect, it } from 'vitest'
import type { Chat, Message } from './gateway'
import { chatText, INBOX_ROW_CHARS, INBOX_ROWS, inboxText } from './views'

const chat = (over: Partial<Chat> = {}): Chat => ({
  id: 'a@s.whatsapp.net',
  name: 'Ana Pop',
  group: false,
  unread: 0,
  clock: '09:36',
  preview: 'Vii maine?',
  ...over,
})

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  sender: 'Ana Pop',
  fromMe: false,
  clock: '09:35',
  text: 'Buna',
  ...over,
})

describe('inboxText', () => {
  const chats = (n: number) => Array.from({ length: n }, (_, i) => chat({ id: `c${i}`, name: `Chat ${i}`, preview: 'hi' }))

  it('shows a position header and one line per chat, with a marker on the selected one', () => {
    expect(inboxText([chat(), chat({ id: 'b', name: 'Familia', preview: 'ok' })], 1).split('\n')).toEqual([
      'Inbox 2/2',
      '  Ana Pop: Vii maine?',
      '> Familia: ok',
    ])
  })

  it('marks unread chats with their count', () => {
    expect(inboxText([chat({ unread: 3 })], 0)).toContain('> (3) Ana Pop: Vii maine?')
  })

  it('keeps every row on one screen line', () => {
    const rows = inboxText([chat({ preview: 'x'.repeat(200) })], 0).split('\n')
    expect(rows[1]).toHaveLength(INBOX_ROW_CHARS)
    expect(rows[1]?.endsWith('...')).toBe(true)
  })

  it('puts a multi-line preview on one line', () => {
    expect(inboxText([chat({ preview: 'unu\ndoi' })], 0)).toContain('> Ana Pop: unu doi')
  })

  it('shows the name alone when there is no preview', () => {
    expect(inboxText([chat({ preview: '' })], 0).split('\n')[1]).toBe('> Ana Pop')
  })

  it('shows a window of rows that fits the screen', () => {
    const rows = inboxText(chats(20), 0).split('\n')
    expect(rows).toHaveLength(1 + INBOX_ROWS)
    expect(rows[1]).toBe('> Chat 0: hi')
  })

  it('scrolls the window so the selected chat stays visible', () => {
    const text = inboxText(chats(20), 12)
    expect(text).toContain('Inbox 13/20')
    expect(text).toContain('> Chat 12: hi')
    expect(text.split('\n')).toHaveLength(1 + INBOX_ROWS)
  })

  it('keeps a full window at the end of the list', () => {
    const rows = inboxText(chats(20), 19).split('\n')
    expect(rows).toHaveLength(1 + INBOX_ROWS)
    expect(rows.at(-1)).toBe('> Chat 19: hi')
  })
})

describe('chatText', () => {
  it('starts with the chat name and lists the newest message first', () => {
    const text = chatText(chat(), [message({ id: 'm1', clock: '09:35', text: 'Buna' }), message({ id: 'm2', clock: '09:36', text: 'Vii?' })], 1000)
    expect(text.split('\n')).toEqual(['Ana Pop', '09:36 Vii?', '09:35 Buna'])
  })

  it('labels my own messages', () => {
    const text = chatText(chat(), [message({ fromMe: true, sender: 'Me', text: 'Da' })], 1000)
    expect(text).toContain('09:35 Me: Da')
  })

  it('names the sender in a group', () => {
    const text = chatText(chat({ group: true, name: 'Familia' }), [message({ sender: 'Ana Pop' })], 1000)
    expect(text).toContain('09:35 Ana Pop: Buna')
  })

  it('drops the oldest messages that do not fit', () => {
    const messages = Array.from({ length: 50 }, (_, i) => message({ id: `m${i}`, text: `message number ${i}` }))
    const text = chatText(chat(), messages, 200)
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text).toContain('message number 49')
    expect(text).not.toContain('message number 0\n')
  })

  it('cuts a single message that is longer than the screen budget', () => {
    const text = chatText(chat(), [message({ text: 'x'.repeat(500) })], 120)
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text.endsWith('...')).toBe(true)
  })

  it('says so when the chat has no messages', () => {
    expect(chatText(chat(), [], 1000)).toBe('Ana Pop\nNo messages')
  })
})
