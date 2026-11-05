// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { contacts } from "~/db/schema/kernel"
import { TEAM_CONTACT_REFERENCES } from "~/modules/contacts/references"
import {
  listContacts,
  mergeContacts,
  mergeContactsWithMailReferences,
} from "~/modules/contacts/service"
import { releaseAppSchema, takeOverAppSchema } from "~/tests/helpers/app-schema-fixture"
import { acquireAppSchemaLock, releaseAppSchemaLock } from "~/tests/helpers/app-schema-lock"

// Distinct org id from queue-event.test.ts (which used 9001) — both files run
// in parallel and shared cleanup races on the kernel.users FK.
const ORG_ID = "00000000-0000-0000-0000-000000c0e191"
const USER_ID = "00000000-0000-0000-0000-000000c0e192"

const events: any[] = []
const rlsDb = db as unknown as RlsClient
const origTx = (rlsDb as any).transaction.bind(rlsDb)
const origQueueEvent = (rlsDb as any).queueEvent

beforeEach(() => {
  ;(rlsDb as any).queueEvent = async (event: any) => {
    events.push(event)
  }
  ;(rlsDb as any).transaction = async (fn: any) =>
    origTx(async (tx: any) => {
      tx.queueEvent = async (event: any) => {
        events.push(event)
      }
      return fn(tx)
    })
})

beforeAll(async () => {
  // listContacts joins app_mail.conversations to derive lastContactedAt, so this
  // file needs a conversations table of a KNOWN shape. `CREATE TABLE IF NOT
  // EXISTS` did not give it one: app_mail is a REGISTERED app schema, present in
  // any database an install has touched, so the statement was a silent no-op and
  // the file ran against a table it never wrote — the same hazard the invoicing
  // block below documents. It takes the schema over instead: the original (the
  // registered app's, or another fixture's) is renamed aside for the lifetime of
  // this file and renamed back in afterAll, so nothing foreign is destroyed and
  // the shape below is the shape the tests run against. The lock is the existing
  // convention for a file that holds an app schema exclusively.
  const mailLock = await acquireAppSchemaLock("app_mail")
  // The handle proves the holder is this file, so the take-over re-enters the
  // lock instead of queueing behind it.
  await takeOverAppSchema("app_mail", { lock: mailLock })
  await sql.unsafe(`GRANT USAGE ON SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`)
  await sql.unsafe(`
    CREATE TABLE app_mail.conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      account_id UUID NOT NULL,
      owner_type TEXT NOT NULL DEFAULT 'user',
      owner_id UUID,
      external_thread_id TEXT NOT NULL,
      subject TEXT,
      snippet TEXT,
      contact_id UUID,
      assigned_to UUID,
      status TEXT NOT NULL,
      labels JSONB NOT NULL DEFAULT '[]',
      is_read BOOLEAN NOT NULL DEFAULT false,
      is_starred BOOLEAN NOT NULL DEFAULT false,
      internal_thread_id UUID,
      last_message_at TIMESTAMPTZ,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await sql.unsafe(
    // liaison_admin too — the mail re-point in mergeContactsWithMailReferences runs
    // under withPrivilegedDb's `SET LOCAL ROLE liaison_admin`, exactly like the
    // invoicing grant below. The registered mail app grants it; this fixture owes
    // the same grant now that it builds the table itself instead of inheriting one.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON app_mail.conversations TO liaison_rls, liaison_app, liaison_admin`,
  )

  // app_invoicing.documents — for the BL-215/merge-leaves-orders test: contacts_merge must re-point
  // the CRM back-link (counterparty_contact_id) so invoices aren't orphaned, WITHOUT touching the
  // frozen legal snapshot (counterparty_name/country). Minimal shape covering the columns the
  // re-point + the assertions read.
  //
  // This file OWNS the unprefixed `app_invoicing` schema for as long as it runs,
  // and owns it BORROWED: whatever is there is renamed aside and renamed back in
  // afterAll (see the app_mail block above). `CREATE TABLE IF NOT EXISTS` alone
  // is not ownership: when the real invoicing app has been registered into this
  // database, the real `documents` table is already there, the IF NOT EXISTS is a
  // silent no-op, and the insert below dies on a column the fixture never heard
  // of (`issuer_profile_id`, NOT NULL since the invoicing manifest declared it
  // required, with a restrict FK to an `issuer_profiles` row this file has no
  // business inventing). Whether this file passed then depended on which other
  // file had registered the app first, which is not a property a test may have.
  // Dropping it instead was not ownership either, in the other direction: it took
  // the registered schema away from every later file in the same process.
  const invoicingLock = await acquireAppSchemaLock("app_invoicing")
  await takeOverAppSchema("app_invoicing", { lock: invoicingLock })
  await sql.unsafe(`GRANT USAGE ON SCHEMA app_invoicing TO liaison_rls, liaison_app, liaison_admin`)
  await sql.unsafe(`
    CREATE TABLE app_invoicing.documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      type TEXT NOT NULL DEFAULT 'invoice',
      status TEXT NOT NULL DEFAULT 'issued',
      counterparty_contact_id UUID,
      counterparty_name TEXT,
      counterparty_country TEXT,
      -- issued_at is NOT optional in this fixture even though the merge re-point
      -- never reads it: listContacts folds invoicing into lastContactedAt with
      -- COALESCE(d.issued_at, d.created_at) as soon as to_regclass finds this
      -- table, so a fixture missing the column makes every listContacts case in
      -- this file fail with "column d.issued_at does not exist".
      issued_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await sql.unsafe(
    // liaison_admin too — withPrivilegedDb's merge re-point runs under `SET LOCAL ROLE liaison_admin`.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON app_invoicing.documents TO liaison_rls, liaison_app, liaison_admin`,
  )

  // The identity table of the same app: one row per contact (unique contact_id), so a merge
  // cannot re-point it blindly.
  await sql.unsafe(`
    CREATE TABLE app_invoicing.counterparty_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      contact_id UUID NOT NULL UNIQUE,
      siren TEXT,
      confirmed_via TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON app_invoicing.counterparty_identities TO liaison_rls, liaison_app, liaison_admin`,
  )

  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ContactMergeOrg', 'contact-merge-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'contact-merge@test.com', 'Merge User') ON CONFLICT DO NOTHING`
})

afterEach(async () => {
  events.length = 0
  ;(rlsDb as any).queueEvent = origQueueEvent
  ;(rlsDb as any).transaction = origTx
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG_ID}`
})

afterAll(async () => {
  // CRITICAL test-isolation: this file CREATEs a minimal unprefixed `app_invoicing` schema (only the
  // `documents` table, no issuer_profiles) for the BL-215 re-point test. The chaos world-builder
  // clones the unprefixed app schemas into its per-run schema, so leaving this PARTIAL schema behind
  // makes every later chaos invoicing install fail "missing issuer_profiles after reloadInstalledApps".
  // So the fixture goes away here, but only the fixture: `releaseAppSchema` drops the schema this
  // file built and renames the original back, restoring the base DB to exactly its pre-test state
  // whether that was "no unprefixed app_invoicing" or the registered invoicing app. The old
  // unconditional `DROP SCHEMA app_invoicing CASCADE` restored the first case and destroyed the
  // second for every later file in the process.
  await releaseAppSchema("app_invoicing")
  await releaseAppSchemaLock("app_invoicing")
  // Same for the faked app_mail: back to whatever was there before this file ran
  // (the registered mail app, in a database that has one).
  await releaseAppSchema("app_mail")
  await releaseAppSchemaLock("app_mail")
})

describe("listContacts with query filter", () => {
  beforeEach(async () => {
    await db.insert(contacts).values([
      {
        orgId: ORG_ID,
        handle: "@c-1",
        name: "Alice Smith",
        email: "alice@example.com",
        company: "Acme Corp",
        createdBy: USER_ID,
      },
      {
        orgId: ORG_ID,
        handle: "@c-2",
        name: "Bob Johnson",
        email: "bob@example.com",
        company: "Beta Inc",
        createdBy: USER_ID,
      },
      {
        orgId: ORG_ID,
        handle: "@c-3",
        name: "Charlie Brown",
        email: "charlie@acme.com",
        company: "Acme Corp",
        createdBy: USER_ID,
      },
    ])
  })

  it("filters by name (case-insensitive)", async () => {
    const result = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50, query: "alice" })
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].name).toBe("Alice Smith")
  })

  it("filters by email", async () => {
    const result = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50, query: "acme" })
    expect(result.rows.length).toBeGreaterThanOrEqual(2)
  })

  it("returns all contacts when query is empty", async () => {
    const result = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50 })
    expect(result.rows.length).toBeGreaterThanOrEqual(3)
  })

  it("hides notification-style senders by default and reveals them with mode=all", async () => {
    await db.insert(contacts).values({
      orgId: ORG_ID,
      handle: "@bot-1",
      name: "Acme Notifications",
      email: "no-reply@notifications.acme.com",
      createdBy: USER_ID,
    })

    const peopleOnly = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50 })
    expect(
      peopleOnly.rows.find((r) => r.email === "no-reply@notifications.acme.com"),
    ).toBeUndefined()

    const all = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50, mode: "all" })
    const bot = all.rows.find((r) => r.email === "no-reply@notifications.acme.com")
    expect(bot).toBeDefined()
    expect(bot?.isAutomated).toBe(true)
  })

  it("still finds noreply senders when the user explicitly searches for them", async () => {
    await db.insert(contacts).values({
      orgId: ORG_ID,
      handle: "@bot-2",
      name: "Billing Receipts",
      email: "receipts@billing.example.com",
      createdBy: USER_ID,
    })

    const result = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      query: "billing",
    })
    expect(result.rows.find((r) => r.email === "receipts@billing.example.com")).toBeDefined()
  })
})

describe("mergeContacts", () => {
  it("merges source into target and deletes source", async () => {
    const [source] = await db
      .insert(contacts)
      .values({
        orgId: ORG_ID,
        handle: "@merge-src",
        name: "Source",
        email: "source@test.com",
        externalIds: { mailchimp: "mc-1" },
        createdBy: USER_ID,
      })
      .returning()
    const [target] = await db
      .insert(contacts)
      .values({
        orgId: ORG_ID,
        handle: "@merge-tgt",
        name: "Target",
        email: "target@test.com",
        externalIds: { hubspot: "hs-1" },
        createdBy: USER_ID,
      })
      .returning()

    const result = await mergeContacts(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      sourceId: source.id,
      targetId: target.id,
      resolvedFields: { name: "Merged Name", email: "target@test.com" },
    })

    expect(result.id).toBe(target.id)
    expect(result.name).toBe("Merged Name")
    expect((result.externalIds as any).mailchimp).toBe("mc-1")
    expect((result.externalIds as any).hubspot).toBe("hs-1")

    const [deletedSource] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, source.id))
      .limit(1)
    expect(deletedSource).toBeUndefined()
    expect(events).toContainEqual(
      expect.objectContaining({
        app: "kernel",
        entity: "contact",
        action: "merge",
        entityId: target.id,
        data: expect.objectContaining({ sourceId: source.id, mergedConversationCount: 0 }),
      }),
    )
  })

  it("carries the SOURCE's email onto the survivor via resolvedFields WITHOUT a unique-index collision (dedupe-scan-whole-contact-list)", async () => {
    // dedupe-scan-whole-contact-list 3× gate run 2: a merge where the agent picked the survivor =
    // target but kept the SOURCE's email (resolvedFields.email = source's address — the documented
    // "keep the BEST email" path) FAILED with handler_outcome_unknown. Root cause: mergeContactsInTx
    // UPDATEs the survivor (setting email = the source's address) BEFORE it DELETEs the source — so the
    // survivor's new email collides with the still-present source row on the (org_id, email) unique
    // index, aborting the whole gated merge. The fix deletes the source first; this test pins it
    // (fails on the old ordering with a unique-violation, passes once the source is removed first).
    const [source] = await db
      .insert(contacts)
      .values({
        orgId: ORG_ID,
        handle: "@merge-email-src",
        name: "Priscila Tavares",
        email: "priscila.tavares@orbitsound.example",
        createdBy: USER_ID,
      })
      .returning()
    const [target] = await db
      .insert(contacts)
      .values({
        orgId: ORG_ID,
        handle: "@merge-email-tgt",
        name: "Priscila Tavares Reis",
        email: "p.tavares@orbitsound.example",
        createdBy: USER_ID,
      })
      .returning()

    // Survivor = target, but keep the SOURCE's (better) email — the exact collision shape.
    const result = await mergeContactsWithMailReferences(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      sourceId: source.id,
      targetId: target.id,
      resolvedFields: { email: "priscila.tavares@orbitsound.example" },
    })

    expect(result.contact.id).toBe(target.id)
    expect(result.contact.email).toBe("priscila.tavares@orbitsound.example")
    // Source is gone; the survivor now uniquely holds the kept email (no orphaned duplicate email).
    const [deletedSource] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, source.id))
      .limit(1)
    expect(deletedSource).toBeUndefined()
    const holders = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, "priscila.tavares@orbitsound.example"))
    expect(holders.length).toBe(1)
    expect(holders[0].id).toBe(target.id)
  })

  it("rejects merge when source equals target", async () => {
    await expect(
      mergeContacts(rlsDb, {
        orgId: ORG_ID,
        userId: USER_ID,
        sourceId: "00000000-0000-0000-0000-000000000001",
        targetId: "00000000-0000-0000-0000-000000000001",
        resolvedFields: {},
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/cannot merge/i),
    })
  })
})

describe("mergeContactsWithMailReferences — invoicing back-link re-point (BL-215)", () => {
  afterEach(async () => {
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG_ID}`
  })

  it("re-points an invoicing document's counterparty_contact_id to the survivor (legal snapshot untouched)", async () => {
    const sourceId = "00000000-0000-0000-0000-0000000c2150"
    const targetId = "00000000-0000-0000-0000-0000000c2151"
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email) VALUES (${sourceId}, ${ORG_ID}, 'bl215-src', 'Westcoast Pro Audio', 'src@bl215.example')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email) VALUES (${targetId}, ${ORG_ID}, 'bl215-tgt', 'Westcoast Pro Audio', 'tgt@bl215.example')`
    const docId = "00000000-0000-0000-0000-0000000c2152"
    // An ISSUED invoice on the SOURCE contact, with a frozen legal snapshot.
    await sql`INSERT INTO app_invoicing.documents (id, org_id, type, status, counterparty_contact_id, counterparty_name, counterparty_country)
      VALUES (${docId}, ${ORG_ID}, 'invoice', 'issued', ${sourceId}, 'Westcoast Pro Audio LLC', 'US')`

    await mergeContactsWithMailReferences(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      sourceId,
      targetId,
      resolvedFields: {},
    })

    const [doc] =
      await sql`SELECT counterparty_contact_id, counterparty_name, counterparty_country FROM app_invoicing.documents WHERE id = ${docId}`
    // CRM back-link follows the survivor → invoice not orphaned by the source delete.
    expect(doc.counterparty_contact_id).toBe(targetId)
    // The frozen LEGAL snapshot is untouched.
    expect(doc.counterparty_name).toBe("Westcoast Pro Audio LLC")
    expect(doc.counterparty_country).toBe("US")
    // Source contact was deleted by the merge.
    const remaining = await sql`SELECT id FROM kernel.contacts WHERE id = ${sourceId}`
    expect(remaining.length).toBe(0)
  })
})

describe("mergeContactsWithMailReferences — counterparty identity (one row per contact)", () => {
  const SRC = "00000000-0000-0000-0000-0000000c3150"
  const TGT = "00000000-0000-0000-0000-0000000c3151"

  async function seedContacts() {
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email) VALUES (${SRC}, ${ORG_ID}, 'idm-src', 'Fabrikam Source', 'src@idm.example')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email) VALUES (${TGT}, ${ORG_ID}, 'idm-tgt', 'Fabrikam Target', 'tgt@idm.example')`
  }
  async function identities() {
    return sql`SELECT contact_id::text AS contact_id, siren, confirmed_via, notes FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG_ID}`
  }
  async function merge() {
    await mergeContactsWithMailReferences(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      sourceId: SRC,
      targetId: TGT,
      resolvedFields: {},
    })
  }

  afterEach(async () => {
    await sql`DELETE FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG_ID}`
  })

  it("keeps the confirmed identity when only the source has one confirmed", async () => {
    await seedContacts()
    await sql`INSERT INTO app_invoicing.counterparty_identities (org_id, contact_id, siren, confirmed_via) VALUES (${ORG_ID}, ${SRC}, '123456782', 'approval')`
    await sql`INSERT INTO app_invoicing.counterparty_identities (org_id, contact_id, siren, confirmed_via) VALUES (${ORG_ID}, ${TGT}, '987654321', NULL)`
    await merge()
    const rows = await identities()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.contact_id).toBe(TGT)
    expect(rows[0]?.siren).toBe("123456782")
    expect(rows[0]?.confirmed_via).toBe("approval")
    expect(rows[0]?.notes).toContain(`merged from ${SRC}`)
  })

  it("on a tie the target's identity wins", async () => {
    await seedContacts()
    await sql`INSERT INTO app_invoicing.counterparty_identities (org_id, contact_id, siren, confirmed_via) VALUES (${ORG_ID}, ${SRC}, '123456782', 'auto')`
    await sql`INSERT INTO app_invoicing.counterparty_identities (org_id, contact_id, siren, confirmed_via) VALUES (${ORG_ID}, ${TGT}, '987654321', 'auto')`
    await merge()
    const rows = await identities()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.contact_id).toBe(TGT)
    expect(rows[0]?.siren).toBe("987654321")
    expect(rows[0]?.notes).toContain(`merged from ${SRC}`)
  })

  it("moves the source's identity to the survivor when the target has none", async () => {
    await seedContacts()
    await sql`INSERT INTO app_invoicing.counterparty_identities (org_id, contact_id, siren, confirmed_via) VALUES (${ORG_ID}, ${SRC}, '123456782', NULL)`
    await merge()
    const rows = await identities()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.contact_id).toBe(TGT)
    expect(rows[0]?.siren).toBe("123456782")
  })

  it("is a no-op for a source without an identity", async () => {
    await seedContacts()
    await sql`INSERT INTO app_invoicing.counterparty_identities (org_id, contact_id, siren) VALUES (${ORG_ID}, ${TGT}, '987654321')`
    await merge()
    const rows = await identities()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.notes).toBeNull()
  })
})

describe("TEAM_CONTACT_REFERENCES", () => {
  it("counts counterparty identities as a team reference", () => {
    expect(TEAM_CONTACT_REFERENCES).toContainEqual({
      kind: "invoicing identities",
      schema: "app_invoicing",
      table: "counterparty_identities",
      predicate: "r.contact_id::text = c.id::text",
    })
  })
})
