// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The interception point: a demo org's Boxtal traffic never leaves the box.
//
// The sandbox fetch bridge asks this once per outbound call, after the demo
// Shopify provider. On a deployment that is not the demo instance the whole
// cost is one boolean read. On the demo instance, for an org carrying the demo
// marker, every Boxtal host is a closed door: the request is answered here
// from fixtures (a token, the content categories, a carrier quote, a shipping
// order, its empty tracking and a specimen label marked as a demo) or refused.
// It is never forwarded, so no parcel is ever booked with a real carrier and no
// label is ever bought. The label import downloads the specimen through the
// same door (sandbox/bridge/files.ts), so a booking finishes the way a real
// one does instead of polling for a label that never comes.
//
// Anything that is not a demo org's Boxtal request declines (null), and the
// bridge goes on exactly as before.
import { randomUUID } from "node:crypto"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import {
  DEMO_BOXTAL_TOKEN_PREFIX,
  fixtureConnectionOf,
  fixtureRefusal,
} from "~/modules/demo/fixture-credential"
import { isBoxtalHost } from "./sentinel"

export interface DemoBoxtalRequest {
  orgId: string
  url: string
  method: string
  body: string | undefined
  /** The request's headers: a sentinel credential marks a fixture connection. */
  headers?: Record<string, string>
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Boxtal v3's `{ status, timestamp, content }` envelope. */
function envelope(content: unknown, status = 200): Response {
  return json({ status, timestamp: new Date().toISOString(), content }, status)
}

function isoDay(fromNow: Date, days: number): string {
  return new Date(fromNow.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Two door-to-door couriers, priced on the parcels' weight and the route
 * (a parcel leaving the EU costs more), collected at the sender's address.
 */
export function demoCotationXml(query: URLSearchParams, now: Date = new Date()): string {
  let kg = 0
  for (let n = 1; query.has(`colis_${n}.poids`); n++) {
    kg += Number(query.get(`colis_${n}.poids`)) || 0
  }
  const to = (query.get("destinataire.pays") ?? "").toUpperCase()
  const export_ = to !== "" && !EU.has(to)
  const offer = (
    code: string,
    label: string,
    service: string,
    serviceLabel: string,
    base: number,
    perKg: number,
    days: number,
  ) => {
    const ht = Math.round((base + perKg * Math.max(kg, 0.5) + (export_ ? 18 : 0)) * 100) / 100
    const ttc = Math.round(ht * 1.2 * 100) / 100
    return `    <offer>
      <mode>COM</mode>
      <operator><code>${code}</code><label>${label}</label></operator>
      <service><code>${service}</code><label>${serviceLabel}</label></service>
      <price><currency>EUR</currency><tax-exclusive>${ht.toFixed(2)}</tax-exclusive><tax-inclusive>${ttc.toFixed(2)}</tax-inclusive></price>
      <collection><date>${isoDay(now, 1)}</date><type><code>COMPANY</code><label>Collected at your address</label></type></collection>
      <delivery><date>${isoDay(now, 1 + days)}</date><type><code>HOME</code><label>Door to door</label></type></delivery>
    </offer>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<cotation>
  <shipment>
${offer("UPSE", "UPS", "ExpressSaver", "UPS Express Saver", 24, 7.5, export_ ? 3 : 1)}
${offer("DHLE", "DHL Express", "ExpressWorldwide", "DHL Express Worldwide", 29, 8.2, export_ ? 2 : 1)}
  </shipment>
</cotation>`
}

const EU = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
])

const CONTENT_CATEGORIES = [
  { id: "content:v1:40110", label: "Audio and video equipment" },
  { id: "content:v1:40150", label: "Computer accessories" },
]

/** A shipping order as Boxtal returns it: booked, never handed to a carrier. */
function demoOrder(id: string, now: Date = new Date()) {
  return {
    id,
    status: "CONFIRMED",
    deliveryPriceExclTax: { value: 0, currency: "EUR" },
    insurancePriceExclTax: { value: 0, currency: "EUR" },
    expectedTakingOverDate: isoDay(now, 1),
    estimatedDeliveryDate: isoDay(now, 4),
  }
}

const ORDER_PATH =
  /^\/shipping\/v3\.1\/shipping-order\/([^/]+)(\/tracking|\/shipping-document|\/demo-label\.pdf)?$/

/**
 * A one-page A6 PDF that says what it is: a demo booking's label, valid for
 * no carrier. Built by hand (fixed objects, computed offsets) so the demo
 * needs no PDF library on this path.
 */
export function demoLabelPdf(orderId: string): Uint8Array {
  const safe = orderId.replace(/[^A-Za-z0-9-]/g, "")
  const text = [
    "BT /F1 18 Tf 24 360 Td (DEMO LABEL) Tj ET",
    "BT /F1 11 Tf 24 336 Td (Not a real shipment. No carrier will collect it.) Tj ET",
    `BT /F1 11 Tf 24 318 Td (Order ${safe}) Tj ET`,
  ].join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 298 420] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) body += `${String(o).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

/** Answer one request to a Boxtal host for a demo org. Never forwards it. */
export function answerDemoBoxtal(method: string, url: URL): Response {
  const m = method.toUpperCase()
  const path = url.pathname
  if (m === "POST" && path === "/iam/account-app/token") {
    return json({ accessToken: `${DEMO_BOXTAL_TOKEN_PREFIX}${randomUUID()}`, expiresIn: 3600 })
  }
  if (m === "GET" && path === "/api/v1/cotation") {
    return new Response(demoCotationXml(url.searchParams), {
      status: 200,
      headers: { "content-type": "application/xml" },
    })
  }
  if (m === "GET" && path === "/shipping/v3.1/content-category") {
    return envelope(CONTENT_CATEGORIES)
  }
  if (m === "POST" && path === "/shipping/v3.1/shipping-order") {
    return envelope(demoOrder(`DEMO-${randomUUID().slice(0, 8).toUpperCase()}`))
  }
  const order = ORDER_PATH.exec(path)
  if (order) {
    const id = decodeURIComponent(order[1]!)
    if (m === "GET" && order[2] === "/tracking") return envelope([])
    // The label is never bought: the booking's document is the demo specimen,
    // served from the same host the app asked.
    if (m === "GET" && order[2] === "/shipping-document") {
      const label = new URL(
        `/shipping/v3.1/shipping-order/${encodeURIComponent(id)}/demo-label.pdf`,
        url.origin,
      )
      return envelope([{ type: "LABEL", format: "PDF_A6", url: label.toString() }])
    }
    if (m === "GET" && order[2] === "/demo-label.pdf") {
      return new Response(demoLabelPdf(id), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })
    }
    if (m === "GET") return envelope(demoOrder(id))
    if (m === "DELETE") return envelope({ ...demoOrder(id), status: "CANCELLED" })
  }
  if (path.startsWith("/shipping/v3.1/subscription")) {
    return envelope(m === "POST" ? { id: 1 } : {})
  }
  return json(
    { status: 404, message: "This demo answers Boxtal quotes and shipping orders only." },
    404,
  )
}

/**
 * The fixture answer for this request, or null when this box, this org or
 * this host is none of the demo's business.
 */
export async function maybeDemoBoxtalResponse(
  request: DemoBoxtalRequest,
): Promise<Response | null> {
  // The seeded fixture connection's own request (its sentinel key, or the
  // token this responder issued) is answered here on ANY box: it holds no real
  // credential and must never reach Boxtal (fixture-credential.ts).
  const fixture = fixtureConnectionOf(request.url, request.headers) === "boxtal"
  if (!isDemoModeEnabled() && !fixture) return null
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (!isBoxtalHost(url.hostname)) return null
  const { marker } = await loadDemoOrg(request.orgId)
  if (!marker) return fixture ? fixtureRefusal("boxtal") : null
  return answerDemoBoxtal(request.method, url)
}
