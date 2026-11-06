import { describe, expect, it, vi } from 'vitest'
import { CodexHistoryWindows } from '../src/codex/history-window.js'

function turns() {
  return Array.from({ length: 30 }, (_, index) => ({
    id: `turn-${index + 1}`,
    status: 'completed',
    items: [
      { id: `user-${index}`, type: 'userMessage', text: `m${index}` },
      { id: `assistant-${index}`, type: 'agentMessage', text: `r${index}` },
    ],
  }))
}

describe('CodexHistoryWindows', () => {
  it('loads only the tail full items after indexing every turn, then extends older on demand', async () => {
    const all = turns()
    const call = vi.fn(async (method: string, params: unknown) => {
      const page = params as Record<string, unknown>
      if (method !== 'thread/turns/list') return {}
      if (page.itemsView === 'summary') return { data: all, nextCursor: null }
      if (page.cursor === undefined) return { data: all.slice(5).reverse(), nextCursor: 'older' }
      return { data: all.slice(0, 5).reverse(), nextCursor: null }
    })
    const windows = new CodexHistoryWindows(call, undefined)

    const tail = await windows.window('thread-1', { updatedAt: 1 })
    expect(tail.totalTurns).toBe(30)
    expect(tail.loaded.size).toBe(25)
    expect(tail.history.entries.length).toBeGreaterThan(0)
    expect(tail.olderCursor).toBe('older')
    expect(tail.turnNumbers.get('turn-25')).toBe(25)

    const older = await windows.window('thread-1', { updatedAt: 1 }, tail.history.entries[0]!.event.seq)
    expect(older.loaded.size).toBe(30)
    expect(older.olderCursor).toBeUndefined()
    expect(older.turnNumbers.get('turn-1')).toBe(1)
    expect(older.history.nextTurn).toBe(31)

    for (const history of [tail.history, older.history]) {
      const seqs = history.entries.map(entry => entry.event.seq)
      expect(seqs.every((seq, index) => index === 0 || seq === seqs[index - 1]! + 1)).toBe(true)
    }
  })

  it('loads more turns when the loaded window cannot fill the requested older page', async () => {
    const all = Array.from({ length: 60 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      items: [
        { id: `user-${index}`, type: 'userMessage', text: `m${index}` },
        { id: `assistant-${index}`, type: 'agentMessage', text: `r${index}` },
      ],
    }))
    const call = vi.fn(async (method: string, params: unknown) => {
      const page = params as Record<string, unknown>
      if (method !== 'thread/turns/list') return {}
      if (page.itemsView === 'summary') return { data: all, nextCursor: null }
      if (page.cursor === undefined) return { data: all.slice(35).reverse(), nextCursor: 'one' }
      if (page.cursor === 'one') return { data: all.slice(10, 35).reverse(), nextCursor: 'two' }
      return { data: all.slice(0, 10).reverse(), nextCursor: null }
    })
    const windows = new CodexHistoryWindows(call, undefined)
    const tail = await windows.window('thread-2', { updatedAt: 1 })
    expect(tail.loaded.size).toBe(25)

    // A seq early inside the tail has fewer than 50 surfaces before it, so the
    // page would be short unless the window is extended first.
    const beforeSeq = tail.history.entries[2]!.event.seq
    const extended = await windows.window('thread-2', { updatedAt: 1 }, beforeSeq, 50)
    expect(extended.loaded.size).toBe(50)
    const surfaces = extended.history.entries.filter(entry => entry.event.seq < beforeSeq
      && (entry.event.type === 'user/message'
        || entry.event.type === 'assistant/message'
        || entry.event.type === 'tool/result')).length
    expect(surfaces).toBeGreaterThanOrEqual(50)
  })
})
