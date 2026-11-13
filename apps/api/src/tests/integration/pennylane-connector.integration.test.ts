// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Integration seam: the REAL pennylane bundle's client + connect probe driven
// against the deterministic external-API mock. This exercises the seam (the
// connector ↔ external Pennylane HTTP boundary), NOT the bundle's internal
// projection logic (that is unit-tested in the bundle's own suites).
import { beforeAll, describe, expect, it } from "bun:test"
import { runConnectProbe } from "../../../../../bundled-apps/pennylane/src/connection"
import { PennylaneClient } from "../../../../../bundled-apps/pennylane/src/lib/pennylane-client"
import {
  makePennylaneMockFetch,
  resetPennylaneMockMode,
  setPennylaneMockMode,
} from "../../../test-support/harness/pennylane-mock-fetch"

// The mock is a typeof fetch returning real Responses; the bundle client expects
// the {status,headers,body} shape — adapt at the test seam exactly as the host
// bridge does (mirror bundled-apps/boxtal/src/smoke.test.ts liveFetch adapter).
function bridgeFetch(mock: typeof fetch) {
  return async (
    url: string,
    opts?: {
      method?: string
      headers?: Record<string, string>
      body?: string | { multipart: unknown[] }
      auth?: unknown
    },
  ) => {
    // The host's part: `auth` names the connection's token, added as the bridge adds it.
    const res = await mock(url, {
      method: opts?.method ?? "GET",
      headers: opts?.auth
        ? { ...opts?.headers, Authorization: "Bearer mock-token" }
        : opts?.headers,
      body: typeof opts?.body === "string" ? opts.body : undefined,
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    return { status: res.status, headers, body: await res.text() }
  }
}

describe("pennylane connector ↔ deep mock (integration)", () => {
  const mock = makePennylaneMockFetch()
  const client = new PennylaneClient({ fetch: bridgeFetch(mock) })
  beforeAll(() => resetPennylaneMockMode())

  it("full mode: connect probe → full scope, cash live", async () => {
    setPennylaneMockMode("full")
    expect(await runConnectProbe(client)).toEqual({
      ok: true,
      scope: "full",
      cash_status: "live",
    })
  })
  it("invoice_only mode (bank-403): probe degrades, cash unavailable, NOT blocked", async () => {
    setPennylaneMockMode("invoice_only")
    expect(await runConnectProbe(client)).toEqual({
      ok: true,
      scope: "invoice_only",
      cash_status: "unavailable",
    })
  })
  it("blocked_finance mode (supplier-403): probe throws scoped to finance", async () => {
    setPennylaneMockMode("blocked_finance")
    await expect(runConnectProbe(client)).rejects.toThrow(/supplier_invoices/)
  })
  it("full mode: supplier_invoices_list reads the seeded book + filter narrows", async () => {
    setPennylaneMockMode("full")
    const all = await client.list<{ id: string; status: string }>("/supplier_invoices", {
      limit: 100,
    })
    expect(all.items.length).toBeGreaterThan(0)
    const unpaid = await client.list<{ id: string; status: string }>("/supplier_invoices", {
      filter: [{ field: "status", operator: "eq", value: "unpaid" }],
    })
    expect(unpaid.items.every((i) => i.status === "unpaid")).toBe(true)
    expect(unpaid.items.length).toBeLessThan(all.items.length)
  })
  // MAJOR UNITS, as decimal strings. The v2 API and the connector both speak
  // euros with two decimals; the minor-unit integers this file used to assert
  // are what the mock spoke before it was corrected, and nothing noticed
  // because the file was listed by no suite and had never run.
  it("full mode: trial_balance reconciles to the asserted P&L (601->cogs)", async () => {
    setPennylaneMockMode("full")
    // The endpoint requires the period window; without it the API answers 400.
    await expect(client.list("/trial_balance")).rejects.toMatchObject({ status: 400 })
    const tb = await client.list<{ account_code: string; balance: string }>("/trial_balance", {
      params: { period_start: "2026-01-01", period_end: "2026-12-31" },
    })
    const byCode = Object.fromEntries(tb.items.map((l) => [l.account_code, l.balance]))
    expect(byCode["707000"]).toBe("100000.00")
    expect(byCode["601000"]).toBe("40000.00")
  })
  it("firm-403 mode: /trial_balance 403s and /ledger_entries reconstructs the same book", async () => {
    setPennylaneMockMode("full", { firm403: true })
    // The firm-scoped trial_balance is unreachable on a Company token.
    await expect(client.list("/trial_balance")).rejects.toMatchObject({ status: 403 })
    // The connector falls back to /ledger_entries, which reconstructs the same TB.
    const ledger = await client.list<{ account_code: string; amount: string }>("/ledger_entries")
    const byCode = Object.fromEntries(ledger.items.map((l) => [l.account_code, l.amount]))
    expect(byCode["707000"]).toBe("100000.00")
    expect(byCode["601000"]).toBe("40000.00")
    expect(byCode["627000"]).toBe("5000.00")
    setPennylaneMockMode("full", { firm403: false })
  })
})
