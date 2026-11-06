import { MAX_SECURE_MESSAGE_BYTES } from '@dsh-remote/protocol'

/**
 * The one history page-size ladder for every path.
 *
 * A first paint starts at 50 messages and steps down only when the encoded page
 * would not fit the secure budget: 50/30/20/12/6/3/1. Both Harness (DS) history
 * and Codex history read from this list, so a size is never hard-coded twice.
 */
export const HISTORY_PAGE_SIZES = [50, 30, 20, 12, 6, 3, 1] as const

/** Envelope bytes an RPC response adds around the result it carries. */
export const RESPONSE_ENVELOPE_BYTES = 8 * 1024

/** Bytes one unary history page may use inside the secure channel. */
export const HISTORY_BUDGET_BYTES = MAX_SECURE_MESSAGE_BYTES - RESPONSE_ENVELOPE_BYTES

/** The ladder for one page, starting at `start` and continuing with every smaller step. */
export function historyPageSizes(start: number = HISTORY_PAGE_SIZES[0]): number[] {
  const sizes: number[] = [start]
  for (const size of HISTORY_PAGE_SIZES) if (size < start) sizes.push(size)
  return sizes
}
