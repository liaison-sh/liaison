// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { createMockDb } from "../test-db"
import { INTERRUPTED_AFTER_MS, parkInterruptedIssues } from "./resume-interrupted"

const NOW = new Date("2026-03-01T12:00:00Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const ISSUER = "00000000-0000-4000-8000-0000000001aa"

function docRow(id: string, over: Record<string, unknown>) {
  return {
    id,
    type: "invoice",
    status: "issued",
    number: `INV-2026-${id.slice(-4)}`,
    number_int: Number.parseInt(id.slice(-4), 10),
    issuer_profile_id: ISSUER,
    pdf_status: "pending",
    counterparty_email: "buyer@example.test",
    lifecycle_log: [{ event: "issued" }],
    created_at: ago(INTERRUPTED_AFTER_MS + 60_000),
    ...over,
  }
}

describe("parkInterruptedIssues", () => {
  test("parks the render of an issue a dead run left unrendered, and the email the order flow owed", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [{ id: ISSUER, auto_email_enabled: true, shopify_shop_id: "shop.example" }],
        documents: [
          docRow("00000000-0000-4000-8000-000000000001", {
            shopify_order_id: "1001",
            lifecycle_log: [{ event: "issued" }, { event: "marked_paid", source: "shopify_order_paid" }],
          }),
          // A manual invoice: its render is owed, never an email nobody asked for.
          docRow("00000000-0000-4000-8000-000000000002", {}),
          // Still inside a run's lifetime: maybe in flight, left alone.
          docRow("00000000-0000-4000-8000-000000000003", { created_at: ago(60_000) }),
          // Rendered: nothing owed.
          docRow("00000000-0000-4000-8000-000000000004", { pdf_status: "ready" }),
        ],
      },
    })
    expect(await parkInterruptedIssues({ db } as never, NOW)).toEqual({ parked: 2 })
    const parks = db.__all("deferred_events").map((p) => [
      (p.blocked_on as Record<string, unknown>).kind,
      (p.blocked_on as Record<string, unknown>).document_id,
    ])
    expect(parks).toEqual([
      ["pdf_render", "00000000-0000-4000-8000-000000000001"],
      ["email_send", "00000000-0000-4000-8000-000000000001"],
      ["pdf_render", "00000000-0000-4000-8000-000000000002"],
    ])
    const status = Object.fromEntries(db.__all("documents").map((d) => [d.id, d.pdf_status]))
    expect(status["00000000-0000-4000-8000-000000000001"]).toBe("failed")
    expect(status["00000000-0000-4000-8000-000000000003"]).toBe("pending")
    // A second sweep finds nothing left to park.
    expect(await parkInterruptedIssues({ db } as never, NOW)).toEqual({ parked: 0 })
  })
})
