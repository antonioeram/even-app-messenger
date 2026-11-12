import { describe, expect, it } from 'vitest'
import type { Chat, Message } from './gateway'
import { chatText, inboxItems, LIST_ITEM_CHARS, LIST_MAX_ITEMS } from './views'

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

describe('inboxItems', () => {
  it('shows name and preview', () => {
    expect(inboxItems([chat()])).toEqual(['Ana Pop: Vii maine?'])
  })

  it('marks unread chats with their count', () => {
    expect(inboxItems([chat({ unread: 3 })])).toEqual(['(3) Ana Pop: Vii maine?'])
  })

  it('keeps every item within the list limit', () => {
    const [item] = inboxItems([chat({ preview: 'x'.repeat(200) })])
    expect(item).toHaveLength(LIST_ITEM_CHARS)
    expect(item?.endsWith('...')).toBe(true)
  })

  it('puts a multi-line preview on one line', () => {
    expect(inboxItems([chat({ preview: 'unu\ndoi' })])).toEqual(['Ana Pop: unu doi'])
  })

  it('shows at most the number of items a list can hold', () => {
    const many = Array.from({ length: 30 }, (_, i) => chat({ id: `c${i}` }))
    expect(inboxItems(many)).toHaveLength(LIST_MAX_ITEMS)
  })

  it('shows the name alone when there is no preview', () => {
    expect(inboxItems([chat({ preview: '' })])).toEqual(['Ana Pop'])
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
