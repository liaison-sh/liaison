// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E3 — Deferred queue + retry plumbing tests.
//
// Drives `park` / `retryEligible` / `markPermanentFailure` / `manualRetry`
// and the `deferredRetryJob` cron handler against the shared `createMockDb`
// generic-CRUD surface — same shape the sandbox bridge exposes.

import { describe, expect, test } from "bun:test"
import {
  DEAD_LETTER_CAP,
  DEAD_LETTER_MIN_AGE_MS,
  type DeferredCtx,
  type DeferredRow,
  RETRY_BATCH_SIZE,
  defaultBackoffMs,
  manualRetry,
  markPermanentFailure,
  park,
  retryEligible,
} from "./deferred"
import { deferredRetryJob } from "./handlers/deferred-retry"
import { raiseIdentityAttention } from "./einvoicing/gate"
import { createMockDb, type MockDb } from "./test-db"

type SeedRow = Partial<DeferredRow> & { id: string }

function seedRows(rows: SeedRow[]): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    id: r.id,
    event_id: r.event_id ?? `evt-${r.id}`,
    event_payload_json: r.event_payload_json ?? {},
    status: r.status ?? "awaiting_config",
    reason: r.reason ?? null,
    blocked_on: r.blocked_on ?? {},
    retry_count: r.retry_count ?? 0,
    retried_at: r.retried_at ?? null,
    created_at: r.created_at ?? new Date("2026-05-14T00:00:00Z"),
  }))
}

function makeCtx(initial: SeedRow[] = []): { ctx: DeferredCtx; db: MockDb } {
  const db = createMockDb({
    seed: initial.length > 0 ? { deferred_events: seedRows(initial) } : {},
  })
  const ctx: DeferredCtx = { db }
  return { ctx, db }
}

describe("deferred queue (E3)", () => {
  test("park inserts a row with the supplied status + blocked_on pointer", async () => {
    const { ctx, db } = makeCtx()
    const r = await park(ctx, {
      event_id: "evt-1",
      event_payload_json: { foo: 1 },
      status: "awaiting_config",
      reason: "issuer_mapping_missing",
      blocked_on: { kind: "issuer_mapping", shop_id: "shop-1" },
    })
    expect(r.id.length).toBeGreaterThan(0)
    const rows = db.__all("deferred_events")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe("awaiting_config")
    expect(rows[0]!.retry_count).toBe(0)
    expect(rows[0]!.retried_at).toBeNull()
  })

  test("park is idempotent by (event_id, blocker): re-parking refreshes in place, no duplicate row", async () => {
    const { ctx, db } = makeCtx()
    const first = await park(ctx, {
      event_id: "evt-dup",
      event_payload_json: { v: 1 },
      status: "awaiting_data",
      reason: "customer_email_missing",
      blocked_on: { kind: "customer_email", customer_id: "c-1" },
    })
    // Same order, same blocker (a webhook redelivery / still-blocked re-dispatch).
    const second = await park(ctx, {
      event_id: "evt-dup",
      event_payload_json: { v: 2 },
      status: "awaiting_data",
      reason: "customer_email_missing",
      blocked_on: { kind: "customer_email", customer_id: "c-1" },
    })
    expect(second.id).toBe(first.id)
    const rows = db.__all("deferred_events")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_payload_json).toEqual({ v: 2 }) // refreshed in place
  })

  test("park keeps DIFFERENT blockers for the same order as separate rows", async () => {
    const { ctx, db } = makeCtx()
    await park(ctx, {
      event_id: "evt-multi",
      event_payload_json: {},
      status: "awaiting_data",
      reason: "customer_email_missing",
      blocked_on: { kind: "customer_email" },
    })
    await park(ctx, {
      event_id: "evt-multi",
      event_payload_json: {},
      status: "render_failed",
      reason: "pdf",
      blocked_on: { kind: "pdf_render", document_id: "doc-9" },
    })
    expect(db.__all("deferred_events")).toHaveLength(2)
  })

  test("retryEligible respects exponential backoff", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const recent = new Date(now.getTime() - 60 * 1000) // 1min ago — too soon for retry_count=1
    const ready = new Date(now.getTime() - 10 * 60 * 1000) // 10min ago — eligible
    const { ctx } = makeCtx([
      { id: "def-A", retry_count: 1, retried_at: recent },
      { id: "def-B", retry_count: 1, retried_at: ready },
    ])
    const eligible = await retryEligible(ctx, { now })
    expect(eligible.map((r) => r.id)).toEqual(["def-B"])
  })

  // red: drop the needsHumanReview filter in retryEligible -> a tax review park is re-driven every
  // sweep, re-parks, and ages into permanent_failure without the order ever being invoiced.
  test("retryEligible leaves tax review parks to a person", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const { ctx } = makeCtx([
      { id: "def-tax", status: "awaiting_data", blocked_on: { kind: "tax_check" } },
      { id: "def-exempt", status: "awaiting_data", blocked_on: { kind: "tax_treatment" } },
      { id: "def-oss", status: "awaiting_config", blocked_on: { kind: "tax_rate" } },
      { id: "def-email", status: "awaiting_data", blocked_on: { kind: "customer_email" } },
    ])
    const eligible = await retryEligible(ctx, { now })
    expect(eligible.map((r) => r.id)).toEqual(["def-email"])
  })

  test("retryEligible excludes rows at the dead-letter cap", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const longAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const { ctx } = makeCtx([
      { id: "def-cap", retry_count: DEAD_LETTER_CAP, retried_at: longAgo },
      { id: "def-ok", retry_count: 0, retried_at: null },
    ])
    const eligible = await retryEligible(ctx, { now })
    expect(eligible.map((r) => r.id)).toEqual(["def-ok"])
  })

  test("markPermanentFailure flips a row once both cap and age criteria are met", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const oldCreated = new Date(now.getTime() - DEAD_LETTER_MIN_AGE_MS - 1000)
    const recentCreated = new Date(now.getTime() - 60 * 1000)
    const { ctx, db } = makeCtx([
      { id: "def-ready", retry_count: DEAD_LETTER_CAP, created_at: oldCreated },
      { id: "def-young", retry_count: DEAD_LETTER_CAP, created_at: recentCreated },
    ])
    // Hydrate DeferredRow objects from the mock store (same shape `retryEligible`
    // produces in production paths).
    const all = await retryEligible(ctx, { now })
    // retryEligible filters by backoff — the elapsed ms is >= cap-rate, so both pass.
    const ready = all.find((r) => r.id === "def-ready")
    const young = all.find((r) => r.id === "def-young")
    // Fallback: build hydrated rows directly if filtering excludes them.
    const readyRow: DeferredRow = ready ?? {
      id: "def-ready",
      event_id: "evt-def-ready",
      event_payload_json: {},
      status: "awaiting_config",
      reason: null,
      blocked_on: {},
      retry_count: DEAD_LETTER_CAP,
      retried_at: null,
      created_at: oldCreated,
    }
    const youngRow: DeferredRow = young ?? {
      id: "def-young",
      event_id: "evt-def-young",
      event_payload_json: {},
      status: "awaiting_config",
      reason: null,
      blocked_on: {},
      retry_count: DEAD_LETTER_CAP,
      retried_at: null,
      created_at: recentCreated,
    }
    const updatedReady = await markPermanentFailure(ctx, readyRow, { now })
    expect(updatedReady.status).toBe("permanent_failure")
    expect(db.__all("deferred_events").find((r) => r.id === "def-ready")?.status).toBe(
      "permanent_failure",
    )
    const updatedYoung = await markPermanentFailure(ctx, youngRow, { now })
    expect(updatedYoung.status).not.toBe("permanent_failure")
  })

  test("manualRetry runs the handler immediately and increments retry_count", async () => {
    const { ctx, db } = makeCtx([{ id: "def-1", retry_count: 2, retried_at: null }])
    let called = false
    const out = await manualRetry(ctx, "def-1", async () => {
      called = true
    })
    expect(called).toBe(true)
    expect(out.status).toBe("ok")
    const row = db.__all("deferred_events").find((r) => r.id === "def-1")!
    expect(row.retry_count).toBe(3)
    expect(row.retried_at).not.toBeNull()
  })

  test("manualRetry on a failing handler keeps the row in place and counts the attempt", async () => {
    const { ctx, db } = makeCtx([{ id: "def-1", retry_count: 2, retried_at: null }])
    const out = await manualRetry(ctx, "def-1", async () => {
      throw new Error("nope")
    })
    expect(out.status).toBe("failed")
    const row = db.__all("deferred_events").find((r) => r.id === "def-1")!
    expect(row.retry_count).toBe(3)
  })

  test("manualRetry success marks row resolved; retryEligible excludes it on the next sweep", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const { ctx, db } = makeCtx([{ id: "def-manual", retry_count: 0, retried_at: null }])
    const out = await manualRetry(ctx, "def-manual", async () => {
      // handler succeeds
    })
    expect(out.status).toBe("ok")
    expect(out.row.status).toBe("resolved")
    const stored = db.__all("deferred_events").find((r) => r.id === "def-manual")!
    expect(stored.status).toBe("resolved")
    // retryEligible must not re-select a resolved row — the re-processing loop
    // that TERMINAL_STATUSES was introduced to prevent.
    const eligible = await retryEligible(ctx, { now })
    expect(eligible.map((r) => r.id)).not.toContain("def-manual")
  })

  test("defaultBackoffMs schedule", () => {
    expect(defaultBackoffMs(0)).toBe(0)
    expect(defaultBackoffMs(1)).toBe(5 * 60 * 1000)
    expect(defaultBackoffMs(2)).toBe(15 * 60 * 1000)
    expect(defaultBackoffMs(3)).toBe(30 * 60 * 1000)
    expect(defaultBackoffMs(4)).toBe(60 * 60 * 1000)
    expect(defaultBackoffMs(10)).toBe(60 * 60 * 1000)
  })

  test("deferredRetryJob: dispatch success → row counted as succeeded; dispatch still-blocked → counted as failed", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const { ctx } = makeCtx([
      { id: "def-OK", retry_count: 0, retried_at: null },
      { id: "def-BLK", retry_count: 0, retried_at: null },
    ])
    const dispatch = async (row: DeferredRow) =>
      row.id === "def-OK"
        ? ({ status: "ok" } as const)
        : ({ status: "still_blocked", reason: "still_no_mapping" } as const)
    const result = await deferredRetryJob(ctx, dispatch, { now })
    expect(result.scanned).toBe(2)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.dead_lettered).toBe(0)
  })

  test("deferredRetryJob: successfully dispatched row is marked resolved and excluded from subsequent sweeps", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const { ctx, db } = makeCtx([{ id: "def-OK", retry_count: 0, retried_at: null }])
    const dispatch = async () => ({ status: "ok" } as const)
    // First sweep — dispatched successfully.
    const first = await deferredRetryJob(ctx, dispatch, { now })
    expect(first.succeeded).toBe(1)
    const row = db.__all("deferred_events").find((r) => r.id === "def-OK")!
    expect(row.status).toBe("resolved")
    // Second sweep — resolved row must NOT appear in retryEligible.
    const second = await deferredRetryJob(ctx, dispatch, { now })
    expect(second.scanned).toBe(0)
    expect(second.succeeded).toBe(0)
  })

  test("retryEligible bounds the batch to RETRY_BATCH_SIZE and never exceeds it", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const created = new Date(now.getTime() - 24 * 60 * 60 * 1000) // long past any backoff
    const many: SeedRow[] = []
    for (let i = 0; i < RETRY_BATCH_SIZE * 4; i++) {
      many.push({
        id: `def-${String(i).padStart(4, "0")}`,
        retry_count: 0,
        retried_at: null,
        created_at: created,
      })
    }
    const { ctx } = makeCtx(many)
    const eligible = await retryEligible(ctx, { now })
    expect(eligible.length).toBe(RETRY_BATCH_SIZE)
  })

  test("retryEligible: successive sweeps advance through the backlog (least-recently-tried first)", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    // 60 rows, all eligible (never tried, created long ago). One sweep drains a
    // batch and stamps retried_at; the NEXT sweep must serve DIFFERENT rows.
    const created = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const rows: SeedRow[] = []
    for (let i = 0; i < RETRY_BATCH_SIZE * 2 + 10; i++) {
      rows.push({ id: `row-${String(i).padStart(4, "0")}`, retry_count: 0, retried_at: null, created_at: created })
    }
    const { ctx } = makeCtx(rows)

    const first = await retryEligible(ctx, { now })
    const firstIds = new Set(first.map((r) => r.id))
    // Simulate the cron stamping retried_at=now on the batch it just handled.
    for (const r of first) {
      await ctx.db.update("deferred_events", r.id, { retried_at: now.toISOString(), retry_count: 1 })
    }
    // Next sweep, same instant: retry_count=1 rows are inside the 5-min backoff,
    // so the never-tried rows sort first and none of the first batch repeats.
    const second = await retryEligible(ctx, { now })
    for (const r of second) expect(firstIds.has(r.id)).toBe(false)
  })

  test("retryEligible excludes bulk dead-lettered rows even when status is non-terminal and retry_count < cap", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const created = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const { ctx } = makeCtx([
      {
        id: "def-dead",
        status: "awaiting_data",
        reason: "dead-lettered 2026-07-08: cutover backfill",
        retry_count: 2,
        retried_at: null,
        created_at: created,
      },
      { id: "def-live", status: "awaiting_data", reason: "customer_email_missing", retry_count: 0, created_at: created },
    ])
    const eligible = await retryEligible(ctx, { now })
    expect(eligible.map((r) => r.id)).toEqual(["def-live"])
  })

  test("deferredRetryJob: a dispatch that aborts the shared tx (25P02) stops the sweep instead of cascading", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const { ctx, db } = makeCtx([
      { id: "def-1", retry_count: 0, retried_at: null },
      { id: "def-2", retry_count: 0, retried_at: null },
      { id: "def-3", retry_count: 0, retried_at: null },
    ])
    let calls = 0
    const dispatch = async () => {
      calls += 1
      if (calls === 2) {
        throw new Error(
          'Failed query: UPDATE "app_invoicing"."deferred_events" — pg: current transaction is aborted, commands ignored until end of transaction block (25P02)',
        )
      }
      return { status: "ok" } as const
    }
    const result = await deferredRetryJob(ctx, dispatch, { now })
    expect(result.aborted).toBe(true)
    // First row resolved; the sweep stopped at the aborted second row and never
    // touched the third — no cascade of 25P02 writes.
    expect(result.succeeded).toBe(1)
    expect(calls).toBe(2)
    expect(db.__all("deferred_events").find((r) => r.id === "def-1")?.status).toBe("resolved")
    expect(db.__all("deferred_events").find((r) => r.id === "def-3")?.status).toBe("awaiting_config")
  })

  test("deferredRetryJob: a single dispatch throwing a non-tx error is isolated, remaining rows still processed", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const { ctx, db } = makeCtx([
      { id: "def-a", retry_count: 0, retried_at: null },
      { id: "def-b", retry_count: 0, retried_at: null },
      { id: "def-c", retry_count: 0, retried_at: null },
    ])
    const dispatch = async (row: DeferredRow) => {
      if (row.id === "def-b") throw new Error("render exploded")
      return { status: "ok" } as const
    }
    const result = await deferredRetryJob(ctx, dispatch, { now })
    expect(result.aborted).toBeUndefined()
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    // def-c was still processed despite def-b throwing.
    expect(db.__all("deferred_events").find((r) => r.id === "def-c")?.status).toBe("resolved")
    expect(db.__all("deferred_events").find((r) => r.id === "def-b")?.reason).toBe("render exploded")
  })

  test("deferredRetryJob: dispatch failure on a near-cap aged row → dead_lettered", async () => {
    const now = new Date("2026-05-15T10:00:00Z")
    const oldCreated = new Date(now.getTime() - DEAD_LETTER_MIN_AGE_MS - 1000)
    const { ctx, db } = makeCtx([
      {
        id: "def-CAP",
        retry_count: DEAD_LETTER_CAP - 1,
        retried_at: null,
        created_at: oldCreated,
      },
    ])
    const dispatch = async () => ({ status: "still_blocked", reason: "x" } as const)
    const result = await deferredRetryJob(ctx, dispatch, { now })
    expect(result.dead_lettered).toBe(1)
    const row = db.__all("deferred_events").find((r) => r.id === "def-CAP")!
    expect(row.status).toBe("permanent_failure")
  })
})

describe("retryEligible reaches open rows behind a large history", () => {
  test("600 resolved rows sorting first by id do not starve an open row", async () => {
    const history: SeedRow[] = Array.from({ length: 600 }, (_, i) => ({
      id: `a-${String(i).padStart(4, "0")}`,
      status: "resolved" as const,
    }))
    const { ctx } = makeCtx([...history, { id: "z-open", status: "awaiting_data" }])
    const rows = await retryEligible(ctx, { now: new Date("2026-06-01T00:00:00Z") })
    expect(rows.map((r) => r.id)).toEqual(["z-open"])
  })
})

describe("identity parks (e-invoicing buyer identity)", () => {
  const now = new Date("2026-10-14T12:00:00Z")
  const identityPark = (over: Partial<SeedRow> = {}): SeedRow => ({
    id: "def-ID",
    status: "awaiting_data",
    reason: "einvoice_data_missing",
    blocked_on: { kind: "einvoice_identity", contact_id: "contact-fr", document_id: "doc-1" },
    ...over,
  })

  test("identity parks never dead-letter: past the cap and the age, they stay eligible and open", async () => {
    const old = new Date(now.getTime() - DEAD_LETTER_MIN_AGE_MS * 4)
    const { ctx, db } = makeCtx([
      identityPark({ retry_count: DEAD_LETTER_CAP + 5, retried_at: old, created_at: old }),
    ])
    const eligible = await retryEligible(ctx, { now })
    expect(eligible.map((r) => r.id)).toEqual(["def-ID"])

    const row = eligible[0]!
    const after = await markPermanentFailure(ctx, row, { now })
    expect(after.status).toBe("awaiting_data")

    const dispatch = async () => ({ status: "still_blocked", reason: "einvoice_data_missing" } as const)
    const result = await deferredRetryJob(ctx, dispatch, { now })
    expect(result.dead_lettered).toBe(0)
    expect(result.failed).toBe(1)
    const stored = db.__all("deferred_events").find((r) => r.id === "def-ID")!
    expect(stored.status).toBe("awaiting_data")
    expect(stored.retry_count).toBe(DEAD_LETTER_CAP + 6)
  })

  test("an identity park is re-driven as soon as its identity changed after the last try; backoff otherwise", async () => {
    // Tried one minute ago at retry 3: the 30-minute backoff has not elapsed.
    const triedAt = new Date(now.getTime() - 60_000)
    const { ctx } = makeCtx([identityPark({ retry_count: 3, retried_at: triedAt })])

    expect(await retryEligible(ctx, { now })).toHaveLength(0)

    const before = new Map([["contact-fr", new Date(triedAt.getTime() - 1000)]])
    expect(await retryEligible(ctx, { now, identityChangedAt: before })).toHaveLength(0)

    const otherContact = new Map([["contact-other", new Date(now.getTime() - 1000)]])
    expect(await retryEligible(ctx, { now, identityChangedAt: otherContact })).toHaveLength(0)

    const changed = new Map([["contact-fr", new Date(triedAt.getTime() + 1000)]])
    const due = await retryEligible(ctx, { now, identityChangedAt: changed })
    expect(due.map((r) => r.id)).toEqual(["def-ID"])
  })

  test("a non-identity park never jumps its backoff on an identity change", async () => {
    const triedAt = new Date(now.getTime() - 60_000)
    const { ctx } = makeCtx([
      {
        id: "def-MAIL",
        status: "awaiting_data",
        retry_count: 3,
        retried_at: triedAt,
        blocked_on: { kind: "customer_email", contact_id: "contact-fr" },
      },
    ])
    const changed = new Map([["contact-fr", new Date(now.getTime() - 1000)]])
    expect(await retryEligible(ctx, { now, identityChangedAt: changed })).toHaveLength(0)
  })
})

describe("identity park lookups stay correct at scale (filtered by contact, not a bounded scan)", () => {
  test("the attention dedupe finds the contact's open park behind 600 other open parks", async () => {
    const { ctx } = makeCtx()
    for (let i = 0; i < 600; i++) {
      await park(ctx, {
        event_id: `order-${i}`,
        event_payload_json: {},
        status: "awaiting_data",
        reason: "customer_kind_missing",
        blocked_on: { kind: "einvoice_identity", contact_id: `contact-${i}`, code: "customer_kind_missing" },
      })
    }
    await park(ctx, {
      event_id: "order-x-1",
      event_payload_json: {},
      status: "awaiting_data",
      reason: "customer_kind_missing",
      blocked_on: { kind: "einvoice_identity", contact_id: "contact-x", code: "customer_kind_missing" },
    })
    const second = await park(ctx, {
      event_id: "order-x-2",
      event_payload_json: {},
      status: "awaiting_data",
      reason: "customer_kind_missing",
      blocked_on: { kind: "einvoice_identity", contact_id: "contact-x", code: "customer_kind_missing" },
    })
    const emitted: unknown[] = []
    const raised = await raiseIdentityAttention(
      { db: ctx.db, emit: async (e) => void emitted.push(e) },
      { park: second, contact_id: "contact-x", code: "customer_kind_missing" },
    )
    expect(raised).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  test("retryEligible asks the identity loader only for the contacts of identity parks not yet due", async () => {
    const now = new Date("2026-10-14T12:00:00Z")
    const triedAt = new Date(now.getTime() - 60_000)
    const { ctx } = makeCtx([
      { id: "a", status: "awaiting_data", retry_count: 3, retried_at: triedAt, blocked_on: { kind: "einvoice_identity", contact_id: "c-wait" } },
      { id: "b", status: "awaiting_data", retry_count: 0, blocked_on: { kind: "einvoice_identity", contact_id: "c-due" } },
      { id: "c", status: "awaiting_data", retry_count: 3, retried_at: triedAt, blocked_on: { kind: "customer_email", contact_id: "c-mail" } },
    ])
    const asked: string[][] = []
    const due = await retryEligible(ctx, {
      now,
      identityChangedAt: async (ids) => {
        asked.push([...ids])
        return new Map([["c-wait", new Date(now.getTime() - 1000)]])
      },
    })
    expect(asked).toEqual([["c-wait"]])
    expect(due.map((r) => r.id).sort()).toEqual(["a", "b"])
  })
})
