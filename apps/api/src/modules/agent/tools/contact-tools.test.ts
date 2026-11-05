// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  contactsWritePreflight,
  contactWebsite,
  handleContactsMerge,
  handleContactsRead,
  handleContactsSearch,
  handleContactsWrite,
  liftMisplacedVatId,
  safeEnrichmentRows,
  summarizeContactsMerge,
  summarizeContactsWrite,
} from "~/modules/agent/tools/contact-tools"
import { armAfterContactMergeFailpoint } from "~/modules/contacts/merge-failpoint"
import { getContact, mergeContactsWithMailReferences } from "~/modules/contacts/service"
import { acquireAppSchemaLock, releaseAppSchemaLock } from "~/tests/helpers/app-schema-lock"

const orgId = "00000000-0000-0000-0000-000000e10001"
const userId = "00000000-0000-0000-0000-000000e10002"
const connectedAccountId = "00000000-0000-0000-0000-000000e10003"
const accountId = "00000000-0000-0000-0000-000000e10004"
const aliceContactId = "00000000-0000-0000-0000-000000e10005"
const bobContactId = "00000000-0000-0000-0000-000000e10006"

const actor: UserContext = {
  actorType: "user",
  userId,
  orgId,
  scopes: ["*"],
  dimensionGrants: { "mail:inbox": ["*"] },
}

async function withAgentContext<T>(
  fn: (ctx: { db: any; userId: string; orgId: string }) => Promise<T>,
) {
  return withRlsContext(actor, (db) => fn({ db, userId, orgId }))
}

async function seedContacts() {
  await sql`
    INSERT INTO kernel.contacts (id, org_id, handle, name, email, phone, company, external_ids, created_by)
    VALUES
      (${aliceContactId}, ${orgId}, '@agent-alice', 'Alice Agent', 'alice@x.com', null, 'Acme', '{"crm":"target","keep":"target-only"}'::jsonb, ${userId}),
      (${bobContactId}, ${orgId}, '@agent-bob', 'Bob Agent', 'bob@y.com', null, 'Globex', '{"crm":"source","mailchimp":"mc-1"}'::jsonb, ${userId})
  `
}

async function seedMailConversation(contactId: string, suffix = "one") {
  const [conversation] = extractRows<{ id: string }>(
    await sql`
    INSERT INTO app_mail.conversations (
      id, org_id, account_id, owner_type, owner_id, external_thread_id,
      subject, snippet, contact_id, status, labels, is_read, is_starred,
      last_message_at, message_count
    )
    VALUES (
      gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, ${`thread-${suffix}`},
      ${`Subject ${suffix}`}, ${`Snippet ${suffix}`}, ${contactId}, 'open', '["INBOX"]'::jsonb,
      false, false, now(), 1
    )
    RETURNING id
  `,
  )
  return conversation.id
}

async function resetFixtures() {
  await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
  await sql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}`

  await sql`
    INSERT INTO kernel.connected_accounts (
      id, org_id, app_name, connection_name, owner_type, owner_id,
      provider_type, identifier, status, created_by, access_token_encrypted
    )
    VALUES (
      ${connectedAccountId}, ${orgId}, 'mail', 'gmail', 'user', ${userId},
      'oauth2', 'agent-tools@test.com', 'active', ${userId}, 'encrypted-token'
    )
  `
  await sql`
    INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
    VALUES (${accountId}, ${orgId}, ${connectedAccountId}, 'user', ${userId}, 'gmail', 'agent-tools@test.com', 'active')
  `
  await seedContacts()
  await seedMailConversation(aliceContactId)
  await sql`
    INSERT INTO kernel.timeline_entries (org_id, app, entity_type, entity_id, actor_id, actor_type, action, summary)
    VALUES (${orgId}, 'kernel', 'contact', ${aliceContactId}, ${userId}, 'user', 'update', 'Updated contact')
  `
}

beforeAll(async () => {
  // Hold the app_mail schema lock for the full file: these tests do data ops
  // against app_mail, and concurrent registration tests may DROP the schema.
  await acquireAppSchemaLock("app_mail")
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS app_mail`)
    await sql.unsafe(`GRANT USAGE ON SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`)
    await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS app_mail.accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      connected_account_id UUID NOT NULL,
      owner_type TEXT NOT NULL DEFAULT 'user',
      owner_id UUID,
      provider TEXT NOT NULL,
      email_address TEXT NOT NULL,
      display_name TEXT,
      sync_status TEXT NOT NULL,
      sync_state JSONB,
      last_sync_at TIMESTAMPTZ,
      last_sync_error TEXT,
      disconnected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, email_address)
    )
  `)
    await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS app_mail.conversations (
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
      `GRANT SELECT, INSERT, UPDATE, DELETE ON app_mail.accounts, app_mail.conversations TO liaison_rls, liaison_app, liaison_admin`,
    )
    // A migrated test database ships app_mail.conversations with FORCE RLS and only a
    // deny-all policy until the mail app registers its real policies, so whether the
    // agent path (liaison_rls) could see this file's seeded conversations depended on
    // what another suite had last done to the shared database: contacts.search then
    // read Alice as never contacted. Own that state here: a permissive read policy
    // limited to this file's org. Permissive policies OR together, so this never
    // narrows anything and never widens beyond this org's fixture rows.
    await sql.unsafe(`DROP POLICY IF EXISTS contact_tools_test_org_read ON app_mail.conversations`)
    await sql.unsafe(
      `CREATE POLICY contact_tools_test_org_read ON app_mail.conversations
         AS PERMISSIVE FOR SELECT TO liaison_rls USING (org_id = '${orgId}'::uuid)`,
    )
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'ContactAgentToolsOrg', 'contact-agent-tools-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status) VALUES (${userId}, ${orgId}, 'contact-agent-tools@test.com', 'Contact Agent', 'x', 'active') ON CONFLICT DO NOTHING`
  } catch (err) {
    await releaseAppSchemaLock("app_mail")
    throw err
  }
}, 60_000)

beforeEach(resetFixtures)

afterAll(async () => {
  try {
    await resetFixtures()
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.users WHERE id = ${userId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    await sql.unsafe(`DROP POLICY IF EXISTS contact_tools_test_org_read ON app_mail.conversations`)
  } finally {
    await releaseAppSchemaLock("app_mail")
  }
})

describe("safeEnrichmentRows — contact-360 enrichment degrades, never crashes", () => {
  // A minimal db stub modelling the SAVEPOINT semantics: `transaction(fn)` runs `fn` inside a
  // savepoint; if `fn` throws, the savepoint rolls back and the error propagates to the caller (which
  // safeEnrichmentRows catches), but the OUTER connection stays usable.
  const makeDb = () =>
    ({
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    }) as unknown as Parameters<typeof safeEnrichmentRows>[0]

  it("a rejected query (e.g. RLS 'permission denied') DEGRADES to [] instead of throwing", async () => {
    const rows = await safeEnrichmentRows(makeDb(), () =>
      Promise.reject(new Error("permission denied for table conversations")),
    )
    expect(rows).toEqual([])
  })

  it("a resolved query passes its rows through", async () => {
    // extractRows accepts a pg-style result ({ rows }) or a bare array; a bare array round-trips.
    const rows = await safeEnrichmentRows<{ id: number }>(makeDb(), () =>
      Promise.resolve([{ id: 1 }, { id: 2 }]),
    )
    expect(rows).toEqual([{ id: 1 }, { id: 2 }])
  })

  // BL-242 regression: the enrichment query runs inside a SAVEPOINT, so a permission-denied that
  // poisons the savepoint does NOT abort the outer transaction — a SECOND enrichment (or any later
  // query) still succeeds. Pre-fix this used a bare try/catch over a query on the SHARED connection,
  // so the first permission error aborted the transaction and the next query threw "current
  // transaction is aborted", crashing the whole tool (making a cross-app contacts_read return error).
  it("runs each query in a savepoint so a failed enrichment does not abort a subsequent one (BL-242)", async () => {
    // A connection stub that ABORTS after any failed statement (Postgres semantics): once aborted,
    // every further statement throws "current transaction is aborted" — UNLESS run inside a fresh
    // savepoint (transaction), which isolates+rolls back the failure.
    let aborted = false
    const conn = {
      run: async (shouldThrow: boolean, rows: unknown[]): Promise<unknown[]> => {
        if (aborted) throw new Error("current transaction is aborted")
        if (shouldThrow) {
          aborted = true
          throw new Error("permission denied for table conversations")
        }
        return rows
      },
    }
    const db = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        // A savepoint snapshots `aborted`; on inner failure it rolls back to the snapshot.
        const snapshot = aborted
        try {
          return await fn({})
        } catch (e) {
          aborted = snapshot // savepoint rollback restores the pre-statement abort flag
          throw e
        }
      },
    } as unknown as Parameters<typeof safeEnrichmentRows>[0]

    const first = await safeEnrichmentRows(db, () => conn.run(true, [])) // permission-denied → []
    const second = await safeEnrichmentRows<{ id: number }>(db, () => conn.run(false, [{ id: 7 }]))
    expect(first).toEqual([])
    expect(second).toEqual([{ id: 7 }]) // would be [] (abort) without savepoint isolation
  })
})

// BL-25 — a weak agent correcting a contact's VAT writes it into the free-form `metadata`
// (metadata.vat_id / vat_number) instead of the field of record `externalIds.vat_id` that the
// invoicing tax logic reads, so the correction never lands and the stale number keeps driving
// export-vs-reverse-charge treatment. liftMisplacedVatId routes it to externalIds at the
// contacts_write boundary (mechanical, mirrors invoicing's liftMisplacedHsCode / BL-39).
describe("liftMisplacedVatId — route a misplaced metadata VAT onto externalIds.vat_id (BL-25)", () => {
  it("lifts metadata.vat_id into externalIds.vat_id and strips it from metadata", () => {
    const out = liftMisplacedVatId(undefined, { vat_id: "GB776269612", note: "post-Brexit" })
    expect(out.externalIds).toEqual({ vat_id: "GB776269612" })
    expect(out.metadata).toEqual({ note: "post-Brexit" })
  })

  it("lifts metadata.vat_number too, and merges into existing externalIds", () => {
    const out = liftMisplacedVatId({ country: "GB" }, { vat_number: "GB776269612" })
    expect(out.externalIds).toEqual({ country: "GB", vat_id: "GB776269612" })
    expect(out.metadata).toBeUndefined() // metadata emptied after the lift
  })

  it("an explicit externalIds.vat_id always wins — metadata is left untouched", () => {
    const out = liftMisplacedVatId({ vat_id: "GB776269612" }, { vat_id: "GB000000000" })
    expect(out.externalIds).toEqual({ vat_id: "GB776269612" })
    expect(out.metadata).toEqual({ vat_id: "GB000000000" })
  })

  it("leaves non-VAT metadata + externalIds unchanged", () => {
    const out = liftMisplacedVatId({ country: "GB" }, { note: "x" })
    expect(out.externalIds).toEqual({ country: "GB" })
    expect(out.metadata).toEqual({ note: "x" })
  })

  it("ignores a blank/non-string VAT value (no lift)", () => {
    expect(liftMisplacedVatId(undefined, { vat_id: "   " }).externalIds).toBeUndefined()
    expect(liftMisplacedVatId(undefined, { vat_id: 12345 }).externalIds).toBeUndefined()
  })
})

// BL-275 — contacts_search surfaces a contact's store/product page URL from `metadata` so a watch routine
// (dealer-price-watch, competitor-watch) can web_watch each dealer's page directly from ONE search. Before
// this, the URL lived only in metadata (invisible to contacts_search → only contacts_read returned it), so
// the routine had no per-source URL to poll → guessed/unreachable URLs → empty fetches → no cross-tick diff
// (the observed dealer-price-watch failure). This pure helper is the load-bearing extraction.
describe("contactWebsite — surface a contact's store/product URL from metadata (BL-275)", () => {
  it("extracts the dealer-watch seed's storeUrl (the canonical key)", () => {
    expect(
      contactWebsite({ storeUrl: "https://modular-plaza-store.example/products/kestrel-6" }),
    ).toBe("https://modular-plaza-store.example/products/kestrel-6")
  })

  it("falls back through website / url / productUrl when storeUrl is absent", () => {
    expect(contactWebsite({ website: "https://dealer.example/shop" })).toBe(
      "https://dealer.example/shop",
    )
    expect(contactWebsite({ url: "http://dealer.example/" })).toBe("http://dealer.example/")
    expect(contactWebsite({ productUrl: "https://dealer.example/p/1" })).toBe(
      "https://dealer.example/p/1",
    )
    // storeUrl wins over the lower-priority keys.
    expect(contactWebsite({ url: "https://low.example", storeUrl: "https://high.example" })).toBe(
      "https://high.example",
    )
  })

  it("returns null for no URL / non-http value / non-object metadata (defensive, never throws)", () => {
    expect(contactWebsite(null)).toBeNull()
    expect(contactWebsite(undefined)).toBeNull()
    expect(contactWebsite("a string")).toBeNull()
    expect(contactWebsite({ note: "no url here" })).toBeNull()
    // A non-http(s) string (e.g. an ftp/javascript scheme or bare text) is NOT a website.
    expect(contactWebsite({ storeUrl: "javascript:alert(1)" })).toBeNull()
    expect(contactWebsite({ website: "modular-plaza-store.example" })).toBeNull()
    expect(contactWebsite({ storeUrl: 12345 })).toBeNull()
  })
})

describe("contact agent tools", () => {
  describe("contacts.search", () => {
    it("returns contacts matching the query, capped at 50", async () => {
      const result = await withAgentContext((ctx) => handleContactsSearch({ query: "Alice" }, ctx))

      expect(result.items.find((contact) => contact.id === aliceContactId)).toBeDefined()
      expect(result.totalCount).toBeGreaterThanOrEqual(1)
    })

    it("returns empty list when no contact matches", async () => {
      const result = await withAgentContext((ctx) =>
        handleContactsSearch({ query: "NoSuchPerson" }, ctx),
      )

      expect(result.items).toEqual([])
      expect(result.totalCount).toBe(0)
    })

    it("caps limit at 50", async () => {
      const result = await withAgentContext((ctx) =>
        handleContactsSearch({ query: "", limit: 999 }, ctx),
      )

      expect(result.items.length).toBeLessThanOrEqual(50)
    })

    // BL-258 (find-inactive-dealers-followup): the agent tool surfaces the server-computed recency
    // (lastContactedAt) and supports the notContactedSince recency filter — under the REAL RLS agent
    // path. Alice has a conversation seeded at now() (recent); Bob has none (never contacted).
    it("surfaces lastContactedAt on each item (computed across linked mail conversations)", async () => {
      const result = await withAgentContext((ctx) => handleContactsSearch({ query: "Agent" }, ctx))
      const alice = result.items.find((c) => c.id === aliceContactId)
      const bob = result.items.find((c) => c.id === bobContactId)
      expect(alice?.lastContactedAt).not.toBeNull() // Alice has a recent conversation
      expect(alice).toHaveProperty("lastContactedAt")
      expect(bob?.lastContactedAt ?? null).toBeNull() // Bob never contacted
    })

    it("notContactedSince filters to the never-contacted contact and EXCLUDES the recently-contacted one", async () => {
      // Alice was contacted now(); a 90-day cutoff excludes her. Bob (never) qualifies as stale.
      const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString()
      const result = await withAgentContext((ctx) =>
        handleContactsSearch({ query: "Agent", notContactedSince: cutoff }, ctx),
      )
      const ids = result.items.map((c) => c.id)
      expect(ids).toContain(bobContactId)
      expect(ids).not.toContain(aliceContactId)
    })

    // BL-FIRST (weekly-enrich-new-contacts-routine): the agent tool surfaces phone/createdAt + the
    // per-row isBare/missingCompany/missingPhone flags so a bare-contact enrichment tick RENDERS the
    // bare set instead of re-deriving emptiness in-context. Alice/Bob both have a company but NULL phone.
    it("surfaces phone + per-row bare flags (Alice/Bob have a company but no phone → missingPhone, isBare)", async () => {
      const result = await withAgentContext((ctx) => handleContactsSearch({ query: "Agent" }, ctx))
      const alice = result.items.find((c) => c.id === aliceContactId)
      expect(alice).toHaveProperty("phone")
      expect(alice).toHaveProperty("createdAt")
      expect(alice?.phone ?? null).toBeNull()
      expect(alice?.missingCompany).toBe(false) // Alice has 'Acme'
      expect(alice?.missingPhone).toBe(true) // Alice has no phone
      expect(alice?.isBare).toBe(true) // bare = missing company OR phone
    })

    it("hasNoPhone filter returns the company-but-no-phone contacts (Alice + Bob)", async () => {
      const result = await withAgentContext((ctx) =>
        handleContactsSearch({ query: "Agent", hasNoPhone: true }, ctx),
      )
      const ids = result.items.map((c) => c.id)
      expect(ids).toContain(aliceContactId)
      expect(ids).toContain(bobContactId)
    })

    it("hasNoCompany filter EXCLUDES the contacts that DO have a company (fails-without proof)", async () => {
      // Alice/Bob both carry a company, so hasNoCompany:true must NOT return them — proving the filter
      // is load-bearing (without it the same query returns them).
      const filtered = await withAgentContext((ctx) =>
        handleContactsSearch({ query: "Agent", hasNoCompany: true }, ctx),
      )
      const filteredIds = filtered.items.map((c) => c.id)
      expect(filteredIds).not.toContain(aliceContactId)
      expect(filteredIds).not.toContain(bobContactId)
      const unfiltered = await withAgentContext((ctx) =>
        handleContactsSearch({ query: "Agent" }, ctx),
      )
      const unfilteredIds = unfiltered.items.map((c) => c.id)
      expect(unfilteredIds).toContain(aliceContactId)
      expect(unfilteredIds).toContain(bobContactId)
    })
  })

  describe("contacts.read", () => {
    it("returns contact with default backlink and timeline limits", async () => {
      const result = (await withAgentContext((ctx) =>
        handleContactsRead({ contactId: aliceContactId }, ctx),
      )) as any

      expect("error" in result).toBe(false)
      expect(result.contact.id).toBe(aliceContactId)
      expect(result.recentMailBacklinks.length).toBeLessThanOrEqual(3)
      expect(result.recentTimeline.length).toBeLessThanOrEqual(3)
    })

    it("returns up to 20 backlinks when includeBacklinks is true", async () => {
      const result = (await withAgentContext((ctx) =>
        handleContactsRead({ contactId: aliceContactId, includeBacklinks: true }, ctx),
      )) as any

      expect("error" in result).toBe(false)
      expect(result.recentMailBacklinks.length).toBeLessThanOrEqual(20)
    })

    it("returns NOT_FOUND for a missing contact", async () => {
      const result = await withAgentContext((ctx) =>
        handleContactsRead({ contactId: "00000000-0000-0000-0000-000000000000" }, ctx),
      )

      expect((result as any).error.code).toBe("NOT_FOUND")
    })
  })

  describe("contacts.write", () => {
    it("creates a new contact when contactId is omitted", async () => {
      const result = (await withAgentContext((ctx) =>
        handleContactsWrite({ name: "Dana", email: "dana@new.com" }, ctx),
      )) as any

      expect(result.contact.email).toBe("dana@new.com")
      expect(result.contact.id).toBeDefined()
    })

    it("updates an existing contact when contactId is provided", async () => {
      const result = (await withAgentContext((ctx) =>
        handleContactsWrite({ contactId: aliceContactId, phone: "+1-555-0100" }, ctx),
      )) as any

      expect(result.contact.phone).toBe("+1-555-0100")
    })

    it("returns EMAIL_IN_USE when email collides with another contact", async () => {
      const result = await withAgentContext((ctx) =>
        handleContactsWrite({ name: "Faux Alice", email: "alice@x.com" }, ctx),
      )

      expect((result as any).error?.code).toBe("EMAIL_IN_USE")
      expect((result as any).error?.existingContactId).toBe(aliceContactId)
    })

    // REGRESSION (enrich-dealer-contact-from-website): updating a BARE contact (no email) with an email
    // must PERSIST the email. The update path previously omitted `email` from the updates object, so an
    // enrichment that passed email got a 2xx but the record kept email=null — the exact judge-observed
    // bug. Fails-without (email stays null) / passes-with (email persists on the row AND the response).
    it("persists email when UPDATING a bare contact (email was silently dropped on update)", async () => {
      // A bare contact: name only, no email/phone/company — the enrich scenario's exact starting state.
      const created = (await withAgentContext((ctx) =>
        handleContactsWrite({ name: "Tonwerk Audio Test" }, ctx),
      )) as any
      expect("error" in created).toBe(false)
      const id: string = created.contact.id
      expect(created.contact.email).toBeNull()

      // Enrich: set email + phone + company + metadata in one update (contactId present).
      const updated = (await withAgentContext((ctx) =>
        handleContactsWrite(
          {
            contactId: id,
            email: "kontakt@tonwerk-audio.example",
            phone: "+49 30 6128 4470",
            company: "Tonwerk Audio",
            metadata: { address: "Skalitzer Strasse 134, 10999 Berlin, Germany" },
          },
          ctx,
        ),
      )) as any
      expect("error" in updated).toBe(false)
      // The returned record carries the email (not null) — the fabrication-of-effect the judge caught.
      expect(updated.contact.email).toBe("kontakt@tonwerk-audio.example")
      expect(updated.contact.phone).toBe("+49 30 6128 4470")
      expect(updated.contact.company).toBe("Tonwerk Audio")

      // And it actually landed in the DB (the authoritative record, not just the in-memory echo).
      const [row] = extractRows<{ email: string | null }>(
        await sql`SELECT email FROM kernel.contacts WHERE id = ${id} AND org_id = ${orgId}`,
      )
      expect(row?.email).toBe("kontakt@tonwerk-audio.example")
    })

    // The update-path email guard mirrors the create path: changing a contact's email to one ALREADY
    // used by a DIFFERENT contact returns a clean EMAIL_IN_USE, not a raw unique-constraint exception.
    it("returns EMAIL_IN_USE when an UPDATE sets an email already used by another contact", async () => {
      const result = await withAgentContext((ctx) =>
        handleContactsWrite({ contactId: bobContactId, email: "alice@x.com" }, ctx),
      )
      expect((result as any).error?.code).toBe("EMAIL_IN_USE")
      expect((result as any).error?.existingContactId).toBe(aliceContactId)
    })

    // REGRESSION (enrich-dealer-contact-from-website): a weak agent nests the phone under metadata
    // instead of the top-level `phone` arg, leaving the dedicated phone COLUMN null (so the detail view
    // shows no phone). The handler lifts metadata.phone → the phone column. Fails-without (column null,
    // value stranded in metadata) / passes-with (column populated, metadata.phone removed).
    it("lifts a phone nested in metadata onto the first-class phone column (enrichment placement trap)", async () => {
      const created = (await withAgentContext((ctx) =>
        handleContactsWrite({ name: "Phone Lift Test" }, ctx),
      )) as any
      const id: string = created.contact.id

      const updated = (await withAgentContext((ctx) =>
        handleContactsWrite(
          {
            contactId: id,
            company: "Tonwerk Audio",
            // The trap: phone nested under metadata instead of the top-level phone arg.
            metadata: {
              phone: "+49 30 6128 4470",
              address: "Skalitzer Strasse 134, 10999 Berlin, Germany",
            },
          },
          ctx,
        ),
      )) as any
      expect("error" in updated).toBe(false)
      // The dedicated column is populated…
      expect(updated.contact.phone).toBe("+49 30 6128 4470")
      // …and the value is no longer stranded under metadata.phone (but the address remains).
      expect(updated.contact.metadata?.phone).toBeUndefined()
      expect(updated.contact.metadata?.address).toBe("Skalitzer Strasse 134, 10999 Berlin, Germany")

      const [row] = extractRows<{ phone: string | null }>(
        await sql`SELECT phone FROM kernel.contacts WHERE id = ${id} AND org_id = ${orgId}`,
      )
      expect(row?.phone).toBe("+49 30 6128 4470")
    })

    // An EXPLICIT top-level phone always wins over a metadata phone (no surprise overwrite).
    it("keeps an explicit top-level phone even when metadata also carries one", async () => {
      const created = (await withAgentContext((ctx) =>
        handleContactsWrite({ name: "Phone Precedence Test" }, ctx),
      )) as any
      const id: string = created.contact.id

      const updated = (await withAgentContext((ctx) =>
        handleContactsWrite(
          { contactId: id, phone: "+49 30 0000 0001", metadata: { phone: "+49 30 9999 9999" } },
          ctx,
        ),
      )) as any
      expect(updated.contact.phone).toBe("+49 30 0000 0001")
    })
  })

  describe("contacts.merge", () => {
    it("merges two contacts and returns the survivor with reassignment count", async () => {
      await seedMailConversation(bobContactId, "bob-one")

      const result = (await withAgentContext((ctx) =>
        handleContactsMerge({ sourceId: bobContactId, targetId: aliceContactId }, ctx),
      )) as any

      expect(result.contact.id).toBe(aliceContactId)
      expect(result.mergedConversationCount).toBe(1)
      const queuedEvents = extractRows<{ payload: any }>(
        await sql`SELECT payload FROM kernel.pending_events WHERE org_id = ${orgId}`,
      ).map((event) => event.payload)
      expect(queuedEvents).toContainEqual(
        expect.objectContaining({
          app: "kernel",
          entity: "contact",
          action: "merge",
          entityId: aliceContactId,
          data: expect.objectContaining({ sourceId: bobContactId, mergedConversationCount: 1 }),
        }),
      )
    })

    it("summarizeContactsMerge names survivor + deleted contacts and warns the merge is irreversible", async () => {
      // The gated merge approval card must let the human see exactly which record survives, which is
      // deleted, and the resolved winning email — before approving an irreversible delete.
      const summary = await withRlsContext(actor, (tx) =>
        summarizeContactsMerge(
          {
            sourceId: bobContactId,
            targetId: aliceContactId,
            resolvedFields: { email: "alice@x.com" },
          },
          { tx, orgId, userId },
        ),
      )
      expect(summary.kind).toBe("contacts_merge")
      // Survivor = target (Alice), deleted = source (Bob); both rendered with name + email.
      expect(summary.title).toMatch(/Alice Agent <alice@x.com>/)
      const joined = summary.lines.join(" \n ")
      expect(joined).toMatch(/Survivor \(kept\): Alice Agent <alice@x.com>/)
      expect(joined).toMatch(/Deleted \(merged away\): Bob Agent <bob@y.com>/)
      expect(joined).toMatch(/IRREVERSIBLE/)
      expect(joined).toMatch(/email="alice@x.com"/)
    })

    it("rejects merge with sourceId equal to targetId", async () => {
      const result = await withAgentContext((ctx) =>
        handleContactsMerge({ sourceId: aliceContactId, targetId: aliceContactId }, ctx),
      )

      expect((result as any).error.code).toBe("INVALID_ARGUMENT")
    })

    it("returns NOT_FOUND when source or target contact is missing", async () => {
      const result = await withAgentContext((ctx) =>
        handleContactsMerge(
          { sourceId: "00000000-0000-0000-0000-000000000000", targetId: aliceContactId },
          ctx,
        ),
      )

      expect((result as any).error.code).toBe("NOT_FOUND")
    })

    it("merges 50 conversations and overlapping externalIds with target winning conflicts", async () => {
      await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
      for (let index = 0; index < 50; index++) {
        await seedMailConversation(bobContactId, `bulk-${index}`)
      }

      const result = (await withAgentContext((ctx) =>
        handleContactsMerge({ sourceId: bobContactId, targetId: aliceContactId }, ctx),
      )) as any

      expect(result.mergedConversationCount).toBe(50)
      expect(result.contact.externalIds.crm).toBe("target")
      expect(result.contact.externalIds.mailchimp).toBe("mc-1")
      const [refs] = extractRows<{ count: number }>(
        await sql`
        SELECT COUNT(*)::int AS count FROM app_mail.conversations WHERE org_id = ${orgId} AND contact_id = ${aliceContactId}
      `,
      )
      expect(refs.count).toBe(50)
    })

    it("rolls back contact changes and mail references when reassignment fails", async () => {
      await seedMailConversation(bobContactId, "rollback")

      const disarm = armAfterContactMergeFailpoint(() => {
        throw new Error("failpoint")
      })
      try {
        await expect(
          withAgentContext((ctx) =>
            mergeContactsWithMailReferences(ctx.db, {
              orgId,
              userId,
              sourceId: bobContactId,
              targetId: aliceContactId,
              resolvedFields: {},
            }),
          ),
        ).rejects.toThrow("failpoint")
      } finally {
        disarm()
      }

      const source = await withAgentContext((ctx) =>
        getContact(ctx.db, { orgId, contactId: bobContactId }),
      )
      expect(source).toBeDefined()
      const [refs] = extractRows<{ count: number }>(
        await sql`
        SELECT COUNT(*)::int AS count FROM app_mail.conversations WHERE org_id = ${orgId} AND contact_id = ${bobContactId}
      `,
      )
      expect(refs.count).toBeGreaterThan(0)
    })
  })
})

describe("contacts_write: its approval card and preflight", () => {
  it("contacts_write's card names the contact and lists each field with its new value", async () => {
    const card = await withAgentContext((ctx) =>
      summarizeContactsWrite(
        {
          contactId: aliceContactId,
          company: "Acme",
          tags: ["vip"],
          metadata: { city: "Lyon", phone: "+33 1 23 45 67 89" },
        },
        { tx: ctx.db, orgId, userId },
      ),
    )
    expect(card.title).toBe("Edit the contact Alice Agent <alice@x.com>")
    // The phone nested in metadata lands on its own field, as the handler writes it.
    expect(card.lines).toEqual([
      "Phone → +33 1 23 45 67 89",
      "Company → Acme",
      "Tags → vip",
      "city → Lyon",
    ])
    const create = await withAgentContext((ctx) =>
      summarizeContactsWrite({ name: "Bea", email: "bea@x.com" }, { tx: ctx.db, orgId, userId }),
    )
    expect(create.title).toBe("Create the contact Bea")
    expect(create.lines).toEqual(["Name → Bea", "Email → bea@x.com"])
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]))
    const capped = await withAgentContext((ctx) =>
      summarizeContactsWrite(
        { contactId: aliceContactId, metadata: many },
        { tx: ctx.db, orgId, userId },
      ),
    )
    expect(capped.lines).toHaveLength(8)
    expect(capped.lines[7]).toBe("and 3 more fields")
  })

  it("contacts_write's preflight refuses an empty write and an unknown contact", async () => {
    const ctx = { orgId, userId }
    expect(await contactsWritePreflight({ contactId: aliceContactId, company: "A" }, ctx)).toEqual({
      ok: true,
    })
    const empty = (await contactsWritePreflight({ contactId: aliceContactId }, ctx)) as {
      error?: { code: string }
    }
    expect(empty.error?.code).toBe("INVALID_ARGUMENT")
    const unknown = (await contactsWritePreflight(
      { contactId: "00000000-0000-0000-0000-000000e10fff", company: "A" },
      ctx,
    )) as { error?: { code: string } }
    expect(unknown.error?.code).toBe("NOT_FOUND")
    expect(await contactsWritePreflight({ name: "New person" }, ctx)).toEqual({ ok: true })
    const clash = (await contactsWritePreflight({ name: "Twin", email: "ALICE@x.com" }, ctx)) as {
      error?: { code: string; existingContactId?: string }
    }
    expect(clash.error).toMatchObject({ code: "EMAIL_IN_USE", existingContactId: aliceContactId })
    // Its own email on its own record is no clash.
    expect(
      await contactsWritePreflight({ contactId: aliceContactId, email: "alice@x.com" }, ctx),
    ).toEqual({ ok: true })
  })
})

// Under SCHEMA_PREFIX (every e2e and Playwright server) the contact tools must read
// the prefixed tables. Scratch `ctpfx_` copies of the four tables hold rows that
// exist ONLY there, while the unprefixed tables keep the regular fixtures, so a
// tool that still reads a fixed `app_mail.` / `kernel.` answers from the wrong
// rows and fails these assertions. The prefix is flipped only inside the RLS
// callback: Drizzle's kernel schema binds at import, `schemaRef` at call time.
describe("contact tools under a schema prefix read the prefixed tables", () => {
  const PREFIX = "ctpfx_"
  const prefixedConnectedAccountId = "00000000-0000-0000-0000-000000e10013"
  const prefixedAccountId = "00000000-0000-0000-0000-000000e10011"
  const prefixedContactId = "00000000-0000-0000-0000-000000e10012"
  const PREFIXED_EMAIL = "prefixed-only@x.com"

  async function withPrefixedAgentContext<T>(
    fn: (ctx: { db: any; userId: string; orgId: string }) => Promise<T>,
  ) {
    return withRlsContext(actor, async (db) => {
      const prior = process.env.SCHEMA_PREFIX
      process.env.SCHEMA_PREFIX = PREFIX
      try {
        return await fn({ db, userId, orgId })
      } finally {
        if (prior === undefined) delete process.env.SCHEMA_PREFIX
        else process.env.SCHEMA_PREFIX = prior
      }
    })
  }

  beforeAll(async () => {
    for (const schema of ["app_mail", "kernel"]) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${PREFIX}${schema} CASCADE`)
      await sql.unsafe(`CREATE SCHEMA ${PREFIX}${schema}`)
      await sql.unsafe(
        `GRANT USAGE ON SCHEMA ${PREFIX}${schema} TO liaison_rls, liaison_app, liaison_admin`,
      )
    }
    for (const [schema, table] of [
      ["app_mail", "accounts"],
      ["app_mail", "conversations"],
      ["kernel", "timeline_entries"],
      ["kernel", "contacts"],
    ]) {
      await sql.unsafe(
        `CREATE TABLE ${PREFIX}${schema}.${table} (LIKE ${schema}.${table} INCLUDING DEFAULTS)`,
      )
      await sql.unsafe(
        `GRANT SELECT ON ${PREFIX}${schema}.${table} TO liaison_rls, liaison_app, liaison_admin`,
      )
    }
  })

  // Runs after the file-level resetFixtures, which reseeds the unprefixed rows.
  beforeEach(async () => {
    await sql.unsafe(
      `TRUNCATE ${PREFIX}app_mail.accounts, ${PREFIX}app_mail.conversations, ${PREFIX}kernel.timeline_entries, ${PREFIX}kernel.contacts`,
    )
    await sql.unsafe(
      `INSERT INTO ${PREFIX}app_mail.accounts (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
       VALUES ($1, $2, $3, 'user', $4, 'gmail', 'prefixed@test.com', 'active')`,
      [prefixedAccountId, orgId, prefixedConnectedAccountId, userId],
    )
    await sql.unsafe(
      `INSERT INTO ${PREFIX}app_mail.conversations (
         id, org_id, account_id, owner_type, owner_id, external_thread_id,
         subject, snippet, contact_id, status, labels, is_read, is_starred, last_message_at, message_count
       ) VALUES (
         gen_random_uuid(), $1, $2, 'user', $3, 'thread-prefixed',
         'Prefixed subject', 'Prefixed snippet', $4, 'open', '["INBOX"]'::jsonb, false, false, now(), 1
       )`,
      [orgId, prefixedAccountId, userId, aliceContactId],
    )
    await sql.unsafe(
      `INSERT INTO ${PREFIX}kernel.timeline_entries (org_id, app, entity_type, entity_id, actor_id, actor_type, action, summary)
       VALUES ($1, 'kernel', 'contact', $2, $3, 'user', 'update', 'Prefixed timeline')`,
      [orgId, aliceContactId, userId],
    )
    await sql.unsafe(
      `INSERT INTO ${PREFIX}kernel.contacts (id, org_id, handle, name, email, phone, company, external_ids, created_by)
       VALUES ($1, $2, '@prefixed-only', 'Prefixed Only', $3, null, null, '{}'::jsonb, $4)`,
      [prefixedContactId, orgId, PREFIXED_EMAIL, userId],
    )
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${PREFIX}app_mail CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${PREFIX}kernel CASCADE`)
  })

  it("contacts.read returns the prefixed mail backlink and timeline, not the unprefixed rows", async () => {
    const result = (await withPrefixedAgentContext((ctx) =>
      handleContactsRead(
        { contactId: aliceContactId, includeBacklinks: true, includeTimeline: true },
        ctx,
      ),
    )) as any

    expect("error" in result).toBe(false)
    expect(result.recentMailBacklinks.map((b: any) => b.subject)).toEqual(["Prefixed subject"])
    expect(result.recentMailBacklinks[0].accountEmail).toBe("prefixed@test.com")
    expect(result.recentTimeline.map((t: any) => t.summary)).toEqual(["Prefixed timeline"])
  })

  it("contacts.write create path detects an email clash in the prefixed contacts table", async () => {
    const result = await withPrefixedAgentContext((ctx) =>
      handleContactsWrite({ name: "Faux Prefixed", email: PREFIXED_EMAIL }, ctx),
    )
    expect((result as any).error?.code).toBe("EMAIL_IN_USE")
    expect((result as any).error?.existingContactId).toBe(prefixedContactId)
  })

  it("contacts.write update path detects an email clash in the prefixed contacts table", async () => {
    const result = await withPrefixedAgentContext((ctx) =>
      handleContactsWrite({ contactId: bobContactId, email: PREFIXED_EMAIL }, ctx),
    )
    expect((result as any).error?.code).toBe("EMAIL_IN_USE")
    expect((result as any).error?.existingContactId).toBe(prefixedContactId)
  })
})
