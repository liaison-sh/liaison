// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e S6 — Numbering invariant under sequential issuance.
//
// Plan §S6: issue ten invoices in quick succession (no gating) and verify the
// issuer's sequence is strictly monotonic 1..10 with no gaps. Pins spec #2
// (numbering monotonic and gapless) at the UI-visible HTTP tier; concurrent
// allocation is pinned separately by the kernel's K3 allocate.test.ts.
//
// Implementation notes:
//  - Issued via the direct tool route (`invoice_create_and_issue`) with the
//    issuer's `invoice_approval_threshold_minor` set to null, so every call
//    issues directly (no approval gate). Sequential, not parallel — the
//    real-world journey is a human issuing one invoice after another.
//  - The handler returns `{ status, document_id, number }`; `number_int` is the
//    trailing 4-digit field of `INV-YYYY-NNNN`, so the monotonic check parses it
//    from `number`.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE as resolvedInvoicingBundle } from "./helpers/invoicing-bundle"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

test.describe("Invoicing: numbering invariant", () => {
  test("ten sequential issuances yield strictly monotonic, gapless numbers 1..10", async ({
    env,
    world,
    qa,
  }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)

    // Install with NO approval threshold so every issuance is direct (ungated).
    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      issuerOverrides: { invoice_approval_threshold_minor: null },
      additionalContacts: [
        {
          country: "FR",
          name: "Sequence Customer",
          email: "seq-s6@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const contactId = installed.additionalContactIds[0]

    const seqNumbers: number[] = []
    const numberStrings: string[] = []
    for (let i = 0; i < 10; i++) {
      const resp = await api(env.serverUrl, "/api/apps/invoicing/tools/invoice_create_and_issue", {
        method: "POST",
        token: qa.admin.token,
        body: {
          params: {
            counterparty: {
              contact_id: contactId,
              legal_name: "Sequence Customer",
              country: "FR",
              vat_id: null,
              address: "17 Rue du Faubourg Saint-Honore, 75008 Paris, France",
              email: "seq-s6@e2e.test",
            },
            issuer_profile_id: installed.primaryIssuerProfileId,
            currency: "EUR",
            incoterm: "DAP",
            items: [
              {
                position: 1,
                description: `Sequential item ${i + 1}`,
                quantity: "1",
                unit_price_minor: "1000",
                product_source: null,
                external_id: null,
              },
            ],
          },
        },
      })
      if (resp.status !== 200) {
        // eslint-disable-next-line no-console
        console.error(`[S6 issue ${i + 1}] non-200:`, resp.status, JSON.stringify(resp.body))
      }
      expect(resp.status).toBe(200)
      const payload = unwrap(resp.body)
      // Must issue directly (ungated) — a pending_approval here means the
      // null-threshold override didn't take and the sequence test is invalid.
      expect(payload.status).toBe("completed")
      const number = String(payload.number)
      expect(number).toMatch(/^INV-\d{4}-\d{4}$/)
      numberStrings.push(number)
      seqNumbers.push(Number(number.slice(-4)))
    }

    // Primary invariant (D2): strictly monotonic, gapless 1..10.
    expect(seqNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    // Cross-check via documents_search: ten issued invoices, all matching the
    // prefix pattern, all distinct.
    const searchResp = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_search", {
      method: "POST",
      token: qa.admin.token,
      body: { params: { type: "invoice" } },
    })
    expect(searchResp.status).toBe(200)
    const sp: unknown = unwrap(searchResp.body)
    const rawBody = searchResp.body as unknown
    const docs = (Array.isArray(sp) ? sp : Array.isArray(rawBody) ? rawBody : []) as Array<
      Record<string, unknown>
    >
    const issued = docs.filter((d) => d.status === "issued")
    expect(issued.length).toBe(10)
    for (const d of issued) {
      expect(String(d.number)).toMatch(/^INV-\d{4}-\d{4}$/)
    }
    const distinct = new Set(numberStrings)
    expect(distinct.size).toBe(10)
  })
})
