// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The nightly storage estimate of a managed org: what it really occupies, not
// only its stored files (the bytes the plan's storage cap refuses uploads on):
// mail bodies and headers, ticket bodies, conversations, knowledge documents,
// thumbnails and its share of the search index. Shown on the Usage page and in
// the plan usage sent to Control. It warns (the org's admins through the
// attention pipeline, Control on the crossing), and it never blocks anything.
//
// CHEAP BY CONSTRUCTION. No counter on any write. One org at a time, one short
// statement per table with a statement timeout, a pause between orgs, a time
// budget for the night; the orgs measured longest ago go first, so a cell the
// budget cuts short finishes them the next night. Per table and org: the row
// count from the org's index, and the average size of at most SAMPLE_ROWS rows.
// `pg_column_size` reads a stored value's size from the row without fetching
// it from TOAST, so a sample costs at most a few hundred heap pages and no body
// is read, sealed or not. An index's share comes from the catalog size
// functions, once per run per table. Thumbnails have no stored size, so they
// count at a typical size; the search share is the org's documents times the
// database's bytes per document. Hence: an estimate, and the UI says so.
//
// SELF-HOSTED: it does not run. Its purpose is a plan's cap and Control; a
// self-hosted operator has neither, sees the real disk, and should not pay for
// a nightly job with no reader. The operator's storage cap on files is unchanged.

import { sql as drizzleSql, eq, isNull } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { organizations, orgBillingState, type StorageEstimate } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { effectiveIndexName, getMeili } from "~/infra/search/client"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { serverT } from "~/modules/i18n/server-i18n"
import { enqueue } from "~/modules/liaison-team/outbox"
import { capOf, normalizeCaps, orgLocale, uuidFrom } from "~/modules/org/caps"
import { orgSearchFilter } from "~/modules/org/purge/external"

const log = rootLogger.child({ module: "storage-estimate" })

/** Rows sampled per table and org; an org with fewer is measured exactly. */
export const SAMPLE_ROWS = 300
/** A row's fixed columns and header, beside the columns that vary. */
const ROW_OVERHEAD_BYTES = 120
/** A typical `.thumb.webp` (modules/files/thumbnail-job.ts); no stored size to read. */
export const THUMBNAIL_BYTES = 30 * 1024
const STATEMENT_TIMEOUT = "15s"
const PAUSE_BETWEEN_ORGS_MS = 100
/** The night's budget; the orgs left wait for the next night, first in line. */
const RUN_BUDGET_MS = 45 * 60_000
const GB = 1024 ** 3

type RowPart = "mail" | "tickets" | "conversations" | "knowledge"

interface Source {
  part: RowPart
  schema: string
  table: string
  /** The columns whose size varies: bodies, headers, addresses. */
  columns: string[]
}

const SOURCES: Source[] = [
  {
    part: "mail",
    schema: "app_mail",
    table: "messages",
    columns: [
      "text_body",
      "html_body",
      "raw_headers",
      "snippet",
      "subject",
      "message_references",
      "from_address",
      "to_addresses",
      "cc_addresses",
      "bcc_addresses",
      "labels",
    ],
  },
  {
    part: "mail",
    schema: "app_mail",
    table: "drafts",
    columns: ["text_body", "html_body", "subject", "to", "cc", "bcc"],
  },
  {
    part: "tickets",
    schema: "app_tickets",
    table: "messages",
    columns: [
      "text_body",
      "html_body",
      "snippet",
      "subject",
      "to_emails",
      "cc_emails",
      "header_references",
    ],
  },
  {
    part: "conversations",
    schema: "kernel",
    table: "messages",
    columns: ["content", "mentions", "metadata"],
  },
  { part: "knowledge", schema: "app_knowledge", table: "documents", columns: ["title", "body"] },
]

const relOf = (s: Source) => `${schemaRef(s.schema)}.${s.table}`

/** A table's size on disk grows by its indexes: index bytes per table byte, 0 when unknown. */
export type IndexRatios = Map<Source, number>

/** Per run: which tables exist on this server and their index share, from the catalog. */
async function tableIndexRatios(): Promise<IndexRatios> {
  const out: IndexRatios = new Map()
  for (const s of SOURCES) {
    const rel = relOf(s)
    try {
      const [row] = await withSystemDb("storage-estimate-tables", async (db) =>
        extractRows<{ ratio: number | null; present: boolean }>(
          await db.execute(drizzleSql`
            SELECT to_regclass(${rel}) IS NOT NULL AS present,
                   CASE WHEN to_regclass(${rel}) IS NULL THEN NULL
                        ELSE pg_indexes_size(to_regclass(${rel}))::float8
                             / NULLIF(pg_table_size(to_regclass(${rel})), 0) END AS ratio`),
        ),
      )
      if (row?.present) out.set(s, Number(row.ratio ?? 0))
    } catch (err) {
      log.warn({ err, table: rel }, "storage estimate: could not read the table's size")
      out.set(s, 0)
    }
  }
  return out
}

/** One table's estimate for one org: rows x (sampled average + overhead) x (1 + index share). */
export function tableBytes(rows: number, avgColumns: number, indexRatio: number): number {
  return Math.round(rows * (avgColumns + ROW_OVERHEAD_BYTES) * (1 + indexRatio))
}

async function measureSource(orgId: string, s: Source, indexRatio: number): Promise<number> {
  const rel = drizzleSql.raw(relOf(s))
  const size = drizzleSql.raw(
    s.columns.map((c) => `COALESCE(pg_column_size("${c}"), 0)`).join(" + "),
  )
  const [row] = await withSystemDb("storage-estimate-table", async (db) => {
    await db.execute(drizzleSql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`))
    return extractRows<{ n: string; avg: number | null }>(
      await db.execute(drizzleSql`
        SELECT (SELECT count(*) FROM ${rel} WHERE org_id = ${orgId}::uuid)::text AS n,
               (SELECT avg(b)::float8
                  FROM (SELECT ${size} AS b FROM ${rel} WHERE org_id = ${orgId}::uuid
                         LIMIT ${SAMPLE_ROWS}) sampled) AS avg`),
    )
  })
  return tableBytes(Number(row?.n ?? 0), Number(row?.avg ?? 0), indexRatio)
}

async function measureFiles(orgId: string): Promise<{ files: number; thumbnails: number }> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const [row] = await withSystemDb("storage-estimate-files", async (db) => {
    await db.execute(drizzleSql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`))
    return extractRows<{ bytes: string; thumbs: string }>(
      await db.execute(drizzleSql`
        SELECT COALESCE(SUM(size_bytes), 0)::text AS bytes, count(thumbnail_key)::text AS thumbs
          FROM ${k}.files WHERE org_id = ${orgId}::uuid`),
    )
  })
  return { files: Number(row?.bytes ?? 0), thumbnails: Number(row?.thumbs ?? 0) * THUMBNAIL_BYTES }
}

/** The search database's bytes per document, null when it cannot be read (the run goes on). */
async function searchBytesPerDocument(): Promise<number | null> {
  try {
    const stats = await getMeili().getStats()
    const docs = Object.values(stats.indexes).reduce((sum, i) => sum + i.numberOfDocuments, 0)
    return docs > 0 ? stats.databaseSize / docs : 0
  } catch (err) {
    log.warn({ err }, "storage estimate: the search index could not be measured")
    return null
  }
}

async function measureSearch(orgId: string, perDocument: number | null): Promise<number | null> {
  if (perDocument === null) return null
  try {
    const page = await getMeili()
      .index(effectiveIndexName())
      .getDocuments({ filter: orgSearchFilter(orgId), limit: 1, fields: ["id"] })
    return Math.round(page.total * perDocument)
  } catch (err) {
    log.warn({ err, orgId }, "storage estimate: the org's search documents could not be counted")
    return null
  }
}

/** One org's estimate, everything it could measure; a part that failed leaves `partial`. */
export async function estimateOrgStorage(
  orgId: string,
  run: { ratios: IndexRatios; searchPerDocument: number | null },
  now: Date,
): Promise<Omit<StorageEstimate, "overCap">> {
  const parts: StorageEstimate["parts"] = {
    files: 0,
    thumbnails: 0,
    mail: 0,
    tickets: 0,
    conversations: 0,
    knowledge: 0,
    search: null,
  }
  let partial = false
  try {
    Object.assign(parts, await measureFiles(orgId))
  } catch (err) {
    partial = true
    log.warn({ err, orgId }, "storage estimate: files could not be measured")
  }
  for (const [source, ratio] of run.ratios) {
    try {
      parts[source.part] += await measureSource(orgId, source, ratio)
    } catch (err) {
      partial = true
      log.warn(
        { err, orgId, table: relOf(source) },
        "storage estimate: a table could not be measured",
      )
    }
  }
  parts.search = await measureSearch(orgId, run.searchPerDocument)
  if (parts.search === null) partial = true
  const bytes = Math.min(
    Object.values(parts).reduce<number>((sum, n) => sum + (n ?? 0), 0),
    Number.MAX_SAFE_INTEGER,
  )
  return { bytes, parts, measuredAt: now.toISOString(), partial }
}

export type EstimateCrossing = "none" | "over" | "back"

/** What a new measure means for the warnings: told once per crossing, re-armed when it falls back. */
export function estimateCrossing(wasOver: boolean, isOver: boolean): EstimateCrossing {
  if (isOver === wasOver) return "none"
  return isOver ? "over" : "back"
}

/** Above the plan's cap. A part that failed only makes the total smaller, so a partial total over the cap is over. */
export function isOverCap(bytes: number, capBytes: number | null): boolean {
  return capBytes !== null && bytes > capBytes
}

const roundGb = (bytes: number) => Math.ceil((bytes / GB) * 100) / 100

/** Stores the measure; on a crossing also queues the warnings, in the same transaction. */
async function recordEstimate(
  orgId: string,
  estimate: Omit<StorageEstimate, "overCap">,
  wasOver: boolean,
  capBytes: number | null,
  capGb: number | null,
  now: Date,
): Promise<void> {
  // A partial measure can only prove an org over its cap, never back under it.
  const isOver = isOverCap(estimate.bytes, capBytes) || (estimate.partial && wasOver)
  const crossing = estimateCrossing(wasOver, isOver)
  const day = now.toISOString().slice(0, 10)
  const summary =
    crossing === "over"
      ? serverT(await orgLocale(orgId), "kernel.orgUsage.noticeStorageEstimateOver", {
          used: roundGb(estimate.bytes),
          limit: capGb ?? 0,
        })
      : null
  await withSystemDb("storage-estimate-record", async (db) => {
    if (crossing !== "none") {
      await enqueue(db, "storage.estimate", {
        requestId: uuidFrom(`storage.estimate|${orgId}|${day}|${crossing}`),
        orgId,
        day,
        estimatedBytes: estimate.bytes,
        capBytes,
        over: isOver,
      })
    }
    if (summary !== null) {
      await db.queueEvent({
        app: "kernel",
        entity: "org_cap",
        action: "threshold",
        entityId: uuidFrom(`${orgId}|storageEstimate|100|${day}`),
        orgId,
        actorType: "system",
        actorId: null,
        timestamp: now.toISOString(),
        data: {
          cap: "storageEstimate",
          threshold: 100,
          used: roundGb(estimate.bytes),
          limit: capGb,
          summary,
          settingsRoute: "/settings/admin/org",
        },
      })
    }
    await db
      .update(orgBillingState)
      .set({ storageEstimate: { ...estimate, overCap: isOver } })
      .where(eq(orgBillingState.orgId, orgId))
  })
}

/** Tonight's measures of the cell's open orgs. Managed edition only; returns the orgs measured. */
export async function runStorageEstimates(
  now = new Date(),
  opts: { pauseMs?: number; budgetMs?: number } = {},
): Promise<number> {
  if (!isManagedEdition()) return 0
  const pauseMs = opts.pauseMs ?? PAUSE_BETWEEN_ORGS_MS
  const budgetMs = opts.budgetMs ?? RUN_BUDGET_MS
  const started = Date.now()
  const orgs = await withSystemDb("storage-estimate-orgs", (db) =>
    db
      .select({
        orgId: orgBillingState.orgId,
        previous: orgBillingState.storageEstimate,
        caps: organizations.caps,
      })
      .from(orgBillingState)
      .innerJoin(organizations, eq(organizations.id, orgBillingState.orgId))
      .where(isNull(orgBillingState.closedAt))
      .orderBy(drizzleSql`${orgBillingState.storageEstimate}->>'measuredAt' ASC NULLS FIRST`),
  )
  const run = {
    ratios: await tableIndexRatios(),
    searchPerDocument: await searchBytesPerDocument(),
  }
  let measured = 0
  for (const org of orgs) {
    if (Date.now() - started > budgetMs) {
      log.warn(
        { left: orgs.length - measured },
        "storage estimate: the night's budget ran out; next night goes on",
      )
      break
    }
    try {
      const capGb = capOf(normalizeCaps(org.caps), "storageGb")
      const estimate = await estimateOrgStorage(org.orgId, run, now)
      await recordEstimate(
        org.orgId,
        estimate,
        org.previous?.overCap === true,
        capGb === null ? null : capGb * GB,
        capGb,
        now,
      )
      measured += 1
    } catch (err) {
      log.warn({ err, orgId: org.orgId }, "storage estimate: this org was not recorded tonight")
    }
    await new Promise((r) => setTimeout(r, pauseMs))
  }
  log.info({ orgs: orgs.length, measured }, "storage estimates done")
  return measured
}
