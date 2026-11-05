// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { SearchIndexFields } from "~/modules/apps/app-registries"
import { isContentSuppressedForRow } from "~/modules/mailbox-crypto/content-suppression"
import { documentId } from "~/modules/search/document-id"
import { buildEnrichmentHelpers, lookupSearchEnrichment } from "~/modules/search/enrichment"
import type { SearchableEntityRegistration } from "~/modules/search/searchable-entities"

/**
 * Single source of truth for turning a searchable entity's row into its Meili
 * document. Used by BOTH the incremental indexer (`indexer.ts`) and the full
 * reindex (`reindex.ts`) — the previous hand-synced duplicate pair (indexer's
 * `buildDocument` + reindex's `buildDoc`, kept in lockstep only by PARITY
 * comments) is retired in favor of this one function (BL-06 class dies
 * structurally: there is no second copy left to drift).
 *
 * Async because enrichment (§3.1 of the unified-search spec) may read the DB
 * to build extra searchable text — e.g. tickets appending contact name/email
 * + message bodies into `body`. Entities with no registered enrichment hook
 * resolve synchronously in practice (no extra await beyond the Promise
 * wrapper), so this stays a drop-in replacement for both call sites.
 */
export function toUnixSeconds(value: unknown): number | null {
  if (value == null) return null
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  if (typeof value === "string" || typeof value === "number") {
    const t = new Date(value).getTime()
    return Number.isFinite(t) ? Math.floor(t / 1000) : null
  }
  return null
}

export async function buildSearchDocument(
  reg: SearchableEntityRegistration,
  orgId: string,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const idField = (row.id as string | undefined) ?? ""
  const doc: Record<string, unknown> = {
    id: documentId(orgId, reg.app, reg.entityType, idField),
    org_id: orgId,
    app: reg.app,
    entity_type: reg.entityType,
    entity_id: idField,
    read_scope: reg.readScope,
    is_mentionable: reg.mentionable !== false,
  }

  // Invariant K, and this is the site that actually leaked. The document TITLE
  // never came from the enrichment hook: it comes from here, reading the mail
  // manifest's `indexFields.title = "subject"`. For freshly ingested mail that
  // column is already NULL, so a test written against fresh ingest would have
  // passed while every reindexed historical conversation carried its plaintext
  // subject into Meili for the whole dual-read window. Suppressing at the
  // generic projection closes both cases at once.
  // The `reg.app` gate is not an optimisation to be tidied away: it keeps this
  // from opening a privileged connection per document for every other app, and
  // it keeps the builder usable with a synthetic org id in unit tests.
  const contentSuppressed =
    reg.app === "mail"
      ? await withPrivilegedDb(orgId, "search-content-suppression", (tx) =>
          isContentSuppressedForRow(tx, orgId, reg.app, reg.entityType, row),
        )
      : false

  const indexFields = reg.indexFields
  if (indexFields?.title) doc.title = contentSuppressed ? null : (row[indexFields.title] ?? null)
  if (indexFields?.handle) doc.handle = row[indexFields.handle] ?? null
  if (indexFields?.labelSecondary) doc.label_secondary = row[indexFields.labelSecondary] ?? null

  // body = the manifest-mapped body field (if any), plus any registered
  // enrichment text appended with a newline separator. An entity with only
  // an enrichment hook and no indexFields.body still gets a body from the
  // hook alone.
  const manifestBody = indexFields?.body ? ((row[indexFields.body] as string | null) ?? null) : null
  const hook = lookupSearchEnrichment(reg.app, reg.entityType)
  let enrichedBody: string | null = null
  let dedupeKey: string | null = null
  if (hook) {
    // Enrichment failures THROW — the caller (indexer job / full reindex)
    // must let this fail the job so BullMQ retries, identical to any other
    // upsert failure. Do NOT catch/swallow here.
    const result = await hook(row, { ...buildEnrichmentHelpers(orgId), contentSuppressed })
    if (typeof result === "string") {
      enrichedBody = result
    } else if (result) {
      enrichedBody = result.bodyExtra ?? null
      dedupeKey = result.dedupeKey ?? null
      if (result.handle !== undefined) doc.handle = result.handle
    }
  }
  // `dedupe_key` groups documents that are facets of ONE logical thing (a
  // ticket's per-reply fragments, a mail conversation and its messages), and
  // human surfaces collapse a group to its best hit with Meili `distinct`. A
  // document that belongs to no group carries NO key: Meili's `distinct` keeps
  // every document without the attribute, so omitting it collapses with
  // nothing, exactly like the old self-valued key did. The self value cost a
  // unique facet value per document (764k of them in production), which Meili
  // 1.10 re-walks on every write to that attribute's facet database.
  if (dedupeKey) doc.dedupe_key = dedupeKey
  // The manifest's extra body text (bodyFields from the row, bodyFrom from its child rows). A
  // suppressed mail row carries none of it, like its title.
  const extraBody = contentSuppressed ? null : bodyFieldsText(indexFields?.bodyFields, row)
  const relatedBody =
    contentSuppressed || !indexFields?.bodyFrom
      ? null
      : await relatedBodyText(reg, orgId, row, indexFields.bodyFrom)
  const bodyParts = [manifestBody, extraBody, relatedBody, enrichedBody].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  )
  if (bodyParts.length > 0) {
    doc.body = bodyParts.join("\n")
  } else if (indexFields?.body) {
    // A manifest declared a body field but the row's value (and any
    // enrichment) was empty/null — preserve the old semantics of emitting
    // `body: null` rather than omitting the key.
    doc.body = null
  }

  const created = toUnixSeconds(row.created_at ?? row.createdAt)
  const updated = toUnixSeconds(row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt)
  if (created !== null) doc.created_at = created
  if (updated !== null) doc.updated_at = updated

  applyPermissionFields(doc, reg, row)

  return doc
}

/** Bound of the extra body text one document carries (bodyFields, and bodyFrom). */
export const EXTRA_BODY_MAX_CHARS = 4000
/** At most this many child rows feed one document's bodyFrom text. */
export const BODY_FROM_MAX_ROWS = 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

/** Distinct non-empty values, newline-joined and capped; null when there are none. */
function joinCapped(values: Array<string | null>): string | null {
  const seen = new Set<string>()
  for (const v of values) if (v) seen.add(v)
  if (seen.size === 0) return null
  return [...seen].join("\n").slice(0, EXTRA_BODY_MAX_CHARS)
}

/**
 * The `indexFields.bodyFields` text of a row: each column's value, or for "column.key" that key
 * of a JSON column (an object, or its JSON text).
 */
export function bodyFieldsText(
  fields: string[] | undefined,
  row: Record<string, unknown>,
): string | null {
  if (!fields || fields.length === 0) return null
  return joinCapped(
    fields.map((f) => {
      const [col, key] = f.split(".", 2) as [string, string | undefined]
      const value = row[col]
      if (key === undefined) return textOf(value)
      let obj: unknown = value
      if (typeof value === "string") {
        try {
          obj = JSON.parse(value)
        } catch {
          return null
        }
      }
      return obj && typeof obj === "object" ? textOf((obj as Record<string, unknown>)[key]) : null
    }),
  )
}

/** Reads the child rows a bodyFrom declares; injectable so the projection is testable without a database. */
export type RelatedRowsReader = (
  orgId: string,
  schemaName: string,
  from: NonNullable<SearchIndexFields["bodyFrom"]>,
  parentId: string,
) => Promise<Array<Record<string, unknown>>>

const readRelatedRows: RelatedRowsReader = async (orgId, schemaName, from, parentId) => {
  const schema = drizzleSql.raw(schemaRef(schemaName))
  const columns = drizzleSql.join(
    from.columns.map((c) => drizzleSql.identifier(c)),
    drizzleSql`, `,
  )
  const rows = await withPrivilegedDb(orgId, "search-body-from", (tx) =>
    tx.execute(drizzleSql`
      SELECT ${columns}
      FROM ${schema}.${drizzleSql.identifier(from.tableName)}
      WHERE org_id = ${orgId}::uuid AND ${drizzleSql.identifier(from.foreignKey)} = ${parentId}::uuid
      LIMIT ${BODY_FROM_MAX_ROWS}
    `),
  )
  return extractRows<Record<string, unknown>>(rows)
}

/**
 * The `indexFields.bodyFrom` text of a row: the declared columns of its child rows in the same
 * app schema (an invoice's line descriptions), deduplicated and capped. Null for an entity
 * outside an app schema or a row without a uuid id.
 */
export async function relatedBodyText(
  reg: SearchableEntityRegistration,
  orgId: string,
  row: Record<string, unknown>,
  from: NonNullable<SearchIndexFields["bodyFrom"]>,
  read: RelatedRowsReader = readRelatedRows,
): Promise<string | null> {
  const id = typeof row.id === "string" ? row.id : ""
  if (!reg.schemaName || !UUID_RE.test(id)) return null
  const rows = await read(orgId, reg.schemaName, from, id)
  return joinCapped(rows.flatMap((r) => from.columns.map((c) => textOf(r[c]))))
}

/**
 * Copy the registration's permission fields from `row` onto `doc`: the one
 * definition of what a document carries for the query-side filter. Exported so
 * a FRAGMENT document (one mail message of a conversation) carries its
 * parent's exact permission fields, read from the parent's row.
 */
export function applyPermissionFields(
  doc: Record<string, unknown>,
  reg: SearchableEntityRegistration,
  row: Record<string, unknown>,
): void {
  const pf = reg.permissionFields ?? {}
  if (pf.participantIdsField && row[pf.participantIdsField] !== undefined) {
    const v = row[pf.participantIdsField]
    // Skip empty/null participant arrays — Meili's `EXISTS` predicate treats
    // empty arrays as present, which makes the permission filter exclude rows
    // that are otherwise visible (e.g. organization-scope docs with no
    // explicit participants but readable via scope grants).
    if (v !== null && !(Array.isArray(v) && v.length === 0)) {
      doc.participant_ids = v
    }
  }
  for (const dim of pf.dimensionFields ?? []) {
    if (row[dim] === undefined) continue
    const v = row[dim]
    // Same treatment for dimension columns: null and empty-array values mean
    // "no dimension set" and must match the filter's `NOT <dim> EXISTS` branch.
    if (v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    doc[dim] = v
  }

  // Generic ACL search primitive (mirrors participant_ids, but with different
  // omission semantics — see below). Field names are declared by the
  // registration; nothing "knowledge"-specific here.
  if (pf.aclFields) {
    const { orgWideField, userIdsField, roleIdsField } = pf.aclFields
    if (row[orgWideField] !== undefined) {
      const orgWide = row[orgWideField]
      // Unlike the dimension arrays, `false` must be emitted — NOT omitted.
      // The filter's `NOT org_wide EXISTS OR org_wide = true OR ...` clause
      // relies on a real `false` value being present to correctly fall
      // through to the acl_user_ids/acl_role_ids disjuncts; omitting it would
      // make `NOT org_wide EXISTS` true and incorrectly grant access.
      if (orgWide !== null) doc[orgWideField] = orgWide
    }
    if (row[userIdsField] !== undefined) {
      const v = row[userIdsField]
      if (v !== null && !(Array.isArray(v) && v.length === 0)) doc[userIdsField] = v
    }
    if (row[roleIdsField] !== undefined) {
      const v = row[roleIdsField]
      if (v !== null && !(Array.isArray(v) && v.length === 0)) doc[roleIdsField] = v
    }
  }
}
