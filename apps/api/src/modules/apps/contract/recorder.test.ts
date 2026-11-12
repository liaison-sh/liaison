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
import { recordEntry, scrubFixture, scrubValue, verifyFixture, writeFixture } from "./recorder"
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
