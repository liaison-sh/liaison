// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The identity of THIS process, THIS boot (blueprint Task 9.2, spec section 15
// A21).
//
// The two-phase mailbox read protocol hands a `requestId` to a browser and then
// waits on an in-memory promise. That promise lives in one process and dies with
// it, so a request minted before a restart must never be accepted after one: the
// resolver it named no longer exists, and accepting it would settle nothing while
// looking like success.
//
// A random uuid rather than a hostname or a container id, deliberately. The
// property required is "this process, this boot"; a hostname survives a restart
// and would be exactly wrong.
export const INSTANCE_ID = crypto.randomUUID()

/**
 * `<instanceId>:<uuid>`. The responder splits on the FIRST colon. `instanceId`
 * is this process's unless a caller stands in for another one (a test running
 * two instances in one process).
 */
export function mintInstanceScopedId(instanceId: string = INSTANCE_ID): string {
  return `${instanceId}:${crypto.randomUUID()}`
}

/** True when `id` was minted by this process on this boot. */
export function isOwnInstanceScopedId(id: string): boolean {
  const idx = id.indexOf(":")
  if (idx <= 0) return false
  return id.slice(0, idx) === INSTANCE_ID
}
