// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * How long an approval may sit at `approving` before it counts as wedged: an
 * execution that died without reporting its outcome, rather than one still
 * running. Far above any handler's real runtime (the sandbox caps a tool's
 * declared budget at 120 s).
 *
 * The server (decide's heal and its stale-request deny, the approving reaper)
 * and the approval card (its "Close stale request" button) read this one value,
 * so the card never offers a close the server then refuses.
 */
export const APPROVING_WEDGE_GRACE_MS = 10 * 60 * 1000

/**
 * True when a claim taken at `claimedAtMs` has been `approving` past the grace
 * window at `nowMs`. An unknown claim time (NaN) counts as wedged on the server,
 * where a row with no claim stamp is a dead one; callers that must not offer an
 * action on missing data check `Number.isFinite` first.
 */
export function isApprovingWedged(claimedAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(claimedAtMs)) return true
  return nowMs - claimedAtMs > APPROVING_WEDGE_GRACE_MS
}
