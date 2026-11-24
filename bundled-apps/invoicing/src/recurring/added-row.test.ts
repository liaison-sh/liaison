// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An invoice added to a month-end run by hand is shown and approved as it will issue: its tax, its
// operation type, its due date and its period. The amount approved is recorded, a run approved
// again says who approved it last, and a card nobody needs any more leaves.
import { describe, expect, test } from "bun:test"
import { CONTACT, harness, ISSUER, schedule } from "../__fixtures__/recurring-draft"
import { draftsCreateTool, draftsUpdateTool } from "../mutations"
import { summarizeRecurringRunIssue } from "../summarizers"
import { recurringDraftJob } from "./draft-job"
import { type CardItem, cardItems, recurringRunIssue, recurringRunUnapprove } from "./run-card"
import { recurringRunGet } from "./run-get"

const SCHED = "33333333-3333-4333-8333-333333333331"

async function drafted(extra: Parameters<typeof harness>[1] = {}) {
  const h = harness("2026-11-27", { schedules: [schedule(SCHED)], ...extra })
  await recurringDraftJob(h.ctx)
  const runId = String(h.db.__all("recurring_runs")[0]?.id)
  return { h, runId }
}

async function add(
  h: Awaited<ReturnType<typeof drafted>>["h"],
  runId: string,
  over: Record<string, unknown> = {},
) {
  const r = await draftsCreateTool(
    h.ctx as never,
    {
      type: "invoice",
      run_id: runId,
      counterparty_contact_id: CONTACT,
      items: [{ description: "Extra hour", quantity: "1", unit_price_minor: "10000" }],
      ...over,
    } as never,
  )
  if (!("draft_id" in r)) throw new Error(JSON.stringify(r))
  return r
}

const item = (h: { db: { __all(t: string): Array<Record<string, unknown>> } }, draftId: string) =>
  h.db.__all("recurring_run_items").find((i) => i.document_id === draftId) as Record<
    string,
    unknown
  >
const doc = (h: { db: { __all(t: string): Array<Record<string, unknown>> } }, id: string) =>
  h.db.__all("documents").find((d) => d.id === id) as Record<string, unknown>

describe("an invoice added to a month-end run", () => {
  test("is on the card with the tax it will issue with, in the tool's answer and on the run's page", async () => {
    const { h, runId } = await drafted()
    const added = await add(h, runId)
    const row = (await cardItems(h.ctx, runId)).items.find(
      (i) => i.document_id === added.draft_id,
    ) as CardItem
    expect(row.total_minor).toBe("12000")
    expect(added.run_row?.row_total_minor).toBe("12000")
    expect(added.run_row?.approve_total_minor).toBe("192000")
    const got = await recurringRunGet(h.ctx, { run_id: runId })
    if (got.status !== "completed") throw new Error("not read")
    const shown = got.rows.find((r) => r.draft_id === added.draft_id)
    expect(shown).toMatchObject({ net_minor: "10000", vat_minor: "2000", total_minor: "12000" })
  })

  test("with a customer outside the issuer's country is shown without the tax it will not carry", async () => {
    const { h, runId } = await drafted()
    const added = await add(h, runId, { counterparty_country: "US" })
    const row = (await cardItems(h.ctx, runId)).items.find((i) => i.document_id === added.draft_id)
    expect(row?.total_minor).toBe("10000")
  })

  test("carries the run's period, an operation type and a due date, all on the run's page", async () => {
    const { h, runId } = await drafted()
    const added = await add(h, runId)
    const d = doc(h, added.draft_id)
    expect(d).toMatchObject({
      operation_category: "services",
      due_at: "2026-12-30",
      service_period_start: "2026-11-01",
      service_period_end: "2026-11-30",
    })
    const line = h.db.__all("document_lines").find((l) => l.document_id === added.draft_id)
    expect(line?.line_kind).toBe("service")
    const got = await recurringRunGet(h.ctx, { run_id: runId })
    if (got.status !== "completed") throw new Error("not read")
    expect(got.rows.find((r) => r.draft_id === added.draft_id)).toMatchObject({
      due_at: "2026-12-30",
      operation_category: "services",
      period_start: "2026-11-01",
      period_end: "2026-11-30",
    })
  })

  test("added after the issue day, in time, is due counted from that day", async () => {
    const { h, runId } = await drafted()
    await h.db.update("recurring_runs", runId, { issue_on: "2026-11-25" })
    const added = await add(h, runId)
    expect(doc(h, added.draft_id).due_at).toBe("2026-12-27")
    expect(doc(h, added.draft_id).external_refs).toMatchObject({ due_counted_from: "2026-11-27" })
  })

  test("for a company abroad whose VAT number an earlier invoice holds is shown without VAT, as it issues", async () => {
    const earlier = {
      id: "55555555-5555-4555-8555-555555555559",
      type: "invoice",
      status: "issued",
      number: "F-2026-0001",
      counterparty_contact_id: CONTACT,
      counterparty_name: "Arlon GmbH",
      counterparty_email: "compta@arlon.example",
      counterparty_address: "Hauptstrasse 1, 10115 Berlin",
      counterparty_country: "DE",
      counterparty_vat_id: "DE298765432",
      issued_at: "2026-10-31",
      currency: "EUR",
      grand_total_minor: "10000",
      tax_total_minor: "0",
      external_refs: {},
      lifecycle_log: [],
    }
    const { h, runId } = await drafted({ docs: [earlier] })
    const added = await add(h, runId, { counterparty_country: "DE" })
    await h.db.update("documents", added.draft_id, { counterparty_vat_id: null })
    const row = async () =>
      (await cardItems(h.ctx, runId)).items.find((i) => i.document_id === added.draft_id)
    expect((await row())?.total_minor).toBe("10000")
    await h.db.update("documents", earlier.id, { counterparty_vat_id: null })
    expect((await row())?.total_minor).not.toBe("10000")
  })

  test("keeps what the caller said, and a goods line is goods", async () => {
    const { h, runId } = await drafted()
    const own = await add(h, runId, { due_at: "2027-01-15", operation_category: "mixed" })
    expect(doc(h, own.draft_id)).toMatchObject({
      due_at: "2027-01-15",
      operation_category: "mixed",
    })
    const goods = await add(h, runId, {
      items: [{ description: "Cable", quantity: "1", unit_price_minor: "500", line_kind: "goods" }],
    })
    expect(doc(h, goods.draft_id).operation_category).toBe("goods")
  })

  test("a card that grew says how many invoices it holds, under a title that names no number", async () => {
    const { h, runId } = await drafted()
    expect(String(h.approvals[0]?.summary)).not.toMatch(/\b\d+ invoice/)
    await add(h, runId)
    const payload = h.restaged[h.restaged.length - 1] as Record<string, unknown>
    const card = await summarizeRecurringRunIssue(payload)
    expect(card.subtitle).toContain("Last day: 2026-11-30.")
    expect(card.lines[0]).toStartWith("2 invoices: ")
    expect(card.lines[1]?.replace(/\s/g, " ")).toBe("Total: 1 920.00 EUR incl. VAT")
  })
})

describe("approving a run", () => {
  test("records the amount of each row and who approved it on the invoice", async () => {
    const { h, runId } = await drafted()
    const added = await add(h, runId)
    const { items } = await cardItems(h.ctx, runId)
    await recurringRunIssue(h.ctx, { run_id: runId, items })
    expect(String(item(h, added.draft_id).approved_total_minor)).toBe("12000")
    expect(doc(h, added.draft_id).approved_by).toBe("user-person")
  })

  test("a card showing another amount than the row bills approves nothing of that row", async () => {
    const { h, runId } = await drafted()
    const added = await add(h, runId)
    const { items } = await cardItems(h.ctx, runId)
    const wrong = items.map((i) =>
      i.document_id === added.draft_id ? { ...i, total_minor: "10000" } : i,
    )
    const r = await recurringRunIssue(h.ctx, { run_id: runId, items: wrong })
    expect(r).toMatchObject({ status: "completed", approved: 1, changed: [added.draft_id] })
    expect(item(h, added.draft_id).state).toBe("waiting_reapproval")
  })

  test("a tax rule, VAT number, operation type or period that changes a row changes its hash", async () => {
    const { h, runId } = await drafted()
    const added = await add(h, runId, { counterparty_country: "DE" })
    const hash = async () =>
      (await cardItems(h.ctx, runId)).items.find((i) => i.document_id === added.draft_id)
        ?.content_hash
    const seen = new Set([await hash()])
    await h.db.update("documents", added.draft_id, {
      external_refs: { ...(doc(h, added.draft_id).external_refs as object), tax_country: "US" },
    })
    seen.add(await hash())
    for (const patch of [
      { operation_category: "mixed" },
      { service_period_end: "2026-12-31" },
      { counterparty_vat_id: "DE298765432" },
    ]) {
      await h.db.update("documents", added.draft_id, patch)
      seen.add(await hash())
    }
    await h.db.update("issuer_profiles", ISSUER, { country: "GB" })
    seen.add(await hash())
    expect(seen.size).toBe(6)
  })

  test("again, by someone else, the run and its row say the last approver", async () => {
    const { h, runId } = await drafted()
    const first = (await cardItems(h.ctx, runId)).items
    await recurringRunIssue(h.ctx, { run_id: runId, items: first })
    h.decided.add("approval-1")
    const added = await add(h, runId)
    const run = () => h.db.__all("recurring_runs")[0] as Record<string, unknown>
    expect(run().approved_by).toBe("user-person")
    const before = run().approved_at
    await new Promise((r) => setTimeout(r, 5))
    const ctx = {
      ...h.ctx,
      approval: {
        approvalRequestId: String(run().approval_request_id),
        approvalDeciderId: "user-second",
        toolName: "invoicing:recurring_run_issue",
      },
    }
    const again = (await cardItems(h.ctx, runId)).items
    expect(again.map((i) => i.document_id)).toEqual([added.draft_id])
    await recurringRunIssue(ctx as never, { run_id: runId, items: again })
    expect(run().approved_by).toBe("user-second")
    expect(run().approved_at).not.toBe(before)
    expect(doc(h, added.draft_id).approved_by).toBe("user-second")
    expect(doc(h, String(first[0]?.document_id)).approved_by).toBe("user-person")
  })

  test("without its waiting card withdraws that card, and with it withdraws nothing", async () => {
    for (const byCard of [false, true]) {
      const { h, runId } = await drafted()
      const gone: string[] = []
      const ctx = {
        ...h.ctx,
        approvals: {
          ...h.ctx.approvals,
          withdraw: async (id: string) => {
            gone.push(id)
            return { ok: true }
          },
        },
        approval: byCard
          ? { approvalRequestId: "approval-1", approvalDeciderId: "user-x", toolName: "t" }
          : null,
      }
      await recurringRunIssue(ctx as never, { run_id: runId })
      expect(gone).toEqual(byCard ? [] : ["approval-1"])
    }
  })

  test("undone, or edited, a row forgets the amount and the approver", async () => {
    const { h, runId } = await drafted()
    const added = await add(h, runId)
    await recurringRunIssue(h.ctx, { run_id: runId })
    await h.db.update("documents", added.draft_id, { updated_at: "2026-11-27T09:00:00Z" })
    await draftsUpdateTool(h.ctx as never, {
      draft_id: added.draft_id,
      patch: { po_number: "PO-1" },
      if_unchanged_since: "2026-11-27T09:00:00Z",
    })
    expect(doc(h, added.draft_id).approved_by).toBeNull()
    expect(item(h, added.draft_id)).toMatchObject({
      state: "waiting_reapproval",
      approved_total_minor: null,
    })
    await recurringRunUnapprove(h.ctx, { run_id: runId })
    const other = h.db.__all("recurring_run_items").find((i) => i.document_id !== added.draft_id)
    expect(other).toMatchObject({ state: "ready", approved_total_minor: null })
    expect(doc(h, String(other?.document_id)).approved_by).toBeNull()
  })
})
