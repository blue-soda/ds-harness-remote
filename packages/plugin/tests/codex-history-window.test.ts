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
  })
})
