// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pennylane e-invoicing webhooks: signature verification (wrong secret, stale timestamp, a
// one-byte body change, missing secret or signature are refused; the replay key is the envelope
// id), the handler records only which invoice may have changed (never the payload's status), and
// the gated setup stores the signing secret through the kernel without ever returning it.
import { describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { createMockDb } from "@liaison/test-helpers/mock-db"
import { makeHmacTestBridge } from "@liaison/test-helpers/webhook-hmac"
import type { PennylaneToolCtx } from "../ctx"
import { PennylaneClient } from "../lib/pennylane-client"
import { PennylaneFake } from "./fake/server"
import { listStatusChanges } from "./inbox"
import {
  BASE_URL_KEY,
  einvoicingWebhookHandler,
  setAppConfig,
  verifyEinvoicingWebhook,
  WEBHOOK_SECRET_KEY,
  webhooksSetup,
} from "./webhooks"

const SECRET = "whsec_test_signing_secret_0123456789"
const NOW = 1_792_050_000_000

/** The host's by-key surface: the verifier names the secret's key, never holds it. */
function bridge(secret: string | null = SECRET) {
  return makeHmacTestBridge({ secretKey: WEBHOOK_SECRET_KEY, secret })
}

function signed(body: string, t = Math.floor(NOW / 1000), secret = SECRET) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex")
  return {
    headers: { "X-Pennylane-Signature": `t=${t},v1=${v1}` },
    body,
    method: "POST",
    query: {},
  }
}

const BODY = JSON.stringify({
  id: "evt_123",
  type: "customer_invoice.e_invoicing_status_updated",
  data: { object: { id: 4242, e_invoicing: { status: "collected" } }, previous_attributes: {} },
})

describe("verify", () => {
  const at = () => NOW
  it("accepts a correct signature, replay key = the envelope id", async () => {
    expect(await verifyEinvoicingWebhook(signed(BODY), bridge(), at)).toEqual({
      ok: true,
      replayKey: "envelope:evt_123",
      replayTtlSeconds: 900,
    })
  })
  it("refuses a signature made with another secret", async () => {
    expect(
      await verifyEinvoicingWebhook(signed(BODY, undefined, "another-secret"), bridge(), at),
    ).toMatchObject({ ok: false, reason: "signature_mismatch" })
  })
  it("refuses a timestamp more than 300 s away (either side)", async () => {
    const t = Math.floor(NOW / 1000)
    expect(await verifyEinvoicingWebhook(signed(BODY, t - 301), bridge(), at)).toMatchObject({
      ok: false,
      reason: "stale_timestamp",
    })
    expect(await verifyEinvoicingWebhook(signed(BODY, t + 301), bridge(), at)).toMatchObject({
      ok: false,
      reason: "stale_timestamp",
    })
    expect((await verifyEinvoicingWebhook(signed(BODY, t - 299), bridge(), at)).ok).toBe(true)
  })
  it("refuses a one-byte change of the body", async () => {
    const req = signed(BODY)
    expect(
      await verifyEinvoicingWebhook({ ...req, body: BODY.replace("4242", "4243") }, bridge(), at),
    ).toMatchObject({ ok: false, reason: "signature_mismatch" })
  })
  it("refuses when no secret is held, or without a signature header", async () => {
    expect(await verifyEinvoicingWebhook(signed(BODY), bridge(null), at)).toMatchObject({
      ok: false,
      reason: "missing_secret",
    })
    expect(
      await verifyEinvoicingWebhook({ ...signed(BODY), headers: {} }, bridge(), at),
    ).toMatchObject({ ok: false, reason: "missing_signature" })
  })
})

describe("handler", () => {
  it("records which invoice may have changed, never its payload status; a redelivered envelope is recorded once", async () => {
    const ctx = {
      db: createMockDb({}, { bridgeWhereOperators: true, ids: "uuid", stampCreatedAt: true }),
    } as unknown as PennylaneToolCtx
    const payload = JSON.parse(BODY)
    expect(await einvoicingWebhookHandler(payload, ctx)).toEqual({ status: 200 })
    expect(await einvoicingWebhookHandler(payload, ctx)).toEqual({ status: 200 })
    const rows = (await ctx.db.findMany("einvoicing_inbox")) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider_ref: "4242",
      kind: "customer_invoice",
      envelope_id: "evt_123",
    })
    expect(JSON.stringify(rows[0])).not.toContain("collected")
    // `data.data` fallback, supplier side, and an unrelated event.
    await einvoicingWebhookHandler(
      { id: "evt_2", type: "supplier_invoice.e_invoicing_received", data: { data: { id: 77 } } },
      ctx,
    )
    await einvoicingWebhookHandler(
      { id: "evt_3", type: "dms_file.created", data: { object: { id: 5 } } },
      ctx,
    )
    const listed = await listStatusChanges(ctx, { cursor: null })
    expect(listed.items.map((i) => `${i.kind}:${i.provider_ref}`)).toEqual([
      "customer_invoice:4242",
      "supplier_invoice:77",
    ])
    // Acknowledged per item: the customer one handled, the supplier one (another consumer's) kept.
    const customer = listed.items.find((i) => i.kind === "customer_invoice")!
    await listStatusChanges(ctx, { cursor: customer.ack })
    const left = await listStatusChanges(ctx, { cursor: null })
    expect(left.items.map((i) => `${i.kind}:${i.provider_ref}`)).toEqual(["supplier_invoice:77"])
    // A consumer listing one kind never sees (nor holds up) another's.
    expect(
      (await listStatusChanges(ctx, { cursor: null, kind: "customer_invoice" })).items,
    ).toEqual([])
  })
})

describe("webhooks_setup", () => {
  function setup() {
    const fake = new PennylaneFake()
    const stored: Record<string, string> = {}
    const ctx = {
      orgId: "00000000-0000-4000-8000-0000000000aa",
      db: createMockDb({}, { bridgeWhereOperators: true, ids: "uuid", stampCreatedAt: true }),
      __client: new PennylaneClient({ fetch: fake.sandboxFetch }),
      config: {
        get: async (k: string) => stored[k] ?? null,
        setSecret: async (k: string, v: string) => {
          stored[k] = v
        },
      },
    } as unknown as Parameters<typeof webhooksSetup>[1]
    return { fake, stored, ctx }
  }

  it("subscribes both events to this instance, stores the secret through the kernel, never returns it", async () => {
    const { fake, stored, ctx } = setup()
    await setAppConfig(ctx, BASE_URL_KEY, "https://liaison.example.test")
    const r = await webhooksSetup({}, ctx)
    expect(r).toMatchObject({
      status: "completed",
      callback_url:
        "https://liaison.example.test/webhooks/00000000-0000-4000-8000-0000000000aa/pennylane/einvoicing",
      events: [
        "customer_invoice.e_invoicing_status_updated",
        "supplier_invoice.e_invoicing_received",
      ],
      replaced: false,
    })
    const secret = [...fake.subscriptions.values()][0]!.secret as string
    expect(stored[WEBHOOK_SECRET_KEY]).toBe(secret)
    expect(JSON.stringify(r)).not.toContain(secret)
    const again = await webhooksSetup({}, ctx)
    expect(again).toMatchObject({ status: "completed", replaced: true })
    expect(fake.subscriptions.size).toBe(1)
  })

  it("refuses without a known public HTTPS address", async () => {
    const { ctx } = setup()
    expect(await webhooksSetup({}, ctx)).toMatchObject({
      status: "error",
      error: { code: "callback_base_url_missing" },
    })
    expect(
      await webhooksSetup({ callback_base_url: "http://insecure.example" }, ctx),
    ).toMatchObject({ status: "error" })
  })
})
