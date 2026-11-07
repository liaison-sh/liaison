// SPDX-License-Identifier: FSL-1.1-ALv2
// The billing code is deployment-agnostic : prices, the top-up
// minimum and unit price, and the payment frame's origin reach a server only
// in the control plane's replies or its own settings. So the billing source
// (server routes, the web page and frame, their strings) names no deployment
// host, no plan price and no tax-regime abbreviation, and no shipped web
// bundle names a payment-frame host.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../../../../..")

const BILLING_SOURCES = [
  "apps/api/src/modules/billing-managed",
  "apps/web/src/modules/settings/BillingSettings.tsx",
  "apps/web/src/modules/settings/PayFrame.tsx",
  "packages/shared/src/i18n/locales/en/cloud-billing.json",
  "packages/shared/src/i18n/locales/fr/cloud-billing.json",
]

function files(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  if (!statSync(abs).isDirectory()) return [abs]
  return readdirSync(abs, { recursive: true })
    .map((f) => path.join(abs, String(f)))
    .filter((f) => statSync(f).isFile() && !f.endsWith("public-guard.test.ts"))
}

/** A whole-euro amount (a plan price shape) next to a euro sign or code, either side. */
const PRICE = /(?:€|EUR)\s?\d+(?:[.,]00)?(?![\d.,])|(?<![\d.,])\d+(?:[.,]00)?\s?(?:€|EUR)/
const DEPLOYMENT = /liaison\.sh\b/
const TAX_ABBREVIATION = /\bHT\b/
/** A hard-coded payment-frame URL: the frame origin only ever comes from the server. */
const FRAME_URL = /https:\/\/pay\.[a-z0-9-]/

describe("billing code names no deployment, price or tax regime", () => {
  const sources = BILLING_SOURCES.flatMap(files)

  test("the billing sources exist (the guard reads real files)", () => {
    expect(sources.length).toBeGreaterThanOrEqual(6)
  })

  for (const [name, pattern] of [
    ["deployment host", DEPLOYMENT],
    ["plan price", PRICE],
    ["tax abbreviation", TAX_ABBREVIATION],
  ] as const) {
    test(`no ${name}`, () => {
      const hits = sources.filter((f) => pattern.test(readFileSync(f, "utf8")))
      expect(hits.map((f) => path.relative(ROOT, f))).toEqual([])
    })
  }

  test("the patterns catch what they should", () => {
    expect(PRICE.test("€40")).toBe(true)
    expect(PRICE.test("70 €")).toBe(true)
    expect(PRICE.test("15.00 EUR")).toBe(true)
    expect(PRICE.test("€31.50")).toBe(false)
    expect(DEPLOYMENT.test("https://example.liaison.sh")).toBe(true)
    expect(DEPLOYMENT.test("https://pay.example.test")).toBe(false)
    expect(DEPLOYMENT.test("acme-pay.liaisonapp")).toBe(false)
    expect(TAX_ABBREVIATION.test("€10 HT")).toBe(true)
    expect(FRAME_URL.test("https://pay.example.test")).toBe(true)
  })

  test("a built web bundle names no payment-frame host", () => {
    const dist = path.join(ROOT, "apps/web/dist")
    if (!existsSync(dist)) return // nothing built in this checkout; CI builds before shipping
    const hits = readdirSync(dist, { recursive: true })
      .map((f) => path.join(dist, String(f)))
      .filter((f) => statSync(f).isFile() && /\.(js|html)$/.test(f))
      .filter((f) => FRAME_URL.test(readFileSync(f, "utf8")))
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([])
  })
})
