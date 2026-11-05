// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-org approval-TIGHTENING evaluator (BL-268). The single kernel gate site
// (execute-tool.ts → computeSkipGate) consults `evaluateApprovalPolicy` at
// propose-time: when an enabled policy's conditions match the call, the policy
// ESCALATES the approval requirement — a non-gated action becomes gated, a
// 1-approver action becomes N-eyes.
//
// ⛔ TIGHTEN-ONLY INVARIANT (security): this evaluator can ONLY add or raise an
// approval requirement. The caller composes the result with the built-in gating
// via MAX semantics (`composeGate` below) — a policy can NEVER make a gated
// action non-gated, NEVER lower min_approvers below the built-in default. This
// is the inverse of `evaluateAutoApprove` (which LOOSENS a gate). Fail-OPEN here
// is SAFE because "open" means "tighten more" — the absence of a policy never
// loosens a gate; a missing policy simply leaves the built-in gating untouched.

import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { approvalPolicies } from "~/db/schema/kernel"
import { conditionsPass, type PolicyCondition } from "~/modules/approvals/auto-approve"

export interface EvaluateApprovalPolicyArgs {
  orgId: string
  toolName: string
  appName: string
  params: unknown
}

export interface ApprovalPolicyDecision {
  /** True when a matching policy demands a human approver (escalate non-gated → gated). */
  requireApproval: boolean
  /** Distinct-approver floor demanded by the matching policy (1 = no N-eyes escalation). */
  minApprovers: number
  /** The matching policy's id, when one fired. */
  policyId?: string
  /** Human-readable trigger for the approval-summary line. */
  reason?: string
}

interface LoadedPolicy {
  id: string
  enabled: boolean
  toolName: string
  conditions: PolicyCondition[]
  requireApproval: boolean
  minApprovers: number
}

/**
 * Load EVERY enabled policy that could apply to this call: the exact toolName
 * AND an app-wide `<app>:*` wildcard. Unlike auto-approve (which loosens — so it
 * fail-CLOSED prefers exact over wildcard), tightening composes the MAX across
 * all matches, so we keep both and let `evaluateApprovalPolicy` take the
 * strongest escalation. Fail-open: a load error returns [] and leaves the
 * built-in gating untouched (never loosens).
 */
async function loadPolicies(
  orgId: string,
  toolName: string,
  appName: string,
): Promise<LoadedPolicy[]> {
  const rows = await withSystemDb("approval-policy-load", (db) =>
    db.select().from(approvalPolicies).where(eq(approvalPolicies.orgId, orgId)),
  )
  const wildcard = `${appName}:*`
  return rows
    .filter((r) => r.toolName === toolName || r.toolName === wildcard)
    .map((r) => ({
      id: r.id,
      enabled: r.enabled,
      toolName: r.toolName,
      conditions: (r.conditions as PolicyCondition[]) ?? [],
      requireApproval: r.requireApproval,
      minApprovers: r.minApprovers,
    }))
}

/**
 * Evaluate the org's tightening policies for a tool call. Takes the MAX across
 * every matching enabled policy: requireApproval ORs to true if ANY match
 * requires it; minApprovers is the max demanded. A non-matching call (no policy,
 * disabled, or conditions fail) returns the neutral `{ requireApproval:false,
 * minApprovers:1 }` — which `composeGate` treats as "no escalation".
 */
export async function evaluateApprovalPolicy(
  args: EvaluateApprovalPolicyArgs,
): Promise<ApprovalPolicyDecision> {
  const policies = await loadPolicies(args.orgId, args.toolName, args.appName)
  let requireApproval = false
  let minApprovers = 1
  let policyId: string | undefined
  let reason: string | undefined
  for (const p of policies) {
    if (!p.enabled) continue
    if (!conditionsPass(p.conditions, args.params)) continue
    // MAX semantics — a policy can only RAISE the requirement.
    if (p.requireApproval) requireApproval = true
    if (p.minApprovers > minApprovers) {
      minApprovers = p.minApprovers
      policyId = p.id
      reason = `org policy ${p.toolName} requires ${p.minApprovers} approvers`
    } else if (p.requireApproval && policyId === undefined) {
      policyId = p.id
      reason = `org policy ${p.toolName} requires approval`
    }
  }
  return { requireApproval, minApprovers, policyId, reason }
}

/**
 * TIGHTEN-ONLY composition (the security core). Given the built-in gating and a
 * policy decision, return the effective gating as the MAX of the two. A policy
 * can ADD a gate (builtinGated:false + requireApproval:true → gated:true) and
 * RAISE the approver floor (minApprovers), but can NEVER un-gate or lower it.
 *
 *   effectiveGated     = builtinGated  OR  policy.requireApproval
 *   effectiveMinApprovers = max(builtinMinApprovers, policy.minApprovers)
 *
 * `escalated` is true when the policy STRICTLY tightened beyond the built-in
 * (used to deny the direct-human self-approve bypass for N-eyes).
 */
export function composeGate(
  builtin: { gated: boolean; minApprovers?: number },
  policy: ApprovalPolicyDecision,
): {
  gated: boolean
  minApprovers: number
  escalated: boolean
  policyId?: string
  reason?: string
} {
  const builtinMin = builtin.minApprovers ?? 1
  const gated = builtin.gated || policy.requireApproval
  const minApprovers = Math.max(builtinMin, policy.minApprovers)
  const escalated = (policy.requireApproval && !builtin.gated) || policy.minApprovers > builtinMin
  return {
    gated,
    minApprovers,
    escalated,
    policyId: escalated ? policy.policyId : undefined,
    reason: escalated ? policy.reason : undefined,
  }
}
