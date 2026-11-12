// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The customer card's logic, without a browser (bundled-app UI tests run under
// bun:test, no DOM): the lookup it asks the app for and how a refusal hides the
// card, which events refresh it, and how projected records read. The rendered
// card is proven in a browser by the api-connector Playwright scenario.
import { beforeEach, describe, expect, it, mock } from "bun:test"

const calls: Array<{ tool: string; args: unknown }> = []
let answer: Record<string, unknown> = {}

mock.module("@liaison/host", () => ({
  app: {
    invokeTool: async (tool: string, args: unknown) => {
      calls.push({ tool, args })
      return answer
    },
  },
  navigate: () => {},
}))

const { lookupCustomer } = await import("./api")
const { isConnectorWriteFor } = await import("./CustomerCard")
const { flattenRecord, formatValue, humanizeKey, rowParts, safeHttpUrl } = await import(
  "./customer-format"
)

const fmt = {
  fmtDate: (v: Date | number) => new Date(v).toISOString().slice(0, 10),
  fmtNumber: (v: number) => String(v),
  fmtCurrency: (v: number, c: string) => `${c} ${v.toFixed(2)}`,
}

describe("the card's lookup", () => {
  beforeEach(() => {
    calls.length = 0
    answer = {}
  })

  it("asks the app's customer_lookup for the ticket, and names the participant the server read", async () => {
    answer = {
      matches: [{ connection: "crm", connectionName: "CRM", matchedBy: "email", summary: {} }],
      configured: true,
      connections: [{ identifier: "crm", name: "CRM" }],
      errors: [],
      email: "jane@acme.test",
    }
    const out = await lookupCustomer({ ticketId: "t1" })
    expect(calls).toEqual([{ tool: "customer_lookup", args: { ticketId: "t1" } }])
    expect(out.kind).toBe("result")
    if (out.kind === "result") expect(out.email).toBe("jane@acme.test")
  })

  it("a viewer without the read scope gets no card, not an error card", async () => {
    answer = { error: { message: "This needs the read scope", status: 403, code: "forbidden" } }
    expect(await lookupCustomer({ mailConversationId: "m1" })).toEqual({ kind: "absent" })
  })

  it("any other refusal is an error the card shows", async () => {
    answer = { error: { message: "boom", status: 502, code: "upstream_status" } }
    await expect(lookupCustomer({ email: "x@y.test" })).rejects.toThrow("boom")
  })
})

describe("what refreshes the card", () => {
  const ev = (data: Record<string, unknown>, action = "update") =>
    ({ key: "kernel:approval_request", action, data }) as never

  it("an approved connector write about this person, or about no one in particular", () => {
    const base = { status: "approved", toolName: "api-connector:connector_write" }
    expect(isConnectorWriteFor(ev({ ...base, currentPayload: { params: {} } }), "a@b.test")).toBe(
      true,
    )
    expect(
      isConnectorWriteFor(
        ev({ ...base, currentPayload: { params: { email: "A@b.test" } } }),
        "a@b.test",
      ),
    ).toBe(true)
    expect(
      isConnectorWriteFor(
        ev({ ...base, currentPayload: { params: { email: "z@b.test" } } }),
        "a@b.test",
      ),
    ).toBe(false)
    expect(isConnectorWriteFor(ev({ ...base, status: "pending" }), "a@b.test")).toBe(false)
    expect(isConnectorWriteFor(ev({ ...base, toolName: "tickets:reply" }), "a@b.test")).toBe(false)
  })
})

describe("how a record reads", () => {
  it("names fields from their keys and flattens nested ones", () => {
    expect(humanizeKey("lifetimeValue")).toBe("Lifetime value")
    expect(humanizeKey("account_manager.name")).toBe("Account manager name")
    expect(flattenRecord({ a: 1, b: { c: "x" } })).toEqual([
      ["a", 1],
      ["b.c", "x"],
    ])
  })

  it("formats a date or an amount only when the key and the value agree", () => {
    expect(formatValue("created_at", "2026-01-02", fmt)).toBe("2026-01-02")
    expect(formatValue("created_at", "soon", fmt)).toBe("soon")
    expect(formatValue("total", 12, fmt, { siblings: { currency: "EUR" } })).toBe("EUR 12.00")
    expect(formatValue("total", 12, fmt)).toBe("12")
    expect(formatValue("count", Number.NaN, fmt)).toBe("")
  })

  it("links out to http(s) only", () => {
    expect(safeHttpUrl("https://crm.example/c/1")).toBe("https://crm.example/c/1")
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull()
    expect(safeHttpUrl("not a url")).toBeNull()
  })

  it("a list row shows its own title, date, amount and status", () => {
    const row = rowParts(
      { number: "SO-1", created_at: "2026-03-04", total: 99, currency: "EUR", status: "paid" },
      fmt,
      "orders",
    )
    expect(row).toEqual({ title: "SO-1", date: "2026-03-04", amount: "EUR 99.00", status: "paid" })
  })
})
