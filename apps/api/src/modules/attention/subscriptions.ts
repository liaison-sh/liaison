// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16 Task A2 — evaluator + thin CRUD for `kernel.attention_subscriptions`.
//
// Semantics summary:
//
//   default-on: if the user has *zero* rules for the event's source, every
//   candidate event for that source passes (subscriptions narrow, they do not
//   widen).
//
//   Once any rule for the source (matched or '*') exists, narrowing kicks in:
//     - the rule's `kinds` must include the event's kind (or '*');
//     - every key in the rule's `filters` must hold against the event's
//       `axes`. Within an axis, multiple allowed values are OR-ed; across
//       axes the relation is AND.
//   A rule with `enabled = false` participates in the "has any rule" check
//   (so disabling a rule does *not* fall back to default-on) but cannot match.
//
//   OR across multiple rules: a single matching rule is enough.
import { and, eq, inArray, or } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { attentionSubscriptions } from "~/db/schema/kernel"

/**
 * Either DB handle works for reads here: routes pass an `RlsClient` (RLS keys
 * the rule rows to `app.user_id`), while the translator passes a `PrivilegedDb`
 * (it must evaluate rules for arbitrary candidate recipients, not just the
 * current request's user, so it bypasses RLS and filters by `userId` itself).
 */
type SubscriptionDb = RlsClient | PrivilegedDb

export interface EvaluateSubscriptionArgs {
  userId: string
  source: string
  kind: string
  axes: Record<string, string | undefined>
}

interface RuleRow {
  source: string
  kinds: string[]
  filters: Record<string, string[]>
  enabled: boolean
}

/** Rule row plus the userId it belongs to — the shape the D2 batch loader returns. */
interface UserRuleRow extends RuleRow {
  userId: string
}

export async function loadRulesForUser(
  db: SubscriptionDb,
  userId: string,
  source: string,
): Promise<RuleRow[]> {
  const rows = await db
    .select({
      source: attentionSubscriptions.source,
      kinds: attentionSubscriptions.kinds,
      filters: attentionSubscriptions.filters,
      enabled: attentionSubscriptions.enabled,
    })
    .from(attentionSubscriptions)
    .where(
      and(
        eq(attentionSubscriptions.userId, userId),
        or(eq(attentionSubscriptions.source, source), eq(attentionSubscriptions.source, "*"))!,
      ),
    )
  return rows as RuleRow[]
}

export function ruleMatches(rule: RuleRow, args: EvaluateSubscriptionArgs): boolean {
  if (!rule.enabled) return false
  const kinds = rule.kinds
  // An empty kinds array is treated as a wildcard: a rule that was re-enabled
  // without specifying kinds must not silently keep the source muted.
  if (kinds.length > 0 && !kinds.includes("*") && !kinds.includes(args.kind)) return false
  const filters = rule.filters
  for (const [axis, allowed] of Object.entries(filters)) {
    const value = args.axes[axis]
    if (value === undefined || !allowed.includes(value)) {
      return false
    }
  }
  return true
}

export async function evaluateSubscription(
  db: SubscriptionDb,
  args: EvaluateSubscriptionArgs,
): Promise<boolean> {
  const rules = await loadRulesForUser(db, args.userId, args.source)
  return evaluateSubscriptionDecision(rules, args)
}

/**
 * D2 batching — pure (no DB) decision helper: identical semantics to
 * `evaluateSubscription`, but takes an already-loaded rule set instead of
 * querying for it. Lets the translator batch-load rules for every candidate
 * in ONE query (`defaultLoadSubscriptionRulesBatch`) and then evaluate each
 * candidate's decision in memory, instead of one privileged transaction per
 * candidate.
 */
export function evaluateSubscriptionDecision(
  rules: RuleRow[],
  args: Pick<EvaluateSubscriptionArgs, "kind" | "axes">,
): boolean {
  if (rules.length === 0) return true // default-on
  for (const r of rules) {
    if (ruleMatches(r, args as EvaluateSubscriptionArgs)) return true
  }
  return false
}

/**
 * D2 batching — production default for a batched rule load: ONE query for
 * every unique candidate userId (`user_id = ANY($ids) AND source IN
 * ($source, '*')`) instead of one `loadRulesForUser` transaction per
 * candidate. Rows are grouped by `userId` so the caller can evaluate each
 * candidate's decision via `evaluateSubscriptionDecision` without further
 * DB access. Candidates absent from the result set have zero rules (i.e.
 * default-on), matching `loadRulesForUser`'s per-user behavior exactly.
 */
export async function loadRulesForUsersBatch(
  db: SubscriptionDb,
  userIds: string[],
  source: string,
): Promise<Map<string, RuleRow[]>> {
  const out = new Map<string, RuleRow[]>()
  if (userIds.length === 0) return out
  const rows = (await db
    .select({
      userId: attentionSubscriptions.userId,
      source: attentionSubscriptions.source,
      kinds: attentionSubscriptions.kinds,
      filters: attentionSubscriptions.filters,
      enabled: attentionSubscriptions.enabled,
    })
    .from(attentionSubscriptions)
    .where(
      and(
        inArray(attentionSubscriptions.userId, userIds),
        or(eq(attentionSubscriptions.source, source), eq(attentionSubscriptions.source, "*"))!,
      ),
    )) as UserRuleRow[]
  for (const row of rows) {
    const existing = out.get(row.userId)
    if (existing) existing.push(row)
    else out.set(row.userId, [row])
  }
  return out
}

// --- thin CRUD (used by REST routes in Task A8a) ---

export interface SubscriptionRulePatch {
  source: string
  kinds: string[]
  filters: Record<string, string[]>
  enabled: boolean
}

export async function listForUser(db: RlsClient, userId: string) {
  return db.select().from(attentionSubscriptions).where(eq(attentionSubscriptions.userId, userId))
}

export async function upsertRule(
  db: RlsClient,
  userId: string,
  patch: SubscriptionRulePatch,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(attentionSubscriptions)
    .values({
      userId,
      source: patch.source,
      kinds: patch.kinds,
      filters: patch.filters,
      enabled: patch.enabled,
    })
    .returning({ id: attentionSubscriptions.id })
  return { id: row!.id }
}

export async function deleteRule(
  db: RlsClient,
  userId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  const out = await db
    .delete(attentionSubscriptions)
    .where(and(eq(attentionSubscriptions.id, id), eq(attentionSubscriptions.userId, userId)))
    .returning({ id: attentionSubscriptions.id })
  return { deleted: out.length > 0 }
}
