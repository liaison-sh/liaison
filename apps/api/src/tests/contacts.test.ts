// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

const rlsDb = db as unknown as RlsClient
;(rlsDb as any).queueEvent = async () => {}

import { resolveContact } from "~/modules/contacts/service"

describe("resolveContact", () => {
  const orgId = "00000000-0000-0000-0000-000000000001"
  const userId = "00000000-0000-0000-0000-000000000002"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'Test Org', 'test') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
  })

  it("creates a new contact when no match found", async () => {
    const { contact } = await resolveContact(
      rlsDb,
      orgId,
      userId,
      {
        email: "hans@acme.de",
        name: "Hans",
      },
      { audience: "org" },
    )
    expect(contact!.id).toBeDefined()
    expect(contact!.email).toBe("hans@acme.de")
    expect(contact!.name).toBe("Hans")
    expect(contact!.handle).toMatch(/^@contact-/)
  })

  it("returns existing contact on second call (idempotent)", async () => {
    const first = await resolveContact(
      rlsDb,
      orgId,
      userId,
      { email: "hans@acme.de" },
      { audience: "org" },
    )
    const second = await resolveContact(
      rlsDb,
      orgId,
      userId,
      { email: "hans@acme.de" },
      { audience: "org" },
    )
    expect(second.contact!.id).toBe(first.contact!.id)
  })

  it("case-insensitive email matching", async () => {
    const { contact: result } = await resolveContact(
      rlsDb,
      orgId,
      userId,
      {
        email: "HANS@ACME.DE",
      },
      { audience: "org" },
    )
    expect(result!.email).toBe("hans@acme.de")
  })

  it("merges external ID into existing contact", async () => {
    const { contact: result } = await resolveContact(
      rlsDb,
      orgId,
      userId,
      {
        email: "hans@acme.de",
        externalId: { shopify: "cust_123" },
      },
      { audience: "org" },
    )
    expect(result!.externalIds?.shopify).toBe("cust_123")
  })

  it("preserves existing external IDs during merge", async () => {
    await resolveContact(
      rlsDb,
      orgId,
      userId,
      {
        email: "hans@acme.de",
        externalId: { hubspot: "hs_456" },
      },
      { audience: "org" },
    )
    const { contact: result } = await resolveContact(
      rlsDb,
      orgId,
      userId,
      {
        email: "hans@acme.de",
      },
      { audience: "org" },
    )
    expect(result!.externalIds?.shopify).toBe("cust_123")
    expect(result!.externalIds?.hubspot).toBe("hs_456")
  })

  it("backfills null fields but does not overwrite existing values", async () => {
    const { contact: result } = await resolveContact(
      rlsDb,
      orgId,
      userId,
      {
        email: "hans@acme.de",
        name: "Hans Updated",
        phone: "+49123456",
      },
      { audience: "org" },
    )
    expect(result!.name).toBe("Hans") // Not overwritten
    expect(result!.phone).toBe("+49123456") // Backfilled
  })

  it("creates new contact with no email", async () => {
    const { contact: result } = await resolveContact(
      rlsDb,
      orgId,
      userId,
      {
        name: "No Email Person",
      },
      { audience: "org" },
    )
    expect(result!.id).toBeDefined()
    expect(result!.email).toBeNull()
    expect(result!.handle).toMatch(/^@contact-/)
  })

  it("creates new contact with empty params", async () => {
    const { contact: result } = await resolveContact(rlsDb, orgId, userId, {}, { audience: "org" })
    expect(result!.id).toBeDefined()
    expect(result!.handle).toMatch(/^@contact-/)
  })

  it("generates unique handles", async () => {
    const c1 = await resolveContact(rlsDb, orgId, userId, { name: "Uniq1" }, { audience: "org" })
    const c2 = await resolveContact(rlsDb, orgId, userId, { name: "Uniq2" }, { audience: "org" })
    expect(c1.contact!.handle).toMatch(/^@contact-\d+$/)
    expect(c2.contact!.handle).toMatch(/^@contact-[0-9a-f]+$/)
    expect(c1.contact!.handle).not.toBe(c2.contact!.handle)
  })

  it("updates existing external ID value when same key is passed", async () => {
    const { contact: updated } = await resolveContact(
      rlsDb,
      orgId,
      userId,
      {
        email: "hans@acme.de",
        externalId: { shopify: "cust_999" },
      },
      { audience: "org" },
    )
    expect(updated!.externalIds?.shopify).toBe("cust_999")
  })
})
