// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task §3.4 — webhook_deliveries ledger prune.
//
// The dedup ledger (`webhook_deliveries`) grows one row per inbound Shopify
// delivery and is never otherwise cleaned up. Spec §3.4: "Records older than 30
// days are pruned." This scheduled job deletes ledger rows whose `receivedAt`
// is older than the retention window. 30 days comfortably exceeds Shopify's
// documented 48-hour / 19-attempt retry window, so pruning never drops a row
// that could still be redelivered.
//
// The SDK `db` surface exposes per-id `delete` (no `deleteMany`), so we page
// through the oldest rows under a per-run cap and delete by id. The job is
// idempotent and bounded; the scheduler re-runs it, so a single tick need not
// drain the entire backlog.
import type { AppContext } from "@liaison/app-sdk"

const RETENTION_DAYS = 30
const PER_RUN_CAP = 1000
const PAGE_SIZE = 200

interface DeliveryRow {
  id: string
  receivedAt?: string | Date | null
}

export async function pruneWebhookDeliveriesJob(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ pruned: number }> {
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  let pruned = 0

  while (pruned < PER_RUN_CAP) {
    // Oldest-first so we always make progress on the longest-lived rows.
    const rows = (await ctx.db.findMany("webhook_deliveries", {
      orderBy: { receivedAt: "asc" },
      limit: PAGE_SIZE,
    })) as DeliveryRow[]
    if (rows.length === 0) break

    // Only the rows past the cutoff are eligible; since rows are oldest-first,
    // the first row that is NOT past the cutoff means everything after it is
    // also within retention — stop.
    let deletedThisPage = 0
    for (const row of rows) {
      const receivedMs = row.receivedAt ? new Date(row.receivedAt).getTime() : Number.NaN
      if (!Number.isFinite(receivedMs) || receivedMs >= cutoffMs) {
        // Reached rows within the retention window (or undatable) — done.
        return { pruned }
      }
      await ctx.db.delete("webhook_deliveries", row.id)
      pruned++
      deletedThisPage++
      if (pruned >= PER_RUN_CAP) break
    }
    // If a full page was returned but none were deletable, stop (defensive).
    if (deletedThisPage === 0) break
  }

  return { pruned }
}
