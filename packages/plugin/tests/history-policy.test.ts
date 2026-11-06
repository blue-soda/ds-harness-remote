import { describe, expect, it } from 'vitest'
import { codexHistoryStatsFileEnabled } from '../src/history-policy.js'

describe('codexHistoryStatsFileEnabled', () => {
  it('is off by default and only explicit truthy values turn it on', () => {
    expect(codexHistoryStatsFileEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    for (const value of ['0', 'false', 'off', 'no', '', '  ']) {
      expect(codexHistoryStatsFileEnabled({ DSH_CODEX_HISTORY_STATS: value } as NodeJS.ProcessEnv)).toBe(false)
    }
    for (const value of ['1', 'true', 'on', 'yes', ' TRUE ']) {
      expect(codexHistoryStatsFileEnabled({ DSH_CODEX_HISTORY_STATS: value } as NodeJS.ProcessEnv)).toBe(true)
    }
  })
})
