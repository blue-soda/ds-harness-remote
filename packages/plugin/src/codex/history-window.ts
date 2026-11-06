import type { SafeLogger } from '../logging.js'
import { HISTORY_PAGE_SIZES } from '../history-policy.js'
import {
  isSurfaceEvent,
  projectCodexNativeHistory,
  type CodexNativeHistory,
} from './virtual-harness.js'

/** One Thread's indexed turns plus the full-item window loaded so far. */
export interface CodexHistoryWindow {
  metadata: Record<string, unknown>
  /** turn id -> absolute 1-based turn number, built from the turn summary index. */
  turnNumbers: Map<string, number>
  /** turn id -> first event seq of that turn, from the summary event-count index. */
  turnStartSeq: Map<string, number>
  totalTurns: number
  /** Total projected events across every indexed turn. */
  totalEvents: number
  /** Full-item turns loaded for the current window. */
  loaded: Map<string, Record<string, unknown>>
  history: CodexNativeHistory
  /** Desc cursor for the page older than the oldest loaded turn. */
  olderCursor?: string
  newestTurnId?: string
  updatedAt?: number
  acceptedPageSize?: number
  at: number
}

const PAGE_LIMIT = 25
const MAX_PAGES = 64
const CACHE_TTL_MS = 5 * 60_000
const CACHE_LIMIT = 16

/**
 * Codex history windows: a full turn-summary index (numbers only) plus a
 * tail-first full-item window. A window is filled from the newest turn
 * backwards, extended only when an older page is requested, and appended
 * when a Thread gains turns.
 */
export class CodexHistoryWindows {
  private readonly windows = new Map<string, CodexHistoryWindow>()

  constructor(
    private readonly call: (method: string, params: unknown) => Promise<unknown>,
    private readonly logger?: SafeLogger,
  ) {}

  async window(threadId: string, metadata: Record<string, unknown>, beforeSeq?: number): Promise<CodexHistoryWindow> {
    const updatedAt = typeof metadata.updatedAt === 'number' ? metadata.updatedAt : undefined
    const cached = this.windows.get(threadId)
    const fresh = cached !== undefined
      && (updatedAt === undefined || cached.updatedAt === undefined || cached.updatedAt === updatedAt)
      && Date.now() - cached.at < CACHE_TTL_MS
    if (fresh && cached !== undefined) {
      cached.at = Date.now()
      await this.ensureOlder(threadId, cached, beforeSeq)
      this.logger?.debug('codex history cache hit', {
        threadId,
        turns: cached.loaded.size,
        records: cached.history.entries.length,
      })
      return cached
    }
    if (cached !== undefined) {
      const appended = await this.appendNewTurns(threadId, cached, updatedAt)
      if (appended !== undefined) {
        await this.ensureOlder(threadId, appended, beforeSeq)
        this.remember(threadId, appended)
        this.logger?.debug('codex history cache appended', {
          threadId,
          turns: appended.loaded.size,
          records: appended.history.entries.length,
        })
        return appended
      }
    }
    const built = await this.rebuild(threadId, metadata, cached?.acceptedPageSize)
    await this.ensureOlder(threadId, built, beforeSeq)
    this.remember(threadId, built)
    return built
  }

  private async rebuild(
    threadId: string,
    metadata: Record<string, unknown>,
    acceptedPageSize?: number,
  ): Promise<CodexHistoryWindow> {
    const startedAt = performance.now()
    const index = await this.readTurnIndex(threadId)
    const window: CodexHistoryWindow = {
      metadata,
      turnNumbers: index.numbers,
      turnStartSeq: index.turnStartSeq,
      totalTurns: index.total,
      totalEvents: index.totalEvents,
      loaded: new Map(),
      history: projectCodexNativeHistory({ ...metadata, turns: [] }, `codex:${threadId}`, 'legacy', {
        turnNumbers: index.numbers,
      }),
      ...(typeof metadata.updatedAt === 'number' ? { updatedAt: metadata.updatedAt } : {}),
      ...(acceptedPageSize === undefined ? {} : { acceptedPageSize }),
      at: Date.now(),
    }
    this.logger?.debug('codex history index', {
      threadId,
      turns: index.total,
      pages: index.pages,
      durationMs: Math.round(performance.now() - startedAt),
    })
    await this.loadTail(threadId, window)
    return window
  }

  private async readTurnIndex(threadId: string): Promise<{
    numbers: Map<string, number>
    turnStartSeq: Map<string, number>
    total: number
    totalEvents: number
    pages: number
  }> {
    const numbers = new Map<string, number>()
    const turnStartSeq = new Map<string, number>()
    let total = 0
    let totalEvents = 0
    let pages = 0
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.turnPage(threadId, cursor, 'asc', 'summary')
      pages += 1
      for (const rawTurn of result.turns) {
        const turnId = typeof rawTurn.id === 'string' ? rawTurn.id : undefined
        if (turnId === undefined || numbers.has(turnId)) continue
        total += 1
        numbers.set(turnId, total)
        turnStartSeq.set(turnId, totalEvents)
        totalEvents += projectCodexNativeHistory({ turns: [rawTurn] }, `codex:${threadId}`).entries.length
      }
      cursor = result.nextCursor
      if (cursor === undefined) break
    }
    return { numbers, turnStartSeq, total, totalEvents, pages }
  }

  private async loadTail(threadId: string, window: CodexHistoryWindow): Promise<void> {
    let cursor: string | undefined
    let fetched = 0
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.turnPage(threadId, cursor, 'desc', 'full')
      fetched += result.turns.length
      this.addTurns(window, result.turns)
      cursor = result.nextCursor
      this.project(threadId, window)
      if (surfaceRecords(window.history) >= HISTORY_PAGE_SIZES[0] || cursor === undefined) break
    }
    window.olderCursor = cursor
    this.logger?.debug('codex history tail', {
      threadId,
      turnsFetched: fetched,
      loadedTurns: window.loaded.size,
      records: window.history.entries.length,
      older: window.olderCursor !== undefined,
    })
  }

  private async ensureOlder(threadId: string, window: CodexHistoryWindow, beforeSeq?: number): Promise<void> {
    if (beforeSeq === undefined) return
    let fetched = 0
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const firstSeq = window.history.entries[0]?.event.seq
      if (firstSeq !== undefined && firstSeq < beforeSeq) return
      if (window.olderCursor === undefined) return
      const result = await this.turnPage(threadId, window.olderCursor, 'desc', 'full')
      fetched += result.turns.length
      this.addTurns(window, result.turns)
      window.olderCursor = result.nextCursor
      this.project(threadId, window)
    }
    this.logger?.debug('codex history older', {
      threadId,
      beforeSeq,
      turnsFetched: fetched,
      loadedTurns: window.loaded.size,
    })
  }

  private async appendNewTurns(
    threadId: string,
    cached: CodexHistoryWindow,
    updatedAt?: number,
  ): Promise<CodexHistoryWindow | undefined> {
    if (cached.newestTurnId === undefined) return undefined
    const newer: Record<string, unknown>[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.turnPage(threadId, cursor, 'desc', 'full')
      for (const rawTurn of result.turns) {
        if (typeof rawTurn.id === 'string' && rawTurn.id === cached.newestTurnId) {
          if (newer.length === 0) {
            cached.updatedAt = updatedAt
            cached.at = Date.now()
            return cached
          }
          this.addTurns(cached, [...newer].reverse())
          this.project(threadId, cached)
          cached.updatedAt = updatedAt
          cached.at = Date.now()
          return cached
        }
        newer.push(rawTurn)
      }
      cursor = result.nextCursor
      if (cursor === undefined) return undefined
    }
    return undefined
  }

  private addTurns(window: CodexHistoryWindow, turns: Record<string, unknown>[]): void {
    for (const turn of turns) {
      const turnId = typeof turn.id === 'string' ? turn.id : undefined
      if (turnId === undefined) continue
      if (!window.turnNumbers.has(turnId)) {
        window.totalTurns += 1
        window.turnNumbers.set(turnId, window.totalTurns)
        window.turnStartSeq.set(turnId, window.totalEvents)
        window.totalEvents += projectCodexNativeHistory({ turns: [turn] }, window.history.header.id).entries.length
      }
      window.loaded.set(turnId, turn)
    }
  }

  private project(threadId: string, window: CodexHistoryWindow): void {
    const turns = [...window.loaded.entries()]
      .sort((left, right) => (window.turnNumbers.get(left[0]) ?? 0) - (window.turnNumbers.get(right[0]) ?? 0))
      .map(([, turn]) => turn)
    const first = [...window.loaded.keys()]
      .sort((left, right) => (window.turnNumbers.get(left) ?? 0) - (window.turnNumbers.get(right) ?? 0))[0]
    const startSeq = first === undefined ? 0 : window.turnStartSeq.get(first) ?? 0
    const history = projectCodexNativeHistory({ ...window.metadata, turns }, `codex:${threadId}`, 'legacy', {
      seq: startSeq,
      turnNumbers: window.turnNumbers,
    })
    history.nextTurn = window.totalTurns + 1
    window.history = history
    const newest = [...window.turnNumbers.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
    if (newest !== undefined) window.newestTurnId = newest
  }

  private async turnPage(
    threadId: string,
    cursor: string | undefined,
    direction: 'asc' | 'desc',
    itemsView: 'full' | 'summary',
  ): Promise<{ turns: Record<string, unknown>[]; nextCursor?: string }> {
    const result = await this.call('thread/turns/list', {
      threadId,
      limit: PAGE_LIMIT,
      sortDirection: direction,
      itemsView,
      ...(cursor === undefined ? {} : { cursor }),
    })
    const page = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {}
    const turns = Array.isArray(page.data) ? page.data.filter((turn): turn is Record<string, unknown> => (
      typeof turn === 'object' && turn !== null && !Array.isArray(turn)
    )) : []
    const nextCursor = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined
    return { turns, nextCursor }
  }

  private remember(threadId: string, window: CodexHistoryWindow): void {
    if (this.windows.size >= CACHE_LIMIT && !this.windows.has(threadId)) {
      const oldest = this.windows.keys().next().value
      if (oldest !== undefined) this.windows.delete(oldest)
    }
    this.windows.set(threadId, window)
  }
}

function surfaceRecords(history: CodexNativeHistory): number {
  return history.entries.filter(entry => isSurfaceEvent(entry.event.type) && entry.event.surfaceOp === 'append').length
}
