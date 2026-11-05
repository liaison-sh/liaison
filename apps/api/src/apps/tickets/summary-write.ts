// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The two writes of the ticket summary job: the finished summary, and the
// error state. Each is ONE short UPDATE in its own transaction (the job runs
// in session mode, so a bridge call is a transaction), issued after the model
// call has returned: no lock is held while the model runs.
//
// A short UPDATE can still lose a deadlock (40P01) or a serialization check
// (40001), e.g. against a schema or policy change on the tickets table. Both
// roll the statement back whole, so the write is re-issued here with backoff.
// Retrying the WRITE, not the job, matters: a job retry would call the model
// (and bill it) again, and a write that is never made leaves the ticket
// showing "generating" until someone regenerates it by hand.
import type { SQL } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { retryOnTransientDbError, type TransientDbRetryInfo } from "~/lib/transient-db-error"

/** The one database method the summary writes need (a bridge `txDb`). */
export interface SummaryDb {
  execute: (query: SQL) => Promise<unknown>
}

export interface SummaryWriteRetry {
  /** Retries after the first attempt (default 4). */
  retries?: number
  /** Wait before retry `attempt` (default 100 ms doubling, jittered). */
  delayMs?: (attempt: number) => number
  onRetry?: (info: TransientDbRetryInfo) => void
}

const DEFAULT_RETRIES = 4

function defaultDelayMs(attempt: number): number {
  const base = 100 * 2 ** (attempt - 1)
  return base + Math.floor(Math.random() * base)
}

function retryOptions(opts: SummaryWriteRetry | undefined) {
  return {
    retries: opts?.retries ?? DEFAULT_RETRIES,
    delayMs: opts?.delayMs ?? defaultDelayMs,
    ...(opts?.onRetry ? { onRetry: opts.onRetry } : {}),
  }
}

/**
 * Store a finished summary and set the ticket back to `idle`. Returns the
 * stored `summary_at`, or null when the ticket is no longer visible (deleted
 * or merged away while the model ran).
 */
export async function writeTicketSummary(
  db: SummaryDb,
  tickets: SQL,
  input: {
    ticketId: string
    orgId: string
    summaryText: string
    messageCount: number
    modelId: string
    usage: { inputTokens: number; outputTokens: number }
  },
  opts?: SummaryWriteRetry,
): Promise<{ summaryAt: Date | string } | null> {
  const row = await retryOnTransientDbError(
    async () =>
      extractRows<{ summary_at: Date | string }>(
        await db.execute(sql`
          UPDATE ${tickets}
          SET summary_text = ${input.summaryText}, summary_at = now(),
              summary_message_count = ${input.messageCount},
              summary_status = 'idle', summary_model = ${input.modelId},
              summary_token_usage = ${JSON.stringify(input.usage)}::jsonb,
              summary_error = null, updated_at = now()
          WHERE id = ${input.ticketId}::uuid AND org_id = ${input.orgId}::uuid
          RETURNING summary_at
        `),
      )[0],
    retryOptions(opts),
  )
  return row ? { summaryAt: row.summary_at } : null
}

/** Put the ticket's summary in the `error` state, with the reason shown to people. */
export async function markSummaryFailed(
  db: SummaryDb,
  tickets: SQL,
  input: { ticketId: string; orgId: string; reason: string },
  opts?: SummaryWriteRetry,
): Promise<void> {
  await retryOnTransientDbError(
    () =>
      db.execute(sql`
        UPDATE ${tickets}
        SET summary_status = 'error', summary_error = ${input.reason}, updated_at = now()
        WHERE id = ${input.ticketId}::uuid AND org_id = ${input.orgId}::uuid
      `),
    retryOptions(opts),
  )
}
