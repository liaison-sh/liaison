// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-org auto-approve engine (Module B). The single kernel gate site
// (execute-tool.ts) consults `evaluateAutoApprove` for a gated tool call: when a
// matching, enabled policy's conditions pass, the actor holds the policy's
// `requiresScope`, AND the sliding-window spend cap has headroom, the gate
// auto-approves instead of raising a human approval. Fail-closed throughout:
// no policy, a disabled policy, a failed condition, a missing scope, or a
// breached window all return `gate`. A call that grants scopes (a routine's
// create or widening update) always returns `gate`.

import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { autoApprovePolicies } from "~/db/schema/kernel"
import { redis } from "~/lib/redis"
import { toolRegistry } from "~/modules/apps/app-registries"
import { hasScope } from "~/modules/permissions/permissions"

export interface PolicyCondition {
  path: string
  op: "lte" | "lt" | "gte" | "gt" | "eq" | "in" | "contains"
  value: unknown
}

export interface PolicyLimits {
  perCallMax?: number
  windowSeconds?: number
  windowMax?: number
}

export interface EvaluateAutoApproveArgs {
  orgId: string
  toolName: string
  appName: string
  params: unknown
  actor: { scopes?: string[]; actorType?: string; userId?: string; orgId?: string }
  /**
   * The calling turn has read untrusted outside text (its thread is tainted: an inbound mail, a
   * web page, a remote tool result). A policy then does not approve a tool whose effect leaves the
   * org unless it opted in (`allowAfterUntrustedContent`). Asked only when a policy matches.
   */
  untrustedTurn?: () => Promise<boolean>
}

export interface AutoApproveDecision {
  decision: "auto_approve" | "gate"
  policyId?: string
  reason?: string
}

interface LoadedPolicy {
  id: string
  enabled: boolean
  conditions: PolicyCondition[]
  limits: PolicyLimits
  requiresScope: string | null
  /** The policy matched through the app-wide `<app>:*` entry, not the tool's own. */
  viaWildcard: boolean
  allowAfterUntrustedContent: boolean
}

/** Load the policy for an exact toolName, falling back to an app-wide `<app>:*`. */
async function loadPolicy(
  orgId: string,
  toolName: string,
  appName: string,
): Promise<LoadedPolicy | null> {
  const rows = await withSystemDb("auto-approve-load", (db) =>
    db.select().from(autoApprovePolicies).where(eq(autoApprovePolicies.orgId, orgId)),
  )
  const exact = rows.find((r) => r.toolName === toolName)
  const wildcard = rows.find((r) => r.toolName === `${appName}:*`)
  const row = exact ?? wildcard
  if (!row) return null
  return {
    id: row.id,
    enabled: row.enabled,
    conditions: (row.conditions as PolicyCondition[]) ?? [],
    limits: (row.limits as PolicyLimits) ?? {},
    requiresScope: row.requiresScope,
    viaWildcard: exact === undefined,
    allowAfterUntrustedContent: row.allowAfterUntrustedContent === true,
  }
}

/** Walk a dotted `path` into a value (e.g. `params.amount.minor`). */
export function resolvePath(root: unknown, path: string): unknown {
  const segments = path.startsWith("params.")
    ? path.slice("params.".length).split(".")
    : path.split(".")
  let cur: unknown = root
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export function compareOp(op: PolicyCondition["op"], actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected
    case "eq":
      return actual === expected
    case "in":
      return Array.isArray(expected) && expected.includes(actual)
    case "contains":
      return (
        (typeof actual === "string" && typeof expected === "string" && actual.includes(expected)) ||
        (Array.isArray(actual) && actual.includes(expected))
      )
    default:
      return false
  }
}

export function conditionsPass(conditions: PolicyCondition[], params: unknown): boolean {
  return conditions.every((c) => compareOp(c.op, resolvePath(params, c.path), c.value))
}

/**
 * Reserve the call's spend against the per-policy **sliding window**, atomically.
 * The window counts cumulative spend (sum of per-call `amount`s) against
 * `windowMax`. It is a sliding-window COUNTER: the current fixed bucket (keyed by
 * `floor(now / windowSeconds)`) plus the previous bucket weighted by how much of
 * it still lies inside the last `windowSeconds`. A fixed window alone let up to
 * 2x `windowMax` through across a bucket boundary; this bounds any
 * `windowSeconds`-long span to `windowMax` (the estimate can only over-count the
 * previous bucket, so it errs towards gating, never towards a larger burst).
 * `INCRBY` then a roll-back+fail if the estimate would breach, lost-update-safe
 * under concurrency. When no window is configured the call is unbounded (the
 * per-call/condition checks already gate it). `amount` defaults to 1 when
 * `params.amount.minor` is absent, so for non-money tools `windowMax` behaves as
 * a per-window call-count cap.
 */
async function reserveLimit(
  orgId: string,
  policyId: string,
  limits: PolicyLimits,
  params: unknown,
): Promise<boolean> {
  // amount = the call's money spend in minor units; defaults to 1 (call-count)
  // for non-money tools that carry no `params.amount.minor`.
  const amount =
    typeof resolvePath(params, "params.amount.minor") === "number"
      ? (resolvePath(params, "params.amount.minor") as number)
      : 1
  if (limits.perCallMax !== undefined && amount > limits.perCallMax) return false
  if (limits.windowMax === undefined || limits.windowSeconds === undefined) return true
  const nowSeconds = Date.now() / 1000
  const bucket = Math.floor(nowSeconds / limits.windowSeconds)
  const key = `aa:${orgId}:${policyId}:${bucket}`
  const total = await redis.incrby(key, amount)
  // Set TTL on first write so the window expires (use 2x the window so the previous bucket is
  // still readable for the sliding estimate).
  if (total === amount) await redis.expire(key, limits.windowSeconds * 2)
  const previousRaw = await redis.get(`aa:${orgId}:${policyId}:${bucket - 1}`)
  const previous = previousRaw === null ? 0 : Number(previousRaw)
  const elapsedFraction = (nowSeconds - bucket * limits.windowSeconds) / limits.windowSeconds
  const estimate = total + (Number.isFinite(previous) ? previous : 0) * (1 - elapsedFraction)
  if (estimate > limits.windowMax) {
    await redis.decrby(key, amount) // roll back the over-budget reservation
    return false
  }
  return true
}

export async function evaluateAutoApprove(
  args: EvaluateAutoApproveArgs,
): Promise<AutoApproveDecision> {
  const policy = await loadPolicy(args.orgId, args.toolName, args.appName)
  if (!policy || !policy.enabled) return { decision: "gate" }
  const shortName = args.toolName.startsWith(`${args.appName}:`)
    ? args.toolName.slice(args.appName.length + 1)
    : args.toolName
  const tool = toolRegistry.get([args.orgId, args.appName, shortName])
  // A call that sets or widens the scopes of something that runs without a person (a routine) hands
  // out a standing capability. No policy approves it: not an app-wide `kernel:*`, not one naming the
  // tool, not one that accepts runs after outside text. A person decides on the approval card, which
  // lists the scopes in plain words. A call that keeps, narrows or sets no scopes is judged as usual.
  if (tool?.grantsScopes && (await tool.grantsScopes(args.params, args.orgId))) {
    return { decision: "gate", policyId: policy.id, reason: "grants_scopes" }
  }
  const impact = tool?.approvalImpact
  // An app-wide `<app>:*` policy covers only org-internal, reversible tools. A tool whose effect
  // leaves the org (sends a mail, replies to a customer, moves money) or that never declared its
  // impact (undeclared reads as external) needs a policy that NAMES it, so a wildcard written for
  // the harmless tools can never wave a send or a payment through.
  if (policy.viaWildcard && impact !== "internal") {
    return { decision: "gate", policyId: policy.id, reason: "wildcard_excludes_external_tool" }
  }
  // A turn that read outside text (an inbound mail, a web page) may be acting on instructions a
  // stranger wrote. An action whose effect leaves the org (or never declared its impact) then
  // waits for a person, unless the policy explicitly accepts unattended runs after such reads.
  if (
    impact !== "internal" &&
    !policy.allowAfterUntrustedContent &&
    args.untrustedTurn &&
    (await args.untrustedTurn())
  ) {
    return { decision: "gate", policyId: policy.id, reason: "untrusted_content_turn" }
  }
  if (policy.requiresScope && !hasScope(policy.requiresScope, args.actor.scopes ?? [])) {
    return { decision: "gate", policyId: policy.id, reason: "actor_lacks_required_scope" }
  }
  if (!conditionsPass(policy.conditions, args.params)) {
    return { decision: "gate", policyId: policy.id, reason: "conditions_failed" }
  }
  const ok = await reserveLimit(args.orgId, policy.id, policy.limits, args.params)
  return ok
    ? { decision: "auto_approve", policyId: policy.id }
    : { decision: "gate", policyId: policy.id, reason: "window_cap" }
}
