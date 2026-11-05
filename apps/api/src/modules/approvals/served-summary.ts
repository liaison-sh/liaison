// SPDX-License-Identifier: FSL-1.1-ALv2
// Wherever approval summaries are SERVED (list, detail, the Home attention
// rows), a row that carries no usable summary gets the one its tool's
// summarizer writes, computed for this response. A row written outside
// executeTool (a seed, an import, a fixture) has a NULL summary, and an older
// fallback stored the raw tool id as the title: the card then led with
// "tickets:reply" and showed the raw payload as its body. The stored row is
// never rewritten: this is a read-time view, like `withLiveTicketRefs`.
//
// A writer that skips executeTool stores the summary itself where it can: the
// demo seed calls `storeApprovalSummaries` on the rows it wrote, so serving them
// runs no summarizer. The read-time fill stays as the fallback for older rows
// and for a tool whose summarizer was not registered when the row was written.
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
import { generateApprovalSummary } from "~/modules/apps/approval-summarizers"

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
 * The rows with every missing summary filled in (copies; the inputs are not
 * mutated). A failure leaves that row as it was.
 */
export async function withFilledSummaries<T extends RowWithPayload>(
  orgId: string,
  rows: T[],
  run: SummaryRunner = asRequester(orgId),
): Promise<T[]> {
  if (rows.every(hasUsableSummary)) return rows
  const out: T[] = []
  for (const row of rows) {
    if (hasUsableSummary(row)) {
      out.push(row)
      continue
    }
    const { appName, toolShortName } = splitToolName(row.tool_name)
    // Only a tool's own summarizer: with none, the feed derives a title from
    // the payload (payload-title.ts) and the card humanizes the tool id.
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
      log.warn({ err, orgId, tool: row.tool_name }, "approval summary: read-time fill failed")
      out.push(row)
    }
  }
  return out
}

/** Missing summaries filled, then each ticket ref brought to the ticket's current handle. */
export async function withServedSummaries<T extends RowWithPayload>(
  tx: RlsClient,
  orgId: string,
  rows: T[],
  run?: SummaryRunner,
): Promise<T[]> {
  return withLiveTicketRefs(tx, orgId, await withFilledSummaries(orgId, rows, run))
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
  const filled = await withFilledSummaries(
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
