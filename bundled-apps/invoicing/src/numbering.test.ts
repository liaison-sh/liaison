// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { allocateNumber, formatNumberString } from "./numbering"

interface MinimalAppCtx {
  sequences: {
    allocate(p: { key: string }): Promise<{ value: number }>
  }
}

// Lightweight in-memory K3 stand-in. Tests assert the helper's contract
// (key shape, prefix expansion, return envelope, per-type prefix selection).
// The full ambient-tx rollback behavior is exercised at the K3 host-module
// level (`apps/api/src/modules/sequences/allocate.test.ts`); this suite tests
// the in-app composition only.
function makeCtx(initial: Record<string, number> = {}) {
  const counters = new Map<string, number>(Object.entries(initial))
  const allocCalls: string[] = []
  return {
    ctx: {
      sequences: {
        async allocate({ key }) {
          allocCalls.push(key)
          const next = (counters.get(key) ?? 0) + 1
          counters.set(key, next)
          return { value: next }
        },
      },
    } satisfies MinimalAppCtx,
    counters,
    allocCalls,
  }
}

describe("formatNumberString", () => {
  test("expands {YYYY} and pads sequence to 4 digits", () => {
    expect(formatNumberString("INV-{YYYY}-", 2026, 1)).toBe("INV-2026-0001")
    expect(formatNumberString("INV-{YYYY}-", 2026, 42)).toBe("INV-2026-0042")
    expect(formatNumberString("INV-{YYYY}-", 2026, 9999)).toBe("INV-2026-9999")
  })

  test("does not truncate sequences beyond 4 digits (10000 → '10000')", () => {
    expect(formatNumberString("INV-{YYYY}-", 2026, 10000)).toBe("INV-2026-10000")
  })

  test("works with a prefix that has no {YYYY} token", () => {
    expect(formatNumberString("INV-", 2026, 7)).toBe("INV-0007")
  })
})

describe("allocateNumber", () => {
  test("returns { value, formatted } for invoice with the issuer's prefix", async () => {
    const { ctx } = makeCtx()
    const issuer = { id: "iss_1", prefix_invoice: "INV-{YYYY}-" }
    const r = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "invoice",
      year_of_issue: 2026,
    })
    expect(r).toEqual({ value: 1, formatted: "INV-2026-0001" })
  })

  test("two sequential allocations on the same key yield 1 and 2", async () => {
    const { ctx } = makeCtx()
    const issuer = { id: "iss_seq", prefix_invoice: "INV-{YYYY}-" }
    const a = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "invoice",
      year_of_issue: 2026,
    })
    const b = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "invoice",
      year_of_issue: 2026,
    })
    expect(a.value).toBe(1)
    expect(b.value).toBe(2)
    expect(b.formatted).toBe("INV-2026-0002")
  })

  test("picks per-type prefix (invoice vs quote vs proforma vs po vs credit_note)", async () => {
    const { ctx, allocCalls } = makeCtx()
    const issuer = {
      id: "iss_pt",
      prefix_invoice: "INV-{YYYY}-",
      prefix_quote: "QUO-{YYYY}-",
      prefix_proforma: "PRO-{YYYY}-",
      prefix_po: "PO-{YYYY}-",
      prefix_credit_note: "CN-{YYYY}-",
    }
    const inv = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "invoice",
      year_of_issue: 2026,
    })
    const quo = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "quote",
      year_of_issue: 2026,
    })
    const pro = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "proforma",
      year_of_issue: 2026,
    })
    const po = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "purchase_order",
      year_of_issue: 2026,
    })
    const cn = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "credit_note",
      year_of_issue: 2026,
    })
    expect(inv.formatted).toBe("INV-2026-0001")
    expect(quo.formatted).toBe("QUO-2026-0001")
    expect(pro.formatted).toBe("PRO-2026-0001")
    expect(po.formatted).toBe("PO-2026-0001")
    expect(cn.formatted).toBe("CN-2026-0001")
    // Each type gets an independent K3 sequence key (per spec §4 "per (issuer, type, year)").
    expect(new Set(allocCalls).size).toBe(5)
  })

  test("credit_note sequence is independent of the invoice sequence (both start at 1, advance separately)", async () => {
    const { ctx } = makeCtx()
    const issuer = { id: "iss_cn", prefix_invoice: "INV-{YYYY}-", prefix_credit_note: "CN-{YYYY}-" }
    const inv1 = await allocateNumber(ctx, { issuer_profile: issuer, type: "invoice", year_of_issue: 2026 })
    const inv2 = await allocateNumber(ctx, { issuer_profile: issuer, type: "invoice", year_of_issue: 2026 })
    const cn1 = await allocateNumber(ctx, { issuer_profile: issuer, type: "credit_note", year_of_issue: 2026 })
    expect(inv1.formatted).toBe("INV-2026-0001")
    expect(inv2.formatted).toBe("INV-2026-0002")
    // The credit note series is NOT advanced by invoice issuance — it starts fresh at 1.
    expect(cn1.formatted).toBe("CN-2026-0001")
  })

  test("builds the K3 key as 'invoicing:doc_number:<issuer.id>:<type>:<year>'", async () => {
    const { ctx, allocCalls } = makeCtx()
    const issuer = { id: "iss_42", prefix_invoice: "INV-{YYYY}-" }
    await allocateNumber(ctx, { issuer_profile: issuer, type: "invoice", year_of_issue: 2026 })
    expect(allocCalls[0]).toBe("invoicing:doc_number:iss_42:invoice:2026")
  })

  test("throws if the issuer is missing the per-type prefix", async () => {
    const { ctx } = makeCtx()
    const issuer = { id: "iss_missing" }
    await expect(
      allocateNumber(ctx, { issuer_profile: issuer, type: "invoice", year_of_issue: 2026 }),
    ).rejects.toThrow(/prefix_invoice/)
  })

  test("two different years on the same (issuer, type) get separate keys (both start at 1)", async () => {
    const { ctx, allocCalls } = makeCtx()
    const issuer = { id: "iss_yr", prefix_invoice: "INV-{YYYY}-" }
    const a = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "invoice",
      year_of_issue: 2025,
    })
    const b = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "invoice",
      year_of_issue: 2026,
    })
    expect(a.value).toBe(1)
    expect(b.value).toBe(1)
    expect(a.formatted).toBe("INV-2025-0001")
    expect(b.formatted).toBe("INV-2026-0001")
    expect(allocCalls).toEqual([
      "invoicing:doc_number:iss_yr:invoice:2025",
      "invoicing:doc_number:iss_yr:invoice:2026",
    ])
  })

  test("steps past numbers already held by documents the sequence never counted", async () => {
    // A seed or an import wrote QUO-2026-0001..0003 and left the sequence at 0:
    // the next quote is 0004, never a second 0001 (which the number's unique
    // index refuses, failing the issue).
    const { ctx, counters } = makeCtx()
    const taken = new Set([1, 2, 3])
    const issuer = { id: "iss_seeded", prefix_quote: "QUO-{YYYY}-" }
    const r = await allocateNumber(ctx, {
      issuer_profile: issuer,
      type: "quote",
      year_of_issue: 2026,
      isTaken: async (v) => taken.has(v),
    })
    expect(r).toEqual({ value: 4, formatted: "QUO-2026-0004" })
    // The sequence now counts the taken numbers, so the next issue is one call.
    expect(counters.get("invoicing:doc_number:iss_seeded:quote:2026")).toBe(4)
  })

  test("a free first number is used as is", async () => {
    const { ctx, allocCalls } = makeCtx({ "invoicing:doc_number:iss_free:invoice:2026": 7 })
    const r = await allocateNumber(ctx, {
      issuer_profile: { id: "iss_free", prefix_invoice: "INV-{YYYY}-" },
      type: "invoice",
      year_of_issue: 2026,
      isTaken: async () => false,
    })
    expect(r.value).toBe(8)
    expect(allocCalls).toHaveLength(1)
  })
})
