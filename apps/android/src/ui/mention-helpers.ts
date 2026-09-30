import type { ComponentType } from 'react'

/** Which suggestion surface is active: `/` commands or `@` references. */
export type MentionType = 'command' | 'context'

/** The active `/` or `@` token anchored at the composer cursor. */
export interface MentionToken {
  type: MentionType
  /** Continuous characters between the trigger and the cursor. */
  query: string
  /** Index of the trigger character inside the draft; the pick replaces from here. */
  start: number
}

export interface ComposerMentionChip {
  id: string
  icon: ComponentType<{ size?: number; color?: string }>
  label: string
  text: string
}

/**
 * Detect an active `/` or `@` token ending exactly at the cursor.
 * The trigger must sit at line start or right after whitespace, and the query
 * is the continuous (whitespace-free) run between trigger and cursor — so
 * deleting the trigger, or typing past a space, closes the popover naturally.
 */
export function detectMention(text: string, cursor: number): MentionToken | undefined {
  if (cursor <= 0) return undefined
  let index = cursor
  while (index > 0 && !/\s/.test(text.charAt(index - 1))) index -= 1
  if (index >= cursor) return undefined
  const trigger = text.charAt(index)
  if (trigger !== '/' && trigger !== '@') return undefined
  if (index > 0 && !/\s/.test(text.charAt(index - 1))) return undefined
  return { type: trigger === '/' ? 'command' : 'context', query: text.slice(index + 1, cursor), start: index }
}

function matchScore(haystack: string, needle: string): number | undefined {
  const at = haystack.indexOf(needle)
  if (at >= 0) return 1_000 - at + (at === 0 ? 200 : 0)
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index === needle.length) return 100
  }
  return undefined
}

/**
 * Case-insensitive fuzzy filter shared by the `/` and `@` menus: contiguous
 * matches outrank scattered subsequence matches; ties keep input order.
 */
export function filterByQuery<T>(items: T[], query: string, textOf: (item: T) => string[]): T[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return items
  const scored: Array<{ item: T; score: number; order: number }> = []
  items.forEach((item, order) => {
    let best: number | undefined
    for (const text of textOf(item)) {
      const score = matchScore(text.toLowerCase(), needle)
      if (score !== undefined && (best === undefined || score > best)) best = score
    }
    if (best !== undefined) scored.push({ item, score: best, order })
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.map(entry => entry.item)
}

/** Web `@file:`path`` mention grammar. */
export function fileMentionText(path: string, isDirectory?: boolean): string {
  const norm = isDirectory && !path.endsWith('/') ? `${path}/` : path
  return `@file:\`${norm}\` `
}

/** Redact Windows / Unix user paths (e.g. C:\Users\<user>\...) to protect personal information. */
export function maskPersonalPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) return path
  return path
    .replace(/^[A-Za-z]:[\\/](?:HuaweiMoveData[\\/])?Users[\\/][^\\/]+/i, '~')
    .replace(/^\/(?:Users|home)[\\/][^\\/]+/i, '~')
}
