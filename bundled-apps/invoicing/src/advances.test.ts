// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Advances: an ordinary invoice in the normal series, deducted from one final only, refunded
// within what remains of it, and never credited while a live final deducts it.

import { describe, expect, test } from "bun:test"
import {
  done,
  harness,
  issuedAdvance,
  PROJECT,
  T_BETA,
  T_LAUNCH,
  withPlan,
} from "./__tests__/billing-plan-fixtures"
import { typeCode } from "./facturx/cii"
import { facturxInputFrom } from "./facturx/input"
import { creditNoteCreateAndIssue, draftsDiscard, invoiceIssue } from "./mutations"
import { advanceRefundPrepare } from "./mutations/advances"
import { milestoneDraftCreate } from "./mutations/billing-plan"
import { counterpartyFromRow } from "./mutations/lines"

type Row = Record<string, unknown>

describe("an advance", () => {
  test("an advance is an ordinary invoice in the normal series with VAT and code 386", async () => {
    const h = harness()
    await withPlan(h)
    const adv = await issuedAdvance(h)
    expect(adv.type).toBe("invoice")
    expect(adv.invoice_role).toBe("advance")
    expect(adv.payment_state).toBe("due")
    expect(String(adv.subtotal_minor)).toBe("1280000")
    expect(String(adv.tax_total_minor)).toBe("256000")
    expect(String(adv.grand_total_minor)).toBe("1536000")
    expect(adv.billing_project_id).toBe(PROJECT)
    // Its lines cite the quote.
    const lines = h.db.__all("document_lines").filter((l) => l.document_id === adv.id)
    expect(String(lines[0]?.description)).toContain("D-2026-0040")
    // The next invoice of the project takes the next number of the same series.
    done(h, T_BETA)
    const beta = await milestoneDraftCreate(h.ctx, { taskId: T_BETA })
    if (beta.status !== "completed") throw new Error(JSON.stringify(beta))
    const issued = (await invoiceIssue(h.ctx, { draft_id: beta.draftId })) as { number: string }
    const n = (s: string) => Number(s.split("-").pop())
    expect(String(adv.number).replace(/\d+$/, "")).toBe(issued.number.replace(/\d+$/, ""))
    expect(n(issued.number)).toBe(n(String(adv.number)) + 1)
    // Factur-X type 386, from the issued row.
    const fx = facturxInputFrom({
      type: "invoice",
      doc: adv,
      lines: [],
      issuer: { legal_name: "x" },
    })
    expect(typeCode(fx)).toBe("386")
    expect(fx.payment_state).toBe("due")
  })

  test("an advance is deducted from one final only, and the refusal names the invoice that took it", async () => {
    const h = harness()
    await withPlan(h)
    const adv = await issuedAdvance(h)
    // Another invoice already deducts this advance.
    const other = crypto.randomUUID()
    h.db.__seed("documents", [
      {
        id: other,
        type: "invoice",
        status: "issued",
        number: "F-2026-0300",
        grand_total_minor: 100n,
        lifecycle_log: [],
      },
    ])
    h.db.__seed("advance_deductions", [
      {
        id: crypto.randomUUID(),
        advance_document_id: adv.id,
        final_document_id: other,
        amount_minor: 1_280_000n,
        tax_rate_bp: 2000,
        line_position: 2,
        state: "issued",
      },
    ])
    done(h, T_LAUNCH)
    const before = h.db.__all("documents").length
    const res = await milestoneDraftCreate(h.ctx, { taskId: T_LAUNCH })
    expect(res).toMatchObject({ status: "error", error: { code: "advance_already_deducted" } })
    expect((res as { error: { message: string } }).error.message).toContain("F-2026-0300")
    expect(h.db.__all("documents")).toHaveLength(before)
    expect(h.db.__all("advance_deductions")).toHaveLength(1)
  })
})

describe("refunding an advance", () => {
  test("a stopped project's advance refund is capped at what remains", async () => {
    const h = harness()
    await withPlan(h)
    const adv = await issuedAdvance(h)
    // 6,000.00 of it was credited already.
    h.db.__seed("documents", [
      {
        id: crypto.randomUUID(),
        type: "credit_note",
        status: "issued",
        number: "A-2026-0001",
        original_document_id: adv.id,
        grand_total_minor: -600_000n,
      },
    ])
    const res = await advanceRefundPrepare(h.ctx, { advanceDocumentId: String(adv.id) })
    expect(res).toMatchObject({ status: "pending_approval" })
    expect((res as { message: string }).message).toContain(String(adv.number))
    const parked = h.approvals.at(-1) as Row
    expect(parked.tool_name).toBe("invoicing:credit_note_create_and_issue")
    const payload = parked.current_payload as {
      items: Row[]
      original_document_id: string
      reason: string
    }
    expect(payload.original_document_id).toBe(String(adv.id))
    expect(payload.reason).toContain(String(adv.number))
    // 9,360.00 incl. VAT remain: 7,800.00 net at 20%.
    expect(
      payload.items.map((i) => [
        String(i.quantity),
        String(i.unit_price_minor),
        i.tax_rate_bp_override,
      ]),
    ).toEqual([["1", "-780000", 2000]])
    // Nothing was issued: the credit note waits on its approval.
    expect(h.db.__all("documents").filter((d) => d.type === "credit_note")).toHaveLength(1)
  })

  test("a deducted advance cannot be fully credited while its final is live", async () => {
    const h = harness()
    await withPlan(h)
    const adv = await issuedAdvance(h)
    done(h, T_LAUNCH)
    const fin = await milestoneDraftCreate(h.ctx, { taskId: T_LAUNCH })
    if (fin.status !== "completed") throw new Error(JSON.stringify(fin))
    const refund = await advanceRefundPrepare(h.ctx, { advanceDocumentId: String(adv.id) })
    expect(refund).toMatchObject({ status: "error", error: { code: "advance_already_deducted" } })
    expect((refund as { error: { message: string } }).error.message).toContain(fin.draftId)
    // The general credit-note path refuses it too.
    const issuer = h.db.__all("issuer_profiles")[0] as Row
    const direct = await creditNoteCreateAndIssue(h.ctx, {
      counterparty: counterpartyFromRow(adv as never, issuer as never),
      currency: "EUR",
      items: [{ description: "Refund", quantity: "1", unit_price_minor: -1_280_000n } as never],
      original_document_id: String(adv.id),
    })
    expect(direct).toMatchObject({ status: "error", error: { code: "advance_already_deducted" } })
    const approvalsBefore = h.approvals.length
    // Once the final's draft is discarded, the advance can be refunded.
    await draftsDiscard(h.ctx, { draft_id: fin.draftId } as never)
    expect(h.db.__all("advance_deductions")).toHaveLength(0)
    const after = await advanceRefundPrepare(h.ctx, { advanceDocumentId: String(adv.id) })
    expect(after).toMatchObject({ status: "pending_approval" })
    expect(h.approvals.length).toBeGreaterThan(approvalsBefore)
  })
})
