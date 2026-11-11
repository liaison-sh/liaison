// SPDX-License-Identifier: FSL-1.1-ALv2
// Approval summaries are STORED STATE. A summary is computed once, when the
// request is made (executeTool stages it) and again when its payload is edited
// (edit.ts, approval_update_payload); every read (list, detail, the Home
// attention rows, the agent's approvals_list) serves the stored text. No
// summarizer runs on a read path: an app's summarizer is app code (a sandbox
// run for a sandboxed app), and a card render must not pay for one.
//
// A row that has no usable summary (written outside executeTool by a seed or
// an import, or an older fallback that stored the raw tool id as the title) is
// served the generic summary of its payload, computed host-side, and the
// backfill (`backfillApprovalSummaries`, run by the leader) stores the real one
// with the tool's summarizer. A writer that skips executeTool stores the
// summary itself where it can: the demo seed calls `storeApprovalSummaries` on
// the rows it wrote.
import type { ApprovalSummary } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { loadRequesterContext } from "~/modules/approvals/event-data"
import { withLiveTicketRefs } from "~/modules/approvals/live-ticket-ref"
import { splitToolName } from "~/modules/approvals/tool-name"
import { approvalSummarizerRegistry } from "~/modules/apps/app-registries"
import {
  generateApprovalSummary,
  genericApprovalSummary,
} from "~/modules/apps/approval-summarizers"

const K = () => sql.raw(schemaRef("kernel"))

interface RowWithPayload {
  tool_name: string
  summary: unknown
  current_payload?: unknown
  requested_by?: string | null
}

function hasUsableSummary(row: RowWithPayload): boolean {
  const s = row.summary
  if (!s || typeof s !== "object") return false
  const title = (s as { title?: unknown }).title
  return typeof title === "string" && title.trim().length > 0 && title !== row.tool_name
}

/** Runs one summarizer for a row; the default runs it as the row's REQUESTER. */
export type SummaryRunner = (
  row: RowWithPayload,
  summarize: (ctx: {
    tx: RlsClient
    userId: string
    actor?: ActorContext
  }) => Promise<ApprovalSummary>,
) => Promise<ApprovalSummary>

/**
 * As the requester, in its own transaction, the way an edit re-summarizes a
 * row (edit.ts): the summary reads what the person who asked could see, and a
 * failed read cannot abort the caller's transaction.
 */
const asRequester =
  (orgId: string): SummaryRunner =>
  async (row, summarize) => {
    const userId = row.requested_by ?? ""
    const actor = await loadRequesterContext(orgId, userId, "approval-served-summary-requester")
    return withRlsContext(actor, (tx) => summarize({ tx, userId, actor }))
  }

/**
 * The rows as served: a row whose tool has a summarizer but whose stored
 * summary is missing or unusable gets the generic summary of its payload
 * (copies; the inputs are not mutated). Runs no summarizer. A row whose tool
 * has no summarizer is left as it is: the feed derives a title from the
 * payload (payload-title.ts) and the card humanizes the tool id.
 */
export function withGenericSummaries<T extends RowWithPayload>(orgId: string, rows: T[]): T[] {
  if (rows.every(hasUsableSummary)) return rows
  return rows.map((row) => {
    if (hasUsableSummary(row)) return row
    const { appName, toolShortName } = splitToolName(row.tool_name)
    if (!approvalSummarizerRegistry.get([orgId, appName, toolShortName])) return row
    return { ...row, summary: genericApprovalSummary(row.tool_name, row.current_payload ?? {}) }
  })
}

/**
 * The rows with every missing summary computed by its tool's summarizer
 * (copies; the inputs are not mutated). A failure, or a tool with no
 * summarizer, leaves that row as it was. Runs summarizers: for the writers
 * that store summaries (`storeApprovalSummaries`, the backfill), never a read.
 */
async function computeMissingSummaries<T extends RowWithPayload>(
  orgId: string,
  rows: T[],
  run: SummaryRunner,
): Promise<T[]> {
  const out: T[] = []
  for (const row of rows) {
    if (hasUsableSummary(row)) {
      out.push(row)
      continue
    }
    const { appName, toolShortName } = splitToolName(row.tool_name)
    if (!approvalSummarizerRegistry.get([orgId, appName, toolShortName])) {
      out.push(row)
      continue
    }
    try {
      const summary = await run(row, ({ tx, userId, actor }) =>
        generateApprovalSummary(
          orgId,
          appName,
          toolShortName,
          row.current_payload ?? {},
          { tx, orgId, userId, ...(actor ? { actor } : {}) },
          row.tool_name,
        ),
      )
      out.push({ ...row, summary })
    } catch (err) {
      log.warn({ err, orgId, tool: row.tool_name }, "approval summary: compute failed")
      out.push(row)
    }
  }
  return out
}

/** Stored summaries (generic where missing), then each ticket ref brought to the ticket's current handle. */
export async function withServedSummaries<T extends RowWithPayload>(
  tx: RlsClient,
  orgId: string,
  rows: T[],
): Promise<T[]> {
  return withLiveTicketRefs(tx, orgId, withGenericSummaries(orgId, rows))
}

/**
 * Store, on approval rows written outside executeTool (a seed), the summary their tool's summarizer
 * writes for the row's current payload, computed as the requester like the read-time fill. A row
 * whose tool has no summarizer registered in this process, or whose summarizer fails, keeps what it
 * has and is filled when served. Returns how many rows were stored.
 */
export async function storeApprovalSummaries(
  orgId: string,
  ids: string[],
  run: SummaryRunner = asRequester(orgId),
): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await withPrivilegedDb(orgId, "approval-summary-store-load", async (tx) => {
    const res = await tx.execute(sql`
      SELECT id, tool_name, current_payload, requested_by
      FROM ${K()}.approval_requests
      WHERE org_id = ${orgId}::uuid
        AND id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`)
    return extractRows<{
      id: string
      tool_name: string
      current_payload: unknown
      requested_by: string | null
    }>(res)
  })
  // Recomputed from the current payload even when a summary is stored: a reseed may have brought
  // the payload to a newer spec.
  const filled = await computeMissingSummaries(
    orgId,
    rows.map((r) => ({ ...r, summary: null as unknown })),
    run,
  )
  const computed = filled.filter((r) => r.summary !== null)
  if (computed.length === 0) return 0
  await withPrivilegedDb(orgId, "approval-summary-store-write", async (tx) => {
    for (const r of computed) {
      await tx.execute(sql`
        UPDATE ${K()}.approval_requests SET summary = ${JSON.stringify(r.summary)}::jsonb
        WHERE id = ${r.id}::uuid AND org_id = ${orgId}::uuid`)
    }
  })
  return computed.length
}
