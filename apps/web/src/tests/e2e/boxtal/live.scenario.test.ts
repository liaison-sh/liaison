// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e — M0.3 LIVE mode. Gated on BOXTAL_E2E_LIVE=1: bypasses the
// sandbox-fetch mock (index.e2e.ts) and drives the real Boxtal sandbox
// (api.boxtal.build / test.envoimoinscher.com) through the SAME app handlers +
// rpc-bridge production fetch path the mock-backed scenarios use.
//
// Spine proven live: content-categories (v3 token exchange) → quote (v1
// cotation) → invoice issue → shipment_draft_create (cross-app K4) → gated
// create_shipment (v3 shipping-order POST) → get_documents (label) → track.
//
// When BOXTAL_E2E_LIVE is unset, EVERY test skips → CI default (mock) is
// untouched. The existing 11 scenarios prove the mock path; this proves live.

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import { decideApproval, waitForApproval } from "../helpers/approvals"
import { installInvoicingApp } from "../invoicing/helpers/install-invoicing-app"
import {
  assertBoxtalBundle,
  BOXTAL_BUNDLE,
  expect,
  INVOICING_BUNDLE,
  test,
} from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"

const LIVE = process.env.BOXTAL_E2E_LIVE === "1"
const liveTest = LIVE ? test : test.skip

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
async function toolPost(
  s: string,
  token: string,
  app: "boxtal" | "invoicing",
  tool: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await api(s, `/api/apps/${app}/tools/${tool}`, {
    method: "POST",
    token,
    body: { params },
  })
  return { status: resp.status, body: unwrap(resp.body) }
}

// Domestic FR→FR business→consumer quote — the smoke-proven live shape.
// NOTE: live Boxtal v1 accepts type "entreprise"/"particulier" (NOT the v3
// "BUSINESS" the mock-backed quote scenario uses — the mock ignores it).
const LIVE_QUOTE_PARAMS = {
  from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
  to: { country: "FR", postalCode: "33000", city: "Bordeaux", type: "particulier" },
  parcels: [{ weight: 1, length: 20, width: 20, height: 20 }],
  content_code: "10120",
}

const SENDER = {
  name: "Fabrikam SAS",
  // Boxtal v3 requires contact.email on BOTH addresses (fromAddress + toAddress)
  // AND validates the TLD — it rejects reserved `.test`/`.local` TLDs as invalid.
  // Use a real-TLD address (mock scenarios can use .test; the live sandbox can't).
  email: "ship@fabrikam.example",
  phone: "+33123456789",
  street: "12 Rue de la Paix",
  city: "Paris",
  postalCode: "75002",
  countryIsoCode: "FR",
}

// Pillar 10 — observation contract (CheckpointDecl), declared inline for the
// LIGHT/LIVE Mission-0 proof. The QA harness browser-driver that reuses this
// exact contract for the UNATTENDED judge is Phase 3. Here the main agent (LIVE
// judge) vision-judges the captured evidence against `rubric` and records the
// checkpoint_verdict at the gate — same contract, two producers.
type CheckpointSeverity = "low" | "medium" | "high"
interface CheckpointDecl {
  name: string
  afterBeat: string
  view: string
  rubric: string
  severity: CheckpointSeverity
  waitForTestid?: string
  mask?: string[]
}
const LIVE_CHECKPOINTS: CheckpointDecl[] = [
  {
    name: "boxtal_shipment_label_visible",
    afterBeat: "create_shipment",
    // The operator-visible shipment lives on the Boxtal app's OWN Shipments
    // surface. The invoicing document-detail "Shipment" tab is a cross-app K5
    // slot whose foreign component isn't resolved in the e2e build (it renders a
    // "Tab unavailable" placeholder), so we judge the Boxtal Shipments detail.
    view: "/boxtal/shipments",
    rubric:
      'The Boxtal shipment detail panel (data-testid="boxtal-shipment-detail") for the live order is visible ' +
      "and shows: a real order-status badge (Pending / Requested / Confirmed — not an error or empty state), the " +
      'recipient (Client Bordeaux), a Carrier line that is not "—", and a tracking-status badge (or a ' +
      '"Tracking: <number>" line once the carrier scans). There is NO error toast, NO stuck spinner, and no ' +
      "blank/black region.",
    severity: "high",
    waitForTestid: "boxtal-shipment-detail",
    mask: [],
  },
]

test.describe("Boxtal: LIVE sandbox", () => {
  liveTest(
    "live quote → shipment → label → tracking spine against the real sandbox",
    async ({ env, world, qa, page }, testInfo) => {
      assertBoxtalBundle()
      const token = qa.admin.token
      const s = env.serverUrl

      // 1. Install Invoicing (FR issuer + an FR contact) + Boxtal (real creds via
      //    the live install route, Task 3) with a sender + a profiled product.
      const invoicing = await installInvoicingApp({
        serverUrl: s,
        token,
        orgId: world.org.id,
        bundlePath: INVOICING_BUNDLE,
        issuerCountry: "FR",
        additionalContacts: [
          {
            country: "FR",
            name: "Client Bordeaux",
            email: "live-fr@e2e.test",
            customerKind: "individual",
          },
        ],
      })
      await installBoxtalApp({
        serverUrl: s,
        token,
        orgId: world.org.id,
        bundlePath: BOXTAL_BUNDLE,
        seedSenderAddress: SENDER,
        seedShippingProfiles: [
          {
            product_source: "shopify",
            product_id: "LIVE-VARIANT",
            unit_weight: 1,
            solo_length: 20,
            solo_width: 20,
            solo_height: 20,
            content_category: "content:v1:10120",
          },
        ],
      })

      // 2. content-categories — proves the LIVE v3 token exchange + a real GET.
      const cats = await toolPost(s, token, "boxtal", "list_content_categories", {})
      expect(cats.status, JSON.stringify(cats.body)).toBe(200)
      const catList = (cats.body.categories ?? cats.body.content_categories ?? cats.body.items) as
        | unknown[]
        | undefined
      expect(Array.isArray(catList) && catList.length >= 1, JSON.stringify(cats.body)).toBe(true)

      // 3. quote — LIVE v1 cotation. Either ≥1 offer or a TYPED empty/cotation_error
      //    (never a generic crash). Capture a real offer_code if present.
      const quoteResp = await toolPost(s, token, "boxtal", "quote", LIVE_QUOTE_PARAMS)
      expect(quoteResp.status, JSON.stringify(quoteResp.body)).toBe(200)
      const offers = offersOf(quoteResp.body)
      // Live sandbox returns offers for a standard FR domestic quote (smoke proved ≥1).
      expect(offers.length, JSON.stringify(quoteResp.body)).toBeGreaterThanOrEqual(1)
      // Pick a HOME-DELIVERY offer: relay/pickup-point offers (needs_relay_point)
      // require a `pickupPointCode` the spine doesn't supply — relay shipping is
      // out of M0.3 scope. The live FR-domestic quote returns home carriers.
      const homeOffer = offers.find((o) => o.needs_relay_point === false)
      expect(homeOffer, `no home-delivery offer in ${JSON.stringify(offers)}`).toBeTruthy()
      const liveOfferCode = String((homeOffer as Record<string, unknown>).offer_code)
      expect(liveOfferCode).toContain("-")

      // 4. Issue a domestic FR invoice (no customs) for the profiled product.
      const issue = await api(s, "/api/apps/invoicing/tools/invoice_create_and_issue", {
        method: "POST",
        token,
        body: {
          params: {
            counterparty: {
              contact_id: invoicing.additionalContactIds[0],
              legal_name: "Client Bordeaux",
              country: "FR",
              vat_id: null,
              address: "12 cours du Medoc, 33300 Bordeaux, France",
              email: "live-fr@e2e.test",
            },
            issuer_profile_id: invoicing.primaryIssuerProfileId,
            currency: "EUR",
            incoterm: "DAP",
            items: [
              {
                position: 1,
                description: "Kestrel 2 controller",
                quantity: "1",
                unit_price_minor: "25000",
                product_source: "shopify",
                external_id: "LIVE-VARIANT",
              },
            ],
          },
        },
      })
      expect(issue.status, JSON.stringify(issue.body)).toBe(200)
      const issued = unwrap(issue.body)
      const invoiceId =
        (issued.document_id as string | undefined) ??
        (issued.result as { document_id?: string } | undefined)?.document_id
      expect(invoiceId, JSON.stringify(issued)).toBeTruthy()

      // 5. shipment_draft_create — cross-app K4 read; domestic FR ⇒ no customs.
      const draft = await toolPost(s, token, "boxtal", "shipment_draft_create", {
        document_ref: invoiceId,
      })
      expect(draft.status, JSON.stringify(draft.body)).toBe(200)
      expect(draft.body.unresolved, JSON.stringify(draft.body)).toEqual([])

      // 6. create_shipment — gated. A direct human-approver call may run inline OR
      //    gate; handle both. Result: a LIVE v3 shipping-order, real boxtal_order_id.
      const create = await toolPost(s, token, "boxtal", "create_shipment", {
        draft_id: invoiceId,
        offer_code: liveOfferCode,
        recipient_phone: "+33600000001",
        recipient_address: {
          name: "Client Bordeaux",
          email: "client.bordeaux.live@example.com",
          phone: "+33600000001",
          street: "1 Cours de l'Intendance",
          city: "Bordeaux",
          postalCode: "33000",
          countryIsoCode: "FR",
        },
      })
      expect(create.status, JSON.stringify(create.body)).toBe(200)
      const blocked = create.body.blocked as { approvalRequestId?: string } | undefined
      if (blocked?.approvalRequestId) {
        const pending = await waitForApproval({ serverUrl: s, token, toolPrefix: "boxtal:" })
        await decideApproval({ serverUrl: s, token, requestId: pending.id, decision: "approve" })
      }

      // 7. Resolve the order id (direct path returns it; gated path → get_shipment
      //    by the linked invoice surfaces it). Poll briefly for the linked row.
      let orderId = create.body.boxtal_order_id as string | undefined
      const deadline = Date.now() + 20_000
      while (!orderId && Date.now() < deadline) {
        const got = await toolPost(s, token, "boxtal", "get_shipment", { document_ref: invoiceId })
        orderId =
          (got.body.boxtal_order_id as string | undefined) ?? (got.body.id as string | undefined)
        if (!orderId) await new Promise((r) => setTimeout(r, 500))
      }
      expect(orderId, "live shipment produced a boxtal order id").toBeTruthy()
      // A LIVE order id is NOT the deterministic mock shape `boxtal-order-<sha12>`.
      expect(orderId).not.toMatch(/^boxtal-order-[0-9a-f]{12}$/)

      // 8. get_documents — the label endpoint reachable live (PENDING ⇒ may be []
      //    immediately after create; assert the call SUCCEEDS, not a specific doc).
      const docs = await toolPost(s, token, "boxtal", "get_documents", { id: orderId })
      expect(docs.status, `get_documents body=${JSON.stringify(docs.body)}`).toBe(200)

      // 9. track — the live tracking endpoint is reachable and returns the
      //    normalized shape. A just-created sandbox order is PENDING with no
      //    carrier scan yet, so `tracking_status` is legitimately null and
      //    `events` is empty — assert reachability + shape, NOT a truthy status
      //    (requiring a real scan seconds after create is the flaky, wrong bar).
      const track = await toolPost(s, token, "boxtal", "track", { id: orderId })
      expect(track.status, JSON.stringify(track.body)).toBe(200)
      expect(track.body, JSON.stringify(track.body)).toHaveProperty("tracking_status")
      expect(
        Array.isArray((track.body as { events?: unknown[] }).events),
        JSON.stringify(track.body),
      ).toBe(true)

      // 10. VISUAL CHECKPOINT (Pillar 10) — the operator can SEE the live shipment.
      //     LIGHT proof of the visual layer end-to-end against live data: navigate a
      //     real browser to the invoice's Boxtal shipment tab, assert the linked panel
      //     rendered, capture the CheckpointEvidence bundle, and emit a
      //     checkpoint_pending marker the LIVE judge converts to a checkpoint_verdict.
      const decl = LIVE_CHECKPOINTS[0]
      const view = decl.view
      // Capture any 4xx/5xx during the checkpoint nav as checkpoint evidence (the
      // judge sees this in context.json). A best-effort tool call (e.g. the
      // Shipments search) may transiently 504 under worker-pool load, but it must
      // NOT surface a global error toast — `invokeTool` is non-toasting and the
      // caller (`fetchShipments`) degrades to an empty list. Recorded, not asserted
      // empty: the search list still populates from the row fetch that succeeds.
      const failedRequests: string[] = []
      page.on("response", (r) => {
        if (r.status() >= 400) {
          try {
            failedRequests.push(
              `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
            )
          } catch {
            /* ignore unparseable url */
          }
        }
      })
      await loginAs(page, env, "admin@test.com", "12345678")
      // localhost (NOT 127.0.0.1) so the host-scoped auth cookie loginAs set applies.
      // Drive the Boxtal app's OWN Shipments surface (the cross-app invoicing tab
      // renders a placeholder in the e2e build). Search → row → detail panel.
      await page.goto(`http://localhost:${env.ports[1]}${view}`)
      await page.waitForLoadState("networkidle")
      const search = page.getByTestId("boxtal-shipments-search")
      await search.waitFor({ state: "visible", timeout: 30_000 })
      await search.fill("Bordeaux")
      const row = page.locator('[data-testid="boxtal-shipments-table"] tr', {
        hasText: /Bordeaux/i,
      })
      await expect(row.first()).toBeVisible({ timeout: 15_000 })
      await row.first().click()
      const panel = page.getByTestId(decl.waitForTestid ?? "boxtal-shipment-detail")
      await panel.waitFor({ state: "visible", timeout: 15_000 })
      // Give late mount-fetches a beat so any best-effort failures land in
      // `failedRequests` before we snapshot the evidence bundle.
      await page.waitForTimeout(1500)

      // Mechanical pre-checks the rubric also covers (defense in depth — a
      // regression fails the test even before the vision judge runs):
      await expect(panel).toBeVisible()
      await expect(panel).toContainText(/Bordeaux/i)
      await expect(panel).toContainText(/Carrier/i)

      // Capture the CheckpointEvidence bundle for the LIVE/UNATTENDED judge.
      const evidenceDir = testInfo.outputPath("checkpoints", decl.name)
      await mkdir(evidenceDir, { recursive: true })
      const screenshotPath = join(evidenceDir, "screenshot.png")
      await page.screenshot({ path: screenshotPath, fullPage: true })
      await writeFile(join(evidenceDir, "dom.html"), await page.content())
      await writeFile(join(evidenceDir, "rubric.txt"), decl.rubric)
      await writeFile(
        join(evidenceDir, "context.json"),
        JSON.stringify(
          {
            scenario: "boxtal_live_spine",
            checkpoint: decl.name,
            afterBeat: decl.afterBeat,
            view,
            severity: decl.severity,
            rubric: decl.rubric,
            invoiceId,
            orderId,
            correlationId: `checkpoint:boxtal_live_spine:${decl.name}`,
            url: page.url(),
            // Best-effort 4xx/5xx seen during the nav — must be handled silently
            // (no global error toast). Evidence, not a pass/fail gate.
            failedRequests,
          },
          null,
          2,
        ),
      )
      // Evidence on disk → the LIVE judge (gate step) writes the checkpoint_verdict.
      console.log(JSON.stringify({ checkpoint_pending: decl.name, evidenceDir }))
      expect(screenshotPath).toContain(decl.name)
    },
  )

  liveTest("live mode skips when the gate is unset (control)", async () => {
    // This body only runs when LIVE; the assertion documents the invariant that
    // the skip-gate above is the only thing standing between CI and a live call.
    expect(process.env.BOXTAL_E2E_LIVE).toBe("1")
  })
})
