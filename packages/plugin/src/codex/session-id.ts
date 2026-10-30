import { codexThreadIdFromKey } from '@dsh-remote/client-core'
import { RpcError } from '../safe-error.js'

const SESSION_PREFIX = 'codex:'

/**
 * Parse the public CodeX session identity without treating it as a Harness agent id.
 *
 * The identity is `codex:<threadId>` and nothing else: the thread id is what every
 * App Server method expects, and it round-trips through a Client unchanged. A row key
 * from the release that published `<threadId>~<createdAt>~<n>` still resolves to its
 * thread, so a Client built against that release keeps working; nothing emits one.
 * @param value - the Session id a Client sent.
 * @returns the Session id and its thread id, or undefined when it is not a CodeX id.
 */
export function parseCodexSessionId(value: unknown): { sessionId: string; threadId: string } | undefined {
  if (typeof value !== 'string' || !value.startsWith(SESSION_PREFIX)) return undefined
  const threadId = codexThreadIdFromKey(value.slice(SESSION_PREFIX.length))
  return threadId === undefined ? undefined : { sessionId: value, threadId }
}

export function requireCodexSessionId(value: unknown): { sessionId: string; threadId: string } {
  const parsed = parseCodexSessionId(value)
  if (parsed === undefined) throw new RpcError('CODEX_SESSION_INVALID', 'The CodeX session identifier is invalid.')
  return parsed
}

/**
 * Resolve a Client-supplied thread key to the id an upstream call must carry.
 *
 * `thread/read`, `thread/resume` and the rest take a thread id; a legacy row key in
 * that position would reach the App Server verbatim and be refused. Anything that is
 * not a recognisable key is returned unchanged, so this never turns a malformed id
 * into a different one.
 * @param key - `params.threadId` as the Client sent it.
 * @returns the real thread id.
 */
export function resolveCodexThreadKey(key: string): string {
  return codexThreadIdFromKey(key) ?? key
}
