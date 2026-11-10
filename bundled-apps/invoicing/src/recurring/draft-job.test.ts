// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end draft job against the in-memory store: one unnumbered draft per due schedule, made
// from the schedule alone, keyed so a second run adds nothing, with flags read from the data.
import { describe, expect, test } from "bun:test"
import { createMockDb, type MockDb } from "../test-db"
import { recurringDraftJob } from "./draft-job"
import type { RunCtx } from "./run-card"
import { weekdayOf } from "./schedule"

export const ISSUER = "11111111-1111-4111-8111-111111111111"
const CONTACT = "22222222-2222-4222-8222-222222222222"

export function schedule(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    issuer_profile_id: ISSUER,
    contact_id: CONTACT,
    status: "active",
    repeats: "month",
    billing_day: "last",
    issue_mode: "review",
    due_rule: "days_30",
    lines: [{ description: "Retainer {period}", qty: 1, unit_price_minor: 150000, vat_bp: 2000, line_kind: "service" }],
    next_issue_on: "2026-11-30",
    next_draft_on: "2026-11-27",
    version: 1,
    created_by: "user-am",
    ...over,
  }
}

export function previousDoc(id: string, paid: boolean): Record<string, unknown> {
  return {
    id,
    type: "invoice",
    status: "issued",
    number: "F-2026-0040",
    counterparty_contact_id: CONTACT,
    counterparty_name: "Atelier Sauvan",
    counterparty_address: "3 rue des Lilas, 69001 Lyon",
    counterparty_country: "FR",
    issuer_profile_id: ISSUER,
    currency: "EUR",
    payment_status: paid ? "paid" : "unpaid",
    external_refs: {},
  }
}

export interface Harness {
  ctx: RunCtx
  db: MockDb
  approvals: Array<Record<string, unknown>>
  restaged: Array<Record<string, unknown>>
  agentCalls: number
}

export function harness(today: string, opts: { schedules?: Array<Record<string, unknown>>; docs?: Array<Record<string, unknown>>; lines?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>>; threshold?: number | null; hour?: number } = {}): Harness {
  const db = createMockDb({
    bridgeWhereOperators: true,
    seed: {
      issuer_profiles: [
        {
          id: ISSUER,
          legal_name: "Maison Nord SARL",
          country: "FR",
          default_currency: "EUR",
          timezone: "Europe/Paris",
          invoice_approval_threshold_minor: opts.threshold === undefined ? null : opts.threshold === null ? null : String(opts.threshold),
        },
      ],
      recurring_schedules: opts.schedules ?? [schedule("33333333-3333-4333-8333-333333333331")],
      ...(opts.docs ? { documents: opts.docs } : {}),
      ...(opts.lines ? { document_lines: opts.lines } : {}),
      ...(opts.items ? { recurring_run_items: opts.items } : {}),
    },
  })
  const h: Harness = { ctx: null as never, db, approvals: [], restaged: [], agentCalls: 0 }
  let n = 0
  h.ctx = {
    db: db as never,
    getUserId: async () => "user-person",
    approval: null,
    time: {
      async civil({ timezone }: { timezone: string }) {
        const [y, m, d] = today.split("-").map(Number) as [number, number, number]
        return { date: today, year: y, month: m, day: d, hour: opts.hour ?? 9, minute: 0, weekday: weekdayOf(today), zone: timezone }
      },
    },
    requestApproval: async (input: Record<string, unknown>) => {
      h.approvals.push(input)
      n += 1
      return { approval_id: `approval-${n}` }
    },
    approvals: {
      restagePayload: async (id: string, fields: Record<string, unknown>) => {
        h.restaged.push({ id, ...fields })
        return { ok: true, approval_id: id, payload_hash: "h", changed: true }
      },
    },
    // A stub agent: any model or agent call made while drafting is counted and fails the test.
    executeTool: async (target: string) => {
      if (target.startsWith("kernel:agents") || target.includes("agent")) h.agentCalls += 1
      return { status: "error", error: { code: "unavailable", message: "no tool in this test" } }
    },
    emit: async () => {},
  } as unknown as RunCtx
  return h
}

describe("the month-end draft job", () => {
  test("the job drafts one unnumbered draft per due schedule from the schedule alone and stores the period", async () => {
    const prev = previousDoc("44444444-4444-4444-8444-444444444441", true)
    const h = harness("2026-11-27", {
      schedules: [schedule("33333333-3333-4333-8333-333333333331", { last_document_id: prev.id })],
      docs: [prev],
    })
    const res = await recurringDraftJob(h.ctx)
    expect(res.drafted).toBe(1)
    expect(h.agentCalls).toBe(0)
    const drafts = h.db.__all("documents").filter((d) => d.status === "draft")
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      number: null,
      type: "invoice",
      external_ref: "recurring:33333333-3333-4333-8333-333333333331:2026-11",
      counterparty_name: "Atelier Sauvan",
      due_at: "2026-12-30",
    })
    const lines = h.db.__all("document_lines").filter((l) => l.document_id === drafts[0]?.id)
    expect(lines).toEqual([expect.objectContaining({ description: "Retainer November 2026", unit_price_minor: "150000", tax_rate_bp: 2000 })])
    const [item] = h.db.__all("recurring_run_items")
    expect(item).toMatchObject({ period_key: "2026-11", period_start: "2026-11-01", period_end: "2026-11-30", document_id: drafts[0]?.id, state: "ready" })
    const [run] = h.db.__all("recurring_runs")
    expect(run).toMatchObject({ issue_on: "2026-11-30", latest_issue_on: "2026-11-30", status: "drafted", approval_request_id: "approval-1" })
    // The schedule moved to its next period.
    expect(h.db.__all("recurring_schedules")[0]).toMatchObject({ next_issue_on: "2026-12-31" })
  })

  test("a schedule whose draft day has not come drafts nothing", async () => {
    const h = harness("2026-11-26")
    expect((await recurringDraftJob(h.ctx)).drafted).toBe(0)
    expect(h.db.__all("documents")).toHaveLength(0)
  })

  test("running the job twice makes one run, one item per schedule, one draft each and one approval", async () => {
    const h = harness("2026-11-27", {
      schedules: [schedule("33333333-3333-4333-8333-333333333331"), schedule("33333333-3333-4333-8333-333333333332")],
    })
    await recurringDraftJob(h.ctx)
    await recurringDraftJob(h.ctx)
    expect(h.db.__all("recurring_runs")).toHaveLength(1)
    expect(h.db.__all("recurring_run_items")).toHaveLength(2)
    expect(h.db.__all("documents").filter((d) => d.status === "draft")).toHaveLength(2)
    expect(h.approvals).toHaveLength(1)
    expect((h.approvals[0]?.current_payload as { items: unknown[] }).items).toHaveLength(2)
  })

  test("the flags come from the data with no model call", async () => {
    const same = previousDoc("44444444-4444-4444-8444-444444444441", false)
    const changed = previousDoc("44444444-4444-4444-8444-444444444442", true)
    const line = (doc: string, price: string) => ({ id: `l-${doc}`, document_id: doc, position: 1, description: "Retainer November 2026", quantity: "1", unit_price_minor: price, tax_rate_bp: 2000, subtotal_minor: price })
    const h = harness("2026-11-27", {
      schedules: [
        schedule("33333333-3333-4333-8333-333333333331", { last_document_id: same.id }),
        schedule("33333333-3333-4333-8333-333333333332", { last_document_id: changed.id }),
        schedule("33333333-3333-4333-8333-333333333333"),
      ],
      docs: [same, changed],
      lines: [line(String(same.id), "150000"), line(String(changed.id), "120000")],
      items: [
        { id: "i-prev-1", run_id: "r-old", schedule_id: "x1", period_key: "2026-10", period_start: "2026-10-01", period_end: "2026-10-31", document_id: same.id, position: 1, state: "issued" },
        { id: "i-prev-2", run_id: "r-old", schedule_id: "x2", period_key: "2026-10", period_start: "2026-10-01", period_end: "2026-10-31", document_id: changed.id, position: 2, state: "issued" },
      ],
    })
    await recurringDraftJob(h.ctx)
    expect(h.agentCalls).toBe(0)
    const notes = Object.fromEntries(
      h.db.__all("recurring_run_items").filter((i) => i.period_key === "2026-11").map((i) => [String(i.schedule_id).slice(-1), i.note]),
    )
    expect(notes["1"]).toBe("Same as October · October is still unpaid")
    expect(notes["2"]).toBe("Changed since October")
    expect(String(notes["3"])).toContain("First invoice")
  })
})
