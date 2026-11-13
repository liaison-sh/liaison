// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Webhook upstream probe. The kernel trusts this report to decide whether webhook silence is a
// dead subscription or a quiet inbox, so each branch pins the side it errs on: a reachable
// Pennylane reports its newest received e-invoice, read live; no live sender reports null (never
// pages); an unreachable Pennylane reports NOTHING (the kernel lists the probe as stale rather than
// reading it as quiet).
import { describe, expect, it } from "bun:test"
import { createMockDb } from "@liaison/test-helpers/mock-db"
import type { PennylaneToolCtx } from "../ctx"
import { probeWebhookUpstreamJob } from "../handlers"
import { PennylaneFake } from "./fake/server"
import { SUBSCRIPTION_KEY, setAppConfig, WEBHOOK_EVENTS } from "./webhooks"

const SIREN = "902000009"

async function setup(
  o: {
    subscribed?: boolean
    events?: readonly string[]
    connected?: boolean
    registrations?: PennylaneFake["registrations"]
  } = {},
) {
  const fake = new PennylaneFake()
  fake.registrations = o.registrations ?? [
    { siren: SIREN, status: "activated", exchange_direction: "emission_and_reception" },
  ]
  const ctx = {
    orgId: "org",
    db: createMockDb({}, { bridgeWhereOperators: true, ids: "uuid", stampCreatedAt: true }),
    fetch: fake.sandboxFetch,
    connections:
      o.connected === false
        ? {}
        : {
            pennylane: {
              getSettings: async () => ({ values: { scope: "company" }, missing: [] }),
            },
          },
  } as unknown as PennylaneToolCtx
  if (o.subscribed !== false) {
    await setAppConfig(ctx, SUBSCRIPTION_KEY, {
      id: 1,
      callback_url: "https://x/webhooks/org/pennylane/einvoicing",
      events: o.events ?? WEBHOOK_EVENTS,
    })
  }
  return { fake, ctx }
}

function receivedAt(fake: PennylaneFake, iso: string, routing = SIREN): number {
  const id = fake.receive({ routing })
  fake.supplierInvoices.get(id)!.created_at = iso
  return id
}

describe("probeWebhookUpstreamJob", () => {
  it("reports when the newest received e-invoice arrived, asking Pennylane live, newest first", async () => {
    const { fake, ctx } = await setup()
    receivedAt(fake, "2026-10-16T09:00:00.000Z")
    receivedAt(fake, "2026-10-18T17:49:00.000Z")
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({
      upstreamActivityAt: "2026-10-18T17:49:00.000Z",
    })
    const list = fake.calls.filter(
      (c) => c.method === "GET" && c.path.startsWith("/supplier_invoices?"),
    )
    expect(list).toHaveLength(1)
    const q = new URLSearchParams(list[0]!.path.split("?")[1])
    expect(q.get("sort")).toBe("-id")
    expect(q.get("limit")).toBe("1")
    expect(JSON.parse(q.get("filter")!)).toEqual([
      { field: "electronic_billing_address", operator: "eq", value: SIREN },
    ])
  })

  it("takes the newest arrival across every reception address", async () => {
    const other = "903000001"
    const { fake, ctx } = await setup({
      registrations: [
        { siren: SIREN, status: "activated", exchange_direction: "emission_and_reception" },
        { siren: other, status: "activated", exchange_direction: "reception" },
      ],
    })
    receivedAt(fake, "2026-10-19T08:00:00.000Z", other)
    receivedAt(fake, "2026-10-17T08:00:00.000Z", SIREN)
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({
      upstreamActivityAt: "2026-10-19T08:00:00.000Z",
    })
  })

  it("nothing received yet has no sender: reports null", async () => {
    const { ctx } = await setup()
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: null })
  })

  it("no reception address registered has no sender: reports null", async () => {
    const { fake, ctx } = await setup({
      registrations: [{ siren: SIREN, status: "activated", exchange_direction: "emission" }],
    })
    receivedAt(fake, "2026-10-18T17:49:00.000Z")
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: null })
  })

  it("no webhook subscription, or one without the reception event, reports null without calling Pennylane", async () => {
    for (const o of [
      { subscribed: false },
      { events: ["customer_invoice.e_invoicing_status_updated"] },
    ]) {
      const { fake, ctx } = await setup(o)
      receivedAt(fake, "2026-10-18T17:49:00.000Z")
      expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: null })
      expect(fake.calls).toEqual([])
    }
  })

  it("Pennylane not connected has no sender: reports null", async () => {
    const { fake, ctx } = await setup({ connected: false })
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: null })
    expect(fake.calls).toEqual([])
  })

  it("a connection that exists but cannot be used is no report, never a quiet one", async () => {
    const { fake, ctx } = await setup()
    ;(ctx as unknown as { connections: unknown }).connections = {
      pennylane: { getSettings: async () => ({ values: { scope: "firm" }, missing: [] }) },
    }
    const result = await probeWebhookUpstreamJob({}, ctx)
    expect(result).toMatchObject({ probed: false })
    expect(fake.calls).toEqual([])
  })

  it("an unreachable Pennylane is no report, never a quiet one", async () => {
    const { fake, ctx } = await setup()
    receivedAt(fake, "2026-10-18T17:49:00.000Z")
    fake.fail((c) => c.path.startsWith("/supplier_invoices"), "replace", {
      status: 503,
      body: { status: 503, error: "unavailable" },
    })
    const result = await probeWebhookUpstreamJob({}, ctx)
    expect("upstreamActivityAt" in result).toBe(false)
    expect(result).toMatchObject({ probed: false })
  })
})
