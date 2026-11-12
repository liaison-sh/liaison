// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B11 — Customer backfill job (Gap-log #5 closes via appCommit).
//
// The backfill is one resumable step (`ctx.steps.run`), done across as many
// runs of this job as it needs; no run waits on Shopify. Its cursor says where
// it stands:
//
//  1. start   `bulkOperationRunQuery({ query: "{ customers { … } }" })`, then
//             wake again in a few seconds (`wakeIn`) to ask about it.
//  2. poll    one look at the bulk operation per wake: still running → wake
//             later (backing off to a minute); FAILED / CANCELED → status
//             `failed` + `customer:backfill_failed`; COMPLETED → import.
//  3. import  `ctx.bulk.fetchToBlob(url)` once per run, then up to
//             IMPORT_ROWS_PER_CHUNK customers per chunk through
//             `ctx.resolveContact`, the cursor (the last imported external id)
//             saved after every chunk. The run's budget ends the run; the step
//             re-enqueues the job, which fetches the export again and skips
//             every id at or below the cursor (the export is id-ascending).
//             An expired export URL (404) starts a new bulk operation, keeping
//             the cursor.
//  4. done    status `completed` + `customer:backfill_completed`.
//
// `backfill_progress` mirrors the state for the settings screen and keeps the
// last imported id between backfills: a later backfill imports only customers
// above it. A fresh trigger (no continuation marker) of a finished backfill
// starts a new one.
//
// External id semantics (Task A0): the SDK passes `externalId: string` and the
// kernel-side bridge keys it under the calling app's name ("shopify"). The
// short id used here is the trailing numeric segment of the Shopify GID.
import type { AppContext, StepChunkResult } from "@liaison/app-sdk"
import { emitEvent } from "../lib/emit"
import { getShopifyClient } from "../lib/get-client"
import type { ShopifyClient } from "../lib/shopify-client"

interface BackfillError extends Error {
  code: string
}

function makeError(code: string, message: string): BackfillError {
  const e = new Error(message) as BackfillError
  e.code = code
  return e
}

const BULK_QUERY = `
  mutation StartCustomerBackfill {
    bulkOperationRunQuery(query: "{ customers { edges { node { id email firstName lastName } } } }") {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`

const POLL_QUERY = `
  query BulkOperationStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation { id status url errorCode }
    }
  }
`

interface BulkOp {
  id: string
  status: "CREATED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | "CANCELING" | "EXPIRED"
  url?: string | null
  errorCode?: string | null
}

interface ShopifyCustomerRow {
  id?: string
  email?: string | null
  firstName?: string | null
  lastName?: string | null
}

interface BackfillProgressRow {
  id: string
  entityType: string
  cursorExternalId: string | null
  blobId: string | null
  status: "idle" | "running" | "failed" | "completed"
}

/** Where the backfill stands (the step's cursor, JSON). `after`: the last imported external id. */
export type BackfillCursor =
  | { phase: "start"; after: string | null }
  | { phase: "poll"; opId: string; polls: number; after: string | null }
  | { phase: "import"; url: string; after: string | null }

export const BACKFILL_STEP = "backfill-customers"
const BATCH_SIZE = 50
/** Customers one chunk imports before its cursor is saved. */
export const IMPORT_ROWS_PER_CHUNK = 250
/** The first look at a new bulk operation, in seconds; doubles per look up to POLL_MAX_WAKE_S. */
const POLL_FIRST_WAKE_S = 5
const POLL_MAX_WAKE_S = 60
/** Looks at one bulk operation before the backfill gives up (about an hour at the cap). */
const MAX_POLLS = 70

/** Extract the trailing numeric (or alphanumeric) segment from a Shopify GID. */
function shortExternalId(gid: string | undefined): string {
  if (!gid) return ""
  const m = gid.match(/\/(\w+)$/)
  return m ? m[1]! : gid
}

/**
 * Resume comparison: is `ext` at or before the resume `cursor`? Shopify bulk
 * customer exports are ordered by id ascending, so we resume by skipping every
 * row whose external id is `<= cursor`. Numeric ids (the common case) compare
 * numerically; non-numeric ids fall back to a stable string comparison. This
 * is robust to the cursor row itself being deleted between runs.
 */
function isAtOrBeforeCursor(ext: string, cursor: string): boolean {
  const a = Number(ext)
  const b = Number(cursor)
  if (Number.isFinite(a) && Number.isFinite(b)) return a <= b
  return ext <= cursor
}

function fullName(row: ShopifyCustomerRow): string | undefined {
  const parts = [row.firstName, row.lastName].filter((x) => x && x.length > 0)
  return parts.length > 0 ? parts.join(" ") : undefined
}

async function loadOrCreateProgress(ctx: AppContext): Promise<BackfillProgressRow> {
  const rows = (await ctx.db.findMany("backfill_progress", {
    where: { entityType: "customers" },
    limit: 1,
  })) as BackfillProgressRow[]
  if (rows.length > 0) return rows[0]!
  const ins = await ctx.db.insert("backfill_progress", {
    entityType: "customers",
    cursorExternalId: null,
    blobId: null,
    status: "running",
  })
  return {
    id: ins.id,
    entityType: "customers",
    cursorExternalId: null,
    blobId: null,
    status: "running",
  }
}

async function startBulkOp(client: ShopifyClient): Promise<BulkOp> {
  const data = await client.query<{
    bulkOperationRunQuery?: { bulkOperation?: BulkOp; userErrors?: Array<{ message: string }> }
  }>(BULK_QUERY, {})
  const op = data.bulkOperationRunQuery?.bulkOperation
  if (!op) {
    const msg = data.bulkOperationRunQuery?.userErrors?.[0]?.message ?? "no bulkOperation returned"
    throw makeError("BULK_RUN_FAILED", msg)
  }
  return op
}

async function bulkOpStatus(client: ShopifyClient, id: string): Promise<BulkOp> {
  const data = await client.query<{ node?: BulkOp | null }>(POLL_QUERY, { id })
  if (!data.node?.status) throw makeError("NO_BULK_OP", `bulk operation ${id} not found`)
  return data.node
}

function isExpiredBlob(err: unknown): boolean {
  const e = err as { status?: number; code?: string }
  return e?.status === 404 || e?.code === "BLOB_FETCH_404"
}

/** The export a run reads from: downloaded once per run, read batch by batch across chunks. */
interface OpenExport {
  url: string
  blobId: string
  batches: AsyncIterator<unknown[]>
  buffered: ShopifyCustomerRow[]
}

async function nextRow(open: OpenExport): Promise<ShopifyCustomerRow | null> {
  while (open.buffered.length === 0) {
    const next = await open.batches.next()
    if (next.done) return null
    open.buffered = (next.value as ShopifyCustomerRow[]).slice()
  }
  return open.buffered.shift() ?? null
}

type JobResult = { status: "completed" | "failed" | "scheduled" | "skipped"; cursor: string | null }

export async function backfillCustomersJob(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<JobResult> {
  const client = await getShopifyClient(ctx)
  const progress = await loadOrCreateProgress(ctx)

  // A fresh trigger (no continuation marker) of a finished backfill starts a new one.
  if (params._steps === undefined && (await ctx.steps.get(BACKFILL_STEP))?.done) {
    await ctx.steps.reset(BACKFILL_STEP)
  }

  let outcome: "completed" | "failed" | null = null
  let open: OpenExport | null = null

  const setProgress = (data: Record<string, unknown>) =>
    ctx.db.update("backfill_progress", progress.id, data)

  const fail = async (
    data: Record<string, unknown>,
    after: string | null,
  ): Promise<StepChunkResult<BackfillCursor>> => {
    await setProgress({ status: "failed" })
    await emitEvent(ctx, { entity: "customer", action: "backfill_failed", data })
    outcome = "failed"
    return { done: true, cursor: { phase: "start", after } }
  }

  const finish = async (after: string | null): Promise<StepChunkResult<BackfillCursor>> => {
    await setProgress({ status: "completed", cursorExternalId: after })
    await emitEvent(ctx, {
      entity: "customer",
      action: "backfill_completed",
      data: { finalCursor: after },
    })
    outcome = "completed"
    return { done: true, cursor: { phase: "start", after } }
  }

  const chunk = async (saved: BackfillCursor | null): Promise<StepChunkResult<BackfillCursor>> => {
    const cursor: BackfillCursor = saved ?? { phase: "start", after: progress.cursorExternalId }

    if (cursor.phase === "start") {
      const op = await startBulkOp(client)
      await setProgress({ status: "running" })
      return {
        done: false,
        cursor: { phase: "poll", opId: op.id, polls: 0, after: cursor.after },
        wakeIn: POLL_FIRST_WAKE_S,
      }
    }

    if (cursor.phase === "poll") {
      const op = await bulkOpStatus(client, cursor.opId)
      if (op.status === "COMPLETED") {
        // No url: the query matched nothing (an empty store).
        if (!op.url) return finish(cursor.after)
        return { done: false, cursor: { phase: "import", url: op.url, after: cursor.after } }
      }
      if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "EXPIRED") {
        return fail({ errorCode: op.errorCode ?? null, opId: op.id }, cursor.after)
      }
      if (cursor.polls + 1 >= MAX_POLLS)
        return fail({ reason: "poll_timeout", opId: op.id }, cursor.after)
      const wakeIn = Math.min(POLL_FIRST_WAKE_S * 2 ** (cursor.polls + 1), POLL_MAX_WAKE_S)
      return { done: false, cursor: { ...cursor, polls: cursor.polls + 1 }, wakeIn }
    }

    // import
    if (!open || open.url !== cursor.url) {
      let blobId: string
      try {
        blobId = (await ctx.bulk.fetchToBlob(cursor.url)).blobId
      } catch (err) {
        if (!isExpiredBlob(err)) throw err
        // The export's URL expired: run the bulk operation again, keeping the cursor.
        return { done: false, cursor: { phase: "start", after: cursor.after } }
      }
      open = {
        url: cursor.url,
        blobId,
        batches: ctx.bulk.iterateJsonl(blobId, { batchSize: BATCH_SIZE })[Symbol.asyncIterator](),
        buffered: [],
      }
    }
    let after = cursor.after
    let imported = 0
    while (imported < IMPORT_ROWS_PER_CHUNK) {
      const row = await nextRow(open)
      if (!row) return finish(after)
      const ext = shortExternalId(row.id)
      if (!ext || (after && isAtOrBeforeCursor(ext, after))) continue
      await ctx.resolveContact({
        email: row.email ?? undefined,
        name: fullName(row),
        externalId: ext,
      })
      after = ext
      imported++
    }
    await setProgress({ cursorExternalId: after, blobId: open.blobId, status: "running" })
    return { done: false, cursor: { phase: "import", url: cursor.url, after } }
  }

  try {
    const run = await ctx.steps.run<BackfillCursor>(BACKFILL_STEP, {}, chunk)
    const status = outcome ?? (run.state === "done" ? "completed" : run.state)
    return { status, cursor: run.cursor?.after ?? progress.cursorExternalId }
  } finally {
    const blobId = (open as OpenExport | null)?.blobId
    if (blobId) await ctx.bulk.deleteBlob(blobId)
  }
}
