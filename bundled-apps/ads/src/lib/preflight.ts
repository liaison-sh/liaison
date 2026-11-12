// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared stage-time preflight plumbing for the ads app's GATED tools.
//
// WHY: a gated call must not be parked for a human when the data it needs is
// missing. Without a manifest `preflight`, the kernel creates the approval
// first and only runs the handler AFTER someone clicks approve, so the agent
// sees a validation failure it could have fixed at call time (and, for
// create_custom_audience, only after an empty audience was already created on
// the live ad account).
//
// Every preflight here wraps the SAME function the handler calls, so the two
// can never drift: the handler keeps throwing its exact message, the preflight
// returns it as a typed tool error.

export interface PreflightRefusal {
  error: { code: string; message: string; retryable: false }
}

export type PreflightOutcome<T = unknown> = ({ ok: true } & T) | PreflightRefusal

/** Build a refusal carrying the handler's own message verbatim. */
export function refuse(code: string, message: string): PreflightRefusal {
  return { error: { code, message, retryable: false } }
}

/** True when the shared checker refused. Narrows the union for both callers. */
export function isRefusal(outcome: { ok: true } | PreflightRefusal): outcome is PreflightRefusal {
  return !("ok" in outcome)
}

/**
 * Handler-side adapter: the handler runs the SAME shared checker and re-throws
 * its refusal as the Error it has always thrown, so observable behaviour on the
 * post-approval path is unchanged.
 */
export function throwIfRefused<T>(outcome: PreflightOutcome<T>): { ok: true } & T {
  if (isRefusal(outcome as { ok: true } | PreflightRefusal)) {
    throw new Error((outcome as PreflightRefusal).error.message)
  }
  return outcome as { ok: true } & T
}

/** Preflight-side adapter: a refusal goes back as a tool error, otherwise allow. */
export function toPreflightResult<T>(outcome: PreflightOutcome<T>): unknown {
  if (isRefusal(outcome as { ok: true } | PreflightRefusal)) {
    return { error: (outcome as PreflightRefusal).error }
  }
  return { ok: true }
}

/**
 * Shared checker for the Google "ad" target id, used by BOTH google_set_status
 * and google_pause. The Google Ads adGroupAd resource name is COMPOSITE:
 * customers/{cid}/adGroupAds/{adGroupId}~{adId}, never a bare ad id. Accept
 * either an explicit ad_group_id + ad_id pair, or an object_id already carrying
 * the "~"-joined composite (e.g. an id echoed back from a prior read).
 *
 * `toolName` only selects the message prefix: the rule itself is one function,
 * so the two tools can never drift.
 */
export function preflightGoogleAdCompositeId(
  toolName: string,
  p: Record<string, unknown>,
): PreflightOutcome<{ adGroupId: string; adId: string; objectId: string }> {
  const adGroupId = p.ad_group_id !== undefined ? String(p.ad_group_id) : undefined
  const adId = p.ad_id !== undefined ? String(p.ad_id) : undefined
  if (adGroupId && adId) {
    return { ok: true, adGroupId, adId, objectId: `${adGroupId}~${adId}` }
  }

  const objectId = p.object_id !== undefined ? String(p.object_id) : ""
  if (objectId.includes("~")) {
    const [ag, ad] = objectId.split("~")
    return { ok: true, adGroupId: ag ?? "", adId: ad ?? "", objectId }
  }

  return refuse(
    "invalid_params",
    `${toolName}: object_type "ad" requires the composite adGroupAd resource id. ` +
      'pass ad_group_id + ad_id (joined internally as "{adGroupId}~{adId}"), or an object_id already in ' +
      '"{adGroupId}~{adId}" composite form',
  )
}
