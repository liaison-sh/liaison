// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Audience-erasure consumer (section 5.5). Consumes `ads.audience_erasure`
// records from the hub service's outbox -- polled via the `database` cross-app
// (section 2.2's hub-DB read path, same as consent-join/metrics), NOT a live
// subscription (Liaison cannot subscribe to the hub service's in-process event
// bus). For each pending record it executes:
//   - Meta remove-users: DELETE /{audience}/users with the schema payload,
//     for every ads audience this app manages.
//   - Google Customer Match removal: offlineUserDataJobs create ->
//     addOperations (remove) -> run.
//
// UNGATED but audited + retried (section 5.5 decision) -- a GDPR erasure
// obligation is a safe-direction outward write, analogous to `pause`/
// `google_pause`; waiting on a human approval TTL would breach the erasure
// obligation. Every removal writes an `audience_erasure_log` row (this app's
// own table -- Liaison cannot mark the hub service's outbox consumed) keyed by
// email_sha256 + platform, so a record already removed on a platform is not
// re-processed on the next sweep (idempotent; a repeat removal is also a
// harmless no-op on the platform side). Absent connections degrade to a
// clean no-op + audit note per platform, never a crash.

import { getMetaClient } from "../lib/get-client"
import { googleAdsMutate } from "../lib/google-client"
import { GoogleConfigError, getGoogleClient } from "../lib/google-config"
import { metaFetch } from "../lib/meta-client"

interface PendingErasure {
  emailSha256: string
  reason: string
  erasedAt: string
}

interface ExecuteToolCtx {
  executeTool?: (
    target: string,
    args: Record<string, unknown>,
  ) => Promise<{
    status: "completed" | "pending_approval" | "error"
    result?: unknown
    error?: { code: string; message: string; retryable?: boolean }
  }>
}

interface AppDb {
  findMany(entity: string, opts?: Record<string, unknown>): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
}

interface SweepCtx extends ExecuteToolCtx {
  db?: AppDb
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<unknown>
  connections: unknown
}

interface SweepParams {
  /** Meta custom audience ids this app manages -- swept for every pending erasure. */
  managed_meta_audience_ids?: string[]
}

interface PollResult {
  pending: PendingErasure[]
  /** True when neither the curated read nor the db_query fallback could be reached -- the sweep ran with zero (possibly stale) records. */
  degraded?: boolean
  note?: string
}

// ─── pending-erasure poll (database cross-app, section 2.2/5.5) ────────────
//
// Preferred: the curated `pending_audience_erasures` db_read. Fallback (per
// §2.2's sanctioned pattern, mirrored from metrics/inputs.ts's
// gatherAttributionRows and consent-join.ts): a parameterized
// `database:db_query` SELECT when the curated read errors (e.g. not yet in
// the hub catalog). Both unreachable degrades to an empty, explicitly
// `degraded:true` poll result -- never a crash, and never silently reported
// as "nothing pending" without the caller being told the source itself was
// unavailable.

// Both database tools return an envelope, not a bare array: { rows,
// truncated } on success or { error: { code, message } } on a handler-level
// failure — and the SQL aliases are snake_case (email_sha256 / erased_at)
// while this module speaks camelCase. Unwrap + normalize defensively (bare
// arrays and camelCase rows accepted for older bridges/fixtures); rows with
// no hash at all are dropped (nothing to sweep against).
function normalizeErasureRow(raw: unknown): PendingErasure | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const emailSha256 = r.emailSha256 ?? r.email_sha256
  if (typeof emailSha256 !== "string" || emailSha256.length === 0) return null
  return {
    emailSha256,
    reason: typeof r.reason === "string" ? r.reason : "",
    erasedAt:
      typeof (r.erasedAt ?? r.erased_at) === "string"
        ? ((r.erasedAt ?? r.erased_at) as string)
        : "",
  }
}

function unwrapDbRows(result: unknown): PendingErasure[] | null {
  let rows: unknown[] | null = null
  if (Array.isArray(result)) rows = result
  else if (result && typeof result === "object") {
    const env = result as { rows?: unknown; error?: unknown }
    if (env.error) return null
    if (Array.isArray(env.rows)) rows = env.rows
  }
  if (rows === null) return null
  return rows.map(normalizeErasureRow).filter((r): r is PendingErasure => r !== null)
}

async function pollPendingErasures(ctx: ExecuteToolCtx): Promise<PollResult> {
  if (!ctx.executeTool) {
    return {
      pending: [],
      degraded: true,
      note: "cross-app calls not enabled on this ctx (see docs/sdk-gaps.md)",
    }
  }

  try {
    const envelope = await ctx.executeTool("database:db_read", {
      name: "pending_audience_erasures",
      params: {},
    })
    if (envelope.status === "completed") {
      const rows = unwrapDbRows(envelope.result)
      if (rows !== null) return { pending: rows }
    }
  } catch {
    // fall through to the db_query fallback below
  }

  try {
    // The hub has no ads.* schema object: erasure records live in the
    // platform's transactional outbox (public.pending_events, type
    // ads.audience_erasure, payload { emailSha256, reason, erasedAt }).
    // Consumption tracking is OURS (audience_erasure_log), so no
    // consumed_at filter exists source-side; we read a bounded recent
    // window and de-dupe against our own log.
    const fallback = await ctx.executeTool("database:db_query", {
      sql: "SELECT payload->>'emailSha256' AS email_sha256, payload->>'reason' AS reason, payload->>'erasedAt' AS erased_at FROM public.pending_events WHERE type = 'ads.audience_erasure' AND created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 500",
    })
    if (fallback.status === "completed") {
      const rows = unwrapDbRows(fallback.result)
      if (rows !== null) return { pending: rows }
    }
    return {
      pending: [],
      degraded: true,
      note: `pending_audience_erasures unavailable (curated read + db_query fallback both failed), see docs/sdk-gaps.md`,
    }
  } catch (e) {
    return {
      pending: [],
      degraded: true,
      note: `pending_audience_erasures unreachable: ${e instanceof Error ? e.message : String(e)}, see docs/sdk-gaps.md`,
    }
  }
}

// ─── already-consumed check (Liaison-side audience_erasure_log) ───────────

async function alreadyConsumed(
  db: AppDb | undefined,
  emailSha256: string,
  platform: "meta" | "google",
): Promise<boolean> {
  if (!db) return false
  const rows = (await db.findMany("audience_erasure_log", {
    where: { email_sha256: emailSha256, platform, status: "removed" },
  })) as Array<Record<string, unknown>>
  return rows.length > 0
}

export type AuditLogStatus = "removed" | "no_op_not_connected" | "no_op_no_audience_ids" | "failed"

async function writeAuditLog(
  db: AppDb | undefined,
  emailSha256: string,
  platform: "meta" | "google",
  status: AuditLogStatus,
  note?: string,
  failedAudienceIds?: string[],
): Promise<void> {
  if (!db) return
  await db.insert("audience_erasure_log", {
    email_sha256: emailSha256,
    platform,
    status,
    consumed_at: status === "removed" ? new Date().toISOString() : null,
    note,
    ...(failedAudienceIds && failedAudienceIds.length > 0
      ? { failed_audience_ids: failedAudienceIds }
      : {}),
  })
}

// ─── Meta remove-users ──────────────────────────────────────────────────────

export type MetaRemoveStatus =
  | "removed"
  | "no_op_not_connected"
  | "no_op_no_audience_ids"
  | "failed"

interface MetaRemoveResult {
  removed: boolean
  status: MetaRemoveStatus
  note?: string
  /** Audience ids whose DELETE call threw, when status is "failed" (partial or total). */
  failedAudienceIds?: string[]
}

/**
 * Remove one hashed email from every managed Meta audience. Each audience's
 * DELETE is wrapped in its own try/catch so one bad/unreachable audience
 * cannot abort the others -- `removed` is only true when EVERY audience
 * succeeded; a partial failure is reported via `failedAudienceIds` so the
 * caller can write an audit row naming exactly which audiences still need
 * the erasure applied (the sweep is idempotent, so a retry only re-touches
 * the audiences that failed -- but today's audit trail records the full
 * per-attempt outcome even though the log lookup key is email+platform,
 * not email+platform+audience).
 */
async function removeFromMeta(
  ctx: SweepCtx,
  emailSha256: string,
  audienceIds: string[],
): Promise<MetaRemoveResult> {
  let client: { accessToken: string; adAccountId: string }
  try {
    client = await getMetaClient(ctx)
  } catch (e) {
    return {
      removed: false,
      status: "no_op_not_connected",
      note: `Meta not connected: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  if (audienceIds.length === 0) {
    return {
      removed: false,
      status: "no_op_no_audience_ids",
      note: "Meta connected, but no managed_meta_audience_ids provided, so there is nothing to remove from",
    }
  }

  const failedAudienceIds: string[] = []
  for (const audienceId of audienceIds) {
    try {
      await metaFetch(ctx.fetch, {
        path: `/${audienceId}/users`,
        method: "DELETE",
        params: {
          payload: { schema: ["EMAIL_SHA256"], data: [[emailSha256]] },
        },
        accessToken: client.accessToken,
      })
    } catch (e) {
      failedAudienceIds.push(audienceId)
      void e
    }
  }

  if (failedAudienceIds.length === 0) {
    return { removed: true, status: "removed" }
  }
  if (failedAudienceIds.length === audienceIds.length) {
    return {
      removed: false,
      status: "failed",
      note: `Meta removal failed for all ${failedAudienceIds.length} managed audience(s): ${failedAudienceIds.join(", ")}`,
      failedAudienceIds,
    }
  }
  return {
    removed: false,
    status: "failed",
    note: `Meta removal failed for ${failedAudienceIds.length}/${audienceIds.length} managed audience(s): ${failedAudienceIds.join(", ")}`,
    failedAudienceIds,
  }
}

// ─── Google Customer Match removal ──────────────────────────────────────────

export type GoogleRemoveStatus = "removed" | "no_op_not_connected" | "failed"

interface GoogleRemoveResult {
  removed: boolean
  status: GoogleRemoveStatus
  note?: string
}

async function removeFromGoogle(ctx: SweepCtx, emailSha256: string): Promise<GoogleRemoveResult> {
  let client: Awaited<ReturnType<typeof getGoogleClient>>
  try {
    client = await getGoogleClient(ctx)
  } catch (e) {
    const note =
      e instanceof GoogleConfigError ? e.message : e instanceof Error ? e.message : String(e)
    return { removed: false, status: "no_op_not_connected", note: `Google not connected: ${note}` }
  }

  const { token, config } = client

  try {
    // Step 1: create the offline user data job.
    const createResult = (await googleAdsMutate(ctx.fetch, {
      customerId: config.customerId,
      path: "offlineUserDataJobs:create",
      operations: [{ create: { type: "CUSTOMER_MATCH_USER_LIST" } }],
      token,
      loginCustomerId: config.loginCustomerId,
    })) as { results?: Array<{ resourceName?: string }> }
    const jobResourceName = createResult.results?.[0]?.resourceName

    if (!jobResourceName) {
      return {
        removed: false,
        status: "failed",
        note: "Google offlineUserDataJobs create did not return a job resource name",
      }
    }

    // Step 2: add a REMOVE operation carrying the hashed email.
    await googleAdsMutate(ctx.fetch, {
      customerId: config.customerId,
      path: `${jobResourceName}:addOperations`,
      operations: [
        {
          remove: {
            userIdentifiers: [{ hashedEmail: emailSha256 }],
          },
        },
      ],
      token,
      loginCustomerId: config.loginCustomerId,
    })

    // Step 3: run the job.
    await googleAdsMutate(ctx.fetch, {
      customerId: config.customerId,
      path: `${jobResourceName}:run`,
      operations: [],
      token,
      loginCustomerId: config.loginCustomerId,
    })

    return { removed: true, status: "removed" }
  } catch (e) {
    return {
      removed: false,
      status: "failed",
      note: `Google Customer Match removal failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

// ─── audience_erasure_sweep ─────────────────────────────────────────────────

export async function audience_erasure_sweep(params: unknown, ctx: SweepCtx): Promise<unknown> {
  const p = (params ?? {}) as SweepParams
  const managedMetaAudienceIds = Array.isArray(p.managed_meta_audience_ids)
    ? p.managed_meta_audience_ids
    : []

  const pollResult = await pollPendingErasures(ctx)
  const pending = pollResult.pending

  let processed = 0
  let skippedAlreadyConsumed = 0
  let metaRemoved = 0
  let googleRemoved = 0
  let erasuresFailed = 0
  let metaNote: string | undefined
  let googleNote: string | undefined

  for (const erasure of pending) {
    const emailSha256 = erasure.emailSha256

    // A single erasure's failure (Meta/Google transiently erroring, a bad
    // audience id, etc.) must never abort the batch -- the sweep is a GDPR
    // obligation covering every OTHER pending record too, so each iteration
    // is isolated: catch, count it as failed, write what audit info we can,
    // and continue to the next erasure.
    try {
      const metaConsumed = await alreadyConsumed(ctx.db, emailSha256, "meta")
      const googleConsumed = await alreadyConsumed(ctx.db, emailSha256, "google")
      if (metaConsumed && googleConsumed) {
        skippedAlreadyConsumed++
        continue
      }
      processed++

      if (!metaConsumed) {
        const metaResult = await removeFromMeta(ctx, emailSha256, managedMetaAudienceIds)
        if (metaResult.removed) {
          metaRemoved++
          await writeAuditLog(ctx.db, emailSha256, "meta", "removed")
        } else {
          metaNote = metaResult.note
          await writeAuditLog(
            ctx.db,
            emailSha256,
            "meta",
            metaResult.status,
            metaResult.note,
            metaResult.failedAudienceIds,
          )
        }
      }

      if (!googleConsumed) {
        const googleResult = await removeFromGoogle(ctx, emailSha256)
        if (googleResult.removed) {
          googleRemoved++
          await writeAuditLog(ctx.db, emailSha256, "google", "removed")
        } else {
          googleNote = googleResult.note
          await writeAuditLog(ctx.db, emailSha256, "google", googleResult.status, googleResult.note)
        }
      }
    } catch (e) {
      erasuresFailed++
      const note = `audience_erasure_sweep: erasure for this record threw mid-batch, skipped and continuing: ${
        e instanceof Error ? e.message : String(e)
      }`
      await writeAuditLog(ctx.db, emailSha256, "meta", "failed", note)
      metaNote = note
    }
  }

  return {
    processed,
    skipped_already_consumed: skippedAlreadyConsumed,
    meta_removed: metaRemoved,
    google_removed: googleRemoved,
    erasures_failed: erasuresFailed,
    ...(metaNote ? { meta_note: metaNote } : {}),
    ...(googleNote ? { google_note: googleNote } : {}),
    ...(pollResult.degraded ? { poll_degraded: true, poll_note: pollResult.note } : {}),
  }
}
