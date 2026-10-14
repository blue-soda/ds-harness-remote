/**
 * The Remote card's authorization decision, kept apart from the component.
 *
 * It lives in its own module so it can be tested without a DOM: `client.ts` touches `window` at module scope, so
 * importing it from a Node test environment fails before any assertion runs.
 */

/**
 * Whether the panel must keep asking for authorization after a device read that **succeeded**.
 *
 * A successful read is not proof that this installation is authorized. Discovery answers with an empty list
 * while the local credential cannot be used — deliberately, because telling a user who is in the middle of
 * signing in to sign out is a circle they cannot act on. The panel used to read that empty answer as
 * "authorized, just no Hosts" and cleared its sign-in state, so a *fresh* device (nothing stored at all)
 * opened on an empty Host list and only reached the sign-in panel after a manual sign-out and sign-in.
 *
 * Both facts are needed, and only the panel has both: what this installation stores (`authorization.local`,
 * answered from local credentials without touching the Server) and what the read returned.
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
