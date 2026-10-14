/**
 * The Remote card's authorization decision, kept apart from the component.
 *
 * It lives in its own module so it can be tested without a DOM: `client.ts` touches `window` at module scope, so
 * importing it from a Node test environment fails before any assertion runs.
 */

/**
 * Whether the panel must keep asking for authorization after a device read that **succeeded**.
 *
 * Discovery reports an authorization failure when the local credential cannot be used — see
 * `RemoteClientRuntime.devices`, which used to answer with an empty list instead and thereby told the panel
 * "authorized, just no Hosts". That empty answer is what opened a fresh device on an empty Host list and only
 * reached the sign-in panel after a manual sign-out.
 *
 * Both facts still matter, and only the panel has both: what this installation stores (`authorization.local`,
 * answered from local credentials without touching the Server) and what the read returned. A successful read
 * plus "nothing stored" must not be read as "signed in to an account with no computers", whatever produced it.
 * @param storedLocally - whether a credential is on disk.
 * @param deviceCount - how many Hosts the read returned.
 * @returns true when the panel should keep asking the user to authorize.
 */
export function authorizationStillNeeded(storedLocally: boolean, deviceCount: number): boolean {
  // A Host we can list proves the credential works, whatever the pre-check said: the two can race a sign-in.
  if (deviceCount > 0) return false
  // Nothing to show and nothing stored: this installation has never been authorized, so ask for it.
  return !storedLocally
}
