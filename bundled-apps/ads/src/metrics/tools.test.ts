// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { metrics_list, metrics_run } from "./tools"
import { createMockDb } from "../test-db"

interface Envelope {
  status: "completed" | "pending_approval" | "error"
  result?: unknown
  error?: { code: string; message: string }
}

function makeExecuteTool(responses: Record<string, Envelope>) {
  return async (target: string, _args: Record<string, unknown>): Promise<Envelope> => {
    return responses[target] ?? { status: "error", error: { code: "not_mocked", message: `no mock for ${target}` } }
  }
}

describe("metrics_list", () => {
  it("returns the registry with id/version/title/inputs/caveats/provisional", async () => {
    const db = createMockDb()
    const result = (await metrics_list({}, { db, executeTool: async () => ({ status: "completed", result: [] }) })) as {
      formulas: Array<{ id: string; version: string; provisional: boolean }>
      count: number
    }
    expect(result.count).toBe(5)
    expect(result.formulas.find((f) => f.id === "blended_mer_dtc")).toBeTruthy()
    expect(result.formulas.every((f) => typeof f.provisional === "boolean")).toBe(true)
  })

  // Declared readOnly in the manifest: a write here would make every scheduled
  // review park the call for approval again.
  it("writes nothing", async () => {
    const db = createMockDb()
    const ctx = { db, executeTool: async () => ({ status: "completed" as const, result: [] }) }
    await metrics_list({}, ctx)
    expect(db.__all("metric_formulas").length).toBe(0)
  })
})

describe("metrics_run", () => {
  it("returns value/formulaId/formulaVersion/lineage/caveats for blended_mer_dtc", async () => {
    const db = createMockDb()
    const executeTool = makeExecuteTool({
      // Real tool envelopes (orders_search results carry refund-adjusted
      // current totals; insight tools wrap rows in data/rows).
      "shopify:orders_search": {
        status: "completed",
        result: { results: [{ currency: "EUR", attributes: { totalAmount: "10000" } }], nextCursor: null, totalCount: 1 },
      },
      "ads:insights_query": { status: "completed", result: { data: [{ spend: 1500 }] } },
      "ads:google_insights_query": { status: "completed", result: { rows: [{ cost: 1000 }], count: 1 } },
      "database:db_read": { status: "completed", result: { rows: [], truncated: false } },
    })
    const result = (await metrics_run(
      { formula_id: "blended_mer_dtc", period_start: "2026-07-01", period_end: "2026-07-31" },
      { db, executeTool },
    )) as { value: string; formulaId: string; formulaVersion: string; lineage: unknown; caveats: string[] }

    expect(result.formulaId).toBe("blended_mer_dtc")
    expect(result.formulaVersion).toBe("1.1.0")
    expect(result.value).toBe("4.0000") // 10000 / 2500
    expect(Array.isArray(result.caveats)).toBe(true)
    expect(result.lineage).toBeTruthy()
    // The figure is also one row, for a dashboard block.
    expect((result as unknown as { rows: unknown[] }).rows).toEqual([
      {
        key: "blended_mer_dtc",
        value: "4.0000",
        period_start: "2026-07-01",
        period_end: "2026-07-31",
        degraded: false,
      },
    ])
  })

  it("byte-identical repeat call against the SAME mocked backend (SC 5)", async () => {
    const db = createMockDb()
    const executeTool = makeExecuteTool({
      "shopify:orders_search": {
        status: "completed",
        result: { results: [{ currency: "EUR", attributes: { totalAmount: "5000" } }], nextCursor: null, totalCount: 1 },
      },
      "ads:insights_query": { status: "completed", result: { data: [{ spend: 500 }] } },
      "ads:google_insights_query": { status: "completed", result: { rows: [{ cost: 500 }], count: 1 } },
      "database:db_read": { status: "completed", result: { rows: [], truncated: false } },
    })
    const params = { formula_id: "blended_mer_dtc", period_start: "2026-07-01", period_end: "2026-07-31" }
    const r1 = await metrics_run(params, { db, executeTool })
    const r2 = await metrics_run(params, { db, executeTool })
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })

  it("rejects an unknown formula_id", async () => {
    const db = createMockDb()
    await expect(
      metrics_run(
        { formula_id: "made_up", period_start: "2026-07-01", period_end: "2026-07-31" },
        { db, executeTool: async () => ({ status: "completed", result: [] }) },
      ),
    ).rejects.toThrow(/unknown formula_id/)
  })

  it("degrades gracefully (no crash) when the database cross-app is unavailable — attribution-only formulas flag degraded", async () => {
    const db = createMockDb()
    const executeTool = async (target: string): Promise<Envelope> => {
      if (target === "database:db_read" || target === "database:db_query") {
        return { status: "error", error: { code: "connect_error", message: "database app not connected" } }
      }
      return { status: "completed", result: [] }
    }
    const result = (await metrics_run(
      { formula_id: "revenue_by_channel", period_start: "2026-07-01", period_end: "2026-07-31" },
      { db, executeTool },
    )) as { degraded?: boolean }
    expect(result.degraded).toBe(true)
  })
})
