// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The customer identity tab, rendered. A registry lookup lists its candidates and records
// nothing: no candidate is pre-selected and no identity write is sent, whether the registry
// returns one company or several. Only a click on "This is the customer" records one, and it
// records exactly the candidate clicked.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
let lookupAnswer: unknown = null

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: () => {},
  app: {
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      calls.push({ tool, params })
      if (tool === "counterparty_identity_get") return { status: "ok", target: "contact", contact_id: "c-1", identity: null, confirmed: false }
      if (tool === "einvoicing_classify") return { status: "ok", regime: null, reasons: [], would_refuse: null }
      if (tool === "counterparty_identity_lookup") return lookupAnswer
      if (tool === "counterparty_identity_set") return { status: "ok", target: "contact", contact_id: "c-1", identity: {}, confirmed_via: "auto" }
      return { status: "ok" }
    },
  },
}))

const { InvoicingIdentity } = await import("./IdentityEditor")

function candidate(siren: string, name: string) {
  return {
    siren,
    siret: `${siren}00011`,
    name,
    legal_name: name,
    sigle: null,
    enseignes: [],
    status: "A",
    nature_juridique: "5710",
    line1: "1 RUE DE L'EXEMPLE",
    postcode: "75002",
    city: "PARIS",
    country_code: "FR",
    active: true,
    name_match: true,
    postcode_match: null,
  }
}

const writes = () => calls.filter((c) => c.tool === "counterparty_identity_set")

async function runLookup() {
  render(() => <InvoicingIdentity entityId="c-1" />)
  const button = await screen.findByTestId("identity-lookup-button")
  fireEvent.click(button)
}

beforeEach(() => {
  calls.length = 0
})
afterEach(() => cleanup())

describe("identity tab lookup (rendered)", () => {
  it("lists several candidates and records none of them", async () => {
    lookupAnswer = {
      status: "ok",
      query: "exemple",
      candidates: [candidate("900000001", "EXEMPLE INDUSTRIES"), candidate("903000008", "EXEMPLE INDUSTRIES NORD")],
    }
    await runLookup()
    await screen.findByTestId("identity-candidate-900000001")
    expect(screen.getByTestId("identity-candidate-903000008")).toBeTruthy()
    // Give any stray effect a chance to fire before asserting nothing was written.
    await new Promise((r) => setTimeout(r, 50))
    expect(writes()).toHaveLength(0)
    expect(document.querySelector("[aria-selected='true'], [aria-checked='true'], [data-selected='true']")).toBeNull()
  })

  it("a single candidate is not picked either", async () => {
    lookupAnswer = { status: "ok", query: "exemple", candidates: [candidate("900000001", "EXEMPLE INDUSTRIES")] }
    await runLookup()
    await screen.findByTestId("identity-candidate-900000001")
    await new Promise((r) => setTimeout(r, 50))
    expect(writes()).toHaveLength(0)
  })

  it("only the clicked candidate is recorded", async () => {
    lookupAnswer = {
      status: "ok",
      query: "exemple",
      candidates: [candidate("900000001", "EXEMPLE INDUSTRIES"), candidate("903000008", "EXEMPLE INDUSTRIES NORD")],
    }
    await runLookup()
    fireEvent.click(await screen.findByTestId("identity-candidate-pick-903000008"))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]!.params).toMatchObject({ contact_id: "c-1", siren: "903000008", source: "registry" })
  })
})
