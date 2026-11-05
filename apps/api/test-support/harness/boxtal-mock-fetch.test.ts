// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression for the Boxtal mock's /tracking checkpoint MESSAGE. The mock used to
// hardcode "Parcel announced" for every status — actively wrong for a
// DELIVERED/EXCEPTION/FAILED_ATTEMPT parcel, leaving `track`'s newest event label
// uninformative (the marco-daily-tracking-exception-sweep categorization signal).
// Now the message is status-appropriate, with an optional per-order override.

import { afterEach, describe, expect, it } from "bun:test"
import { makeBoxtalMockFetch, resetBoxtalMockMode, setBoxtalMockMode } from "./boxtal-mock-fetch"

const mockFetch = makeBoxtalMockFetch()

async function trackingHistory(orderId: string): Promise<{ status: string; message: string }> {
  const res = await mockFetch(
    `https://api.boxtal.build/shipping/v3.1/shipping-order/${orderId}/tracking`,
    { method: "GET" },
  )
  const body = (await res.json()) as {
    content: Array<{ history: Array<{ status: string; message: string }> }>
  }
  const ev = body.content[0]?.history[0]
  if (!ev) throw new Error("no tracking history event")
  return ev
}

describe("Boxtal mock — /tracking checkpoint message", () => {
  afterEach(() => resetBoxtalMockMode())

  it("emits a status-appropriate default message (not the old 'Parcel announced' for every status)", async () => {
    setBoxtalMockMode({ trackingStatus: { orderId: "ord-fail", status: "FAILED_ATTEMPT" } })
    const ev = await trackingHistory("ord-fail")
    expect(ev.status).toBe("FAILED_ATTEMPT")
    expect(ev.message).toBe("Delivery attempt failed — recipient absent")
    expect(ev.message).not.toBe("Parcel announced")
  })

  it("uses the per-order message override when provided", async () => {
    setBoxtalMockMode({
      trackingStatus: {
        orderId: "ord-customs",
        status: "EXCEPTION",
        message: "Held at customs — import clearance documentation required",
      },
    })
    const ev = await trackingHistory("ord-customs")
    expect(ev.status).toBe("EXCEPTION")
    expect(ev.message).toBe("Held at customs — import clearance documentation required")
  })

  it("an unconfigured order defaults to ANNOUNCED / 'Parcel announced'", async () => {
    const ev = await trackingHistory("ord-fresh")
    expect(ev.status).toBe("ANNOUNCED")
    expect(ev.message).toBe("Parcel announced")
  })

  // Regression (marco-mondial-relay-pickup-expiry-followup): the mock carries a per-order
  // pickup collection deadline on the tracking package for a parcel at a pickup point, so
  // `track` can surface the authoritative carrier deadline.
  const trackingPackage = async (orderId: string) => {
    const res = await mockFetch(
      `https://api.boxtal.build/shipping/v3.1/shipping-order/${orderId}/tracking`,
      { method: "GET" },
    )
    const body = (await res.json()) as {
      content: Array<{ status: string; pickupDeadline?: string }>
    }
    return body.content[0]
  }

  it("emits pickupDeadline on the tracking package for a REACHED_DELIVERY_PICKUP_POINT parcel", async () => {
    setBoxtalMockMode({
      trackingStatus: {
        orderId: "ord-relay",
        status: "REACHED_DELIVERY_PICKUP_POINT",
        pickupDeadline: "2026-06-25",
      },
    })
    const pkg = await trackingPackage("ord-relay")
    expect(pkg?.status).toBe("REACHED_DELIVERY_PICKUP_POINT")
    expect(pkg?.pickupDeadline).toBe("2026-06-25")
  })

  it("does NOT emit pickupDeadline when the parcel is not at a pickup point", async () => {
    setBoxtalMockMode({
      trackingStatus: {
        orderId: "ord-transit",
        status: "IN_TRANSIT",
        pickupDeadline: "2026-06-25",
      },
    })
    const pkg = await trackingPackage("ord-transit")
    expect(pkg?.status).toBe("IN_TRANSIT")
    expect(pkg?.pickupDeadline).toBeUndefined()
  })
})

// A real Boxtal cotation returns DIFFERENT carriers by route: domestic French carriers
// (Colissimo / Mondial Relay / Chronopost) for FR→FR, and international, customs-capable
// carriers (UPS / FedEx / DPD international) for an export route. The mock used to serve
// the same domestic French list regardless of destination, so a JP/US export quote could
// NOT offer a destination-capable carrier — marco-prepare-single-export-shipment-jp could
// never satisfy "pick a carrier that does Japan". The mock now branches on
// destinataire.pays vs expediteur.pays.
describe("Boxtal mock — cotation carriers by route (domestic vs international)", () => {
  afterEach(() => resetBoxtalMockMode())

  const cotation = async (from: string, to: string): Promise<string> => {
    const qs = `expediteur.pays=${from}&expediteur.code_postal=31000&destinataire.pays=${to}&destinataire.code_postal=10000&colis_1.poids=2.5`
    const res = await mockFetch(`https://test.envoimoinscher.com/api/v1/cotation?${qs}`, {
      method: "GET",
    })
    return res.text()
  }

  it("serves DOMESTIC French carriers for an FR→FR route", async () => {
    const xml = await cotation("FR", "FR")
    expect(xml).toContain("Colissimo")
    expect(xml).toContain("Mondial Relay")
    expect(xml).not.toContain("UPS")
    expect(xml).not.toContain("FedEx")
  })

  it("serves INTERNATIONAL JP-capable carriers for an FR→JP export route", async () => {
    const xml = await cotation("FR", "JP")
    expect(xml).toContain("UPS")
    expect(xml).toContain("FedEx")
    expect(xml).toContain("DPD")
    // domestic-only services must NOT be offered on an international route
    expect(xml).not.toContain("Mondial Relay")
    expect(xml).not.toContain("Colissimo")
  })

  it("serves international carriers for FR→US too (route, not a single country)", async () => {
    const xml = await cotation("FR", "US")
    expect(xml).toContain("UPS")
    expect(xml).not.toContain("Colissimo")
  })

  // REGRESSION (l766 S4) — an INTRA-EU cross-border route (FR→DE/NL/BE) is CUSTOMS-FREE and ships on the
  // domestic/EU-economy carriers (Colissimo / Mondial Relay), NOT the international customs set. The old
  // discriminator (`to !== from`) wrongly served the international-only fixture for these, so an
  // EU-domestic batch could never be quoted on Colissimo/Mondial Relay — create_shipment hit
  // `offer_not_quoted` and a weak agent fabricated the tail. The route is an export ONLY when it leaves
  // the EU customs union.
  it("serves DOMESTIC/EU-economy carriers for an INTRA-EU cross-border route (FR→DE, FR→NL, FR→BE)", async () => {
    for (const to of ["DE", "NL", "BE"]) {
      const xml = await cotation("FR", to)
      expect(xml).toContain("Colissimo")
      expect(xml).toContain("Mondial Relay")
      expect(xml).not.toContain("UPS")
      expect(xml).not.toContain("FedEx")
    }
  })

  it("still serves INTERNATIONAL carriers for a route that LEAVES the EU (FR→GB post-Brexit, FR→CH)", async () => {
    for (const to of ["GB", "CH"]) {
      const xml = await cotation("FR", to)
      expect(xml).toContain("UPS")
      expect(xml).not.toContain("Colissimo")
    }
  })

  it("an EXPLICIT fault-mode fixture (empty) still wins over destination routing", async () => {
    setBoxtalMockMode({ cotationFixture: "empty" })
    const xml = await cotation("FR", "JP")
    // the empty fixture has no UPS/FedEx offers — destination routing must not override it
    expect(xml).not.toContain("UPS")
    expect(xml).not.toContain("FedEx")
  })
})

describe("Boxtal mock — v3 subscriptions", () => {
  // onConnectionEstablished creates each subscription, then sets its signing key
  // on the dedicated endpoint; a 404 there degraded every mocked install.
  it("answers the webhook-secret PUT for a created subscription", async () => {
    const created = await mockFetch("https://api.boxtal.build/shipping/v3.1/subscription", {
      method: "POST",
      body: JSON.stringify({ eventType: "TRACKING_CHANGED", callbackUrl: "https://x.test/cb" }),
    })
    expect(created.status).toBe(200)
    const { content } = (await created.json()) as { content: { id: string } }
    const res = await mockFetch(
      `https://api.boxtal.build/shipping/v3.1/subscription/${content.id}/webhook-secret`,
      { method: "PUT", body: JSON.stringify({ webhookSecret: "a".repeat(64) }) },
    )
    expect(res.status).toBe(200)
  })
})
