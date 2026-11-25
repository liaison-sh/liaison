// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An advance that a final invoice deducts cannot be credited while that final is live: the final
// already takes it off what the client pays, so crediting it too would refund it twice. Checked on
// every credit note against an invoice (credit_note_create_and_issue, its approval's re-run, and
// advance_refund_prepare), so no path refunds a deducted advance.

import { isFullyCredited } from "./credit-coverage"
import type { ErrorEnvelope, MutationsDb } from "./shared"

type Row = Record<string, unknown>

/** `advance_already_deducted` naming the final, when `originalId` is an advance a live final deducts. */
export async function advanceDeductedRefusal(
  db: Pick<MutationsDb, "findMany" | "findOne">,
  originalId: string,
): Promise<ErrorEnvelope | null> {
  const original = (
    (await db.findMany("documents", { where: { id: originalId }, limit: 1 })) as Row[]
  )[0]
  if (!original || original.invoice_role !== "advance") return null
  const taken = (await db.findMany("advance_deductions", {
    where: { advance_document_id: originalId },
    limit: 20,
  })) as Row[]
  for (const t of taken) {
    if (t.state === "released") continue
    const final = (
      (await db.findMany("documents", {
        where: { id: String(t.final_document_id) },
        limit: 1,
      })) as Row[]
    )[0]
    if (!final || final.status === "cancelled" || final.status === "voided") continue
    if (final.status !== "draft") {
      const notes = (await db.findMany("documents", {
        where: { original_document_id: String(final.id) },
        limit: 50,
      })) as Row[]
      const grand = final.grand_total_minor
      const credited = await isFullyCredited(
        db,
        {
          id: String(final.id),
          lifecycle_log: (final.lifecycle_log as Row[] | undefined) ?? [],
          grand_total_minor: typeof grand === "bigint" ? grand : BigInt(String(grand ?? 0)),
        },
        notes,
      )
      if (credited) continue
    }
    const name = final.number ? `invoice ${String(final.number)}` : `draft ${String(final.id)}`
    return {
      status: "error",
      error: {
        code: "advance_already_deducted",
        message: `Advance ${String(original.number ?? originalId)} is deducted from ${name}, so no credit note was made: refunding it too would pay it back twice. Credit ${name} first, or discard it if it is still a draft.`,
      },
    }
  }
  return null
}
