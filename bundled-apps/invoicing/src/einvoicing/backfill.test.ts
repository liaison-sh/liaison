// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Identity backfill and the identity-confirm job against the in-memory db and recorded registry
// answers. A dry run writes nothing; a second run writes nothing new; a SIREN read off a French
// VAT id is written only when the registry returns exactly that company, active, under the
// counterparty's own name; identities recorded by a person or a registry check are never touched.
import { describe, expect, test } from "bun:test"
import { retryEligible } from "../deferred"
import { createMockDb } from "../test-db"
import { backfillIdentities, identityConfirmJob, parseBillingBlob } from "./backfill"
import { registryResponse, registryResultWith } from "./lookup.fixtures"
import { FICTIONAL_SIRENS } from "./test-fixtures"

const ISSUER = "00000000-0000-4000-8000-0000000b0001"
const C_DE = "00000000-0000-4000-8000-0000000b0011" // a consumer in Germany
const C_VAT = "00000000-0000-4000-8000-0000000b0012" // a French company with a French VAT id
const C_NOVAT = "00000000-0000-4000-8000-0000000b0013" // a French company, no VAT id
const C_HUMAN = "00000000-0000-4000-8000-0000000b0014" // identity recorded by a person
const C_MISMATCH = "00000000-0000-4000-8000-0000000b0015" // VAT id of another company

const VAT_SIREN = FICTIONAL_SIRENS[0] // 900000001
const MISMATCH_SIREN = FICTIONAL_SIRENS[2] // 903000008

function frVat(siren: string): string {
  const key = (12 + 3 * (Number(siren) % 97)) % 97
  return `FR${String(key).padStart(2, "0")}${siren}`
}

const VAT_HIT = registryResultWith({
  siren: VAT_SIREN,
  nom_complet: "EXEMPLE INDUSTRIES",
  code_postal: "75002",
  libelle_commune: "PARIS",
})
const MISMATCH_HIT = registryResultWith({
  siren: MISMATCH_SIREN,
  nom_complet: "AUTRE ENTREPRISE FICTIVE",
  code_postal: "33000",
  libelle_commune: "BORDEAUX",
})

function doc(over: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "invoice",
    status: "issued",
    issuer_profile_id: ISSUER,
    currency: "EUR",
    issued_at: "2026-09-01T00:00:00Z",
    external_refs: {},
    lifecycle_log: [],
    ...over,
  }
}

function seed() {
  return {
    issuer_profiles: [
      {
        id: ISSUER,
        legal_name: "Emetteur Fictif SAS",
        country: "FR",
        vat_id: "FR68900000001",
        tax_registration_id: "90000000100017",
        siren: null,
        siret: null,
      },
    ],
    documents: [
      doc({
        id: "00000000-0000-4000-8000-0000000d0001",
        counterparty_contact_id: C_DE,
        counterparty_name: "Joel Beispiel",
        counterparty_country: "DE",
        counterparty_address: "Musterstrasse 1\n10115 Berlin",
      }),
      doc({
        id: "00000000-0000-4000-8000-0000000d0002",
        counterparty_contact_id: C_VAT,
        counterparty_name: "Exemple Industries SAS",
        counterparty_vat_id: frVat(VAT_SIREN),
        counterparty_country: "FR",
        counterparty_address: "1 rue de l'Exemple\n75002 Paris",
      }),
      doc({
        id: "00000000-0000-4000-8000-0000000d0003",
        counterparty_contact_id: C_NOVAT,
        counterparty_name: "Studio Imaginaire",
        counterparty_country: "FR",
        counterparty_address: "3 place du Test\n69002 Lyon\nFrance",
      }),
      doc({
        id: "00000000-0000-4000-8000-0000000d0004",
        counterparty_contact_id: C_HUMAN,
        counterparty_name: "Studio Fictif",
        counterparty_vat_id: frVat(MISMATCH_SIREN),
        counterparty_country: "FR",
        counterparty_address: "Adresse sans code",
      }),
      doc({
        id: "00000000-0000-4000-8000-0000000d0005",
        counterparty_contact_id: C_MISMATCH,
        counterparty_name: "Maison Inventee",
        counterparty_vat_id: frVat(MISMATCH_SIREN),
        counterparty_country: "FR",
        counterparty_address: "5 rue du Faux\n13001 Marseille",
      }),
      // A contactless document is no counterparty the backfill can record.
      doc({
        id: "00000000-0000-4000-8000-0000000d0006",
        counterparty_contact_id: null,
        counterparty_name: "Sans Contact",
        counterparty_country: "FR",
      }),
    ],
    counterparty_identities: [
      {
        id: "idn-human",
        contact_id: C_HUMAN,
        customer_kind: "business",
        siren: null,
        source: "manual",
        notes: "set by a person",
        changed_at: new Date("2026-09-01T00:00:00Z"),
      },
    ],
  }
}

/** Registry fake answering by the searched SIREN from recorded, anonymised results. */
function registry(results: Record<string, Record<string, unknown>>) {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    const q = new URL(url).searchParams.get("q") ?? ""
    const hit = results[q]
    return registryResponse(hit ? [hit] : [])
  }
  return { fetch, calls }
}

function setup(
  results: Record<string, Record<string, unknown>> = {
    [VAT_SIREN]: VAT_HIT,
    [MISMATCH_SIREN]: MISMATCH_HIT,
  },
) {
  const db = createMockDb({ seed: seed() })
  const reg = registry(results)
  const companies: Record<string, string> = {
    [C_NOVAT]: "Studio Imaginaire",
    [C_VAT]: "Exemple Industries",
  }
  const ctx = {
    db,
    fetch: reg.fetch,
    executeTool: async (name: string, params: Record<string, unknown>) => {
      if (name !== "kernel:contacts_read") return { status: "error", error: { code: "unexpected" } }
      const id = String(params.contactId)
      return {
        status: "completed",
        result: { contact: { id, name: null, company: companies[id] ?? null } },
      }
    },
  }
  return { ctx: ctx as never, db, reg }
}

const byContact = (db: ReturnType<typeof createMockDb>, id: string) =>
  db.__all("counterparty_identities").find((r) => r.contact_id === id)

describe("parseBillingBlob", () => {
  test("last line 'postcode city', with an optional country line after it", () => {
    expect(parseBillingBlob("1 rue de l'Exemple\n75002 Paris")).toEqual({
      line1: "1 rue de l'Exemple",
      postcode: "75002",
      city: "Paris",
    })
    expect(parseBillingBlob("3 place du Test\n69002 Lyon\nFrance")).toEqual({
      line1: "3 place du Test",
      postcode: "69002",
      city: "Lyon",
    })
    expect(parseBillingBlob("1 rue Test, 75001 Paris")).toEqual({
      line1: "1 rue Test",
      postcode: "75001",
      city: "Paris",
    })
  })
  test("no postcode -> null (left for the readiness list)", () => {
    expect(parseBillingBlob("Adresse sans code")).toBeNull()
    expect(parseBillingBlob(null)).toBeNull()
  })
})

describe("einvoicing_backfill_identities", () => {
  test("dry run writes nothing and reports what it would write", async () => {
    const s = setup()
    const before = JSON.stringify({
      i: s.db.__all("counterparty_identities"),
      d: s.db.__all("documents"),
      p: s.db.__all("issuer_profiles"),
    })
    const r = (await backfillIdentities(s.ctx, { dry_run: true })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(r.dry_run).toBe(true)
    expect(r.scanned).toBe(5)
    expect(r.would_write).toBeGreaterThan(0)
    expect(r).not.toHaveProperty("written")
    expect(r.next_cursor).toBeNull()
    expect(typeof r.readiness_count).toBe("number")
    expect(
      JSON.stringify({
        i: s.db.__all("counterparty_identities"),
        d: s.db.__all("documents"),
        p: s.db.__all("issuer_profiles"),
      }),
    ).toBe(before)
  })

  test("real run: every contact gets a kind; the VAT one is registry-confirmed; billing filled from the blob", async () => {
    const s = setup()
    const r = (await backfillIdentities(s.ctx, { dry_run: false })) as Record<string, unknown>
    expect(r.status).toBe("ok")
    expect(r.written).toBeGreaterThan(0)
    expect(byContact(s.db, C_DE)).toMatchObject({
      customer_kind: "individual",
      source: "derived",
      siren: null,
    })
    expect(byContact(s.db, C_VAT)).toMatchObject({
      customer_kind: "business",
      siren: VAT_SIREN,
      source: "vat_derived",
      confirmed_via: "auto",
      registry_name: "EXEMPLE INDUSTRIES",
      registry_status: "A",
      registry_city: "PARIS",
    })
    expect(byContact(s.db, C_VAT)!.changed_at).toBeTruthy()
    expect(byContact(s.db, C_NOVAT)).toMatchObject({
      customer_kind: "business",
      siren: null,
      source: "derived",
    })
    const d2 = s.db.__all("documents").find((d) => d.id === "00000000-0000-4000-8000-0000000d0002")!
    expect(d2).toMatchObject({
      billing_line1: "1 rue de l'Exemple",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
    })
    const d3 = s.db.__all("documents").find((d) => d.id === "00000000-0000-4000-8000-0000000d0003")!
    expect(d3).toMatchObject({
      billing_postcode: "69002",
      billing_city: "Lyon",
      billing_country_code: "FR",
    })
    // A consumer's documents are not touched.
    const d1 = s.db.__all("documents").find((d) => d.id === "00000000-0000-4000-8000-0000000d0001")!
    expect(d1.billing_postcode).toBeUndefined()
  })

  test("a registry mismatch is never written; the counterparty stays on the readiness list", async () => {
    const s = setup()
    const r = (await backfillIdentities(s.ctx, { dry_run: false })) as Record<string, unknown>
    const row = byContact(s.db, C_MISMATCH)
    expect(row).toMatchObject({ customer_kind: "business", source: "derived" })
    expect(row!.siren ?? null).toBeNull()
    expect(row!.confirmed_via ?? null).toBeNull()
    expect((r.counts as Record<string, number>).unconfirmed).toBeGreaterThanOrEqual(1)
    expect(r.readiness_count).toBeGreaterThanOrEqual(2) // C_NOVAT + C_MISMATCH at least
  })

  // red: drop the active check in confirmSiren -> a ceased company's SIREN is auto-confirmed.
  test("a ceased SIREN is never confirmed, even under the counterparty's own name", async () => {
    const ceased = registryResultWith({
      siren: VAT_SIREN,
      nom_complet: "EXEMPLE INDUSTRIES",
      etat_administratif: "C",
    })
    const s = setup({ [VAT_SIREN]: ceased, [MISMATCH_SIREN]: MISMATCH_HIT })
    await backfillIdentities(s.ctx, { dry_run: false })
    const row = byContact(s.db, C_VAT)
    expect(row).toMatchObject({ customer_kind: "business" })
    expect(row!.confirmed_via ?? null).toBeNull()
    expect(row!.registry_status ?? null).not.toBe("A")
  })

  test("never overwrites an identity a person recorded", async () => {
    const s = setup()
    const before = { ...byContact(s.db, C_HUMAN)! }
    await backfillIdentities(s.ctx, { dry_run: false })
    expect(byContact(s.db, C_HUMAN)).toEqual(before)
    // No registry call for it: its VAT SIREN belongs to the mismatching company, looked up once for C_MISMATCH only.
    expect(s.reg.calls.filter((u) => u.includes(`q=${MISMATCH_SIREN}`))).toHaveLength(1)
  })

  test("idempotent: a second run writes nothing", async () => {
    const s = setup()
    await backfillIdentities(s.ctx, { dry_run: false })
    const snapshot = JSON.stringify({
      i: s.db.__all("counterparty_identities"),
      d: s.db.__all("documents"),
      p: s.db.__all("issuer_profiles"),
    })
    const again = (await backfillIdentities(s.ctx, { dry_run: false })) as Record<string, unknown>
    expect(again.written).toBe(0)
    expect(
      JSON.stringify({
        i: s.db.__all("counterparty_identities"),
        d: s.db.__all("documents"),
        p: s.db.__all("issuer_profiles"),
      }),
    ).toBe(snapshot)
  })

  test("issuer SIREN / SIRET backfilled from a Luhn-valid registration id, never over a recorded one", async () => {
    const s = setup()
    await backfillIdentities(s.ctx, { dry_run: false })
    expect(s.db.__all("issuer_profiles")[0]).toMatchObject({
      siren: "900000001",
      siret: "90000000100017",
    })

    const s2 = setup()
    await s2.db.update("issuer_profiles", ISSUER, {
      siren: "902000009",
      tax_registration_id: "123",
    })
    await backfillIdentities(s2.ctx, { dry_run: false })
    expect(s2.db.__all("issuer_profiles")[0]).toMatchObject({ siren: "902000009", siret: null })
  })

  test("registry lookups are bounded per call; the cursor resumes where it stopped", async () => {
    const s = setup()
    const first = (await backfillIdentities(s.ctx, { dry_run: false, limit: 1 })) as Record<
      string,
      unknown
    >
    expect(s.reg.calls).toHaveLength(1)
    expect(first.next_cursor).toBeTruthy()
    let cursor = first.next_cursor as string | null
    for (let i = 0; i < 10 && cursor; i++) {
      const next = (await backfillIdentities(s.ctx, {
        dry_run: false,
        limit: 1,
        cursor,
      })) as Record<string, unknown>
      cursor = next.next_cursor as string | null
    }
    expect(cursor).toBeNull()
    expect(byContact(s.db, C_VAT)).toMatchObject({ confirmed_via: "auto" })
    expect(byContact(s.db, C_DE)).toMatchObject({ customer_kind: "individual" })
  })

  test("limit is capped at 50", async () => {
    const s = setup()
    const r = (await backfillIdentities(s.ctx, { dry_run: true, limit: 500 })) as Record<
      string,
      unknown
    >
    expect(r.limit).toBe(50)
  })
})

describe("identity-confirm job", () => {
  test("confirms a derived SIREN and the park waiting on it becomes due", async () => {
    const parkedAt = new Date(Date.now() - 60_000)
    const db = createMockDb({
      seed: {
        documents: [
          doc({
            id: "00000000-0000-4000-8000-0000000d0101",
            counterparty_contact_id: C_VAT,
            counterparty_name: "Exemple Industries SAS",
            counterparty_country: "FR",
          }),
        ],
        counterparty_identities: [
          {
            id: "idn-derived",
            contact_id: C_VAT,
            customer_kind: "business",
            siren: VAT_SIREN,
            vat_id: frVat(VAT_SIREN),
            source: "derived",
            confirmed_via: null,
            changed_at: new Date(Date.now() - 3_600_000),
          },
        ],
        deferred_events: [
          {
            id: "park-1",
            event_id: "7001",
            event_payload_json: { id: "7001" },
            status: "awaiting_data",
            reason: "registry_unconfirmed",
            blocked_on: {
              kind: "einvoice_identity",
              contact_id: C_VAT,
              code: "registry_unconfirmed",
            },
            retry_count: 1,
            retried_at: parkedAt.toISOString(),
            created_at: parkedAt.toISOString(),
            contact_id: C_VAT,
          },
        ],
      },
    })
    const reg = registry({ [VAT_SIREN]: VAT_HIT })
    const ctx = {
      db,
      fetch: reg.fetch,
      executeTool: async () => ({ status: "error", error: { code: "x" } }),
    }

    const changedBefore = new Map([[C_VAT, new Date(Date.now() - 3_600_000)]])
    expect(await retryEligible({ db } as never, { identityChangedAt: changedBefore })).toHaveLength(
      0,
    )

    const r = await identityConfirmJob(ctx as never)
    expect(r).toMatchObject({ checked: 1, confirmed: 1 })
    const row = db.__all("counterparty_identities")[0]!
    expect(row).toMatchObject({
      siren: VAT_SIREN,
      confirmed_via: "auto",
      source: "vat_derived",
      registry_name: "EXEMPLE INDUSTRIES",
    })

    const changed = new Map([
      [
        C_VAT,
        new Date(
          String(row.changed_at instanceof Date ? row.changed_at.toISOString() : row.changed_at),
        ),
      ],
    ])
    const due = await retryEligible({ db } as never, { identityChangedAt: changed })
    expect(due.map((d) => d.id)).toEqual(["park-1"])
  })

  test("a mismatch is not confirmed, marks the check, and is not re-checked on the next run", async () => {
    const db = createMockDb({
      seed: {
        counterparty_identities: [
          {
            id: "idn-x",
            contact_id: C_MISMATCH,
            customer_kind: "business",
            siren: MISMATCH_SIREN,
            source: "derived",
            confirmed_via: null,
            changed_at: new Date("2026-09-01T00:00:00Z"),
          },
        ],
        documents: [
          doc({
            id: "00000000-0000-4000-8000-0000000d0102",
            counterparty_contact_id: C_MISMATCH,
            counterparty_name: "Maison Inventee",
            counterparty_country: "FR",
          }),
        ],
      },
    })
    const reg = registry({ [MISMATCH_SIREN]: MISMATCH_HIT })
    const ctx = { db, fetch: reg.fetch }
    const r = await identityConfirmJob(ctx as never)
    expect(r).toMatchObject({ checked: 1, confirmed: 0 })
    const row = db.__all("counterparty_identities")[0]!
    expect(row.confirmed_via ?? null).toBeNull()
    expect(row.registry_name ?? null).toBeNull()
    expect(new Date(String(row.changed_at)).toISOString()).toBe("2026-09-01T00:00:00.000Z")
    expect(row.registry_checked_at).toBeTruthy()
    const again = await identityConfirmJob(ctx as never)
    expect(again).toMatchObject({ checked: 0 })
    expect(reg.calls).toHaveLength(1)
  })

  // red: drop the active check in confirmSiren -> the job confirms a ceased company's SIREN.
  test("a ceased SIREN is not confirmed by the job", async () => {
    const ceased = registryResultWith({
      siren: VAT_SIREN,
      nom_complet: "EXEMPLE INDUSTRIES",
      etat_administratif: "C",
    })
    const db = createMockDb({
      seed: {
        documents: [
          doc({
            id: "00000000-0000-4000-8000-0000000d0103",
            counterparty_contact_id: C_VAT,
            counterparty_name: "Exemple Industries SAS",
            counterparty_country: "FR",
          }),
        ],
        counterparty_identities: [
          {
            id: "idn-ceased",
            contact_id: C_VAT,
            customer_kind: "business",
            siren: VAT_SIREN,
            source: "derived",
            confirmed_via: null,
            changed_at: new Date("2026-09-01T00:00:00Z"),
          },
        ],
      },
    })
    const reg = registry({ [VAT_SIREN]: ceased })
    const r = await identityConfirmJob({ db, fetch: reg.fetch } as never)
    expect(r).toMatchObject({ checked: 1, confirmed: 0 })
    const row = db.__all("counterparty_identities")[0]!
    expect(row.confirmed_via ?? null).toBeNull()
    expect(new Date(String(row.changed_at)).toISOString()).toBe("2026-09-01T00:00:00.000Z")
  })

  test("at most 20 lookups per run, and rows a person or a registry check recorded are not read as candidates", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `idn-${i}`,
      contact_id: `00000000-0000-4000-8000-0000000c${String(i).padStart(4, "0")}`,
      customer_kind: "business",
      siren: VAT_SIREN,
      source: "derived",
      confirmed_via: null,
    }))
    rows.push({
      id: "idn-manual",
      contact_id: C_HUMAN,
      customer_kind: "business",
      siren: VAT_SIREN,
      source: "manual",
      confirmed_via: null,
    })
    const db = createMockDb({ seed: { counterparty_identities: rows } })
    const reg = registry({})
    const r = await identityConfirmJob({ db, fetch: reg.fetch } as never)
    expect(r.checked).toBe(20)
    expect(reg.calls).toHaveLength(20)
    expect(
      db.__all("counterparty_identities").find((x) => x.id === "idn-manual")!.registry_checked_at ??
        null,
    ).toBeNull()
  })
})
