// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The customer identity tab: customer kind (four values with plain-word help), SIREN / SIRET
// validated as typed (every message names its field), a registry lookup that lists candidates
// and NEVER picks one, the registry name and city with a provenance line, and the territory
// decision for a buyer the classifier cannot place. A tab, never a modal.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CUSTOMER_KIND_OPTIONS } from "../einvoicing/blockers"
import {
  InvoicingIdentity,
  identitySetNote,
  identityTarget,
  lookupView,
  provenanceLine,
  sirenFieldError,
  siretFieldError,
  territoryNeeded,
} from "./IdentityEditor"

const source = readFileSync(join(import.meta.dir, "IdentityEditor.tsx"), "utf-8")

// Fictional, Luhn-valid.
const SIREN = "900000001"

function siretOf(siren: string): string {
  // Find a Luhn-valid 14-digit SIRET under this SIREN.
  for (let n = 0; n < 100000; n++) {
    const s = siren + String(n).padStart(5, "0")
    let sum = 0
    const rev = [...s].reverse()
    for (let i = 0; i < rev.length; i++) {
      let d = Number(rev[i])
      if (i % 2 === 1) {
        d *= 2
        if (d > 9) d -= 9
      }
      sum += d
    }
    if (sum % 10 === 0) return s
  }
  throw new Error("no siret")
}

describe("identity tab target", () => {
  it("is a contact id, or a draft that has no contact", () => {
    expect(identityTarget("c-1")).toEqual({ contact_id: "c-1" })
    expect(identityTarget("document:d-1")).toEqual({ document_id: "d-1" })
    expect(identityTarget(undefined)).toBeNull()
    expect(identityTarget("")).toBeNull()
  })
})

describe("SIREN / SIRET live validation", () => {
  it("accepts empty and valid numbers, spaces allowed", () => {
    expect(sirenFieldError("")).toBeNull()
    expect(sirenFieldError(SIREN)).toBeNull()
    expect(sirenFieldError("900 000 001")).toBeNull()
  })

  it("every message names the field", () => {
    expect(sirenFieldError("12345")).toBe("SIREN: 9 digits expected.")
    expect(sirenFieldError("900000002")).toBe("SIREN: this number fails its check digit.")
    expect(siretFieldError("123", SIREN)).toBe("SIRET: 14 digits expected.")
    const siret = siretOf(SIREN)
    expect(siretFieldError(siret, SIREN)).toBeNull()
    expect(siretFieldError(siret, "902000009")).toBe("SIRET: it must start with the SIREN.")
    const bad = `${SIREN}${String((Number(siret.slice(9)) + 1) % 100000).padStart(5, "0")}`
    expect(siretFieldError(bad, SIREN)).toBe("SIRET: this number fails its check digit.")
  })
})

describe("registry lookup", () => {
  const candidate = {
    siren: SIREN,
    siret: null,
    name: "ATELIER FICTIF",
    legal_name: "ATELIER FICTIF",
    status: "A",
    city: "Paris",
    postcode: "75001",
    active: true,
    name_match: true,
  }

  it("never picks a candidate, even when the registry returns only one", () => {
    const v = lookupView({ status: "ok", candidates: [candidate] })
    expect(v.candidates).toHaveLength(1)
    expect(v.selected).toBeNull()
    expect(v.message).toBeNull()
  })

  it("says plainly when the registry has nothing or cannot be reached", () => {
    expect(
      lookupView({ status: "registry_unconfirmed", reason: "no_result", message: "x" }).message,
    ).toBe("The registry returned no company for this search. Try another spelling or the SIREN.")
    expect(
      lookupView({ status: "registry_unconfirmed", reason: "unreachable", message: "x" }).message,
    ).toBe("The registry could not be reached. Try again in a moment.")
    expect(
      lookupView({
        status: "error",
        error: { code: "siren_invalid", message: "SIREN 1 fails the checksum." },
      }).message,
    ).toBe("SIREN 1 fails the checksum.")
  })
})

describe("saving", () => {
  it("a mismatch or an unconfirmed SIREN is never presented as recorded", () => {
    expect(identitySetNote({ status: "ok" })).toEqual({ text: "Saved.", isError: false })
    expect(identitySetNote({ status: "pending_approval", approval_id: "a" })).toEqual({
      text: "Sent for a person to confirm. Nothing is recorded until then.",
      isError: false,
    })
    expect(identitySetNote({ blocked: { approvalRequestId: "a" } })).toEqual({
      text: "Sent for a person to confirm. Nothing is recorded until then.",
      isError: false,
    })
    expect(
      identitySetNote({ status: "error", error: { code: "siren_invalid", message: "SIRET bad." } }),
    ).toEqual({
      text: "SIRET bad.",
      isError: true,
    })
  })

  it("a registry proposal is shown with the saved note", () => {
    expect(identitySetNote({ status: "ok", proposal: { note: "Public body." } }).text).toBe(
      "Saved. Public body.",
    )
  })
})

describe("what is shown", () => {
  it("the four customer kinds each carry plain-word help", () => {
    expect(CUSTOMER_KIND_OPTIONS.map((o) => o.value)).toEqual([
      "business",
      "individual",
      "public_entity",
      "non_registered_entity",
    ])
    for (const o of CUSTOMER_KIND_OPTIONS) expect(o.help.length).toBeGreaterThan(10)
  })

  it("provenance says where the SIREN came from and how it was confirmed", () => {
    expect(
      provenanceLine({
        source: "registry",
        confirmed_via: "auto",
        registry_checked_at: "2026-10-14T09:00:00Z",
      }),
    ).toBe("From the business registry, confirmed automatically, checked 2026-10-14.")
    expect(provenanceLine({ source: "manual", confirmed_via: "approval" })).toBe(
      "Typed by a person, confirmed by a person.",
    )
    expect(provenanceLine({ source: "vat_derived", confirmed_via: null })).toBe(
      "Read from the French VAT number, not confirmed yet.",
    )
    expect(provenanceLine(null)).toBeNull()
  })

  it("the territory decision appears only when the classifier needs one or one is recorded", () => {
    expect(territoryNeeded({ regime: "needs_review" }, null)).toBe(true)
    expect(territoryNeeded({ regime: "e_invoice" }, { territory_treatment: "as_fr" })).toBe(true)
    expect(territoryNeeded({ regime: "e_invoice" }, null)).toBe(false)
    expect(territoryNeeded(null, null)).toBe(false)
  })

  it("is a tab with testids, no modal", () => {
    expect(typeof InvoicingIdentity).toBe("function")
    expect(source).not.toMatch(/ConfirmDialog|role="dialog"/)
    for (const id of [
      "invoicing-identity",
      "identity-kind-",
      "identity-field-siren",
      "identity-field-siret",
      "identity-lookup-button",
      "identity-candidate-",
      "identity-save",
      "identity-provenance",
      "identity-registry-name",
    ]) {
      expect(source).toContain(id)
    }
    expect(source).toContain("counterparty_identity_lookup")
    expect(source).toContain("counterparty_identity_set")
    expect(source).toContain("counterparty_territory_set")
  })
})
