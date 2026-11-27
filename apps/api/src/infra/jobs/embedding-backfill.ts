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
  opts: { delay?: number } = {},
): Promise<void> {
  await enqueueAppJob(
    QUEUE_APP,
    EMBEDDING_BACKFILL_JOB,
    { orgId, batchSize } satisfies EmbeddingBackfillPayload,
    { jobId: backfillStepId(orgId, cursor), ...opts },
  )
}

/** Start (or join) the org's backfill chain at its persisted cursor. */
export async function enqueueEmbeddingBackfill(
  orgId: string,
  batchSize?: number,
  opts: { delay?: number } = {},
): Promise<void> {
  await enqueueBackfillStep(orgId, await readBackfillCursor(orgId), batchSize, opts)
}

/* -------------------------------------------------------------------------- */
/* The re-embed after a width change (EMBEDDING_DIMENSIONS)                    */
/* -------------------------------------------------------------------------- */
//
// A rebuild at a new width notes the documents that had a vector
// (modules/search/reembed-queue.ts). This chain gives them one again: a step
// takes up to REEMBED_BATCH noted rows of one org, rebuilds their documents
// from Postgres with a fresh vector in one embedding call and one Meili write,
// and only then removes them from the set. A kill costs at most the batch in
// flight, which the next step simply does again. Search works the whole time:
// keyword legs are untouched, and the vector leg reaches more documents as
// the chain advances.

export const EMBEDDING_REEMBED_JOB = "search-embedding-reembed"
/** Noted rows per step: one embedding call and one Meili task. */
export const REEMBED_BATCH = 50
/** Pause between two steps of one org, so the chain never crowds live indexing. */
const REEMBED_STEP_DELAY_MS = 1_000
/** While the index does not yet declare the new width (the rebuild is running). */
const REEMBED_WAIT_FOR_INDEX_MS = 60_000
/** One step per org at a time, across processes and duplicate chains. */
const REEMBED_LOCK_MS = 5 * 60_000
const reembedLockKey = (orgId: string) => `search:reembed:lock:${orgId}`

export interface ReembedPayload {
  orgId: string
  /** The step's position in its chain, which keeps every step's job id distinct. */
  step?: number
}

export type ReembedStepResult =
  | { status: "embedded"; embedded: number; left: number }
  | { status: "waiting_for_index" | "locked" | "no_embedder" | "done" }

/**
 * One step: up to `batchSize` noted rows of the org, re-indexed with a vector.
 * Waits (embeds nothing, removes nothing) while the index does not declare the
 * org's embedder at its width, i.e. before the rebuild at the new width has
 * swapped in: writing then would drop the old index's vectors for nothing.
 */
export async function processReembedStep(
  orgId: string,
  batchSize = REEMBED_BATCH,
): Promise<ReembedStepResult> {
  const queue = await import("~/modules/search/reembed-queue")
  const { resolveOrgEmbedder, memoryEmbedderDeclared, indexMessagesBulk, indexBriefRowsBulk } =
    await import("~/modules/search/message-indexer")
  const lockKey = reembedLockKey(orgId)
  const token = crypto.randomUUID()
  if ((await redis.set(lockKey, token, "PX", REEMBED_LOCK_MS, "NX")) !== "OK") {
    return { status: "locked" }
  }
  try {
    const members = await queue.peekReembed(orgId, batchSize)
    if (members.length === 0) {
      await queue.settleReembed(orgId, [])
      return { status: "done" }
    }
    const embedder = await resolveOrgEmbedder(orgId)
    if (!embedder) {
      // No key (or a model that cannot reach the width): nothing can embed
      // these, and they already answer keyword searches.
      await queue.dropReembed(orgId)
      log.info({ orgId }, "embedding_reembed_dropped_no_embedder")
      return { status: "no_embedder" }
    }
    if (!(await memoryEmbedderDeclared(embedder.dimensions))) {
      return { status: "waiting_for_index" }
    }
    const messageIds: string[] = []
    const briefs: Array<{ kind: "brief_row" | "episode"; id: string }> = []
    for (const m of members) {
      const item = queue.parseReembedMember(m)
      if (!item) continue
      if (item.kind === "message") messageIds.push(item.id)
      else briefs.push({ kind: item.kind, id: item.id })
    }
    if (messageIds.length > 0) {
      const { failures } = await indexMessagesBulk(orgId, messageIds, {
        batchSize: messageIds.length,
      })
      // A failed batch stays noted and is tried again by the next step.
      if (failures.length > 0) {
        throw new Error(`re-embed: ${failures.length} messages failed: ${failures[0]?.error}`)
      }
    }
    await indexBriefRowsBulk(orgId, briefs)
    const left = await queue.settleReembed(orgId, members)
    log.info({ orgId, embedded: members.length, left }, "embedding_reembed_progress")
    return { status: "embedded", embedded: members.length, left }
  } finally {
    // Released only when still ours: a step that outlived the lock must not
    // free the one another step holds now.
    const held = await redis.get(lockKey).catch(() => null)
    if (held === token) await redis.del(lockKey).catch(() => undefined)
  }
}

function reembedStepId(orgId: string, step: number): string {
  return `${EMBEDDING_REEMBED_JOB}:${orgId}:${step}`
}

async function enqueueReembedStep(orgId: string, step: number, delay = 0): Promise<void> {
  await enqueueAppJob(QUEUE_APP, EMBEDDING_REEMBED_JOB, { orgId, step } satisfies ReembedPayload, {
    jobId: reembedStepId(orgId, step),
    ...(delay > 0 ? { delay } : {}),
  })
}

/**
 * One chain step, then the next one unless the org is done. `processStep` is
 * injectable for the test. A step that finds the org locked ends its chain:
 * the holder's chain carries on.
 */
export async function runReembedStep(
  payload: ReembedPayload,
  processStep: (orgId: string) => Promise<ReembedStepResult> = processReembedStep,
): Promise<ReembedStepResult> {
  const result = await processStep(payload.orgId)
  const next = (payload.step ?? 0) + 1
  if (result.status === "embedded" && result.left > 0) {
    await enqueueReembedStep(payload.orgId, next, REEMBED_STEP_DELAY_MS)
  } else if (result.status === "waiting_for_index") {
    await enqueueReembedStep(payload.orgId, next, REEMBED_WAIT_FOR_INDEX_MS)
  }
  return result
}

export function registerEmbeddingReembedWorker(): void {
  registerJobWorker(QUEUE_APP, EMBEDDING_REEMBED_JOB, (payload: ReembedPayload) =>
    runReembedStep(payload).then(() => undefined),
  )
}

/**
 * Make sure a chain will pick up rows noted for one org (a live write during
 * the width change). One waiting kick per org: the queue deduplicates it on
 * its id while it waits, so a burst of writes queues one job, not one each.
 * Best effort; never throws.
 */
export async function kickReembed(orgId: string): Promise<void> {
  try {
    await enqueueAppJob(
      QUEUE_APP,
      EMBEDDING_REEMBED_JOB,
      { orgId, step: 0 } satisfies ReembedPayload,
      { jobId: `${EMBEDDING_REEMBED_JOB}:${orgId}:kick`, delay: REEMBED_WAIT_FOR_INDEX_MS },
    )
  } catch (err) {
    log.warn({ err, orgId }, "Could not queue the re-embed; the next leader acquire resumes it")
  }
}

/**
 * Start (or rejoin) a chain for every org with noted rows. Called after the
 * rebuild at a new width swaps in, and by the leader on every lease acquire
 * (`checkMemoryEmbedderWidth`), so a chain lost to a restart picks up where
 * the set says. Redis and the queue only: no database read.
 */
export async function resumeReembed(): Promise<number> {
  const { orgsAwaitingReembed } = await import("~/modules/search/reembed-queue")
  const orgs = await orgsAwaitingReembed()
  // A fresh id per resume: an older chain still queued is not mistaken for
  // this one, and two chains of one org are kept apart by the step lock.
  const step = Date.now()
  for (const orgId of orgs) await enqueueReembedStep(orgId, step)
  if (orgs.length > 0) log.info({ orgs: orgs.length }, "embedding_reembed_resumed")
  return orgs.length
}

/**
 * The leader's check of the embedder width, once per lease acquire. When the
 * index declares the memory embedder at a width other than
 * EMBEDDING_DIMENSIONS, asks for the rebuild at the configured width (one job,
 * deduplicated); then resumes any re-embed still waiting. One Meili settings
 * read; never a scan, never a database read. A width no provider path
 * produces (a test index) is left alone. Never throws.
 */
export async function checkMemoryEmbedderWidth(): Promise<void> {
  try {
    const [{ offlineSideCalls }, client, dims, { MEMORY_EMBEDDER_NAME }] = await Promise.all([
      import("~/lib/env"),
      import("~/infra/search/client"),
      import("~/modules/search/embedding-dimensions"),
      import("~/modules/search/vector-opt-out"),
    ])
    if (offlineSideCalls()) return
    const configured = dims.configuredEmbeddingDimensions()
    let declared: number | null = null
    try {
      const settings = (await client
        .getMeili()
        .index(client.effectiveIndexName())
        .getSettings()) as { embedders?: Record<string, { dimensions?: number }> | null }
      const width = settings.embedders?.[MEMORY_EMBEDDER_NAME]?.dimensions
      declared = typeof width === "number" ? width : null
    } catch {
      // No index yet: the first build declares the configured width.
    }
    if (
      declared !== null &&
      declared !== configured &&
      dims.isSupportedEmbeddingDimensions(declared)
    ) {
      const { requestIndexRebuild } = await import("~/modules/search/reindex")
      log.info({ from: declared, to: configured }, "memory_embedder_width_changed")
      await requestIndexRebuild("memory_embedder_width_changed", { embedderDimensions: configured })
    }
    await resumeReembed()
  } catch (err) {
    log.warn({ err }, "Checking the memory embedder width failed; the next leader acquire retries")
  }
}
