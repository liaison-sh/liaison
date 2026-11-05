// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 G1 — overdue-scan handler test + manifest attention/jobs pins.
//
// Drives `overdueScanJob` against the shared `createMockDb` generic-CRUD
// surface. The handler scopes its `findMany('documents', ...)` to
// `where: { status: 'issued' }` and post-filters client-side on
// `payment_status` and `due_at`.

import { describe, expect, it } from "bun:test"
import manifest from "../../app.manifest.json"
import { overdueScanJob, overdueScanJobHandler, type OverdueScanCtx } from "./overdue-scan"
import { createMockDb, type MockDb } from "../test-db"

interface SeedDocOptions {
  id?: string
  type?: string
  number?: string | null
  status?: string
  payment_status?: string
  due_at?: string | null
  grand_total_minor?: number | string
  currency?: string
  counterparty_contact_id?: string | null
}

function seedDoc(over: SeedDocOptions = {}): Record<string, unknown> {
  return {
    id: over.id ?? "doc-1",
    type: over.type ?? "invoice",
    number: over.number ?? "INV-2026-0001",
    status: over.status ?? "issued",
    payment_status: over.payment_status ?? "unpaid",
    due_at: over.due_at === undefined ? "2026-05-01" : over.due_at,
    grand_total_minor:
      over.grand_total_minor === undefined ? "10000" : String(over.grand_total_minor),
    currency: over.currency ?? "EUR",
    counterparty_contact_id: over.counterparty_contact_id ?? "contact-1",
  }
}

function makeCtx(docs: Array<Record<string, unknown>>): {
  ctx: OverdueScanCtx
  db: MockDb
  emitted: Array<Record<string, unknown>>
} {
  const db = createMockDb({ seed: { documents: docs } })
  const emitted: Array<Record<string, unknown>> = []
  const ctx: OverdueScanCtx = {
    db,
    async emit(event) {
      emitted.push(event as unknown as Record<string, unknown>)
    },
  }
  return { ctx, db, emitted }
}

describe("overdueScanJob (Phase 17 G1)", () => {
  it("kernel-shaped handler forwards the SECOND arg as ctx (payload ignored)", async () => {
    // Regression: bound directly, `overdueScanJob(ctx, opts)` would receive the
    // scheduled payload as `ctx` and dereference a db-less object. The wrapper
    // must flip to the internal shape so the scan actually runs in production.
    const { ctx, emitted } = makeCtx([seedDoc({ id: "a" })])
    const r = await overdueScanJobHandler(undefined, ctx, { now: new Date("2026-05-28") })
    expect(r.scanned).toBe(1)
    expect(r.emitted).toBe(1)
    expect(emitted.length).toBe(1)
  })

  it("emits one attention per overdue document", async () => {
    const { ctx, emitted } = makeCtx([
      seedDoc({ id: "a" }),
      seedDoc({ id: "b" }),
    ])
    const r = await overdueScanJob(ctx, { now: new Date("2026-05-28") })
    expect(r.scanned).toBe(2)
    expect(r.emitted).toBe(2)
    expect(emitted.length).toBe(2)
    // Emits the declared event `detail:document_overdue` (entity:action),
    // which the manifest attention rule maps to the `invoicing:document.overdue`
    // attention kind. `entity: "detail"` deep-links the item to the document
    // detail tab (`invoicing:detail`).
    expect(emitted[0]!.entity).toBe("detail")
    expect(emitted[0]!.action).toBe("document_overdue")
    expect(
      (emitted[0]!.data as Record<string, unknown>).days_overdue as number,
    ).toBeGreaterThan(0)
  })

  // B3 regression: the attention summary must render a human currency amount,
  // never raw minor units and never the word "minor". The event carries a
  // pre-formatted `grand_total_display` honoring the currency exponent.
  it("emits a currency-formatted display amount (EUR two-decimal, JPY whole)", async () => {
    const eur = makeCtx([seedDoc({ id: "eur", grand_total_minor: 2015800, currency: "EUR" })])
    await overdueScanJob(eur.ctx, { now: new Date("2026-05-28") })
    expect((eur.emitted[0]!.data as Record<string, unknown>).grand_total_display).toBe(
      "20158.00 EUR",
    )

    const jpy = makeCtx([seedDoc({ id: "jpy", grand_total_minor: 23900, currency: "JPY" })])
    await overdueScanJob(jpy.ctx, { now: new Date("2026-05-28") })
    expect((jpy.emitted[0]!.data as Record<string, unknown>).grand_total_display).toBe("23900 JPY")
  })

  it("skips paid documents", async () => {
    const { ctx } = makeCtx([seedDoc({ payment_status: "paid" })])
    const r = await overdueScanJob(ctx, { now: new Date("2026-05-28") })
    expect(r.emitted).toBe(0)
  })

  it("skips non-issued documents", async () => {
    // The handler scopes findMany to status='issued' — draft rows aren't
    // returned at all; both `scanned` and `emitted` are 0.
    const { ctx } = makeCtx([seedDoc({ status: "draft" })])
    const r = await overdueScanJob(ctx, { now: new Date("2026-05-28") })
    expect(r.emitted).toBe(0)
    expect(r.scanned).toBe(0)
  })

  it("skips documents without a due date", async () => {
    const { ctx } = makeCtx([seedDoc({ due_at: null })])
    const r = await overdueScanJob(ctx, { now: new Date("2026-05-28") })
    expect(r.emitted).toBe(0)
  })

  it("skips documents whose due date is in the future", async () => {
    const { ctx } = makeCtx([seedDoc({ due_at: "2026-06-30" })])
    const r = await overdueScanJob(ctx, { now: new Date("2026-05-28") })
    expect(r.emitted).toBe(0)
  })

  it("computes days_overdue correctly", async () => {
    const { ctx, emitted } = makeCtx([
      seedDoc({ id: "a", due_at: "2026-05-20" }),
    ])
    await overdueScanJob(ctx, { now: new Date("2026-05-28") })
    expect(
      (emitted[0]!.data as Record<string, unknown>).days_overdue,
    ).toBe(8)
  })

  it("excludes credit notes even if (defensively) seeded with status='issued' and a past due_at", async () => {
    // Credit notes never carry a due_at in production (issueDocument passes draft.due_at=null for
    // credit_note_create_and_issue/credit_note_issue), so the `!doc.due_at` guard alone would already
    // exclude them — this test pins the explicit `doc.type !== "invoice"` gate as a second,
    // independent line of defense against a credit note ever entering AR/overdue reporting.
    const { ctx, emitted } = makeCtx([
      seedDoc({ id: "cn-1", type: "credit_note", due_at: "2026-05-01", payment_status: "unpaid" }),
    ])
    const r = await overdueScanJob(ctx, { now: new Date("2026-05-28") })
    expect(r.emitted).toBe(0)
    expect(emitted.length).toBe(0)
  })
})

describe("manifest attention + jobs (Phase 17 G1)", () => {
  const m = manifest as {
    attention?: {
      translations?: Array<{
        event?: string
        kind?: string
        urgency?: number
        summary?: string
      }>
    }
    jobs?: Record<string, { handler?: string; schedule?: string }>
  }

  it("declares every required attention translation kind", () => {
    const t = m.attention?.translations ?? []
    const kinds = new Set(t.map((x) => x.kind))
    const required = [
      "invoicing:document.overdue",
      "invoicing:event.deferred",
      "invoicing:customs.gap",
      "invoicing:pdf.failed",
      "invoicing:two_eyes_violated",
      "invoicing:email.failed",
      "invoicing:numbering.skipped",
    ]
    for (const r of required) {
      expect(kinds.has(r)).toBe(true)
    }
  })

  it("declares the deferred-retry + overdue-scan jobs with schedules", () => {
    const dr = m.jobs?.["deferred-retry"]
    expect(dr).toBeDefined()
    // The kernel-shaped `(payload, ctx)` wrapper that supplies the real
    // re-dispatch — NOT the pure `deferredRetryJob` drain (which takes an
    // injected dispatch and would receive the ctx as its dispatch arg).
    expect(dr?.handler).toBe("deferredRetryJobHandler")
    expect(dr?.schedule).toBe("*/5 * * * *")

    const os = m.jobs?.["overdue-scan"]
    expect(os).toBeDefined()
    expect(os?.handler).toBe("overdueScanJobHandler")
    expect(os?.schedule).toMatch(/^0 \d+ \* \* \*$/)
  })

  it("attention translations have a non-empty summary string", () => {
    const t = m.attention?.translations ?? []
    for (const entry of t) {
      expect(typeof entry.summary).toBe("string")
      expect(entry.summary!.length).toBeGreaterThan(0)
      expect(typeof entry.urgency).toBe("number")
    }
  })
})

describe("overdue resolution — a paid past-due invoice clears its stale row", () => {
  // The overdue row is written once and never revisited: paying the invoice just
  // stopped the scan re-emitting, so the feed kept claiming the invoice was late
  // long after the money arrived. The scan now emits the same event with
  // days_overdue 0, which the manifest's resolveWhen turns into a mark-read.
  const NOW = new Date("2026-06-01T00:00:00.000Z")

  it("emits a days_overdue 0 event for an invoice that was overdue and is now paid", () => {
    const { ctx, emitted } = makeCtx([
      seedDoc({ id: "doc-paid", payment_status: "paid", due_at: "2026-05-01" }),
    ])
    return overdueScanJob(ctx, { now: NOW }).then((res) => {
      expect(res.emitted).toBe(0)
      expect(res.resolved).toBe(1)
      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({ entity: "detail", action: "document_overdue", entityId: "doc-paid" })
      expect((emitted[0]!.data as Record<string, unknown>).days_overdue).toBe(0)
    })
  })

  it("stays silent for a paid invoice that was never overdue", async () => {
    // Bounded by design: a large paid history must not cost an event per doc.
    const { ctx, emitted } = makeCtx([
      seedDoc({ id: "doc-early", payment_status: "paid", due_at: "2026-07-01" }),
    ])
    const res = await overdueScanJob(ctx, { now: NOW })
    expect(res.resolved).toBe(0)
    expect(emitted).toHaveLength(0)
  })

  it("still raises the overdue row for an unpaid past-due invoice", async () => {
    const { ctx, emitted } = makeCtx([
      seedDoc({ id: "doc-late", payment_status: "unpaid", due_at: "2026-05-01" }),
    ])
    const res = await overdueScanJob(ctx, { now: NOW })
    expect(res.emitted).toBe(1)
    expect(res.resolved).toBe(0)
    expect((emitted[0]!.data as Record<string, unknown>).days_overdue).toBe(31)
  })

  it("never resolves a non-invoice document type", async () => {
    const { ctx, emitted } = makeCtx([
      seedDoc({ id: "cn-1", type: "credit_note", payment_status: "paid", due_at: "2026-05-01" }),
    ])
    const res = await overdueScanJob(ctx, { now: NOW })
    expect(res.resolved).toBe(0)
    expect(emitted).toHaveLength(0)
  })

  it("the manifest translation turns a days_overdue 0 event into a resolution", () => {
    const t = (manifest as unknown as {
      attention: { translations: Array<{ event: string; resolveWhen?: unknown }> }
    }).attention.translations.find((x) => x.event === "detail:document_overdue")
    expect(t?.resolveWhen).toEqual({ field: "days_overdue", equals: 0 })
  })
})
