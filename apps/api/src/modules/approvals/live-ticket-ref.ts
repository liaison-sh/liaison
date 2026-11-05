// SPDX-License-Identifier: FSL-1.1-ALv2
// A ticket approval's `summary.ref` (`ticket-B2B-123`) is written once, when
// the approval is raised. A later reclassify, or the org turning id
// segmentation on or off, leaves it naming the old segment. Wherever approval
// summaries are SERVED (list, detail, the Home attention rows) the ref is
// recomputed from the ticket's current display handle, in one batch per
// response. The stored row is never rewritten: this is a read-time view.
import { currentDisplayHandlesForRefs } from "~/apps/tickets/display-handle"
import type { RlsClient } from "~/db"
import { appsLogger as log } from "~/lib/logger"

interface RowWithSummary {
  tool_name: string
  summary: unknown
}

function ticketRefOf(row: RowWithSummary): string | null {
  if (!row.tool_name.startsWith("tickets:")) return null
  const s = row.summary
  if (!s || typeof s !== "object") return null
  const ref = (s as { ref?: unknown }).ref
  return typeof ref === "string" && ref.length > 0 ? ref : null
}

/**
 * The rows with each ticket approval's `summary.ref` replaced by the ticket's
 * CURRENT display handle (copies; the inputs are not mutated). Rows that are
 * not ticket approvals, or whose ticket the caller cannot see, come back as
 * they were. A failed lookup never fails the response: the stored ref stands.
 */
export async function withLiveTicketRefs<T extends RowWithSummary>(
  tx: RlsClient,
  orgId: string,
  rows: T[],
): Promise<T[]> {
  const refs = rows.map(ticketRefOf).filter((r): r is string => r !== null)
  if (refs.length === 0) return rows
  let live: Map<string, string>
  try {
    // In a SAVEPOINT: a failed read (tickets not installed) must not abort the
    // caller's transaction, which still has the rest of the response to read.
    live = await tx.transaction((sp) => currentDisplayHandlesForRefs(sp, orgId, refs))
  } catch (err) {
    log.warn({ err, orgId }, "approval ref: live ticket handle lookup failed")
    return rows
  }
  return rows.map((row) => {
    const ref = ticketRefOf(row)
    const current = ref ? live.get(ref) : undefined
    if (!ref || !current || current === ref) return row
    return { ...row, summary: { ...(row.summary as object), ref: current } }
  })
}
