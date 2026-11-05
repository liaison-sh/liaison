// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T3 — manual_spend_add (gated) + manual_spend_list (ungated).

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createMockDb } from "../test-db"
import { manual_spend_add, manual_spend_list } from "./manual-spend"
import type { AppCtx } from "../lib/ctx-types"

function makeCtx(db = createMockDb()): AppCtx {
  return { fetch: async () => ({}), connections: {}, db, actorId: "user_1" } as unknown as AppCtx
}

describe("manual_spend_add", () => {
  it("inserts a row with channel/period/amount/currency", async () => {
    const ctx = makeCtx()
    const result = await manual_spend_add(
      {
        channel: "specialized-site-x",
        period_start: "2026-06-01",
        period_end: "2026-06-30",
        amount: 500,
        currency: "EUR",
      },
      ctx,
    ) as Record<string, unknown>
    const row = result.row as Record<string, unknown>
    expect(row.channel).toBe("specialized-site-x")
    expect(row.amount).toBe(500)
    expect(row.currency).toBe("EUR")
    expect(row.period_start).toBe("2026-06-01")
    expect(row.period_end).toBe("2026-06-30")
  })

  it("throws when a required field is missing", async () => {
    const ctx = makeCtx()
    await expect(manual_spend_add({ channel: "x" }, ctx)).rejects.toThrow()
  })

  it("is gated in the manifest with summarizeManualSpendAdd", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8"),
    ) as { tools: Record<string, { gated?: boolean; summarizer?: string }> }
    expect(manifest.tools.manual_spend_add?.gated).toBe(true)
    expect(manifest.tools.manual_spend_add?.summarizer).toBe("summarizeManualSpendAdd")
  })
})

describe("manual_spend_list", () => {
  it("returns previously added rows", async () => {
    const ctx = makeCtx()
    await manual_spend_add(
      { channel: "site-a", period_start: "2026-06-01", period_end: "2026-06-30", amount: 100, currency: "EUR" },
      ctx,
    )
    await manual_spend_add(
      { channel: "site-b", period_start: "2026-06-01", period_end: "2026-06-30", amount: 200, currency: "EUR" },
      ctx,
    )
    const result = await manual_spend_list({}, ctx) as Record<string, unknown>
    expect((result.entries as unknown[]).length).toBe(2)
  })

  it("filters by channel", async () => {
    const ctx = makeCtx()
    await manual_spend_add(
      { channel: "site-a", period_start: "2026-06-01", period_end: "2026-06-30", amount: 100, currency: "EUR" },
      ctx,
    )
    await manual_spend_add(
      { channel: "site-b", period_start: "2026-06-01", period_end: "2026-06-30", amount: 200, currency: "EUR" },
      ctx,
    )
    const result = await manual_spend_list({ channel: "site-a" }, ctx) as Record<string, unknown>
    const entries = result.entries as Array<Record<string, unknown>>
    expect(entries.length).toBe(1)
    expect(entries[0]?.channel).toBe("site-a")
  })

  it("returns empty + unseeded note when the ledger has no rows (Morgan's buy list absent fallback)", async () => {
    const ctx = makeCtx()
    const result = await manual_spend_list({}, ctx) as Record<string, unknown>
    expect((result.entries as unknown[]).length).toBe(0)
    expect(String(result.note)).toContain("unseeded")
  })
})
