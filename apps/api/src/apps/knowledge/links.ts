// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Page links (S13, S14).
 *
 * A page link is stored as `[](knowledge:document:<id>)`: the id and nothing else. The
 * title is resolved for each reader at read time, so a reader who cannot open the page
 * never receives it. Agents were handed `@[Title](knowledge:document:<id>)` and pasted
 * it into bodies, so every write drops the label (`normalizePageRefs`), every read of a
 * row drops it (`rowFromDb`), and the backfill below removes it from what was stored
 * before: bodies, summaries and page history.
 *
 * `app_knowledge.document_links` holds one row per (linking page, linked page), written
 * in the same transaction as the text. Backlinks read it under the reader's row
 * security and then the same read check `get` runs, so they list only pages the reader
 * may read. A link to a page in the Trash, purged or never readable resolves to nothing.
 */
import { normalizePageRefs, pageIdsOf } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { dropArchivedKnowledgeHits, type KnowledgeActor } from "~/apps/knowledge/service"
import { md5 } from "~/apps/knowledge/versions"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { knowledgeLogger as log } from "~/lib/logger"
import { sweepSkippingMoving, writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"

/** Ids one resolve answers at most. */
export const MAX_RESOLVE_IDS = 200
/** Pages the picker offers at most. */
export const PICK_LIMIT = 20
/** Pages the backfill normalises per transaction. */
export const BACKFILL_BATCH = 100

const MARKER = "%knowledge:document:%"

/** A writer's transaction, or the backfill's privileged one. */
type Tx = RlsClient | PrivilegedDb

/** A page a reader may open, as a link to it shows it. */
export interface LinkedPage {
  id: string
  title: string
}

/**
 * Record the pages `body` links to as this page's links, replacing the previous set.
 * Self-links are not recorded. Runs in the writer's transaction (row security: the
 * page's editors, or its creator holding the create scope).
 */
export async function refreshDocumentLinks(
  tx: Tx,
  orgId: string,
  documentId: string,
  body: string,
): Promise<void> {
  const self = documentId.toLowerCase()
  const targets = [...new Set(pageIdsOf(body).map((id) => id.toLowerCase()))].filter(
    (id) => id !== self,
  )
  const links = knowledgeRel("document_links")
  await tx.execute(sql`
    DELETE FROM ${links}
     WHERE source_document_id = ${documentId}::uuid
       ${targets.length > 0 ? sql`AND target_document_id <> ALL(${`{${targets.join(",")}}`}::uuid[])` : sql``}`)
  if (targets.length === 0) return
  await tx.execute(sql`
    INSERT INTO ${links} (org_id, source_document_id, target_document_id)
    SELECT ${orgId}::uuid, ${documentId}::uuid, t
      FROM unnest(${`{${targets.join(",")}}`}::uuid[]) AS t
    ON CONFLICT (source_document_id, target_document_id) DO NOTHING`)
}

/**
 * The live pages among `ids` that `actor` may read, with their titles, in the order
 * asked; every other id is absent (unknown, in the Trash, or not readable).
 */
export async function readablePages(
  tx: RlsClient,
  actor: KnowledgeActor,
  ids: readonly string[],
): Promise<LinkedPage[]> {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))]
  if (unique.length === 0) return []
  // Live rows the reader sees under row security, then the read check `get` runs.
  const kept = await dropArchivedKnowledgeHits(
    tx,
    actor.orgId,
    unique.map((id) => ({ sourceEntityId: id, type: "document" })),
    { ...actor, includeArchived: false },
  )
  if (kept.length === 0) return []
  const rows = extractRows<{ id: string; title: string }>(
    await tx.execute(sql`
      SELECT id::text AS id, title FROM ${knowledgeRel("documents")}
       WHERE org_id = ${actor.orgId}::uuid AND archived_at IS NULL
         AND id = ANY(${`{${kept.map((k) => k.sourceEntityId).join(",")}}`}::uuid[])`),
  )
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]))
  return unique.flatMap((id) => {
    const row = byId.get(id)
    return row ? [{ id: row.id, title: row.title }] : []
  })
}

/** The pages a body links to that `actor` may read (an agent's `get`). */
export async function readableLinksOf(
  tx: RlsClient,
  actor: KnowledgeActor,
  body: string,
): Promise<LinkedPage[]> {
  return readablePages(tx, actor, pageIdsOf(body))
}

/**
 * The live pages linking to `documentId` that `actor` may read. The caller has already
 * checked that the actor may read `documentId` itself.
 */
export async function pageBacklinks(
  tx: RlsClient,
  actor: KnowledgeActor,
  documentId: string,
): Promise<LinkedPage[]> {
  const sources = extractRows<{ id: string }>(
    await tx.execute(sql`
      SELECT l.source_document_id::text AS id FROM ${knowledgeRel("document_links")} l
       WHERE l.org_id = ${actor.orgId}::uuid AND l.target_document_id = ${documentId}::uuid
       ORDER BY l.created_at DESC
       LIMIT 500`),
  )
  return readablePages(
    tx,
    actor,
    sources.map((s) => s.id),
  )
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/**
 * Pages whose title contains `q` that `actor` may read and that are not in the Trash,
 * titles starting with it first, then the most recently changed. Read from the table,
 * not the search index, so a page created a moment ago is found.
 */
export async function pickPages(
  tx: RlsClient,
  actor: KnowledgeActor,
  q: string,
): Promise<LinkedPage[]> {
  const query = q.trim().slice(0, 200)
  const rows = extractRows<{ id: string }>(
    await tx.execute(sql`
      SELECT id::text AS id FROM ${knowledgeRel("documents")}
       WHERE org_id = ${actor.orgId}::uuid AND archived_at IS NULL
         ${query ? sql`AND title ILIKE ${likePattern(query)} ESCAPE '\\'` : sql``}
       ORDER BY ${query ? sql`(title ILIKE ${likePattern(query).slice(1)} ESCAPE '\\') DESC,` : sql``}
                updated_at DESC, id
       LIMIT ${PICK_LIMIT * 3}`),
  )
  return (
    await readablePages(
      tx,
      actor,
      rows.map((r) => r.id),
    )
  ).slice(0, PICK_LIMIT)
}

// ---------------------------------------------------------------------------
// Texts stored before page links were normalised
// ---------------------------------------------------------------------------

interface PageRow {
  id: string
  body: string
  summary: string | null
  revision: number
  synced: boolean
}

interface VersionTextRow {
  id: string
  title: string
  body: string
}

/** What one page's normalisation changes (or would change). */
interface PageNormalisation {
  bodyChanged: boolean
  versions: Array<{ id: string; title: string; body: string }>
}

async function planPage(tx: Tx, page: PageRow): Promise<PageNormalisation> {
  const body = normalizePageRefs(page.body)
  const summary = page.summary === null ? null : normalizePageRefs(page.summary)
  const bodyChanged = !page.synced && (body !== page.body || summary !== page.summary)
  const candidates = extractRows<VersionTextRow>(
    await tx.execute(sql`
      SELECT id::text AS id, title, body FROM ${knowledgeRel("document_versions")}
       WHERE document_id = ${page.id}::uuid
         AND (body LIKE ${MARKER} OR title LIKE ${MARKER})`),
  )
  const versions = candidates.flatMap((v) => {
    const title = normalizePageRefs(v.title)
    const text = normalizePageRefs(v.body)
    return title !== v.title || text !== v.body ? [{ id: v.id, title, body: text }] : []
  })
  return { bodyChanged, versions }
}

/**
 * Normalise one page as stored (body, summary, every version), record its links and
 * mark it done. Only link tokens change: no revision, no `updated_at`, no review
 * status, no event. A synced page's text belongs to its source and is left as it is
 * (reads drop its labels); its links are recorded. `tx` holds the page row locked, or
 * is the transaction of a writer about to update it.
 */
async function normalisePage(tx: Tx, orgId: string, page: PageRow, plan: PageNormalisation) {
  const docs = knowledgeRel("documents")
  if (plan.bodyChanged) {
    await tx.execute(sql`
      UPDATE ${docs}
         SET body = ${normalizePageRefs(page.body)},
             summary = ${page.summary === null ? null : normalizePageRefs(page.summary)},
             links_indexed_at = now()
       WHERE id = ${page.id}::uuid AND org_id = ${orgId}::uuid AND revision = ${page.revision}`)
  } else {
    await tx.execute(sql`
      UPDATE ${docs} SET links_indexed_at = now()
       WHERE id = ${page.id}::uuid AND org_id = ${orgId}::uuid`)
  }
  for (const v of plan.versions) {
    // body_md5 follows the text, so the next save compares against the text kept.
    await tx.execute(sql`
      UPDATE ${knowledgeRel("document_versions")}
         SET title = ${v.title}, body = ${v.body}, body_md5 = ${md5(v.body)}
       WHERE id = ${v.id}::uuid AND document_id = ${page.id}::uuid`)
  }
  await refreshDocumentLinks(tx, orgId, page.id, normalizePageRefs(page.body))
}

/**
 * A page the backfill takes: not done, and its text, summary or history names a page
 * (any form; the marker is the scheme). Every other page is marked done by its next save.
 */
function needsBackfill(orgId: string) {
  return sql`org_id = ${orgId}::uuid AND links_indexed_at IS NULL
    AND (body ILIKE ${MARKER} OR summary ILIKE ${MARKER}
         OR EXISTS (SELECT 1 FROM ${knowledgeRel("document_versions")} v
                     WHERE v.document_id = ${knowledgeRel("documents")}.id
                       AND (v.body ILIKE ${MARKER} OR v.title ILIKE ${MARKER})))`
}

function pageRowsSql(where: ReturnType<typeof sql>, limit: number, lock: boolean) {
  return sql`
    SELECT id::text AS id, body, summary, revision, (synced_source_id IS NOT NULL) AS synced
      FROM ${knowledgeRel("documents")}
     WHERE ${where}
     ORDER BY id
     LIMIT ${limit}
     ${lock ? sql`FOR UPDATE SKIP LOCKED` : sql``}`
}

/**
 * A writer's update of a page the backfill has not reached yet normalises it first, in
 * the writer's transaction, so the save compares and records texts without labels (no
 * spurious baseline in history). A no-op once the page is done.
 */
export async function normaliseStoredLinksBeforeWrite(
  tx: RlsClient,
  orgId: string,
  documentId: string,
): Promise<void> {
  const [page] = extractRows<PageRow>(
    await tx.execute(
      pageRowsSql(
        sql`id = ${documentId}::uuid AND org_id = ${orgId}::uuid AND links_indexed_at IS NULL`,
        1,
        true,
      ),
    ),
  )
  if (!page) return
  await normalisePage(tx, orgId, page, await planPage(tx, page))
}

export interface PageLinksBackfillReport {
  dryRun: boolean
  /** Pages with a page link not done before this run (a dry run: still to do). */
  documents: number
  /** Pages whose stored body or summary lost a label (or would). */
  documentsChanged: number
  /** History rows that lost a label (or would). */
  versionsChanged: number
}

/**
 * The backfill: every page whose links were never recorded (`links_indexed_at` null)
 * and whose text, summary or history names a page, in batches of {@link BACKFILL_BATCH}, one privileged transaction each, the rows
 * locked (a page a writer holds is skipped and normalised by that write). Idempotent:
 * a run over done pages finds nothing. A changed page is re-indexed for search after
 * its batch commits. `dryRun` only counts.
 */
export async function backfillPageLinks(
  opts: { orgId?: string; dryRun?: boolean } = {},
): Promise<PageLinksBackfillReport> {
  const dryRun = opts.dryRun === true
  const report: PageLinksBackfillReport = {
    dryRun,
    documents: 0,
    documentsChanged: 0,
    versionsChanged: 0,
  }
  const orgIds = opts.orgId
    ? [opts.orgId]
    : extractRows<{ org_id: string }>(
        await sweepSkippingMoving((notMoving) =>
          withSystemDb("knowledge-links-backfill-orgs", (db) =>
            db.execute(sql`
              SELECT DISTINCT d.org_id::text AS org_id FROM ${knowledgeRel("documents")} d
               WHERE d.links_indexed_at IS NULL AND ${notMoving(sql.raw("d.org_id"))}
                 AND (d.body ILIKE ${MARKER} OR d.summary ILIKE ${MARKER}
                      OR EXISTS (SELECT 1 FROM ${knowledgeRel("document_versions")} v
                                  WHERE v.document_id = d.id
                                    AND (v.body ILIKE ${MARKER} OR v.title ILIKE ${MARKER})))`),
          ),
        ),
      ).map((r) => r.org_id)
  for (const orgId of orgIds) {
    try {
      const run = () => (dryRun ? countOrg(orgId, report) : backfillOrg(orgId, report))
      await (dryRun ? run() : writeUnlessMoving(orgId, run))
    } catch (err) {
      // One organisation's failure leaves its pages for the next run; the others go on.
      log.error({ err, orgId }, "knowledge: page links backfill failed")
    }
  }
  return report
}

async function countOrg(orgId: string, report: PageLinksBackfillReport): Promise<void> {
  let after = "00000000-0000-0000-0000-000000000000"
  for (;;) {
    const pages = await withPrivilegedDb(orgId, "knowledge-links-backfill-count", async (tx) => {
      const rows = extractRows<PageRow>(
        await tx.execute(
          pageRowsSql(sql`${needsBackfill(orgId)} AND id > ${after}::uuid`, BACKFILL_BATCH, false),
        ),
      )
      for (const page of rows) {
        const plan = await planPage(tx, page)
        if (plan.bodyChanged) report.documentsChanged++
        report.versionsChanged += plan.versions.length
      }
      return rows
    })
    report.documents += pages.length
    const last = pages.at(-1)
    if (!last || pages.length < BACKFILL_BATCH) return
    after = last.id
  }
}

async function backfillOrg(orgId: string, report: PageLinksBackfillReport): Promise<void> {
  const { enqueueIndexerUpsert } = await import("~/modules/search/indexer")
  for (;;) {
    const { done, changed } = await withPrivilegedDb(
      orgId,
      "knowledge-links-backfill",
      async (tx) => {
        const rows = extractRows<PageRow>(
          await tx.execute(pageRowsSql(needsBackfill(orgId), BACKFILL_BATCH, true)),
        )
        const changedIds: string[] = []
        for (const page of rows) {
          const plan = await planPage(tx, page)
          await normalisePage(tx, orgId, page, plan)
          if (plan.bodyChanged) {
            report.documentsChanged++
            changedIds.push(page.id)
          }
          report.versionsChanged += plan.versions.length
        }
        return { done: rows.length, changed: changedIds }
      },
    )
    report.documents += done
    // The search document of a changed page (its summary is indexed as stored).
    for (const id of changed) {
      await enqueueIndexerUpsert(orgId, "knowledge", "document", id, "links-backfill")
    }
    if (done < BACKFILL_BATCH) return
  }
}
