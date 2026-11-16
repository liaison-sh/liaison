// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Restricted records (`org_access = 'none'`): what a read of one stamps on the turn.

/**
 * The taint scope of a read of a restricted record (`org_access = 'none'`):
 * `restricted:<app>.<entity>:<id>`. No grant covers it, `*` included; only the record's list
 * does (`kernel.restricted_readers`, read by the taint judgement and the stamping writer).
 */
export const RESTRICTED_SCOPE_PREFIX = "restricted:"

export function isRestrictedScope(scope: unknown): scope is string {
  return typeof scope === "string" && scope.startsWith(RESTRICTED_SCOPE_PREFIX)
}

/** The record kinds a read tool may declare `restrictedRows` for: `<app>.<entity>`, each with
 *  its list function in `kernel.restricted_readers` and `kernel.restricted_among` (0331). */
export const RESTRICTED_ENTITY_KINDS: readonly string[] = [
  "agreements.agreement",
  "knowledge.document",
]

/** The read scope of each record kind: what a reader of the record holds besides the list. */
export const RESTRICTED_KIND_READ_SCOPE: Readonly<Record<string, string>> = {
  "agreements.agreement": "agreements:agreements:read",
  "knowledge.document": "knowledge:documents:read",
}

/**
 * A taint with each restricted scope replaced by its record kind's read scope (deduplicated,
 * sorted): the form a deciding or audience scope takes, since no grant holds a restricted
 * scope. An unknown kind keeps its restricted scope, which nobody holds (fails closed).
 */
export function restrictedAsReadScopes(scopes: readonly string[]): string[] {
  const out = new Set<string>()
  for (const s of scopes) {
    if (!isRestrictedScope(s)) {
      out.add(s)
      continue
    }
    const kind = s.slice(RESTRICTED_SCOPE_PREFIX.length).split(":")[0] ?? ""
    out.add(RESTRICTED_KIND_READ_SCOPE[kind] ?? s)
  }
  return [...out].sort()
}

export function restrictedScope(app: string, entity: string, id: string): string {
  return `${RESTRICTED_SCOPE_PREFIX}${app}.${entity}:${id}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The event families about a record of a restricted kind, keyed `<app>:<entity>`: the record
 * kind, and the `data` key naming the record when the entity id is something else (an
 * agreement's evidence event names it in `agreement_id` when its entity id is a version).
 */
const RESTRICTED_EVENT_FAMILIES: Readonly<Record<string, { kind: string; dataKey?: string }>> = {
  "agreements:agreement": { kind: "agreements.agreement" },
  "agreements:evidence": { kind: "agreements.agreement", dataKey: "agreement_id" },
  "knowledge:document": { kind: "knowledge.document" },
}

/**
 * The restricted scope an event's record would carry, when the event is about a record of a
 * restricted kind; null for every other event. Whether the record is restricted right now is
 * its list function's answer (null when it is open).
 */
export function restrictedScopeOfEvent(event: {
  app?: string
  entity?: string
  entityId?: unknown
  data?: unknown
}): string | null {
  const family = RESTRICTED_EVENT_FAMILIES[`${event.app ?? ""}:${event.entity ?? ""}`]
  if (!family) return null
  const data =
    event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {}
  const uuid = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null)
  const id = (family.dataKey ? uuid(data[family.dataKey]) : null) ?? uuid(event.entityId)
  return id ? `${RESTRICTED_SCOPE_PREFIX}${family.kind}:${id}` : null
}
