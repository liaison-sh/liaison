// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T48: the one-shot backfill that gives the documents already in the index
// their vectors.
//
// RESUMABLE, BECAUSE IT WILL BE KILLED. Embedding a real org's transcript is
// minutes of provider calls, and the process running it is restarted by a
// deploy like any other. So the unit of work is a BATCH, the cursor is
// persisted after every batch, and a rerun starts from the cursor rather than
// from the beginning: a kill costs at most the batch in flight, never the run.
//
// KEYWORD ONLY UNTIL A DOCUMENT HAS ITS VECTOR. The backfill is not a gate on
// anything: search works the whole time it runs, the vector leg simply reaches
// fewer documents the earlier it is. Nothing waits for it and nothing fails
// because it has not finished.
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { searchLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { quoteIdent } from "~/lib/sql-utils"
import { processMessageIndexerJob } from "~/modules/search/message-indexer"

const QUEUE_APP = "kernel"
export const EMBEDDING_BACKFILL_JOB = "search-embedding-backfill"

/** How many messages one batch embeds. Small enough to lose cheaply. */
export const DEFAULT_BACKFILL_BATCH = 50

export interface EmbeddingBackfillPayload {
  orgId: string
  batchSize?: number
}

/**
 * The cursor: the `(created_at, id)` of the last message a COMPLETED batch
 * embedded, as `<iso>|<uuid>`. Kept in Redis rather than in a table because it
 * is progress, not state: losing it costs a rerun of work that is idempotent
 * anyway, and it must never be something a schema migration has to carry.
 */
const cursorKey = (orgId: string) => `search:embedding-backfill:${orgId}`

export async function readBackfillCursor(orgId: string): Promise<string | null> {
  try {
    return await redis.get(cursorKey(orgId))
  } catch (err) {
    log.warn({ err, orgId }, "Could not read the embedding backfill cursor; starting over")
    return null
  }
}

export async function writeBackfillCursor(orgId: string, cursor: string): Promise<void> {
  try {
    await redis.set(cursorKey(orgId), cursor)
  } catch (err) {
    // A lost cursor costs repeated work, never wrong work: re-indexing a
    // message that already has its vector writes the same document again.
    log.warn({ err, orgId }, "Could not persist the embedding backfill cursor")
  }
}

export async function clearBackfillCursor(orgId: string): Promise<void> {
  try {
    await redis.del(cursorKey(orgId))
  } catch {
    /* a stale cursor only ever skips forward, and the next full run clears it */
  }
}

function parseCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (!cursor) return null
  const at = cursor.lastIndexOf("|")
  if (at <= 0) return null
  return { createdAt: cursor.slice(0, at), id: cursor.slice(at + 1) }
}

export interface BackfillBatchResult {
  embedded: number
  cursor: string | null
  done: boolean
}

/**
 * One batch. Returns where it got to, so a caller (the job, or a test) can see
 * the progress without reading Redis.
 */
export async function processEmbeddingBackfillJob(
  payload: EmbeddingBackfillPayload,
): Promise<BackfillBatchResult> {
  const { orgId } = payload
  const batchSize = payload.batchSize ?? DEFAULT_BACKFILL_BATCH
  const from = parseCursor(await readBackfillCursor(orgId))
  const qualified = sql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent("messages")}`)

  const rows = await withPrivilegedDb(orgId, "embedding-backfill:batch", async (tx) => {
    // Ordered by `(created_at, id)`, the same total order the cursor names, so
    // a resume can never skip a row or read one twice.
    const result = from
      ? await tx.execute(
          sql`SELECT id, created_at FROM ${qualified}
              WHERE org_id = ${orgId} AND deleted_at IS NULL
                AND (created_at, id) > (${from.createdAt}::timestamptz, ${from.id}::uuid)
              ORDER BY created_at ASC, id ASC LIMIT ${batchSize}`,
        )
      : await tx.execute(
          sql`SELECT id, created_at FROM ${qualified}
              WHERE org_id = ${orgId} AND deleted_at IS NULL
              ORDER BY created_at ASC, id ASC LIMIT ${batchSize}`,
        )
    const out =
      (result as { rows?: Record<string, unknown>[] }).rows ?? (result as Record<string, unknown>[])
    return (out ?? []) as Array<{ id: string; created_at: Date | string }>
  })

  if (rows.length === 0) {
    log.info({ orgId }, "embedding_backfill_complete")
    return { embedded: 0, cursor: from ? `${from.createdAt}|${from.id}` : null, done: true }
  }

  let embedded = 0
  let last: { createdAt: string; id: string } | null = from
  for (const row of rows) {
    try {
      await processMessageIndexerJob({ action: "upsert", orgId, messageId: row.id })
      embedded++
    } catch (err) {
      // One unindexable message must not stop the run: the cursor still moves
      // past it, and the row keeps whatever document it already had.
      log.warn({ err, orgId, messageId: row.id }, "Backfill could not index a message")
    }
    last = {
      createdAt: new Date(row.created_at as string).toISOString(),
      id: row.id,
    }
  }

  const cursor = last ? `${last.createdAt}|${last.id}` : null
  // The cursor is written ONCE, after the batch, never per message: a cursor
  // written mid batch would claim progress a kill has not actually made.
  if (cursor) await writeBackfillCursor(orgId, cursor)
  const done = rows.length < batchSize
  log.info({ orgId, embedded, cursor, done }, "embedding_backfill_progress")
  return { embedded, cursor, done }
}

/**
 * One chain step: embed a batch, then queue the next step unless done. The job
 * re-enqueues itself rather than looping in one run, so a deploy that kills
 * the process loses one batch and the queue picks it back up. The next step's
 * id comes from the cursor THIS batch reached, in memory: re-reading Redis
 * could see a cursor another writer moved meanwhile and fork the chain.
 * `processBatch` is injectable for the test.
 */
export async function runBackfillStep(
  payload: EmbeddingBackfillPayload,
  processBatch: (
    p: EmbeddingBackfillPayload,
  ) => Promise<BackfillBatchResult> = processEmbeddingBackfillJob,
): Promise<void> {
  const result = await processBatch(payload)
  if (!result.done) await enqueueBackfillStep(payload.orgId, result.cursor, payload.batchSize)
}

export function registerEmbeddingBackfillWorker(): void {
  registerJobWorker(QUEUE_APP, EMBEDDING_BACKFILL_JOB, (payload: EmbeddingBackfillPayload) =>
    runBackfillStep(payload),
  )
}

/**
 * The id of the chain step that starts at `cursor`: the org plus the position.
 *
 * ONE CHAIN PER ORG. The id used to carry `Date.now()`, so two triggers (a
 * rerun while a run was going) started two chains that raced on the one
 * cursor. Keyed on the position instead, every trigger and every
 * continuation that would start at the same place is the same job, and the
 * queue's deduplication keeps just one of them while it waits or runs. A step
 * always continues from a later cursor than its own, so its continuation is
 * never deduplicated against the step itself.
 */
export function backfillStepId(orgId: string, cursor: string | null): string {
  return `${EMBEDDING_BACKFILL_JOB}:${orgId}:${cursor ?? "start"}`
}

/** Queue the chain step that starts at `cursor` (deduplicated on its id). */
async function enqueueBackfillStep(
  orgId: string,
  cursor: string | null,
  batchSize?: number,
): Promise<void> {
  await enqueueAppJob(
    QUEUE_APP,
    EMBEDDING_BACKFILL_JOB,
    { orgId, batchSize } satisfies EmbeddingBackfillPayload,
    { jobId: backfillStepId(orgId, cursor) },
  )
}

/** Start (or join) the org's backfill chain at its persisted cursor. */
export async function enqueueEmbeddingBackfill(orgId: string, batchSize?: number): Promise<void> {
  await enqueueBackfillStep(orgId, await readBackfillCursor(orgId), batchSize)
}
