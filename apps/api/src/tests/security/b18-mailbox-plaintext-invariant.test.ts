// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-SEC-10: Invariant P. For a mail row whose owning account is personal AND
// whose owner holds an active mailbox identity, no plaintext subject, body or
// snippet can enter the database, and `raw_headers` can carry no key outside
// the section 5.2 envelope allowlist.
//
// Three properties are load-bearing and each has its own group below.
//
//  1. The trigger ARMS on the existence of an active `kernel.user_mailbox_identities`
//     row, never on `app_mail.accounts.encryption_state`. `encryption_state` is
//     operational (it drives sync suspension and the UI) and a single
//     `UPDATE ... SET encryption_state = 'blocked'` must not be able to disarm a
//     database-level guarantee.
//  2. The trigger FAILS CLOSED. Its account lookup runs through a SECURITY DEFINER
//     helper, so a writer session that cannot see the account row is refused rather
//     than waved through with a NULL state.
//  3. The trigger fires only on values the encryption regime OWNS. A partial UPDATE
//     populates NEW with the unchanged OLD values, so a naive "raise when a guarded
//     column is non-NULL" predicate would make every markRead / archive / setLabels
//     write fail on a not-yet-backfilled row and brick an enrolled mailbox for the
//     whole migration window. Hence the SUCCEED group, which is not decoration: a run
//     that reports only raises means the fixture never built a legacy plaintext row.
//
// The harness registers the REAL manifest through `registerApps`, so the trigger
// under test is the one `ddl.ts` generates. A hand-rolled `CREATE TRIGGER` here
// would stay green with a broken manifest declaration.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { initEventBus } from "~/infra/events/event-bus"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const ORG_ID = "00000000-0000-0000-0000-0000000b1800"
const ARMED_USER_ID = "00000000-0000-0000-0000-0000000b1801"
const BARE_USER_ID = "00000000-0000-0000-0000-0000000b1802"
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000b1803"
const CONN_ID = "00000000-0000-0000-0000-0000000b1804"
const ARMED_ACCT = "00000000-0000-0000-0000-0000000b1805"
const BARE_ACCT = "00000000-0000-0000-0000-0000000b1806"
const SHARED_ACCT = "00000000-0000-0000-0000-0000000b1807"
const ARMED_CONV = "00000000-0000-0000-0000-0000000b1808"
const BARE_CONV = "00000000-0000-0000-0000-0000000b1809"
const SHARED_CONV = "00000000-0000-0000-0000-0000000b180a"
const LEGACY_MSG = "00000000-0000-0000-0000-0000000b180b"
const LEGACY_DRAFT = "00000000-0000-0000-0000-0000000b180c"
const GHOST_ACCT = "00000000-0000-0000-0000-0000000b18ff"

/** The section 5.2 envelope allowlist. A header outside it is content. */
const ALLOWED_HEADERS = [
  "message-id",
  "in-reply-to",
  "references",
  "date",
  "from",
  "to",
  "cc",
  "bcc",
  "return-path",
  "delivered-to",
  "content-type",
  "content-transfer-encoding",
  "list-unsubscribe",
  "list-id",
  "auto-submitted",
  "precedence",
]

async function expectRaises(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown
  try {
    await fn()
  } catch (err) {
    raised = err
  }
  expect(raised).toBeDefined()
  expect(String((raised as Error)?.message ?? raised)).toContain(code)
}

async function insertMessage(
  accountId: string,
  conversationId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const cols: Record<string, unknown> = {
    org_id: ORG_ID,
    conversation_id: conversationId,
    account_id: accountId,
    external_message_id: `ext-${Math.random().toString(36).slice(2)}`,
    message_references: "[]",
    from_address: JSON.stringify({ email: "a@example.com" }),
    to_addresses: "[]",
    cc_addresses: "[]",
    bcc_addresses: "[]",
    is_read: false,
    is_starred: false,
    labels: "[]",
    direction: "inbound",
    raw_headers: JSON.stringify({ "message-id": "<x@example.com>" }),
    owner_type: "user",
    ...extra,
  }
  const names = Object.keys(cols)
  const values = Object.values(cols)
  const placeholders = names.map((_, i) => `$${i + 1}`).join(", ")
  const rows = await sql.unsafe(
    `INSERT INTO app_mail.messages (${names.join(", ")}) VALUES (${placeholders}) RETURNING id`,
    values as never[],
  )
  return (rows as unknown as Array<{ id: string }>)[0].id
}

async function seedIdentity(): Promise<void> {
  await sql.unsafe(
    `INSERT INTO kernel.user_mailbox_identities
       (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
     VALUES ($1, $2, 1, '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, 'active')
     ON CONFLICT (user_id, key_id) DO UPDATE SET status = 'active'`,
    [ORG_ID, ARMED_USER_ID],
  )
}

async function dropIdentity(): Promise<void> {
  await sql.unsafe(`DELETE FROM kernel.user_mailbox_identities WHERE user_id = $1`, [ARMED_USER_ID])
}

describe("T-SEC-10, Invariant P: an armed mailbox cannot take plaintext", () => {
  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    try {
      await sql.unsafe(
        `INSERT INTO kernel.organizations (id, name, slug)
         VALUES ($1, 'Invariant P Org', 'invariant-p-org') ON CONFLICT (id) DO NOTHING`,
        [ORG_ID],
      )
      for (const [id, email] of [
        [ARMED_USER_ID, "armed-p@test.com"],
        [BARE_USER_ID, "bare-p@test.com"],
        [OTHER_USER_ID, "other-p@test.com"],
      ]) {
        await sql.unsafe(
          `INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
           VALUES ($1, $2, $3, 'hash', 'P User', 'active') ON CONFLICT (id) DO NOTHING`,
          [id, ORG_ID, email],
        )
      }
      await initSandboxPool()
      initEventBus()
      await registerApps([mailAppManifest as unknown as AppDescriptor], ORG_ID)

      await sql.unsafe(
        `INSERT INTO kernel.connected_accounts
           (id, org_id, app_name, connection_name, owner_type, provider_type, identifier, created_by)
         VALUES ($1, $2, 'mail', 'gmail', 'org', 'oauth2', 'invariant-p', $3)
         ON CONFLICT (id) DO NOTHING`,
        [CONN_ID, ORG_ID, ARMED_USER_ID],
      )
    } catch (err) {
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 60_000)

  afterAll(async () => {
    await releaseAppSchemaJsLock("app_mail")
  })

  beforeEach(async () => {
    // Order matters: the fixture's legacy plaintext rows are written while the
    // mailbox is DISARMED, exactly as a real pre-migration mailbox was, and the
    // identity is inserted afterwards. Seeding them the other way round would
    // trip the very trigger under test.
    await dropIdentity()
    await sql.unsafe(`DELETE FROM app_mail.drafts WHERE org_id = $1`, [ORG_ID])
    await sql.unsafe(`DELETE FROM app_mail.messages WHERE org_id = $1`, [ORG_ID])
    await sql.unsafe(`DELETE FROM app_mail.conversations WHERE org_id = $1`, [ORG_ID])
    await sql.unsafe(`DELETE FROM app_mail.accounts WHERE org_id = $1`, [ORG_ID])

    for (const [id, ownerType, ownerId, email] of [
      [ARMED_ACCT, "user", ARMED_USER_ID, "armed-box@test.com"],
      [BARE_ACCT, "user", BARE_USER_ID, "bare-box@test.com"],
      [SHARED_ACCT, "shared", null, "shared-box@test.com"],
    ] as Array<[string, string, string | null, string]>) {
      await sql.unsafe(
        `INSERT INTO app_mail.accounts
           (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
         VALUES ($1, $2, $3, $4, $5, 'gmail', $6, 'active')`,
        [id, ORG_ID, CONN_ID, ownerType, ownerId, email],
      )
    }
    for (const [id, acct, owner] of [
      [ARMED_CONV, ARMED_ACCT, "user"],
      [BARE_CONV, BARE_ACCT, "user"],
      [SHARED_CONV, SHARED_ACCT, "shared"],
    ]) {
      await sql.unsafe(
        `INSERT INTO app_mail.conversations
           (id, org_id, account_id, owner_type, external_thread_id, subject, snippet,
            status, labels, is_read, is_starred, message_count)
         VALUES ($1, $2, $3, $4, $5, 'Legacy subject', 'Legacy snippet', 'open', '[]', false, false, 0)`,
        [id, ORG_ID, acct, owner, `thread-${id}`],
      )
    }
    await sql.unsafe(
      `INSERT INTO app_mail.messages
         (id, org_id, conversation_id, account_id, external_message_id, message_references,
          from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body,
          html_body, snippet, is_read, is_starred, labels, direction, raw_headers, owner_type)
       VALUES ($1, $2, $3, $4, 'legacy-1', '[]', '{"email":"a@example.com"}', '[]', '[]', '[]',
               'Legacy subject', 'Legacy body', '<p>Legacy body</p>', 'Legacy snippet',
               false, false, '[]', 'inbound', '{"message-id":"<legacy@example.com>"}', 'user')`,
      [LEGACY_MSG, ORG_ID, ARMED_CONV, ARMED_ACCT],
    )
    await sql.unsafe(
      `INSERT INTO app_mail.drafts (id, org_id, account_id, "to", cc, bcc, created_by)
       VALUES ($1, $2, $3, '[]', '[]', '[]', $4)`,
      [LEGACY_DRAFT, ORG_ID, ARMED_ACCT, ARMED_USER_ID],
    )
    await seedIdentity()
  })

  describe("non-vacuity: the guard and the fixture both exist", () => {
    it("the trigger is installed on messages, conversations and drafts", async () => {
      const rows = (await sql.unsafe(
        `SELECT c.relname AS table_name
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app_mail' AND t.tgname = 'enforce_mailbox_plaintext_invariant'`,
      )) as unknown as Array<{ table_name: string }>
      expect(rows.map((r) => r.table_name).sort()).toEqual(["conversations", "drafts", "messages"])
    })

    it("both SECURITY DEFINER helpers exist and are owned by liaison_admin", async () => {
      const rows = (await sql.unsafe(
        `SELECT p.proname, p.prosecdef, r.rolname AS owner
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_roles r ON r.oid = p.proowner
          WHERE n.nspname = 'app_mail'
            AND p.proname IN ('mailbox_invariant_armed', 'mailbox_account_exists')`,
      )) as unknown as Array<{ proname: string; prosecdef: boolean; owner: string }>
      expect(rows.map((r) => r.proname).sort()).toEqual([
        "mailbox_account_exists",
        "mailbox_invariant_armed",
      ])
      for (const r of rows) {
        expect(r.prosecdef).toBe(true)
        expect(r.owner).toBe("liaison_admin")
      }
    })

    it("the fixture built an armed account holding a legacy plaintext message", async () => {
      const armed = (await sql.unsafe(`SELECT app_mail.mailbox_invariant_armed($1) AS armed`, [
        ARMED_ACCT,
      ])) as unknown as Array<{ armed: boolean }>
      expect(armed[0].armed).toBe(true)
      const bare = (await sql.unsafe(`SELECT app_mail.mailbox_invariant_armed($1) AS armed`, [
        BARE_ACCT,
      ])) as unknown as Array<{ armed: boolean }>
      expect(bare[0].armed).toBe(false)
      const legacy = (await sql.unsafe(
        `SELECT subject, text_body, snippet FROM app_mail.messages WHERE id = $1`,
        [LEGACY_MSG],
      )) as unknown as Array<{ subject: string; text_body: string; snippet: string }>
      expect(legacy[0].subject).toBe("Legacy subject")
      expect(legacy[0].text_body).toBe("Legacy body")
    })
  })

  describe("must SUCCEED: ordinary writes on a half-migrated armed mailbox", () => {
    it("marking a legacy plaintext message read succeeds", async () => {
      await sql.unsafe(`UPDATE app_mail.messages SET is_read = true WHERE id = $1`, [LEGACY_MSG])
      const rows = (await sql.unsafe(`SELECT is_read FROM app_mail.messages WHERE id = $1`, [
        LEGACY_MSG,
      ])) as unknown as Array<{ is_read: boolean }>
      expect(rows[0].is_read).toBe(true)
    })

    it("relabelling a legacy plaintext message succeeds", async () => {
      await sql.unsafe(`UPDATE app_mail.messages SET labels = '["x"]'::jsonb WHERE id = $1`, [
        LEGACY_MSG,
      ])
      const rows = (await sql.unsafe(`SELECT labels FROM app_mail.messages WHERE id = $1`, [
        LEGACY_MSG,
      ])) as unknown as Array<{ labels: unknown }>
      expect(rows[0].labels).toEqual(["x"])
    })

    it("a recomputeConversationState shaped update resupplying an identical snippet succeeds", async () => {
      await sql.unsafe(
        `UPDATE app_mail.conversations
            SET snippet = 'Legacy snippet', message_count = 3, last_message_at = now()
          WHERE id = $1`,
        [ARMED_CONV],
      )
      const rows = (await sql.unsafe(
        `SELECT message_count FROM app_mail.conversations WHERE id = $1`,
        [ARMED_CONV],
      )) as unknown as Array<{ message_count: number }>
      expect(rows[0].message_count).toBe(3)
    })

    it("a ciphertext only message insert succeeds on an armed account", async () => {
      const id = await insertMessage(ARMED_ACCT, ARMED_CONV, {
        text_body_ciphertext: Buffer.from("sealed"),
        enc_version: 1,
      })
      expect(id).toBeTruthy()
    })

    it("a draft insert with all three plaintext columns NULL succeeds", async () => {
      // Task 4.7. They shipped NOT NULL DEFAULT '', which made a sealed draft
      // physically impossible. This is the case that proves the constraint is
      // really gone against the REAL registered trigger, not just against
      // information_schema.
      const rows = (await sql.unsafe(
        `INSERT INTO app_mail.drafts (org_id, account_id, "to", cc, bcc, subject, html_body, text_body, created_by)
         VALUES ($1, $2, '[]', '[]', '[]', NULL, NULL, NULL, $3) RETURNING id, subject`,
        [ORG_ID, ARMED_ACCT, ARMED_USER_ID],
      )) as unknown as Array<{ id: string; subject: string | null }>
      expect(rows[0].id).toBeTruthy()
      expect(rows[0].subject).toBeNull()
    })

    it("a draft insert that omits the plaintext columns stores NULL, not an empty string", async () => {
      // Dropping the DEFAULT matters as much as dropping the NOT NULL: otherwise
      // an insert that omits the column reinstates '' after every purge.
      const rows = (await sql.unsafe(
        `INSERT INTO app_mail.drafts (org_id, account_id, "to", cc, bcc, created_by)
         VALUES ($1, $2, '[]', '[]', '[]', $3) RETURNING subject, html_body, text_body`,
        [ORG_ID, ARMED_ACCT, ARMED_USER_ID],
      )) as unknown as Array<{ subject: unknown; html_body: unknown; text_body: unknown }>
      expect(rows[0].subject).toBeNull()
      expect(rows[0].html_body).toBeNull()
      expect(rows[0].text_body).toBeNull()
    })

    it("an existing legacy draft row still holding an empty string is accepted", async () => {
      // Existing rows keep '' and are deliberately NOT rewritten. The trigger
      // compares NULLIF(NEW.c, ''), so a blank draft field is not a violation.
      await sql.unsafe(`UPDATE app_mail.drafts SET subject = '' WHERE id = $1`, [LEGACY_DRAFT])
      await sql.unsafe(
        `UPDATE app_mail.drafts SET "to" = '["a@example.com"]'::jsonb WHERE id = $1`,
        [LEGACY_DRAFT],
      )
      const rows = (await sql.unsafe(`SELECT subject FROM app_mail.drafts WHERE id = $1`, [
        LEGACY_DRAFT,
      ])) as unknown as Array<{ subject: string }>
      expect(rows[0].subject).toBe("")
    })

    it("a draft insert leaving the plaintext columns blank succeeds", async () => {
      const rows = (await sql.unsafe(
        `INSERT INTO app_mail.drafts (org_id, account_id, "to", cc, bcc, subject, html_body, text_body, created_by)
         VALUES ($1, $2, '[]', '[]', '[]', '', '', '', $3) RETURNING id`,
        [ORG_ID, ARMED_ACCT, ARMED_USER_ID],
      )) as unknown as Array<{ id: string }>
      expect(rows[0].id).toBeTruthy()
    })

    it("every guarded write succeeds on a personal account with no active identity", async () => {
      await sql.unsafe(`UPDATE app_mail.conversations SET subject = 'Anything' WHERE id = $1`, [
        BARE_CONV,
      ])
      const id = await insertMessage(BARE_ACCT, BARE_CONV, {
        subject: "Plain subject",
        text_body: "Plain body",
        raw_headers: JSON.stringify({ "x-mailer": "anything" }),
      })
      expect(id).toBeTruthy()
    })

    it("every guarded write succeeds on a shared org account", async () => {
      await sql.unsafe(`UPDATE app_mail.conversations SET subject = 'Anything' WHERE id = $1`, [
        SHARED_CONV,
      ])
      const id = await insertMessage(SHARED_ACCT, SHARED_CONV, {
        owner_type: "shared",
        subject: "Plain subject",
        text_body: "Plain body",
        raw_headers: JSON.stringify({ "x-mailer": "anything" }),
      })
      expect(id).toBeTruthy()
    })
  })

  describe("must RAISE mailbox_plaintext_forbidden", () => {
    it("an INSERT carrying a subject raises", async () => {
      await expectRaises(
        () => insertMessage(ARMED_ACCT, ARMED_CONV, { subject: "Secret" }),
        "mailbox_plaintext_forbidden",
      )
    })

    it("an INSERT carrying a text body raises", async () => {
      await expectRaises(
        () => insertMessage(ARMED_ACCT, ARMED_CONV, { text_body: "Secret" }),
        "mailbox_plaintext_forbidden",
      )
    })

    it("an UPDATE changing text_body to a new value raises", async () => {
      await expectRaises(
        () =>
          sql.unsafe(`UPDATE app_mail.messages SET text_body = 'Changed' WHERE id = $1`, [
            LEGACY_MSG,
          ]),
        "mailbox_plaintext_forbidden",
      )
    })

    it("an UPDATE setting a subject where it was NULL raises", async () => {
      const id = await insertMessage(ARMED_ACCT, ARMED_CONV, {})
      await expectRaises(
        () => sql.unsafe(`UPDATE app_mail.messages SET subject = 'New' WHERE id = $1`, [id]),
        "mailbox_plaintext_forbidden",
      )
    })

    it("the same three raise against a conversation", async () => {
      await expectRaises(
        () =>
          sql.unsafe(
            `INSERT INTO app_mail.conversations
               (org_id, account_id, owner_type, external_thread_id, subject, status, labels,
                is_read, is_starred, message_count)
             VALUES ($1, $2, 'user', 'thread-new', 'Secret', 'open', '[]', false, false, 0)`,
            [ORG_ID, ARMED_ACCT],
          ),
        "mailbox_plaintext_forbidden",
      )
      await expectRaises(
        () =>
          sql.unsafe(`UPDATE app_mail.conversations SET snippet = 'Changed' WHERE id = $1`, [
            ARMED_CONV,
          ]),
        "mailbox_plaintext_forbidden",
      )
      await expectRaises(
        () =>
          sql.unsafe(`UPDATE app_mail.conversations SET subject = 'Changed' WHERE id = $1`, [
            ARMED_CONV,
          ]),
        "mailbox_plaintext_forbidden",
      )
    })

    it("a draft update setting a non-empty subject raises", async () => {
      await expectRaises(
        () =>
          sql.unsafe(`UPDATE app_mail.drafts SET subject = 'Secret' WHERE id = $1`, [LEGACY_DRAFT]),
        "mailbox_plaintext_forbidden",
      )
    })

    it("a draft update setting a non-empty html body raises", async () => {
      await expectRaises(
        () =>
          sql.unsafe(`UPDATE app_mail.drafts SET html_body = '<p>Secret</p>' WHERE id = $1`, [
            LEGACY_DRAFT,
          ]),
        "mailbox_plaintext_forbidden",
      )
    })
  })

  describe("must RAISE mailbox_headers_forbidden", () => {
    it("an INSERT whose raw_headers carries x-mailer raises", async () => {
      await expectRaises(
        () =>
          insertMessage(ARMED_ACCT, ARMED_CONV, {
            raw_headers: JSON.stringify({ "message-id": "<a@b>", "x-mailer": "Outlook" }),
          }),
        "mailbox_headers_forbidden",
      )
    })

    it("an UPDATE replacing raw_headers with one carrying subject raises", async () => {
      await expectRaises(
        () =>
          sql.unsafe(
            `UPDATE app_mail.messages SET raw_headers = '{"subject":"Secret"}'::jsonb WHERE id = $1`,
            [LEGACY_MSG],
          ),
        "mailbox_headers_forbidden",
      )
    })

    it("every allowlisted header together is accepted", async () => {
      const headers: Record<string, string> = {}
      for (const h of ALLOWED_HEADERS) headers[h] = "value"
      const id = await insertMessage(ARMED_ACCT, ARMED_CONV, {
        raw_headers: JSON.stringify(headers),
      })
      expect(id).toBeTruthy()
    })
  })

  describe("arming is not flippable through encryption_state", () => {
    for (const state of ["blocked", "paused"]) {
      it(`a plaintext insert still raises with the account at ${state}`, async () => {
        await sql.unsafe(`UPDATE app_mail.accounts SET encryption_state = $2 WHERE id = $1`, [
          ARMED_ACCT,
          state,
        ])
        await expectRaises(
          () => insertMessage(ARMED_ACCT, ARMED_CONV, { subject: "Secret" }),
          "mailbox_plaintext_forbidden",
        )
      })
    }

    it("removing the active identity is the only disarm", async () => {
      // Documented deliberately: deleting the identity row disarms the trigger.
      // Phase 13's downgrade detector is what makes that event visible; there is
      // no cheaper in-database disarm.
      await dropIdentity()
      const id = await insertMessage(ARMED_ACCT, ARMED_CONV, { subject: "Now allowed" })
      expect(id).toBeTruthy()
    })

    it("retiring every identity disarms, an extra active identity does not", async () => {
      await sql.unsafe(
        `UPDATE kernel.user_mailbox_identities SET status = 'retired' WHERE user_id = $1`,
        [ARMED_USER_ID],
      )
      const id = await insertMessage(ARMED_ACCT, ARMED_CONV, { subject: "Now allowed" })
      expect(id).toBeTruthy()
      await seedIdentity()
      await expectRaises(
        () => insertMessage(ARMED_ACCT, ARMED_CONV, { subject: "Secret" }),
        "mailbox_plaintext_forbidden",
      )
    })
  })

  describe("fails closed, never open", () => {
    it("a write against an unresolvable account raises mailbox_account_unresolved", async () => {
      await expectRaises(
        () => insertMessage(GHOST_ACCT, ARMED_CONV, { subject: "Secret" }),
        "mailbox_account_unresolved",
      )
    })

    it("the armed lookup survives a session that cannot see the account", async () => {
      // This is the fail-closed proof. `app_mail.accounts` carries FORCE RLS with
      // a deny-default policy and a personalScope owner check, so an INLINE lookup
      // from inside a SECURITY INVOKER trigger would see zero rows for this
      // session, read the state as NULL, and let the write through. The helper is
      // SECURITY DEFINER, so it answers truthfully. Both halves are asserted in
      // one session so the second cannot be explained away by the first.
      const seen = await withRlsContext(
        {
          actorType: "user",
          userId: OTHER_USER_ID,
          orgId: ORG_ID,
          scopes: ["*"],
          dimensionGrants: { "*": ["*"] },
        },
        async (tx) => {
          const { sql: ds } = await import("drizzle-orm")
          const blind = extractRows<{ n: string }>(
            await tx.execute(
              ds`SELECT count(*)::text AS n FROM app_mail.accounts WHERE id = ${ARMED_ACCT}`,
            ),
          )
          const armed = extractRows<{ armed: boolean }>(
            await tx.execute(ds`SELECT app_mail.mailbox_invariant_armed(${ARMED_ACCT}) AS armed`),
          )
          return { visible: Number(blind[0].n), armed: armed[0].armed }
        },
      )
      expect(seen.visible).toBe(0)
      expect(seen.armed).toBe(true)
    })

    it("a guarded insert inside a blind RLS session raises and lands nothing", async () => {
      const before = (await sql.unsafe(
        `SELECT count(*)::int AS n FROM app_mail.messages WHERE account_id = $1`,
        [ARMED_ACCT],
      )) as unknown as Array<{ n: number }>
      let raised: unknown
      try {
        await withRlsContext(
          {
            actorType: "user",
            userId: OTHER_USER_ID,
            orgId: ORG_ID,
            scopes: ["*"],
            dimensionGrants: { "*": ["*"] },
          },
          async (tx) => {
            const { sql: ds } = await import("drizzle-orm")
            await tx.execute(ds`INSERT INTO app_mail.messages
                 (org_id, conversation_id, account_id, external_message_id, message_references,
                  from_address, to_addresses, cc_addresses, bcc_addresses, subject,
                  is_read, is_starred, labels, direction, raw_headers, owner_type)
               VALUES (${ORG_ID}, ${ARMED_CONV}, ${ARMED_ACCT}, 'blind-1', '[]',
                       '{"email":"a@example.com"}', '[]', '[]', '[]', 'Secret',
                       false, false, '[]', 'inbound', '{}', 'user')`)
          },
        )
      } catch (err) {
        raised = err
      }
      expect(raised).toBeDefined()
      // Assert the TRIGGER is what refused, not RLS. Without this the case is
      // vacuous: a deny-default RLS policy rejects this insert on its own, so a
      // bare "something threw" assertion stays green with the trigger dropped
      // entirely, which is the exact fail-open A2 exists to rule out.
      // Drizzle wraps the driver error, so read the whole cause chain.
      let chain = ""
      for (let e: any = raised; e; e = e.cause) chain += `${e.message ?? String(e)}\n`
      expect(chain).toMatch(/mailbox_plaintext_forbidden|mailbox_account_unresolved/)
      const after = (await sql.unsafe(
        `SELECT count(*)::int AS n FROM app_mail.messages WHERE account_id = $1`,
        [ARMED_ACCT],
      )) as unknown as Array<{ n: number }>
      expect(after[0].n).toBe(before[0].n)
    })
  })
})
