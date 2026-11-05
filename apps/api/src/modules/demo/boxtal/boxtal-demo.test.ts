// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's Boxtal connection (walk 5, D41): a demo org's carrier quote and
// shipping order are answered in-process, so the commerce scenario can stage
// its order's label, and no request to a Boxtal host ever leaves the box for
// a demo org. Any other org, or a box out of demo mode, is untouched.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { sql } from "~/db"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { parseCotationXml } from "../../../../../../bundled-apps/boxtal/src/lib/boxtal-v1-client"
import { maybeDemoBoxtalResponse } from "./index"

const DEMO_ORG = crypto.randomUUID()
const NORMAL_ORG = crypto.randomUUID()
const COTATION =
  "https://test.envoimoinscher.com/api/v1/cotation?colis_1.poids=1.8&colis_1.longueur=20" +
  "&destinataire.pays=JP&destinataire.code_postal=220-0012&expediteur.pays=FR"

const ask = (orgId: string, url: string, method = "GET") =>
  maybeDemoBoxtalResponse({ orgId, url, method, body: undefined })

describe("the demo's Boxtal connection", () => {
  beforeAll(async () => {
    for (const [id, name] of [
      [DEMO_ORG, "Boxtal Demo Org"],
      [NORMAL_ORG, "Boxtal Normal Org"],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${id}, ${name}, ${`boxtal-demo-${id.slice(0, 8)}`})`
    }
    await markOrgAsDemo(DEMO_ORG, visitorMarker(24))
    invalidateDemoMarker()
  })
  afterEach(() => DemoModeTestAccess.set(null))
  afterAll(() => invalidateDemoMarker())

  it("answers a demo org's quote with door-to-door couriers the app's own parser reads", async () => {
    DemoModeTestAccess.set(true)
    const res = await ask(DEMO_ORG, COTATION)
    expect(res?.status).toBe(200)
    const offers = parseCotationXml(await res!.text())
    expect(offers.length).toBeGreaterThan(0)
    for (const o of offers) {
      expect(o.price_ttc).toBeGreaterThan(0)
      expect(o.pickup_at_sender).toBe(true)
      expect(o.needs_relay_point).toBe(false)
    }
  })

  it("books a demo org's shipping order without a carrier, and answers with a demo label", async () => {
    DemoModeTestAccess.set(true)
    const token = await ask(DEMO_ORG, "https://api.boxtal.build/iam/account-app/token", "POST")
    expect(((await token!.json()) as { accessToken?: string }).accessToken).toBeTruthy()
    const created = await ask(
      DEMO_ORG,
      "https://api.boxtal.build/shipping/v3.1/shipping-order",
      "POST",
    )
    const order = ((await created!.json()) as { content: { id: string; status: string } }).content
    expect(order.id).toMatch(/^DEMO-/)
    const docs = await ask(
      DEMO_ORG,
      `https://api.boxtal.build/shipping/v3.1/shipping-order/${order.id}/shipping-document`,
    )
    // Walk D62: a booking with no label kept the approved sequence polling
    // for 21 minutes, then failed it and woke the agent. The demo answers
    // with a specimen label on the host the app asked, marked as a demo.
    const content = (
      (await docs!.json()) as {
        content: Array<{ type: string; format: string; url: string }>
      }
    ).content
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe("LABEL")
    const labelUrl = new URL(content[0]!.url)
    expect(labelUrl.hostname).toBe("api.boxtal.build")
    const pdf = await ask(DEMO_ORG, labelUrl.toString())
    expect(pdf?.status).toBe(200)
    expect(pdf!.headers.get("content-type")).toBe("application/pdf")
    const bytes = new Uint8Array(await pdf!.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    expect(text.startsWith("%PDF-")).toBe(true)
    expect(text).toContain("DEMO LABEL")
    // A well-formed document: a PDF reader opens it.
    const { PDFDocument } = await import("pdf-lib")
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })

  it("refuses, never forwards, any other Boxtal request of a demo org", async () => {
    DemoModeTestAccess.set(true)
    const res = await ask(DEMO_ORG, "https://www.envoimoinscher.com/api/v1/order", "POST")
    expect(res?.status).toBe(404)
  })

  it("leaves a normal org, another host, and a box out of demo mode alone", async () => {
    DemoModeTestAccess.set(true)
    expect(await ask(NORMAL_ORG, COTATION)).toBeNull()
    expect(await ask(DEMO_ORG, "https://example.com/api/v1/cotation")).toBeNull()
    DemoModeTestAccess.set(false)
    expect(await ask(DEMO_ORG, COTATION)).toBeNull()
  })

  it("only the demo module and the demo seeder install the connection", () => {
    const src = path.resolve(import.meta.dir, "..", "..", "..")
    const repo = path.resolve(src, "..", "..", "..")
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist") continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
          if (/\binstallDemoBoxtalConnection\s*\(/.test(readFileSync(full, "utf8"))) {
            hits.push(path.relative(repo, full))
          }
        }
      }
    }
    walk(src)
    walk(path.join(repo, "scripts"))
    for (const hit of hits) {
      expect(
        hit.startsWith("apps/api/src/modules/demo/boxtal/") ||
          hit.startsWith("apps/api/src/seed/tiers/demo/"),
        hit,
      ).toBe(true)
    }
  })
})
