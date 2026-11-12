// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Counterparty identity tools against the in-memory db and the recorded registry answers.
// The registry decides: an agent- or human-supplied SIREN is written without approval only when
// the registry returns it active under the counterparty's own name; anything else (another
// company's SIREN, no result, an outage, overwriting a confirmed SIREN) asks a human first and
// writes nothing until then.
import { describe, expect, test } from "bun:test"
import { createMockDb, type MockDb } from "../test-db"
import {
  counterpartyIdentityGet,
  counterpartyIdentityLookup,
  counterpartyIdentitySet,
  counterpartyTerritorySet,
} from "./identity-tools"
import { REGISTRY_SEARCH_EMPTY, registryResponse, registryResultWith } from "./lookup.fixtures"
import { einvoicingSettingsSet } from "./settings-tool"
import { FICTIONAL_SIRENS } from "./test-fixtures"

const CONTACT = "00000000-0000-4000-8000-0000000c8001"
const OWN_SIREN = FICTIONAL_SIRENS[0] // the buyer's own company
const OTHER_SIREN = FICTIONAL_SIRENS[2] // another, unrelated company

const OWN = registryResultWith({
  siren: OWN_SIREN,
  nom_complet: "EXEMPLE INDUSTRIES",
  code_postal: "75002",
  libelle_commune: "PARIS",
})
const OTHER = registryResultWith({
  siren: OTHER_SIREN,
  nom_complet: "AUTRE ENTREPRISE FICTIVE",
  code_postal: "33000",
  libelle_commune: "BORDEAUX",
})

type Answer = { status: number; headers: Record<string, string>; body: string } | Error
type Emitted = { entity: string; action: string; entityId?: string; data?: Record<string, unknown> }
type ApprovalReq = {
  tool_name: string
  summary: string
  summary_detail?: { lines?: string[] }
  current_payload: unknown
}

function setup(
  opts: {
    answers?: Answer[]
    identity?: Record<string, unknown>
    documents?: Array<Record<string, unknown>>
    company?: string | null
    contactName?: string | null
    approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  } = {},
) {
  const db: MockDb = createMockDb({
    seed: {
      counterparty_identities: opts.identity
        ? [{ id: "idn-1", contact_id: CONTACT, ...opts.identity }]
        : [],
      documents: opts.documents ?? [],
    },
  })
  const answers = [...(opts.answers ?? [])]
  const fetchCalls: string[] = []
  const approvals: ApprovalReq[] = []
  const emitted: Emitted[] = []
  const ctx = {
    db,
    fetch: async (url: string) => {
      fetchCalls.push(url)
      const next = answers.shift()
      if (!next) throw new Error("unexpected registry call")
      if (next instanceof Error) throw next
      return next
    },
    executeTool: async (name: string) => {
      if (name !== "kernel:contacts_read") return { status: "error", error: { code: "unexpected" } }
      return {
        status: "completed",
        result: {
          contact: {
            id: CONTACT,
            name: opts.contactName === undefined ? "Celine Exemple" : opts.contactName,
            company: opts.company === undefined ? "Exemple Industries SAS" : opts.company,
          },
        },
      }
    },
    approval: opts.approval ?? null,
    requestApproval: async (input: ApprovalReq) => {
      approvals.push(input)
      return { approval_id: `appr-${approvals.length}` }
    },
    emit: async (e: Emitted) => {
      emitted.push(e)
    },
    getUserId: async () => "user-1",
  }
  const identities = () => db.__all("counterparty_identities")
  return { ctx: ctx as never, db, fetchCalls, approvals, emitted, identities }
}

describe("counterparty_identity_set — registry-confirmed writes (S4b)", () => {
  test("agent_web SIREN, active, name matches -> ungated, confirmed_via auto", async () => {
    const s = setup({ answers: [registryResponse([OWN])] })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OWN_SIREN,
      source: "agent_web",
      source_url: "https://annuaire.example/x",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(s.approvals).toHaveLength(0)
    const rows = s.identities()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      contact_id: CONTACT,
      siren: OWN_SIREN,
      customer_kind: "business",
      source: "agent_web",
      source_url: "https://annuaire.example/x",
      confirmed_via: "auto",
      registry_name: "EXEMPLE INDUSTRIES",
      registry_status: "A",
      registry_postcode: "75002",
      registry_city: "PARIS",
    })
    expect(rows[0]!.changed_at).toBeTruthy()
    expect(s.fetchCalls[0]).toContain(`q=${OWN_SIREN}`)
    // The buyer's identity attention item closes.
    expect(s.emitted).toContainEqual(
      expect.objectContaining({
        entity: "einvoicing",
        action: "identity_missing",
        entityId: CONTACT,
        data: expect.objectContaining({ resolved: true }),
      }),
    )
  })

  test("a registry-confirmed SIREN without a source_url keeps the registry answer it was confirmed by", async () => {
    // red: source_url stays null -> a SIREN picked from the registry carries no provenance link.
    const s = setup({ answers: [registryResponse([OWN])] })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OWN_SIREN,
      source: "registry",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    const row = s.identities()[0]!
    expect(row).toMatchObject({ source: "registry", confirmed_via: "auto" })
    expect(row.source_url).toBe(s.fetchCalls[0]!)
    expect(String(row.source_url)).toStartWith(
      `https://recherche-entreprises.api.gouv.fr/search?q=${OWN_SIREN}`,
    )
  })

  test("another company's valid, active SIREN -> pending_approval with a mismatch flag, no row", async () => {
    const s = setup({ answers: [registryResponse([OTHER])] })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OTHER_SIREN,
      source: "agent_web",
      source_url: "https://web.example/page",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect(r.approval_id).toBe("appr-1")
    expect((r.flags as Record<string, unknown>).name_mismatch).toBe(true)
    expect(s.identities()).toHaveLength(0)
    expect(s.approvals).toHaveLength(1)
    const card = s.approvals[0]!
    expect(card.tool_name).toBe("invoicing:counterparty_identity_set")
    const lines = card.summary_detail?.lines?.join("\n") ?? ""
    expect(lines).toContain("Exemple Industries SAS")
    expect(lines).toContain("AUTRE ENTREPRISE FICTIVE")
    expect(lines).toContain(OTHER_SIREN)
    expect(lines).toContain("BORDEAUX")
    expect(lines).toContain("https://web.example/page")
    expect(lines.toLowerCase()).toContain("does not match")
    expect(s.emitted).toHaveLength(0)
  })

  test("0 results -> gated", async () => {
    const s = setup({ answers: [registryResponse(REGISTRY_SEARCH_EMPTY.results)] })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OWN_SIREN,
      source: "manual",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect((r.flags as Record<string, unknown>).registry).toBe("no_result")
    expect(s.identities()).toHaveLength(0)
  })

  test("registry outage -> gated", async () => {
    const s = setup({ answers: [new Error("ECONNREFUSED")] })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OWN_SIREN,
      source: "manual",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect((r.flags as Record<string, unknown>).registry).toBe("unreachable")
    expect(s.identities()).toHaveLength(0)
  })

  test("overwriting a confirmed, different SIREN -> gated even on a name match", async () => {
    const s = setup({
      identity: {
        customer_kind: "business",
        siren: OTHER_SIREN,
        source: "registry",
        confirmed_via: "auto",
        changed_at: new Date("2026-10-01T00:00:00Z"),
      },
      answers: [registryResponse([OWN])],
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OWN_SIREN,
      source: "registry",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect((r.flags as Record<string, unknown>).overwrites_confirmed_siren).toBe(true)
    expect(s.identities()[0]!.siren).toBe(OTHER_SIREN)
  })

  test("a ceased SIREN -> gated", async () => {
    const ceased = registryResultWith({
      siren: OWN_SIREN,
      nom_complet: "EXEMPLE INDUSTRIES",
      etat_administratif: "C",
    })
    const s = setup({ answers: [registryResponse([ceased])] })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OWN_SIREN,
      source: "registry",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect((r.flags as Record<string, unknown>).ceased).toBe(true)
  })

  test("approved re-entry writes the SIREN with confirmed_via approval", async () => {
    const s = setup({
      answers: [registryResponse([OTHER])],
      approval: {
        approvalRequestId: "appr-9",
        approvalDeciderId: "user-2",
        toolName: "invoicing:counterparty_identity_set",
      },
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OTHER_SIREN,
      source: "agent_web",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(s.approvals).toHaveLength(0)
    expect(s.identities()[0]).toMatchObject({
      siren: OTHER_SIREN,
      confirmed_via: "approval",
      approval_request_id: "appr-9",
      verified_by: "user-2",
      registry_name: "AUTRE ENTREPRISE FICTIVE",
    })
  })

  test("invalid Luhn -> siren_invalid, nothing written, no registry call", async () => {
    const s = setup()
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: "900000002",
      source: "manual",
    })) as {
      status: string
      error: { code: string }
    }
    expect(r.status).toBe("error")
    expect(r.error.code).toBe("siren_invalid")
    expect(s.fetchCalls).toHaveLength(0)
    expect(s.identities()).toHaveLength(0)
  })

  test("a SIRET of another SIREN -> siren_invalid", async () => {
    const s = setup()
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OWN_SIREN,
      siret: "90200000900032",
      source: "manual",
    })) as { status: string; error: { code: string } }
    expect(r.error.code).toBe("siren_invalid")
  })

  test("kind-only write is ungated, calls no registry, bumps changed_at", async () => {
    const old = new Date("2026-01-01T00:00:00Z")
    // A person (no company): recording them as an individual is a plain fact, written at once.
    const s = setup({
      identity: { customer_kind: null, source: "derived", changed_at: old },
      company: null,
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      customer_kind: "individual",
      source: "manual",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(s.fetchCalls).toHaveLength(0)
    expect(s.approvals).toHaveLength(0)
    const row = s.identities()[0]!
    expect(row.customer_kind).toBe("individual")
    expect(new Date(String(row.changed_at)).getTime()).toBeGreaterThan(old.getTime())
  })

  test("a company recorded as not a business asks a person first: nothing is written", async () => {
    // red: written at once -> an agent stuck on a missing SIREN re-labelled a French company as a
    // non-registered entity and issued its invoice outside e-invoicing.
    for (const kind of ["individual", "non_registered_entity"]) {
      const s = setup()
      const r = (await counterpartyIdentitySet(s.ctx, {
        contact_id: CONTACT,
        customer_kind: kind,
        source: "manual",
      })) as Record<string, unknown>
      expect(r.status).toBe("pending_approval")
      expect(s.identities()).toHaveLength(0)
      expect(s.approvals).toHaveLength(1)
      const lines = s.approvals[0]!.summary_detail?.lines?.join("\n") ?? ""
      expect(lines).toContain("Exemple Industries SAS")
      expect(lines).toContain(kind)
    }
  })

  test("a recorded business changed to another kind asks a person, even with no company on the contact", async () => {
    const s = setup({
      identity: {
        customer_kind: "business",
        source: "manual",
        changed_at: new Date("2026-01-01T00:00:00Z"),
      },
      company: null,
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      customer_kind: "non_registered_entity",
      source: "manual",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect(s.identities()[0]!.customer_kind).toBe("business")
  })

  test("approved, the kind change of a company is written", async () => {
    const s = setup({
      approval: {
        approvalRequestId: "appr-5",
        approvalDeciderId: "user-2",
        toolName: "invoicing:counterparty_identity_set",
      },
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      customer_kind: "individual",
      source: "manual",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(s.identities()[0]!.customer_kind).toBe("individual")
  })

  test("nature_juridique 7xxx proposes public_entity (never sets it)", async () => {
    const pub = registryResultWith({
      siren: OWN_SIREN,
      nom_complet: "EXEMPLE INDUSTRIES",
      nature_juridique: "7210",
    })
    const s = setup({ answers: [registryResponse([pub])] })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OWN_SIREN,
      source: "registry",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(r.proposal).toMatchObject({ customer_kind: "public_entity" })
    expect(s.identities()[0]!.customer_kind).toBe("business")
  })

  test("a contactless issued document is never rewritten: link it to a contact first", async () => {
    const s = setup({
      documents: [
        {
          id: "doc-1",
          type: "invoice",
          status: "issued",
          number: "INV-1",
          counterparty_contact_id: null,
          counterparty_name: "Exemple Industries SAS",
        },
      ],
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      document_id: "doc-1",
      customer_kind: "business",
      source: "manual",
    })) as {
      status: string
      error: { code: string; message: string }
    }
    expect(r.error.code).toBe("document_not_editable")
    expect(r.error.message).toContain("documents_update")
  })

  test("a contactless draft never confirms its own name: a SIREN on it always asks a human", async () => {
    // The draft's name is whatever its creator typed (drafts_create is ungated): matching the
    // registry against it would let anyone confirm any company's SIREN in two calls.
    const s = setup({
      answers: [registryResponse([OWN])],
      documents: [
        {
          id: "doc-2",
          type: "invoice",
          status: "draft",
          counterparty_contact_id: null,
          counterparty_name: "Exemple Industries SAS",
        },
      ],
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      document_id: "doc-2",
      siren: OWN_SIREN,
      source: "registry",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect((r.flags as Record<string, unknown>).name_mismatch).toBe(true)
    const doc = s.db.__all("documents")[0]!
    expect(doc.buyer_siren ?? null).toBeNull()
  })

  test("approved re-entry on a contactless draft records the SIREN on its snapshot", async () => {
    const s = setup({
      answers: [registryResponse([OWN])],
      documents: [
        {
          id: "doc-2",
          type: "invoice",
          status: "draft",
          counterparty_contact_id: null,
          counterparty_name: "Exemple Industries SAS",
        },
      ],
      approval: {
        approvalRequestId: "appr-7",
        approvalDeciderId: "user-2",
        toolName: "invoicing:counterparty_identity_set",
      },
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      document_id: "doc-2",
      siren: OWN_SIREN,
      source: "registry",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(s.db.__all("documents")[0]).toMatchObject({
      buyer_siren: OWN_SIREN,
      customer_kind: "business",
      buyer_siren_confirmed_via: "approval",
    })
    expect(s.identities()).toHaveLength(0)
  })
})

describe("counterparty_identity_set — what the registry name is matched against (SK4)", () => {
  // red: match against a draft's name -> an agent creates a draft for the contact named after the
  // target company, then confirms that company's SIREN on the contact without any approval.
  test("a draft's counterparty name never confirms a SIREN", async () => {
    const s = setup({
      company: null,
      contactName: null,
      answers: [registryResponse([OTHER])],
      documents: [
        {
          id: "d-draft",
          type: "invoice",
          status: "draft",
          counterparty_contact_id: CONTACT,
          counterparty_name: "Autre Entreprise Fictive SAS",
        },
      ],
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OTHER_SIREN,
      source: "agent_web",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect(s.identities()).toHaveLength(0)
  })

  test("nor does an issued quote's (only issued invoices count)", async () => {
    const s = setup({
      company: null,
      contactName: null,
      answers: [registryResponse([OTHER])],
      documents: [
        {
          id: "d-quote",
          type: "quote",
          status: "issued",
          number: "QUO-1",
          counterparty_contact_id: CONTACT,
          counterparty_name: "Autre Entreprise Fictive SAS",
        },
      ],
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OTHER_SIREN,
      source: "agent_web",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
  })

  test("an issued invoice's counterparty name does confirm", async () => {
    const s = setup({
      company: null,
      contactName: null,
      answers: [registryResponse([OWN])],
      documents: [
        {
          id: "d-inv",
          type: "invoice",
          status: "issued",
          number: "INV-1",
          counterparty_contact_id: CONTACT,
          counterparty_name: "Exemple Industries SAS",
        },
      ],
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OWN_SIREN,
      source: "registry",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
  })

  // red: keep the contact's personal name as a target -> a homonym company (a sole trader named like
  // the person) is confirmed for a contact that is a company.
  test("a contact with a company: the person's name is not a match target", async () => {
    const homonym = registryResultWith({ siren: OTHER_SIREN, nom_complet: "CELINE EXEMPLE" })
    const s = setup({
      company: "Exemple Industries SAS",
      contactName: "Celine Exemple",
      answers: [registryResponse([homonym])],
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OTHER_SIREN,
      source: "agent_web",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect(s.identities()).toHaveLength(0)
  })

  test("a contact with a VAT id: the person's name is not a match target either", async () => {
    const homonym = registryResultWith({ siren: OTHER_SIREN, nom_complet: "CELINE EXEMPLE" })
    const s = setup({
      company: null,
      contactName: "Celine Exemple",
      identity: { customer_kind: "business", vat_id: "FR60902000009", source: "derived" },
      answers: [registryResponse([homonym])],
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OTHER_SIREN,
      source: "agent_web",
    })) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
  })

  test("a confirmed_via smuggled into the call is ignored: the registry still decides", async () => {
    const s = setup({ answers: [registryResponse([OTHER])] })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OTHER_SIREN,
      source: "agent_web",
      confirmed_via: "approval",
    } as never)) as Record<string, unknown>
    expect(r.status).toBe("pending_approval")
    expect(s.identities()).toHaveLength(0)
  })

  test("a contact with neither (a sole trader): its name is the target", async () => {
    const trader = registryResultWith({ siren: OTHER_SIREN, nom_complet: "CELINE EXEMPLE" })
    const s = setup({
      company: null,
      contactName: "Celine Exemple",
      answers: [registryResponse([trader])],
    })
    const r = (await counterpartyIdentitySet(s.ctx, {
      contact_id: CONTACT,
      siren: OTHER_SIREN,
      source: "registry",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
  })
})

describe("counterparty_identity_lookup", () => {
  test("FR VAT derivation first: searches by the derived SIREN, flags the name match, picks none", async () => {
    const s = setup({
      identity: { customer_kind: "business", vat_id: "FR60902000009", source: "derived" },
      answers: [
        registryResponse([
          registryResultWith({ siren: "902000009", nom_complet: "EXEMPLE INDUSTRIES" }),
        ]),
      ],
    })
    const r = (await counterpartyIdentityLookup(s.ctx, { contact_id: CONTACT })) as Record<
      string,
      unknown
    >
    expect(r.status).toBe("ok")
    expect(r.derived_siren).toBe("902000009")
    expect(s.fetchCalls[0]).toContain("q=902000009")
    const cands = r.candidates as Array<Record<string, unknown>>
    expect(cands[0]).toMatchObject({ siren: "902000009", name_match: true, active: true })
    expect(r.picked).toBeUndefined()
    expect(s.identities()[0]!.siren ?? null).toBeNull()
  })

  test("a Monaco VAT id never derives a SIREN", async () => {
    const s = setup({
      identity: { customer_kind: "business", vat_id: "FR60902000009", source: "derived" },
      documents: [
        {
          id: "d-mc",
          type: "invoice",
          status: "issued",
          counterparty_contact_id: CONTACT,
          counterparty_name: "Exemple Industries SAS",
          billing_country_code: "MC",
          counterparty_country: "MC",
        },
      ],
      answers: [registryResponse([])],
    })
    const r = (await counterpartyIdentityLookup(s.ctx, { contact_id: CONTACT })) as Record<
      string,
      unknown
    >
    expect(r.derived_siren ?? null).toBeNull()
    expect(s.fetchCalls[0]).not.toContain("902000009")
  })

  test("an invalid SIREN query -> siren_invalid", async () => {
    const s = setup()
    const r = (await counterpartyIdentityLookup(s.ctx, { siren: "123456789" })) as {
      error: { code: string }
    }
    expect(r.error.code).toBe("siren_invalid")
  })

  test("a mistyped query for a known contact falls back to the names the contact is recorded under", async () => {
    // red: only the caller's text was searched -> one typo in the company name and the agent
    // concluded the registry did not know the buyer.
    const s = setup({
      answers: [registryResponse(REGISTRY_SEARCH_EMPTY.results), registryResponse([OWN])],
    })
    const r = (await counterpartyIdentityLookup(s.ctx, {
      contact_id: CONTACT,
      query: "Exemple Indutsries",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(s.fetchCalls).toHaveLength(2)
    expect(s.fetchCalls[1]).toContain(encodeURIComponent("Exemple Industries SAS"))
    const c = (r.candidates as Array<Record<string, unknown>>)[0]!
    expect(c).toMatchObject({ siren: OWN_SIREN, name_match: true })
    expect(r.query).toBe("Exemple Industries SAS")
  })

  test("no registry result names the next step: the web as a pointer, never a changed kind or an invented SIREN", async () => {
    // red: the message only said "try another spelling" -> agents never searched the web, then
    // invented a SIREN or re-labelled the buyer.
    // Both the caller's text and the contact's recorded name find nothing.
    const s = setup({
      answers: [
        registryResponse(REGISTRY_SEARCH_EMPTY.results),
        registryResponse(REGISTRY_SEARCH_EMPTY.results),
      ],
    })
    const r = (await counterpartyIdentityLookup(s.ctx, {
      contact_id: CONTACT,
      query: "Exemple Industries",
    })) as Record<string, unknown>
    expect(r.status).toBe("registry_unconfirmed")
    const m = String(r.message)
    for (const w of [
      "web_search",
      "web_fetch",
      "counterparty_identity_set",
      "agent_web",
      "source_url",
    ])
      expect(m).toContain(w)
    expect(m).toMatch(/never invent a SIREN/i)
    expect(m).toMatch(/customer_kind/)
  })

  test("registry unreachable is reported, not an error", async () => {
    const s = setup({ answers: [new Error("down")] })
    const r = (await counterpartyIdentityLookup(s.ctx, { query: "exemple" })) as Record<
      string,
      unknown
    >
    expect(r).toMatchObject({ status: "registry_unconfirmed", reason: "unreachable" })
  })
})

describe("counterparty_identity_get", () => {
  test("by contact returns the row and whether its SIREN is confirmed", async () => {
    const s = setup({
      identity: {
        customer_kind: "business",
        siren: OWN_SIREN,
        confirmed_via: "auto",
        source: "registry",
      },
    })
    const r = (await counterpartyIdentityGet(s.ctx, { contact_id: CONTACT })) as Record<
      string,
      unknown
    >
    expect(r).toMatchObject({ status: "ok", target: "contact", confirmed: true })
    expect((r.identity as Record<string, unknown>).siren).toBe(OWN_SIREN)
    // red: no pointer -> an agent answered "can I e-invoice them?" from the stored row alone.
    expect(String(r.next_step)).toContain("einvoicing_classify")
    // The editor heads the tab with the customer's name.
    expect(typeof r.counterparty_name).toBe("string")
    expect(String(r.counterparty_name).length).toBeGreaterThan(0)
  })

  test("by contactless document returns its snapshot", async () => {
    const s = setup({
      documents: [
        {
          id: "doc-3",
          type: "invoice",
          status: "issued",
          counterparty_contact_id: null,
          counterparty_name: "Studio Fictif",
          customer_kind: "business",
          buyer_siren: OWN_SIREN,
          billing_postcode: "75002",
        },
      ],
    })
    const r = (await counterpartyIdentityGet(s.ctx, { document_id: "doc-3" })) as Record<
      string,
      unknown
    >
    expect(r).toMatchObject({ status: "ok", target: "document", confirmed: false })
    expect((r.snapshot as Record<string, unknown>).buyer_siren).toBe(OWN_SIREN)
    expect(r.counterparty_name).toBe("Studio Fictif")
  })
})

describe("counterparty_territory_set / einvoicing_settings_set", () => {
  test("territory treatment is recorded with its reason and bumps changed_at", async () => {
    const s = setup()
    const r = (await counterpartyTerritorySet(s.ctx, {
      contact_id: CONTACT,
      treatment: "as_foreign",
      reason: "Established outside the VAT territory",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(s.identities()[0]).toMatchObject({
      territory_treatment: "as_foreign",
      territory_reason: "Established outside the VAT territory",
      source: "manual",
    })
    expect(s.identities()[0]!.changed_at).toBeTruthy()
  })

  test("settings: gate mode set by the tool, invalid date refused", async () => {
    const s = setup()
    const bad = (await einvoicingSettingsSet(s.ctx, { cibs_switch_date: "next year" })) as {
      error: { code: string }
    }
    expect(bad.error.code).toBe("invalid_input")
    const r = (await einvoicingSettingsSet(s.ctx, {
      gate_mode: "warn",
      cibs_switch_date: "2027-01-01",
    })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(s.db.__all("einvoicing_settings")[0]).toMatchObject({
      gate_mode: "warn",
      gate_mode_source: "tool",
      cibs_switch_date: "2027-01-01",
      changed_by: "user-1",
    })
    await einvoicingSettingsSet(s.ctx, { gate_mode: "enforce" })
    expect(s.db.__all("einvoicing_settings")).toHaveLength(1)
    expect(s.db.__all("einvoicing_settings")[0]!.gate_mode).toBe("enforce")
  })
})
