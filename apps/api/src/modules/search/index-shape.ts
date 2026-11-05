// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the unified search index should look like: its settings, and a
// fingerprint of the SHAPE of the documents in it.
//
// SETTINGS ARE THE PER-WRITE COST
// -------------------------------
// Every filterable attribute is a facet database Meili updates on every write,
// and on Meili 1.10 a string facet's search structure is rebuilt from all of
// its values. So the list below is the attributes some query filters on and
// nothing else. Measured on a 300k document copy of the production shape
// (Meili 1.10.3, see the W2 report): dropping the two attributes that were
// unique per document (`entity_id`, the self-valued `dedupe_key`) and the two
// nothing filtered on (`author_agent_id`, `participant_agent_ids`) took a
// 1,000 document write from 23.8 s to 3.1 s.
//
//   org_id, app, entity_type, read_scope, participant_ids, is_mentionable
//                         the permission filter and every surface's scoping
//   dedupe_key            Meili `distinct` needs it filterable; only documents
//                         that belong to a group carry it
//   parent_type           a fragment (one mail message) is found when a search
//                         is scoped to its parent's type (service.ts)
//   dimension and ACL fields, per the manifests
//   the transcript's own: required_scopes, thread_id, created_at, has_vector
//
// `entity_id` stays ON every document (it is how a hit names its entity) but is
// not filterable: its one filter, the disclosed-message clause, now narrows by
// the disclosed messages' threads instead (service.ts).
//
// THE SHAPE FINGERPRINT
// ---------------------
// A document built by older code can differ from what the builders produce now
// (a dimension added to a manifest, a field dropped), and settings alone do not
// say so. The fingerprint hashes the settings, every registration's
// document-shaping fields and DOC_SHAPE_VERSION; the rebuild writes it into
// the index it builds (a meta document), and boot compares. A mismatch
// schedules a rebuild into a shadow index; the live index keeps serving.

import { createHash } from "node:crypto"
import { MESSAGE_SEARCH_FILTERABLE_ATTRIBUTES } from "~/modules/search/message-indexer"
import type { SearchableRegistrations } from "~/modules/search/searchable-entities"

/**
 * Bump when any document builder changes what an EXISTING document should
 * contain (a field added, renamed or dropped, a window rule changed): the next
 * boot sees a different fingerprint and rebuilds the index in the background.
 *
 * Bump it too when a migration writes rows the live indexer never saw (it
 * emits no events): the rebuild streams them from Postgres like everything
 * else, once, with the access rules of their kind.
 *
 * 2: windows anchored by id, no self-valued dedupe_key, no agent attributes,
 *    has_vector, mail message fragments.
 * 3: the contact notes migration 0216 copied into contact discussions.
 */
export const DOC_SHAPE_VERSION = 3

const STATIC_FILTERABLE = [
  "org_id",
  "app",
  "entity_type",
  "read_scope",
  "participant_ids",
  "is_mentionable",
  "dedupe_key",
  "parent_type",
]

const STATIC_SEARCHABLE = ["title", "handle", "label_secondary", "body"]
// `created_at` only: memory search's time window filters on it and the
// near-duplicate pass sorts by it. Nothing sorted on `updated_at`.
const STATIC_SORTABLE = ["created_at"]

// The id-resolution projection pages up to this many ranked hits for a single
// text-search entity scope. Meili's own default maxTotalHits is 1000.
const PAGINATION_MAX_TOTAL_HITS = 10_000

export interface SettingsInputs {
  registeredReadScopes: string[]
  dimensionFields: string[]
  aclFieldNames?: string[]
}

/**
 * The full expected Meili settings for the unified search index: the one
 * definition drift detection, the rebuild and the CLI all apply.
 */
export function expectedSettings(args: SettingsInputs) {
  const filterable = new Set<string>(STATIC_FILTERABLE)
  for (const d of args.dimensionFields) filterable.add(d)
  for (const f of args.aclFieldNames ?? []) filterable.add(f)
  // Thread messages are indexed by message-indexer.ts, not as a registered
  // entity, so their attributes arrive through its own exported list.
  for (const a of MESSAGE_SEARCH_FILTERABLE_ATTRIBUTES) filterable.add(a)
  return {
    filterableAttributes: Array.from(filterable),
    sortableAttributes: [...STATIC_SORTABLE],
    searchableAttributes: [...STATIC_SEARCHABLE],
    pagination: { maxTotalHits: PAGINATION_MAX_TOTAL_HITS },
  }
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false
  return true
}

/** True when `actual` (Meili's getSettings) already has every expected setting. */
export function settingsMatch(actual: unknown, expected: ReturnType<typeof expectedSettings>) {
  const a = actual as {
    filterableAttributes?: string[]
    sortableAttributes?: string[]
    searchableAttributes?: string[]
    pagination?: { maxTotalHits?: number }
  } | null
  if (!setsEqual(a?.filterableAttributes ?? [], expected.filterableAttributes)) return false
  if (!setsEqual(a?.sortableAttributes ?? [], expected.sortableAttributes)) return false
  // searchableAttributes is order-sensitive in Meili (ranking precedence).
  const sea = a?.searchableAttributes ?? []
  if (sea.length !== expected.searchableAttributes.length) return false
  for (let i = 0; i < sea.length; i++) if (sea[i] !== expected.searchableAttributes[i]) return false
  return a?.pagination?.maxTotalHits === expected.pagination.maxTotalHits
}

/** The settings inputs a set of searchable registrations calls for. */
export function settingsInputsOf(regs: SearchableRegistrations): Required<SettingsInputs> {
  return {
    registeredReadScopes: [...regs.registeredReadScopes],
    dimensionFields: [...regs.dimensionFields],
    aclFieldNames: [...regs.aclFieldNames],
  }
}

/** JSON with sorted object keys, so a fingerprint does not depend on key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * The shape fingerprint of the index these registrations call for (see the
 * header). Same inputs, same string, in every process, whatever their order.
 * The registrations are the installed catalog's (`catalogSearchInputs`), never
 * whichever orgs a process happens to have registered.
 */
export function searchShapeFingerprintOf(registrations: SearchableRegistrations): string {
  const settings = expectedSettings(settingsInputsOf(registrations))
  const regs = new Map<string, unknown>()
  for (const r of registrations.entities) {
    regs.set(`${r.app}:${r.entityType}`, {
      app: r.app,
      entityType: r.entityType,
      readScope: r.readScope,
      tableName: r.tableName,
      schemaName: r.schemaName,
      indexFields: r.indexFields,
      permissionFields: r.permissionFields,
      indexFilter: r.indexFilter,
      archivedField: r.archivedField,
      mentionable: r.mentionable,
    })
  }
  const shape = {
    v: DOC_SHAPE_VERSION,
    settings: {
      filterable: [...settings.filterableAttributes].sort(),
      sortable: [...settings.sortableAttributes].sort(),
      searchable: settings.searchableAttributes,
      pagination: settings.pagination,
    },
    registrations: [...regs.keys()].sort().map((k) => regs.get(k)),
  }
  return createHash("sha256").update(stableJson(shape)).digest("hex").slice(0, 32)
}

/**
 * The meta document a rebuild writes into the index it builds. Its `org_id`
 * matches no org, and every search filters on `org_id`, so no query returns it.
 */
export const INDEX_META_DOC_ID = "__liaison_index_meta__"

export function indexMetaDocument(
  fingerprint: string,
  catalogVersions?: Record<string, string>,
): Record<string, unknown> {
  return {
    id: INDEX_META_DOC_ID,
    org_id: "__meta__",
    app: "__meta__",
    entity_type: "__meta__",
    read_scope: "__meta__",
    is_mentionable: false,
    shape: fingerprint,
    // The catalog the index was built from: an older release's drift check
    // leaves an index built for a newer catalog alone (drift.ts).
    ...(catalogVersions ? { catalog_versions: JSON.stringify(catalogVersions) } : {}),
    built_at: new Date().toISOString(),
  }
}
