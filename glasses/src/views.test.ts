import { describe, expect, it } from 'vitest'
import type { Chat, Message } from './gateway'
import { INBOX_ROWS } from './screen'
import {
  BUBBLE_LINE_CHARS,
  chatBubbles,
  INBOX_LINE_CHARS,
  inboxRows,
  MAX_BUBBLES,
  noteRows,
  PAGE_LINE_BUDGET,
} from './views'

const chat = (over: Partial<Chat> = {}): Chat => ({
  id: 'a@s.whatsapp.net',
  name: 'Ana Pop',
  group: false,
  unread: 0,
  clock: '09:36',
  preview: 'Vii maine?',
  lastFromMe: false,
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

describe('inboxRows', () => {
  const chats = (n: number) => Array.from({ length: n }, (_, i) => chat({ id: `c${i}`, name: `Chat ${i}`, preview: 'hi', clock: '10:00' }))
  const texts = (rows: { text: string }[]) => rows.map((row) => row.text)

  it('gives each chat a box: marker, name and time on top, newest text below', () => {
    const rows = inboxRows([chat(), chat({ id: 'b', name: 'Familia', preview: 'ok', clock: '11.11' })], 1)
    expect(texts(rows)).toEqual(['  Ana Pop  09:36\nVii maine?', '> Familia  11.11\nok'])
    expect(rows.map((row) => row.selected)).toEqual([false, true])
  })

  it('says so when the newest message is mine', () => {
    const rows = inboxRows([chat({ lastFromMe: true, preview: 'Ajung in 10 minute' }), chat({ id: 'b' })], 1)
    expect(texts(rows)).toEqual(['  Ana Pop  09:36\nMe: Ajung in 10 minute', '> Ana Pop  09:36\nVii maine?'])
  })

  it('marks unread chats with a star and their count', () => {
    expect(texts(inboxRows([chat({ unread: 3 }), chat({ id: 'b' })], 1))[0]).toBe('* Ana Pop  09:36\nVii maine? (3)')
  })

  it('keeps both lines of a box short enough not to wrap', () => {
    const [row] = inboxRows([chat({ name: 'N'.repeat(80), preview: 'x'.repeat(200) })], 0)
    for (const line of (row?.text ?? '').split('\n')) expect(line.length).toBeLessThanOrEqual(INBOX_LINE_CHARS)
    expect(row?.text).toContain('09:36')
    expect(row?.text.endsWith('...')).toBe(true)
  })

  it('puts a multi-line preview on one line', () => {
    expect(texts(inboxRows([chat({ preview: 'unu\ndoi' })], 0))[0]).toBe('> Ana Pop  09:36\nunu doi')
  })

  it('shows as many boxes as the screen holds', () => {
    const rows = inboxRows(chats(20), 0)
    expect(rows).toHaveLength(INBOX_ROWS)
    expect(rows[0]?.text).toBe('> Chat 0  10:00\nhi')
  })

  it('shows the list one screenful at a time', () => {
    const onPage = (cursor: number) => inboxRows(chats(20), cursor).map((row) => /Chat \d+/.exec(row.text)?.[0])
    expect(onPage(12)).toEqual(['Chat 12', 'Chat 13', 'Chat 14', 'Chat 15'])
    expect(onPage(13)).toEqual(onPage(12))
    expect(onPage(16)).toEqual(['Chat 16', 'Chat 17', 'Chat 18', 'Chat 19'])
    expect(inboxRows(chats(20), 13).filter((row) => row.selected).map((row) => row.text)).toEqual(['> Chat 13  10:00\nhi'])
  })

  it('keeps a full window at the end of the list', () => {
    const rows = inboxRows(chats(20), 19)
    expect(rows).toHaveLength(INBOX_ROWS)
    expect(rows.at(-1)?.text).toBe('> Chat 19  10:00\nhi')
  })

  it('adds selectable link rows after the chats', () => {
    const rows = inboxRows([chat()], 2, ['[Unanswered]', '[All chats]'])
    expect(texts(rows)).toEqual(['  Ana Pop  09:36\nVii maine?', '  [Unanswered]', '> [All chats]'])
  })
})

describe('noteRows', () => {
  it('spreads the lines of a note over the row boxes, two lines each', () => {
    expect(noteRows('one\ntwo\nthree').map((row) => row.text)).toEqual(['one\ntwo', 'three'])
  })

  it('skips blank lines and never needs more boxes than the screen has', () => {
    const rows = noteRows('a\n\nb\nc\nd\ne\nf\ng\nh\ni\nj')
    expect(rows.length).toBeLessThanOrEqual(INBOX_ROWS)
    expect(rows[0]?.text).toBe('a\nb')
  })
})

describe('chatBubbles', () => {
  it('heads each bubble with sender and time and lists messages oldest first', () => {
    const pages = chatBubbles(chat(), [
      message({ id: 'm1', clock: '09:35', text: 'Buna' }),
      message({ id: 'm2', clock: '09:36', text: 'Vii?', fromMe: true, sender: 'Me' }),
    ])
    expect(pages).toEqual([
      [
        { mine: false, text: 'Ana Pop - 09:35\nBuna', lines: 2 },
        { mine: true, text: 'Me - 09:36\nVii?', lines: 2 },
      ],
    ])
  })

  it('wraps long text inside the bubble and counts its lines', () => {
    const [[bubble] = []] = chatBubbles(chat(), [message({ text: 'cuvant '.repeat(20).trim() })])
    const lines = (bubble?.text ?? '').split('\n')
    expect(bubble?.lines).toBe(lines.length)
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(BUBBLE_LINE_CHARS)
    expect(lines.slice(1).join(' ')).toBe('cuvant '.repeat(20).trim())
  })

  it('fills pages up to the line budget, with the newest messages on the last page', () => {
    const messages = Array.from({ length: 10 }, (_, i) => message({ id: `m${i}`, text: `message number ${i}` }))
    const pages = chatBubbles(chat(), messages)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      expect(page.reduce((total, bubble) => total + bubble.lines, 0)).toBeLessThanOrEqual(PAGE_LINE_BUDGET)
      expect(page.length).toBeLessThanOrEqual(MAX_BUBBLES)
    }
    expect(pages.at(-1)?.at(-1)?.text).toContain('message number 9')
    expect(pages[0]?.[0]?.text).toContain('message number 0')
  })

  it('fills the last page first, so the newest messages are never alone on a short page', () => {
    const messages = Array.from({ length: 4 }, (_, i) => message({ id: `m${i}`, text: `m${i}` }))
    const pages = chatBubbles(chat(), messages)
    expect(pages.at(-1)).toHaveLength(MAX_BUBBLES)
    expect(pages[0]).toHaveLength(4 - MAX_BUBBLES)
  })

  it('spreads a message longer than a page over several bubbles', () => {
    const pages = chatBubbles(chat(), [message({ text: 'cuvant '.repeat(120).trim() })])
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(page.reduce((total, bubble) => total + bubble.lines, 0)).toBeLessThanOrEqual(PAGE_LINE_BUDGET)
    expect(pages.flat().map((bubble) => bubble.text.split('\n').slice(1).join(' ')).join(' ')).toBe('cuvant '.repeat(120).trim())
  })

  it('returns no pages for a chat without messages', () => {
    expect(chatBubbles(chat(), [])).toEqual([])
  })
})
