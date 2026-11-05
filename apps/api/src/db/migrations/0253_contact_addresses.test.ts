// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0253: kernel.contact_addresses. Each contact's legacy
// `metadata.shipping_address` becomes one delivery address, origin
// `legacy_metadata`, NEVER verified; a second run copies nothing twice; and the
// table refuses a verification without a verifier or a basis.
//
// The contacts are made through the seed factories; the migration replays in
// ONE transaction on one superuser connection that is rolled back, and the
// CHECK probes roll back too.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"
import { withSystemDb } from "~/db/privileged"
import { contactAddresses } from "~/db/schema/kernel"
import { seedContext } from "~/seed/context"
import { actorFor } from "~/seed/factories/people/actors"
import { resolveContacts } from "~/seed/factories/people/contacts"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const FILE = new URL("./0253_contact_addresses.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const conn = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await conn.end()
}, 30_000)

class Rollback extends Error {}

interface AddressRow {
  contact_id: string
  role: string
  origin: string
  name: string | null
  company: string | null
  street1: string | null
  street2: string | null
  city: string | null
  postal_code: string | null
  region: string | null
  country_iso2: string | null
  phone: string | null
  email: string | null
  verified_at: Date | null
  verified_by: string | null
  source: string | null
}

/** Run `fn` in a transaction that is always rolled back. */
async function rolledBack(fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  await conn
    .begin(async (tx) => {
      await fn(tx)
      throw new Rollback()
    })
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err
    })
}

let orgId = ""
let adminId = ""
const ids: Record<string, string> = {}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  const admin = await minimal.orgAdmin(orgId)
  adminId = admin.id
  const ctx = seedContext({ orgId, now: new Date() })
  const actor = await actorFor(ctx, admin.id)
  const contacts = await resolveContacts(ctx, actor, [
    {
      key: "full",
      email: "lena@northwind.example",
      name: "Lena Brandt",
      metadata: {
        segment: "b2b",
        shipping_address: {
          name: "Lena Brandt",
          company: "Northwind Acoustics",
          email: "lena@northwind.example",
          phone: " +49 30 1234567 ",
          street: "Torstrasse 12",
          city: "Berlin",
          postalCode: "10119",
          countryIsoCode: "de",
          state: "",
        },
      },
    },
    {
      key: "snake",
      email: "dock@harbour.example",
      name: "Harbour Supplies",
      metadata: {
        shipping_address: {
          address1: "5 Harbour Road",
          address2: "Unit 4",
          city: "Leeds",
          postal_code: "LS1 4AB",
          country: "United Kingdom",
          province: "West Yorkshire",
        },
      },
    },
    // Blank fields only: no usable address, nothing copied.
    {
      key: "blank",
      email: "blank@example.com",
      name: "Blank",
      metadata: { shipping_address: { street: "  ", city: "", phone: "1" } },
    },
    { key: "none", email: "none@example.com", name: "None", metadata: { segment: "b2c" } },
  ])
  for (const [key, c] of contacts) ids[key] = c.id
}, 120_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("0253 contact addresses", () => {
  it("copies each legacy shipping address as an UNVERIFIED delivery address, once", async () => {
    const seen: { rows?: AddressRow[]; secondRun?: number; metadataKept?: unknown } = {}
    await rolledBack(async (tx) => {
      await tx.unsafe(readFileSync(FILE, "utf8"))

      seen.rows = await tx<AddressRow[]>`
        SELECT contact_id::text, role, origin, name, company, street1, street2, city,
               postal_code, region, country_iso2, phone, email, verified_at,
               verified_by::text, source
          FROM kernel.contact_addresses WHERE org_id = ${orgId}
         ORDER BY city`
      const [kept] = await tx<{ m: unknown }[]>`
        SELECT metadata -> 'shipping_address' AS m FROM kernel.contacts WHERE id = ${ids.full ?? ""}`
      seen.metadataKept = kept?.m

      await tx.unsafe(readFileSync(FILE, "utf8"))
      const [again] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.contact_addresses WHERE org_id = ${orgId}`
      seen.secondRun = again?.n
    })

    const rows = seen.rows ?? []
    expect(rows.map((r) => r.contact_id)).toEqual([ids.full, ids.snake])
    for (const row of rows) {
      // The discriminator for "never auto-verified".
      expect(row.verified_at).toBeNull()
      expect(row.verified_by).toBeNull()
      expect(row.source).toBeNull()
      expect(row.role).toBe("delivery")
      expect(row.origin).toBe("legacy_metadata")
    }
    const [berlin, leeds] = rows
    expect(berlin).toMatchObject({
      name: "Lena Brandt",
      company: "Northwind Acoustics",
      email: "lena@northwind.example",
      phone: "+49 30 1234567",
      street1: "Torstrasse 12",
      street2: null,
      city: "Berlin",
      postal_code: "10119",
      region: null,
      country_iso2: "DE",
    })
    expect(leeds).toMatchObject({
      street1: "5 Harbour Road",
      street2: "Unit 4",
      postal_code: "LS1 4AB",
      region: "West Yorkshire",
      // Not a two-letter code: left empty on the row, kept in the metadata.
      country_iso2: null,
    })
    expect(seen.metadataKept).toMatchObject({ street: "Torstrasse 12" })
    expect(seen.secondRun).toBe(2)
  })

  it("refuses a verification without a verifier or without a basis", async () => {
    const contactId = ids.none ?? ""
    const attempt = async (row: {
      verifiedAt: Date | null
      verifiedBy: string | null
      source: "purchase_order" | null
    }): Promise<string> => {
      try {
        await withSystemDb("test-0253-check", (db) =>
          db.transaction(async (tx) => {
            await tx
              .insert(contactAddresses)
              .values({ orgId, contactId, street1: "Main St 1", ...row })
            throw new Rollback()
          }),
        )
        return "ok"
      } catch (err) {
        if (err instanceof Rollback) return "ok"
        return pgCode(err) ?? String(err)
      }
    }
    const now = new Date()
    expect({
      noVerifier: await attempt({ verifiedAt: now, verifiedBy: null, source: "purchase_order" }),
      noSource: await attempt({ verifiedAt: now, verifiedBy: adminId, source: null }),
      complete: await attempt({ verifiedAt: now, verifiedBy: adminId, source: "purchase_order" }),
      verifierWithoutDate: await attempt({ verifiedAt: null, verifiedBy: adminId, source: null }),
    }).toEqual({
      noVerifier: "23514",
      noSource: "23514",
      complete: "ok",
      verifierWithoutDate: "23514",
    })
  })
})

/** The SQLSTATE of a failed statement, through drizzle's wrapping. */
function pgCode(err: unknown): string | undefined {
  let e: unknown = err
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}
