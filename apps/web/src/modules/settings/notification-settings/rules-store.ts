// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-app rules of Settings -> Notifications (formerly the Attention
// rules page, Phase 16 Task A8b).
//
// Backed by:
//   GET  /api/apps/manifests/attention-axes      → list of installed apps with
//                                                  declared `kinds` + `filterableAxes`.
//   GET  /api/attention/subscriptions            → current user's rules.
//   POST /api/attention/subscriptions            → create a new rule for a source.
//   PUT  /api/attention/subscriptions/:id        → replace an existing rule.
//   DELETE /api/attention/subscriptions/:id      → remove a rule.
import type { useApi } from "~/modules/shell/ApiContext"

export interface AppAxesRow {
  app: string
  kinds: string[]
  filterableAxes: string[]
}

export interface SubscriptionRule {
  id: string
  source: string
  kinds: string[]
  filters: Record<string, string[]>
  enabled: boolean
}

export interface RuleBody {
  source: string
  kinds: string[]
  filters: Record<string, string[]>
  enabled: boolean
}

type Api = ReturnType<typeof useApi>

export async function fetchAppAxes(api: Api): Promise<AppAxesRow[]> {
  return api.get<AppAxesRow[]>("/apps/manifests/attention-axes")
}

export async function fetchRules(api: Api): Promise<SubscriptionRule[]> {
  return api.get<SubscriptionRule[]>("/attention/subscriptions")
}

export async function createRule(api: Api, body: RuleBody): Promise<{ id: string }> {
  return api.post<{ id: string }>("/attention/subscriptions", body)
}

export async function updateRule(api: Api, id: string, body: RuleBody): Promise<{ id: string }> {
  return api.put<{ id: string }>(`/attention/subscriptions/${id}`, body)
}

/**
 * Toggle the enabled bit for a given source. The "default-on" semantics mean
 * the absence of a rule is "all kinds, all axes". To disable a source, we
 * insert (or update) a single rule with `enabled: false` and no narrowing —
 * the recipient resolver then treats the user as opted-out for that source.
 *
 * Returns the new rule id (or the original on update).
 */
export async function toggleSourceEnabled(
  api: Api,
  existing: SubscriptionRule | undefined,
  source: string,
  enabled: boolean,
): Promise<string> {
  if (existing) {
    const out = await updateRule(api, existing.id, {
      source,
      kinds: existing.kinds,
      filters: existing.filters,
      enabled,
    })
    return out.id
  }
  const out = await createRule(api, {
    source,
    kinds: [],
    filters: {},
    enabled,
  })
  return out.id
}

/**
 * The kinds a rule currently lets through, out of `declared`. No rule, or a
 * rule with no kinds or a "*", lets every declared kind through
 * (subscriptions.ts); a disabled rule lets none.
 */
export function allowedKinds(
  rule: SubscriptionRule | undefined,
  declared: readonly string[],
): Set<string> {
  if (!rule) return new Set(declared)
  if (!rule.enabled) return new Set()
  if (rule.kinds.length === 0 || rule.kinds.includes("*")) return new Set(declared)
  return new Set(declared.filter((k) => rule.kinds.includes(k)))
}

/**
 * Writes the rule that lets `kind` through or not, keeping every other kind
 * as it is. Every declared kind let through again stores no narrowing (an
 * empty kinds list); no kind left means the source is off.
 */
export async function setKindAllowed(
  api: Api,
  existing: SubscriptionRule | undefined,
  source: string,
  declared: readonly string[],
  kind: string,
  allowed: boolean,
): Promise<void> {
  const next = allowedKinds(existing, declared)
  if (allowed) next.add(kind)
  else next.delete(kind)
  const everything = declared.every((k) => next.has(k))
  const body: RuleBody = {
    source,
    kinds: everything || next.size === 0 ? [] : declared.filter((k) => next.has(k)),
    filters: existing?.filters ?? {},
    enabled: next.size > 0,
  }
  if (existing) await updateRule(api, existing.id, body)
  else await createRule(api, body)
}
