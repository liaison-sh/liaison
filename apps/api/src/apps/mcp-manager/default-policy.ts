// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The connection default policy, applied to one tool. ONE function, read by both the static
// projection (`ToolProjector.registerTools` decides the registry entry's `gated` flag, so the
// approval card fires before the transport is dialed) and the per-call decision
// (`McpRepo.getPolicyForCall`, step (c) after role and per-tool overrides). Both read the
// annotations of the same `tools/list` answer, so they cannot disagree.
//
// The rule (owner decision 2026-10-25):
//   - `auto` runs every call without approval.
//   - `gate_all` parks every call for a human.
//   - `gate_writes` (the default, "Changes need approval") runs a tool the server annotates
//     `readOnlyHint: true` and NOT `destructiveHint: true` without approval. Every other tool
//     parks: writes, destructive tools, tools with no annotations or no readOnlyHint, and tools
//     whose annotations are unknown (not yet listed).
//
// Residual risk: the annotations are the server's own claims. A malicious or compromised
// server can label a write read-only, and a read's arguments still leave Liaison, so a read
// can carry data out. The connection default policy is the admin's trust decision: a server
// they do not trust gets "Every call needs approval" (`gate_all`). Calls stay tainting and
// `externalEffect`, so after a turn read untrusted content even an ungated call parks
// (scopes/taint.ts).

import type { McpToolAnnotations, PerCallDecision } from "./types"

export type ConnectionDefaultPolicy = "auto" | "gate_writes" | "gate_all"

/** True when the server marks the tool read-only and not destructive. */
export function isAnnotatedReadOnly(annotations: McpToolAnnotations | undefined): boolean {
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true
}

/** The connection default's decision for one tool, from its `tools/list` annotations. */
export function connectionDefaultDecision(
  policy: ConnectionDefaultPolicy,
  annotations: McpToolAnnotations | undefined,
): Exclude<PerCallDecision, "deny"> {
  if (policy === "auto") return "auto"
  if (policy === "gate_all") return "gate"
  return isAnnotatedReadOnly(annotations) ? "auto" : "gate"
}

const DEFAULT_POLICIES: readonly ConnectionDefaultPolicy[] = ["auto", "gate_writes", "gate_all"]

/**
 * What each connection default gives one tool. The tools list sends it so the web shows a
 * tool's decision under the default being chosen (the tools review) without restating the
 * rule above.
 */
export function defaultDecisionsFor(
  annotations: McpToolAnnotations | undefined,
): Record<ConnectionDefaultPolicy, Exclude<PerCallDecision, "deny">> {
  const out = {} as Record<ConnectionDefaultPolicy, Exclude<PerCallDecision, "deny">>
  for (const p of DEFAULT_POLICIES) out[p] = connectionDefaultDecision(p, annotations)
  return out
}

/**
 * A tool's decision for a caller no role override matches: its per-tool override when one
 * is set, else the connection default's decision (`McpRepo.getPolicyForCall` steps (b), (c)).
 */
export function effectiveToolDecision(
  policy: ConnectionDefaultPolicy,
  annotations: McpToolAnnotations | undefined,
  overrideDecision: PerCallDecision | null | undefined,
): { effectiveDecision: PerCallDecision; source: "override" | "default" } {
  if (overrideDecision != null) return { effectiveDecision: overrideDecision, source: "override" }
  return { effectiveDecision: connectionDefaultDecision(policy, annotations), source: "default" }
}
