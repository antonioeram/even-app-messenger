import { describe, expect, it } from 'vitest'
import type { Chat, Message } from './gateway'
import { CHAT_LINE_CHARS, CHAT_PAGE_LINES, chatPages, INBOX_ROW_CHARS, INBOX_ROWS, inboxText } from './views'

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
  const chats = (n: number) => Array.from({ length: n }, (_, i) => chat({ id: `c${i}`, name: `Chat ${i}`, preview: 'hi', clock: '10:00' }))

  it('shows a titled header and one line per chat: time, name, text, with a marker on the selected one', () => {
    expect(inboxText('Unanswered', [chat(), chat({ id: 'b', name: 'Familia', preview: 'ok', clock: '11.11' })], 1).split('\n')).toEqual([
      'Unanswered (2)',
      '  09:36 Ana Pop: Vii maine?',
      '> 11.11 Familia: ok',
    ])
  })

  it('marks unread chats with their count', () => {
    expect(inboxText('All chats', [chat({ unread: 3 })], 0)).toContain('> 09:36 (3) Ana Pop: Vii maine?')
  })

  it('keeps every row on one screen line', () => {
    const rows = inboxText('All chats', [chat({ preview: 'x'.repeat(200) })], 0).split('\n')
    expect(rows[1]).toHaveLength(INBOX_ROW_CHARS)
    expect(rows[1]?.endsWith('...')).toBe(true)
  })

  it('puts a multi-line preview on one line', () => {
    expect(inboxText('All chats', [chat({ preview: 'unu\ndoi' })], 0)).toContain('> 09:36 Ana Pop: unu doi')
  })

  it('shows time and name alone when there is no preview', () => {
    expect(inboxText('All chats', [chat({ preview: '' })], 0).split('\n')[1]).toBe('> 09:36 Ana Pop')
  })

  it('shows a window of rows that fits the screen', () => {
    const rows = inboxText('All chats', chats(20), 0).split('\n')
    expect(rows).toHaveLength(1 + INBOX_ROWS)
    expect(rows[1]).toBe('> 10:00 Chat 0: hi')
  })

  it('scrolls the window so the selected chat stays visible', () => {
    const text = inboxText('All chats', chats(20), 12)
    expect(text).toContain('> 10:00 Chat 12: hi')
    expect(text.split('\n')).toHaveLength(1 + INBOX_ROWS)
  })

  it('adds a selectable extra row after the chats', () => {
    const rows = inboxText('Unanswered', [chat()], 1, '[All chats]').split('\n')
    expect(rows).toEqual(['Unanswered (1)', '  09:36 Ana Pop: Vii maine?', '> [All chats]'])
  })

  it('shows the extra row alone when there are no chats', () => {
    expect(inboxText('Unanswered', [], 0, '[All chats]').split('\n')).toEqual(['Unanswered (0)', '> [All chats]'])
  })
})

describe('chatPages', () => {
  it('shows chat name with page position, then time, name and text, newest first', () => {
    const pages = chatPages(chat(), [
      message({ id: 'm1', clock: '09:35', text: 'Buna' }),
      message({ id: 'm2', clock: '09:36', text: 'Vii?' }),
    ])
    expect(pages).toEqual(['Ana Pop 1/1\n09:36 Ana Pop: Vii?\n09:35 Ana Pop: Buna'])
  })

  it('labels my own messages', () => {
    expect(chatPages(chat(), [message({ fromMe: true, sender: 'Me', text: 'Da' })])[0]).toContain('09:35 Me: Da')
  })

  it('wraps a long message at word boundaries', () => {
    const [page] = chatPages(chat(), [message({ text: 'cuvant '.repeat(20).trim() })])
    const lines = (page ?? '').split('\n').slice(1)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(CHAT_LINE_CHARS)
    expect(lines.join(' ')).toBe(`09:35 Ana Pop: ${'cuvant '.repeat(20).trim()}`)
  })

  it('breaks a word that is longer than a line', () => {
    const [page] = chatPages(chat(), [message({ text: 'x'.repeat(100) })])
    for (const line of (page ?? '').split('\n')) expect(line.length).toBeLessThanOrEqual(CHAT_LINE_CHARS)
  })

  it('fills each page with at most a screen of lines and numbers the pages', () => {
    const messages = Array.from({ length: 20 }, (_, i) => message({ id: `m${i}`, text: `message number ${i}` }))
    const pages = chatPages(chat(), messages)
    expect(pages.length).toBe(Math.ceil(20 / CHAT_PAGE_LINES))
    expect(pages[0]?.split('\n')).toHaveLength(1 + CHAT_PAGE_LINES)
    expect(pages[0]).toContain(`Ana Pop 1/${pages.length}`)
    expect(pages[0]).toContain('message number 19')
    expect(pages.at(-1)).toContain('message number 0')
  })

  it('does not split a message across pages when it fits on the next one', () => {
    const filler = Array.from({ length: CHAT_PAGE_LINES - 1 }, (_, i) => message({ id: `f${i}`, text: `f${i}` }))
    const twoLines = message({ id: 'old', text: 'cuvant '.repeat(9).trim() })
    const pages = chatPages(chat(), [twoLines, ...filler])
    expect(pages).toHaveLength(2)
    expect(pages[0]).not.toContain('cuvant')
  })

  it('spreads a message longer than a page over several pages', () => {
    const pages = chatPages(chat(), [message({ text: 'cuvant '.repeat(120).trim() })])
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(page.split('\n').length).toBeLessThanOrEqual(1 + CHAT_PAGE_LINES)
  })

  it('says so when the chat has no messages', () => {
    expect(chatPages(chat(), [])).toEqual(['Ana Pop\nNo messages'])
  })
})
