// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The recording half of the contract harness: a recorded run replays on the
// same isolate, the scrubber leaves no secret or personal value in a fixture
// (the repository is public) and keeps it replayable, and a webhook verifier
// replays on the bridge it gets in production.
import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLimits } from "~/modules/apps/run-limits"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { verifySurface } from "./apps.test-helpers"
import type { ContractEntry } from "./entries"
import { surfaceFor } from "./harness"
import { quickJsContractExecutor } from "./quickjs-isolate"
import {
  recordEntry,
  scrubFixture,
  scrubStoreIdentity,
  scrubValue,
  verifyFixture,
  writeFixture,
} from "./recorder"
import type { EgressFixture } from "./replay-bridge"

const SCRIPT = `async function lookup(params, ctx) {
  var r = await ctx.fetch("https://" + params.host + "/items/" + params.id, { method: "GET" })
  return { name: r.body.name, at: Date.now() }
}
globalThis.lookup = lookup;`

const ENTRY: ContractEntry = { entry: "tool:lookup", kind: "tool", exportName: "lookup" }
const SURFACE = [
  ["fetch", "async"],
  ["log_info", "sync"],
] as const
const limits = () => ({ ...runLimits("tool"), wallMs: 5_000 })

const tmp = mkdtempSync(join(tmpdir(), "contract-recorder-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe("recordEntry + verifyFixture", () => {
  it("records a run on a live bridge, and the scrubbed fixture replays identically", async () => {
    const isolate = await quickJsContractExecutor.open(
      { script: SCRIPT },
      { memoryBytes: 64 * 1024 * 1024 },
    )
    try {
      let liveCalls = 0
      const real: AppBridge = {
        fetch: async (url: unknown) => {
          liveCalls++
          await new Promise((r) => setTimeout(r, 20)) // a real call takes real time
          return JSON.stringify({
            status: 200,
            headers: { "content-type": "application/json", "x-request-id": "abc", "cf-ray": "1" },
            body: { name: `item ${String(url).split("/").pop()}`, owner: "Jane.Doe@corp.test" },
          })
        },
        log_info: () => undefined,
      }
      const { fixture, outcome } = await recordEntry({
        isolate,
        entry: ENTRY,
        input: { params: { host: "shop.test", id: "42" } },
        real,
        surface: SURFACE,
        limits: limits(),
        recordedFrom: "a test bridge",
      })
      expect(outcome.ok).toBe(true)
      expect(liveCalls).toBe(1)
      expect(fixture.calls.map((c) => c.method)).toEqual(["fetch"])

      const scrubbed = scrubFixture(fixture, [{ from: "shop.test", to: "shop.example" }])
      const text = JSON.stringify(scrubbed)
      expect(text).not.toContain("shop.test")
      expect(text).not.toContain("Jane.Doe")
      expect(text).not.toContain("x-request-id")
      expect(text).toContain("content-type")

      expect(
        await verifyFixture({
          isolate,
          entry: ENTRY,
          fixture: scrubbed,
          surface: SURFACE,
          limits: limits(),
        }),
      ).toBeNull()

      // A fixture missing the call the run makes is refused.
      expect(
        await verifyFixture({
          isolate,
          entry: ENTRY,
          fixture: { ...scrubbed, calls: [] },
          surface: SURFACE,
          limits: limits(),
        }),
      ).toContain("unrecorded calls: fetch")

      const path = writeFixture(tmp, "demo", scrubbed)
      expect(path).toBe(join(tmp, "demo", "tool__lookup.json"))
      expect(JSON.parse(readFileSync(path, "utf8")).entry).toBe("tool:lookup")
    } finally {
      isolate.dispose()
    }
  })
})

describe("scrubValue", () => {
  it("replaces literals, emails (one stand-in per address), IPs, phones, tokens and URL credentials", () => {
    const out = scrubValue(
      {
        shop: "real-store.myshopify.com",
        email: "Ann@Corp.test",
        cc: ["ann@corp.test", "bob@corp.test", "keep@example.com"],
        browser_ip: "203.0.113.77",
        local: "127.0.0.1",
        phone: "+33 6 12 34 56 78",
        id: 1234567890123,
        total: "1234.56",
        checkout_token: "c0ffee",
        api_key: "",
        status_url: "https://x.test/orders/1?key=abc123&lang=en",
        body: JSON.stringify({ phone: "(555) 010-2000", note: "hi" }),
      },
      [{ from: "real-store", to: "contract-shop" }],
    ) as Record<string, unknown>
    expect(out.shop).toBe("contract-shop.myshopify.com")
    expect(out.email).toBe("person1@example.com")
    expect(out.cc).toEqual(["person1@example.com", "person2@example.com", "keep@example.com"])
    expect(out.browser_ip).toBe("192.0.2.1")
    expect(out.local).toBe("127.0.0.1")
    expect(out.phone).toBe("+15550100000")
    expect(out.id).toBe(1234567890123)
    expect(out.total).toBe("1234.56")
    expect(out.checkout_token).toBe("redacted")
    expect(out.api_key).toBe("")
    expect(out.status_url).toBe("https://x.test/orders/1?key=redacted&lang=en")
    expect(JSON.parse(out.body as string)).toEqual({ phone: "+15550100000", note: "hi" })
  })

  it("replaces a credential-named value everywhere it appears, so a call passing it back still matches", () => {
    const out = scrubValue(
      {
        calls: [
          { method: "begin", reply: JSON.stringify({ state: "run", token: "lease-123" }) },
          { method: "save", args: ["step", "lease-123", { done: true }] },
          { method: "other", reply: { checkout_token: "c0ffee" } },
        ],
      },
      [],
    )
    const text = JSON.stringify(out)
    expect(text).not.toContain("lease-123")
    expect(text).not.toContain("c0ffee")
    const calls = (out as { calls: Array<{ reply?: unknown; args?: unknown[] }> }).calls
    const lease = (JSON.parse(calls[0]?.reply as string) as { token: string }).token
    expect(calls[1]?.args?.[1]).toBe(lease)
    expect((calls[2]?.reply as { checkout_token?: string } | undefined)?.checkout_token).not.toBe(
      lease,
    )
  })

  it("keeps a fetch answer's error and non-fetch calls untouched by header trimming", () => {
    const fixture: EgressFixture = {
      entry: "tool:x",
      calls: [
        { method: "kv_get", args: ["k"], reply: { headers: { "x-keep": "1" } } },
        { method: "fetch", args: ["u"], error: { message: "boom", status: 500 } },
      ],
    }
    expect(scrubFixture(fixture, [])).toEqual(fixture)
  })
})

// A live store's identity: what a recording reads from a real store and must
// never write into a public fixture.
const LIVE = {
  title: "Nimbus Keyboard Mk II",
  variantTitle: "Graphite",
  sku: "NMB-MK2-GR",
  vendor: "Nimbus Instruments Ltd",
  handle: "nimbus-keyboard-mk-ii",
  firstName: "Oriane",
  lastName: "Valcourt",
  company: "Valcourt Studios SARL",
  address1: "17 Quai des Brumes",
  location: "Valcourt Warehouse",
}
const LIVE_VALUES = Object.values(LIVE)

/** A product, its variant, an order line and a customer, the shapes a store answers with. */
function storeAnswer() {
  return {
    product: {
      id: "gid://shopify/Product/1",
      title: LIVE.title,
      handle: LIVE.handle,
      vendor: LIVE.vendor,
      variants: [
        {
          id: "gid://shopify/ProductVariant/2",
          title: LIVE.variantTitle,
          displayName: `${LIVE.title} - ${LIVE.variantTitle}`,
          sku: LIVE.sku,
          price: "499.00",
        },
        { id: "gid://shopify/ProductVariant/3", title: "Default Title", sku: null },
      ],
    },
    customer: {
      first_name: LIVE.firstName,
      last_name: LIVE.lastName,
      email: "oriane@valcourt.test",
      displayName: `${LIVE.firstName} ${LIVE.lastName}`,
      companyContactProfiles: [{ company: { name: LIVE.company } }],
      defaultAddress: { address1: LIVE.address1, city: "Lyon", zip: "69002", countryCode: "FR" },
    },
    location: { name: LIVE.location, address1: LIVE.address1, city: "Lyon" },
    shipping_lines: [{ title: "Standard", price: "9.00" }],
    tax_lines: [{ title: "FR TVA", rate: 0.2 }],
  }
}

const RESTOCK = `async function restock(params, ctx) {
  var p = await ctx.fetch("https://" + params.host + "/products/" + params.id, { method: "GET" })
  var v = p.body.product.variants[0]
  var q = await ctx.fetch("https://" + params.host + "/search?sku=" + encodeURIComponent(v.sku) +
    "&q=" + encodeURIComponent(p.body.product.title), { method: "GET" })
  var line = { title: p.body.product.title, sku: v.sku, quantity: 2 }
  await ctx.fetch("https://" + params.host + "/orders", { method: "POST", body: JSON.stringify({ line_items: [line] }) })
  return { line: line, buyer: q.body.customer.first_name + " " + q.body.customer.last_name }
}
globalThis.restock = restock;`
const RESTOCK_ENTRY: ContractEntry = { entry: "tool:restock", kind: "tool", exportName: "restock" }

describe("store identity in a recorded fixture", () => {
  it("leaves no value of the live store's identity fields, and the scrubbed fixture still replays", async () => {
    const isolate = await quickJsContractExecutor.open(
      { script: RESTOCK },
      { memoryBytes: 64 * 1024 * 1024 },
    )
    try {
      const real: AppBridge = {
        fetch: async () =>
          JSON.stringify({
            status: 200,
            headers: { "content-type": "application/json" },
            body: storeAnswer(),
          }),
        log_info: () => undefined,
      }
      const { fixture, outcome } = await recordEntry({
        isolate,
        entry: RESTOCK_ENTRY,
        input: { params: { host: "live-store.test", id: "1", note: `restock ${LIVE.title}` } },
        real,
        surface: SURFACE,
        limits: limits(),
        recordedFrom: "a test bridge",
      })
      expect(outcome.ok).toBe(true)
      const live = JSON.stringify(fixture)
      for (const v of LIVE_VALUES) expect(live).toContain(v)

      const scrubbed = scrubFixture(fixture, [{ from: "live-store.test", to: "shop.example" }])
      const text = JSON.stringify(scrubbed)
      for (const v of LIVE_VALUES) expect(text).not.toContain(v)
      for (const v of LIVE_VALUES) expect(text).not.toContain(encodeURIComponent(v))
      // What carries no identity stays as recorded.
      for (const kept of ["Default Title", "Standard", "FR TVA", "Lyon", "69002", "499.00"]) {
        expect(text).toContain(kept)
      }
      // A title and a SKU the run passes back in a later call match their recording.
      expect(
        await verifyFixture({
          isolate,
          entry: RESTOCK_ENTRY,
          fixture: scrubbed,
          surface: SURFACE,
          limits: limits(),
        }),
      ).toBeNull()
    } finally {
      isolate.dispose()
    }
  })

  it("gives a live value the same invented stand-in every time", () => {
    const a = JSON.stringify(scrubStoreIdentity({ calls: [{ reply: storeAnswer() }] }))
    const b = JSON.stringify(scrubStoreIdentity({ other: JSON.stringify(storeAnswer()) }))
    const titleIn = (s: string) => /Item [0-9a-f]{8}/.exec(s)?.[0]
    const skuIn = (s: string) => /SKU-[0-9A-F]{8}/.exec(s)?.[0]
    expect(titleIn(a)).toBeDefined()
    expect(titleIn(a)).toBe(titleIn(b))
    expect(skuIn(a)).toBe(skuIn(b))
    // Scrubbing a scrubbed value changes nothing.
    expect(JSON.stringify(scrubStoreIdentity(JSON.parse(a)))).toBe(a)
  })
})

describe("surfaceFor", () => {
  it("gives a webhook verifier the production verify bridge, every other entry the app's", () => {
    const app = { surface: SURFACE, verifySurface: verifySurface() }
    const verify: ContractEntry = {
      entry: "webhook-verify:x",
      kind: "webhook-verify",
      exportName: "verifyX",
    }
    expect(surfaceFor(app, ENTRY)).toBe(SURFACE)
    expect(surfaceFor(app, verify)).toBe(app.verifySurface)
    expect(app.verifySurface.length).toBeGreaterThan(0)
    expect(app.verifySurface.every(([, kind]) => kind === "async")).toBe(true)
    expect(surfaceFor({ surface: SURFACE }, verify)).toBe(SURFACE)
  })
})
