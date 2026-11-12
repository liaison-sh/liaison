// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D5 write inheritance: the requiredScopes a record written DURING a turn must
// carry. The closed list of scope-tagged sinks is messages, `kernel.agent_memory`
// and `app_knowledge.documents` (spec-security.md, "Scope taint on writes"); the
// message half is the mandatory `requiredScopes` field on the message writes,
// and this module is the same rule for the other two sinks.
//
// Every answer is projected onto the read scopes it implies (scope-taint.ts, rule 5): a
// fallback to an effective scope keeps the widening, never its write or action scopes.
//
// The answer is never guessed. Inside a turn the scopes come from the run
// frame; when the frame is lost (a sandbox bridge callback) they come from the
// frame captured while it was still live. When a turn is running and none of
// those sources knows its taint, the write is REFUSED rather than landing
// untagged, because an untagged row reads as "this turn touched no scoped data"
// to every later reader.
import {
  captureSpawnParentFrame,
  currentRunContext,
  currentToolCallScopesBefore,
  isPersonClientFrame,
  type SpawnParentFrame,
} from "~/modules/agent/runtime/run-context"
import { projectTaintScopes } from "~/modules/agent/scopes/taint-read-scopes"

/** Error code a refused write carries, matching the sandbox bridge's message post. */
export const SCOPE_UNKNOWN_CODE = "scope_unknown"

/** Sorted and deduplicated, so a tag compares and reads identically everywhere. */
export function normalizeRequiredScopes(scopes: string[]): string[] {
  return [...new Set(scopes)].sort()
}

/**
 * The runtime half of the mandatory `requiredScopes` argument (the P2b-T15
 * convention): a missing or non-string-array value throws instead of falling
 * back to a column default. `[]` is a positive assertion that the write carries
 * no scoped data.
 */
export function assertExplicitRequiredScopes(
  requiredScopes: unknown,
  sink: string,
): asserts requiredScopes is string[] {
  if (!Array.isArray(requiredScopes) || requiredScopes.some((s) => typeof s !== "string")) {
    throw new Error(
      `a ${sink} write requires an explicit requiredScopes string array; pass [] only for a write that carries no scoped data`,
    )
  }
}

export function scopeUnknownError(what: string): Error & { code: string } {
  const err = new Error(
    `${SCOPE_UNKNOWN_CODE}: ${what} was called from an agent turn whose scope taint is unknown`,
  ) as Error & { code: string }
  err.code = SCOPE_UNKNOWN_CODE
  return err
}

/**
 * The turn's scopes as seen from INSIDE its ALS frame (a host-side tool
 * handler). Same ladder as the agent message post: the snapshot from before the
 * running tool call recorded its own scope (a write tool's own scope is not a
 * data read), then the accumulator, then the turn's effective scope, then the
 * caller's scopes (a direct call with no frame at all acts with those; every
 * MCP gateway call, agentless included, has a frame since rule 14). `null`
 * means nothing knew: fail closed. A person's own external client's frame
 * stamps `[]`, as a UI write (rule 14f): only its posts carry its window.
 */
export function currentTurnWriteScopes(fallbackScopes?: string[]): string[] | null {
  const frame = currentRunContext()
  // Rule 14f: a person's own external client writes as the person, with the empty stamp.
  if (isPersonClientFrame(frame)) return []
  const known =
    currentToolCallScopesBefore() ??
    frame?.turnScopeAccumulator?.snapshot() ??
    frame?.effectiveScope ??
    fallbackScopes
  return known === undefined ? null : projectTaintScopes(known)
}

/**
 * The same ladder for a callback that LOST the frame, resolved against the
 * frame captured where it was still live (the X4b/Y1 capture pattern). A null
 * captured frame means no turn called this at all (a human request, a job), so
 * the write asserts the empty set; a frame that knows nothing is refused.
 */
export function capturedFrameWriteScopes(
  frame: SpawnParentFrame | null,
  callerScopes?: string[],
  opts?: { keepPersonClientTaint?: boolean },
): string[] | null {
  if (frame === null) return []
  // Rule 14f: a person's own client stamps its writes `[]`. Only the value forwarded to the
  // dispatch keeps the window (`keepPersonClientTaint`), which judges its posts with it.
  if (frame.personClient === true && opts?.keepPersonClientTaint !== true) return []
  const known = frame.taintScopes ?? frame.effectiveScope ?? callerScopes
  return known === undefined ? null : projectTaintScopes(known)
}

/**
 * FX4, the capture half. What a gated tool call's writes WOULD have been tagged
 * with had the call not been deferred for human approval. Read at the moment
 * the approval row is created, which is the last moment the proposing turn's
 * frame exists: the human approves minutes or days later, in another request.
 *
 * The taint is taken WITHOUT the calling tool's own scope, exactly as a
 * knowledge write takes it (`captureSpawnParentFrame()` with no
 * `includeCallingTool`): the gated tool's own write scope is the write itself,
 * not data the turn read, and tagging with it would hide the result from
 * readers who may read but not write.
 *
 * Three answers, all meaningful:
 *   `[]`   no frame at all, so no turn proposed this (a human, a job), or a
 *          person's own external client's frame proposing anything but a post
 *          (rule 14f). The re-entry writes untagged, which is what the call would
 *          have done inline.
 *   scopes the turn's accumulated scopes, seeded back on re-entry.
 *   `null` a turn whose taint is not knowable. Stored as SQL NULL so the
 *          re-entry fails closed instead of asserting the empty set.
 */
export function proposingTurnWriteScopes(opts?: { personClientPost?: boolean }): string[] | null {
  const frame = captureSpawnParentFrame()
  if (frame === null) return []
  // Rule 14f: a person's own client's approval carries `[]` (no narrowing, an untagged
  // re-entry), except a kernel-thread post's, whose re-entry is stamped with the window.
  if (frame.personClient === true && opts?.personClientPost !== true) return []
  const known = frame.taintScopes ?? frame.effectiveScope
  return known === undefined ? null : projectTaintScopes(known)
}

/**
 * FX4, the re-entry half. The scopes an approved re-entry seeds its execution
 * with, from the `proposing_turn_scopes` column written above.
 *
 * A stored array is used as-is, `[]` included: it is the proposing turn's
 * positive assertion that nothing scoped had been read, so an untainted
 * proposal still writes untagged and stays visible.
 *
 * NOTHING stored (SQL NULL: an approval created before migration 0067, or a
 * proposing turn whose taint was not knowable) falls back to the REQUESTER's
 * full scope set, the same fail-closed answer FX1 gave the failBundle notice.
 * It over-tags -- the row is visible only to people who hold what the requester
 * holds -- and over-tagging is the safe direction. It never falls back to `[]`,
 * which would publish the write to the whole room.
 *
 * An UNREADABLE value (present but not a string array) and a missing value with
 * no usable requester scope set are both refused outright: the re-entry throws
 * before the handler runs, so the approval reverts to pending with the reason on
 * the card, and nothing is written untagged.
 */
export function approvalReentryWriteScopes(
  storedProposingTurnScopes: unknown,
  requesterScopes: string[] | undefined,
): string[] {
  if (storedProposingTurnScopes === null || storedProposingTurnScopes === undefined) {
    if (
      !Array.isArray(requesterScopes) ||
      requesterScopes.length === 0 ||
      requesterScopes.some((s) => typeof s !== "string")
    ) {
      throw scopeUnknownError(
        "an approved re-entry with no recorded proposing-turn scopes and no requester scope set to fall back on",
      )
    }
    return normalizeRequiredScopes(requesterScopes)
  }
  if (
    !Array.isArray(storedProposingTurnScopes) ||
    storedProposingTurnScopes.some((s) => typeof s !== "string")
  ) {
    throw scopeUnknownError(
      "an approved re-entry whose recorded proposing-turn scopes are unreadable",
    )
  }
  return normalizeRequiredScopes(storedProposingTurnScopes as string[])
}
