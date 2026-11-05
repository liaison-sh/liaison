// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { filterByBuyerConsent, filterByNewsletterConsent } from "./consent-join"

interface Envelope {
  status: "completed" | "pending_approval" | "error"
  result?: unknown
  error?: { code: string; message: string }
}

/**
 * Keys responses by BOTH the db_read `name` param and the email — a
 * handler that swapped readName (e.g. passed
 * "subscribers_marketing_consent" where "purchase_attribution_by_email"
 * was intended) gets no match here and falls through to `fallback`
 * (default: unreachable), which fails the suite rather than silently
 * passing on the wrong consent domain's data (MAJOR 11).
 */
function makeExecuteTool(
  byNameAndEmail: Record<string, Record<string, Envelope>>,
  fallback: Envelope = { status: "error", error: { code: "not_mocked", message: "no mock for this name+email" } },
) {
  return async (target: string, args: Record<string, unknown>): Promise<Envelope> => {
    if (target !== "database:db_read") return fallback
    const name = String(args.name ?? "")
    const email = String((args.params as Record<string, unknown> | undefined)?.email ?? args.email ?? "")
    return byNameAndEmail[name]?.[email] ?? fallback
  }
}

const CUSTOMERS = [{ email: "granted@example.com" }, { email: "denied@example.com" }, { email: "nosource@example.com" }]

describe("filterByBuyerConsent", () => {
  it("dispatches the db_read call with name=purchase_attribution_by_email (not the newsletter read)", async () => {
    const seen: string[] = []
    const executeTool = async (target: string, args: Record<string, unknown>): Promise<Envelope> => {
      if (target === "database:db_read") seen.push(String(args.name ?? ""))
      return { status: "completed", result: [{ ad_consent: "granted" }] }
    }
    await filterByBuyerConsent([{ email: "a@example.com" }], { executeTool })
    expect(seen.every((n) => n === "purchase_attribution_by_email")).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
  })

  it("keeps only emails with a granted ad_consent record, drops the rest (default-deny)", async () => {
    const executeTool = makeExecuteTool({
      purchase_attribution_by_email: {
        "granted@example.com": { status: "completed", result: [{ ad_consent: "granted" }] },
        "denied@example.com": { status: "completed", result: [{ ad_consent: "denied" }] },
        "nosource@example.com": { status: "completed", result: [] },
      },
    })
    const result = await filterByBuyerConsent(CUSTOMERS, { executeTool })
    expect(result.allowed.map((c) => c.email)).toEqual(["granted@example.com"])
    expect(result.droppedNoConsent).toBe(1)
    expect(result.droppedNoConsentSource).toBe(1)
  })

  it("fails the suite if the handler swapped readName (e.g. dispatched the newsletter read for a buyer join)", async () => {
    // Only the newsletter name is mocked with a granted result -- if
    // filterByBuyerConsent ever dispatched "subscribers_marketing_consent"
    // instead of "purchase_attribution_by_email", it would hit this mock and
    // wrongly report granted. It must NOT, so the customer should be dropped
    // as no_source/unreachable, never allowed.
    const executeTool = makeExecuteTool({
      subscribers_marketing_consent: {
        "swap-check@example.com": { status: "completed", result: [{ marketing_consent: true }] },
      },
    })
    const result = await filterByBuyerConsent([{ email: "swap-check@example.com" }], { executeTool })
    expect(result.allowed.length).toBe(0)
  })

  it("fails CLOSED (drops all + reports) when the consent source is unreachable", async () => {
    const executeTool = async (): Promise<Envelope> => ({
      status: "error",
      error: { code: "connect_error", message: "database app not connected" },
    })
    const result = await filterByBuyerConsent(CUSTOMERS, { executeTool })
    expect(result.allowed.length).toBe(0)
    expect(result.droppedNoConsentSource).toBe(CUSTOMERS.length)
    expect(result.sourceUnreachable).toBe(true)
  })

  it("skips customers with no email entirely (nothing to join)", async () => {
    const executeTool = makeExecuteTool({})
    const result = await filterByBuyerConsent([{ email: undefined }, { email: "" }], { executeTool })
    expect(result.allowed.length).toBe(0)
  })

  it("falls back to database:db_query (parameterized SELECT) when the curated db_read errors", async () => {
    const seenQueries: Array<{ sql: string; params: unknown[] }> = []
    const executeTool = async (target: string, args: Record<string, unknown>): Promise<Envelope> => {
      if (target === "database:db_read") {
        return { status: "error", error: { code: "not_found", message: "no such read" } }
      }
      if (target === "database:db_query") {
        seenQueries.push({ sql: String(args.sql ?? ""), params: (args.params as unknown[]) ?? [] })
        return { status: "completed", result: [{ ad_consent: "granted" }] }
      }
      return { status: "error", error: { code: "not_mocked", message: "unexpected target" } }
    }
    const result = await filterByBuyerConsent([{ email: "fallback@example.com" }], { executeTool })
    expect(result.allowed.map((c) => c.email)).toEqual(["fallback@example.com"])
    expect(seenQueries.length).toBe(1)
    expect(seenQueries[0]?.sql).toMatch(/purchase_attribution/i)
    expect(seenQueries[0]?.params).toContain("fallback@example.com")
  })

  it("fails closed when BOTH the curated db_read and the db_query fallback error", async () => {
    const executeTool = async (): Promise<Envelope> => ({
      status: "error",
      error: { code: "connect_error", message: "database app not connected" },
    })
    const result = await filterByBuyerConsent([{ email: "both-down@example.com" }], { executeTool })
    expect(result.allowed.length).toBe(0)
    expect(result.sourceUnreachable).toBe(true)
  })
})

describe("filterByNewsletterConsent", () => {
  it("dispatches the db_read call with name=subscribers_marketing_consent (not the buyer read)", async () => {
    const seen: string[] = []
    const executeTool = async (target: string, args: Record<string, unknown>): Promise<Envelope> => {
      if (target === "database:db_read") seen.push(String(args.name ?? ""))
      return { status: "completed", result: [{ marketing_consent: true }] }
    }
    await filterByNewsletterConsent([{ email: "a@example.com" }], { executeTool })
    expect(seen.every((n) => n === "subscribers_marketing_consent")).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
  })

  it("keeps only emails with marketing_consent=true; buyer consent does NOT transfer", async () => {
    const executeTool = makeExecuteTool({
      subscribers_marketing_consent: {
        "granted@example.com": { status: "completed", result: [{ marketing_consent: true }] },
        "denied@example.com": { status: "completed", result: [{ marketing_consent: false }] },
        "nosource@example.com": { status: "completed", result: [] },
      },
    })
    const result = await filterByNewsletterConsent(CUSTOMERS, { executeTool })
    expect(result.allowed.map((c) => c.email)).toEqual(["granted@example.com"])
    expect(result.droppedNoConsent).toBe(1)
    expect(result.droppedNoConsentSource).toBe(1)
  })

  it("fails the suite if the handler swapped readName (e.g. dispatched the buyer read for a newsletter join)", async () => {
    const executeTool = makeExecuteTool({
      purchase_attribution_by_email: {
        "swap-check@example.com": { status: "completed", result: [{ ad_consent: "granted" }] },
      },
    })
    const result = await filterByNewsletterConsent([{ email: "swap-check@example.com" }], { executeTool })
    expect(result.allowed.length).toBe(0)
  })

  it("fails CLOSED when the consent source is unreachable", async () => {
    const executeTool = async (): Promise<Envelope> => ({
      status: "error",
      error: { code: "connect_error", message: "database app not connected" },
    })
    const result = await filterByNewsletterConsent(CUSTOMERS, { executeTool })
    expect(result.allowed.length).toBe(0)
    expect(result.sourceUnreachable).toBe(true)
  })
})

describe("consent domains do not cross", () => {
  it("a buyer-consented email with no newsletter consent record is dropped from a newsletter upload", async () => {
    const executeTool = makeExecuteTool({
      purchase_attribution_by_email: {
        "buyer-only@example.com": { status: "completed", result: [{ ad_consent: "granted" }] },
      },
      subscribers_marketing_consent: {
        "buyer-only@example.com": { status: "completed", result: [] },
      },
    })
    const result = await filterByNewsletterConsent([{ email: "buyer-only@example.com" }], { executeTool })
    expect(result.allowed.length).toBe(0)
  })
})
