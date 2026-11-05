// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S1 + S2 — quote (cotation) tool path.
//
// S1: the `quote` tool returns carrier offers parsed from the recorded
//     multi-offer cotation XML, sorted ASCENDING by `price_ht`, with the DEV
//     offer dropped, each offer carrying a composite `offer_code`. Exactly one
//     v1 `/api/v1/cotation` GET is recorded.
// S2: empty cotation → `{ offers: [] }` (200, not an error); error cotation →
//     a typed failure surfacing the verbatim `<message>`.
import { api } from "@liaison/test-helpers"
import { assertBoxtalBundle, BOXTAL_BUNDLE, expect, test } from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { getRequests, resetMock, setMockMode, v1CotationGets } from "./helpers/mock-boxtal"

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}
const offersOf = (body: unknown): Array<Record<string, unknown>> => {
  const u = unwrap(body)
  return Array.isArray((u as { offers?: unknown[] }).offers)
    ? (u as { offers: Array<Record<string, unknown>> }).offers
    : []
}

const QUOTE_PARAMS = {
  // v1 cotation requires the French party vocabulary ("entreprise"/"particulier")
  // — the v1 client (boxtal-v1-client.ts) passes `type` straight through to
  // `expediteur.type`/`destinataire.type` with no normalization, and the quote
  // tool manifest enum is `["entreprise","particulier"]`. ("BUSINESS"/"RESIDENTIAL"
  // is the v3 *shipment* address vocabulary, not valid for a v1 quote.)
  from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
  to: { country: "FR", postalCode: "13001", city: "Marseille", type: "entreprise" },
  parcels: [{ weight: 3, length: 30, width: 20, height: 15 }],
  content_code: "10120",
}

test.describe("Boxtal: quote", () => {
  test("quote returns sorted, DEV-filtered offers; one v1 cotation GET", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    const token = qa.admin.token
    await resetMock(env.serverUrl, token)
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })
    await resetMock(env.serverUrl, token) // clear the connect-path requests
    await setMockMode({ serverUrl: env.serverUrl, token, cotationFixture: "multi" })

    const resp = await api(env.serverUrl, "/api/apps/boxtal/tools/quote", {
      method: "POST",
      token,
      body: { params: QUOTE_PARAMS },
    })
    expect(resp.status).toBe(200)
    const offers = offersOf(resp.body)
    // cotation-multi.xml has 3 COM offers (MONR 5.50, CHRP 7.80, SOGP 9.20), no DEV.
    // MONR CpourToi delivers to a PICKUP_POINT and `exclude_pickup_point_services`
    // defaults to true for an org that never set it (src/settings.ts), so a plain
    // quote returns the two door-to-door offers only.
    expect(offers.map((o) => o.offer_code)).toEqual(["CHRP-Chrono18", "SOGP-DomicileSansSignature"])
    // Sorted ascending by price_ht — cheapest first.
    const prices = offers.map((o) => Number(o.price_ht))
    expect(prices).toEqual([...prices].sort((a, b) => a - b))
    expect(prices[0]).toBeCloseTo(7.8, 2)
    // Each offer carries the composite offer_code (carrierCode-serviceCode).
    expect(offers[0].offer_code).toBe("CHRP-Chrono18")
    expect(
      offers.every(
        (o) => typeof o.offer_code === "string" && (o.offer_code as string).includes("-"),
      ),
    ).toBe(true)
    // No DEV offer leaked (cotation-multi has none; the parser also filters mode=DEV).
    expect(offers.some((o) => String(o.service).toLowerCase().includes("dev"))).toBe(false)

    // Exactly one v1 cotation GET hit the mock, with the French query keys.
    const reqs = await getRequests(env.serverUrl, token)
    const cotation = v1CotationGets(reqs)
    expect(cotation.length).toBe(1)
    expect(cotation[0].url).toContain("/api/v1/cotation?")
    // French querystring keys (colis_1.poids, expediteur.pays) — proves the v1 query builder ran.
    expect(decodeURIComponent(cotation[0].url)).toMatch(/colis_1\.poids|expediteur\.pays/)

    // Lift the exclusion and the relay offer comes back, cheapest first: the count
    // is the rule speaking, not a fixture quirk.
    const relaxed = await api(
      env.serverUrl,
      "/api/apps/boxtal/tools/settings_carrier_allowlist_set",
      {
        method: "POST",
        token,
        body: { params: { exclude_pickup_point_services: false } },
      },
    )
    expect(relaxed.status, JSON.stringify(relaxed.body)).toBe(200)
    const withRelay = await api(env.serverUrl, "/api/apps/boxtal/tools/quote", {
      method: "POST",
      token,
      body: { params: QUOTE_PARAMS },
    })
    expect(withRelay.status).toBe(200)
    const relayOffers = offersOf(withRelay.body)
    expect(relayOffers.map((o) => o.offer_code)).toEqual([
      "MONR-CpourToi",
      "CHRP-Chrono18",
      "SOGP-DomicileSansSignature",
    ])
    expect(Number(relayOffers[0].price_ht)).toBeCloseTo(5.5, 2)
  })

  test("dev-fixture quote drops the DEV offer and keeps the COM one", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    const token = qa.admin.token
    await resetMock(env.serverUrl, token)
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })
    await resetMock(env.serverUrl, token)
    await setMockMode({ serverUrl: env.serverUrl, token, cotationFixture: "dev" })

    const resp = await api(env.serverUrl, "/api/apps/boxtal/tools/quote", {
      method: "POST",
      token,
      body: { params: QUOTE_PARAMS },
    })
    expect(resp.status).toBe(200)
    const offers = offersOf(resp.body)
    // cotation-dev.xml: one DEV (UPSE 3.00) + one COM (CHRP 12.00). DEV dropped.
    expect(offers.length).toBe(1)
    expect(offers[0].carrier_code).toBe("CHRP")
    expect(Number(offers[0].price_ht)).toBeCloseTo(12.0, 2)
  })

  test("empty cotation degrades to { offers: [] }; error cotation surfaces the <message>", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    const token = qa.admin.token
    await resetMock(env.serverUrl, token)
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })
    await resetMock(env.serverUrl, token)

    // Empty: no <offer> → empty list, 200, not an error.
    await setMockMode({ serverUrl: env.serverUrl, token, cotationFixture: "empty" })
    const empty = await api(env.serverUrl, "/api/apps/boxtal/tools/quote", {
      method: "POST",
      token,
      body: { params: QUOTE_PARAMS },
    })
    expect(empty.status).toBe(200)
    expect(offersOf(empty.body)).toEqual([])

    // Error: <error><message>…</message></error> → typed failure surfacing the message.
    await setMockMode({ serverUrl: env.serverUrl, token, cotationFixture: "error" })
    const errored = await api(env.serverUrl, "/api/apps/boxtal/tools/quote", {
      method: "POST",
      token,
      body: { params: QUOTE_PARAMS },
    })
    // The XML <error> path throws a typed BoxtalApiError carrying the verbatim
    // French message — surfaced through the tool envelope (not a generic 500).
    const text = JSON.stringify(errored.body)
    expect(text).toContain("Le code postal du destinataire est invalide")
  })
})
