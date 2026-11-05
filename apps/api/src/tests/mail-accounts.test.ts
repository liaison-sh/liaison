// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { type AppEvent, initEventBus } from "~/infra/events/event-bus"
import {
  connectionConfigRegistry,
  getDeclaredEmits,
  resetAppRegistries,
  setDeclaredEmits,
} from "~/modules/apps/app-registries"
import {
  createCredentialConnection,
  disconnectConnection,
} from "~/modules/apps/connections/service"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { processTranslationEvent } from "~/modules/attention/translator"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000301"
const USER_A_ID = "00000000-0000-0000-0000-000000000302"

describe("mail accounts integration", () => {
  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    await acquireAppSchemaJsLock("app_tickets")
    try {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG_ID}, 'Mail Integration Org', 'mail-int-test')
      ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name)
      VALUES (${USER_A_ID}, ${TEST_ORG_ID}, 'alice-mail@test.com', 'hash', 'Alice Mail')
      ON CONFLICT (id) DO NOTHING`

      await initSandboxPool()
      initEventBus()

      // Register once — registerApps + BullMQ scheduled jobs can be slow
      setDeclaredEmits(
        "*",
        "kernel",
        new Set(["connected_account:create", "connected_account:disconnect"]),
      )
      await registerApps(
        [
          mailAppManifest as unknown as AppDescriptor,
          ticketsAppManifest as unknown as AppDescriptor,
        ],
        TEST_ORG_ID,
      )
    } catch (err) {
      await releaseAppSchemaJsLock("app_tickets")
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 30_000)

  beforeEach(async () => {
    // Only clean data, don't re-register (avoids BullMQ timeout)
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${TEST_ORG_ID}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${TEST_ORG_ID}`
    // Clean extension table if it exists
    try {
      await sql.unsafe(`DELETE FROM app_mail.accounts WHERE org_id = '${TEST_ORG_ID}'`)
    } catch {}
  })

  afterAll(async () => {
    try {
      await sql`DELETE FROM kernel.apps WHERE name IN ('mail', 'tickets')`
      await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${TEST_ORG_ID}`
      await sql`DELETE FROM kernel.attention_events WHERE org_id = ${TEST_ORG_ID}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG_ID}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
      resetAppRegistries()
    } finally {
      await releaseAppSchemaJsLock("app_tickets")
      await releaseAppSchemaJsLock("app_mail")
    }
  })

  it("creates app_mail schema and accounts table with constraints and indexes", async () => {
    const [tableCheck] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_mail' AND table_name = 'accounts'
      ) AS "exists"
    `
    expect(tableCheck.exists).toBe(true)

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app_mail' AND table_name = 'accounts'
      ORDER BY ordinal_position
    `
    const colNames = cols.map((c: any) => c.column_name)
    expect(colNames).toContain("connected_account_id")
    expect(colNames).toContain("owner_type")
    expect(colNames).toContain("email_address")
    expect(colNames).toContain("sync_status")

    const constraints = await sql`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema = 'app_mail' AND table_name = 'accounts' AND constraint_type = 'UNIQUE'
    `
    expect(constraints.length).toBeGreaterThan(0)

    const indexes = await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'app_mail' AND tablename = 'accounts'
    `
    const indexNames = indexes.map((i: any) => i.indexname)
    expect(indexNames.some((n: string) => n.includes("sync_status"))).toBe(true)
    expect(indexNames.some((n: string) => n.includes("connected_account_id"))).toBe(true)
  })

  it("populates connection config registry for gmail and imap", () => {
    const gmailConfig = connectionConfigRegistry.get([TEST_ORG_ID, "mail", "gmail"])
    expect(gmailConfig).toBeDefined()
    expect(gmailConfig!.type).toBe("oauth2")
    expect(gmailConfig!.extraParams).toEqual({ access_type: "offline", prompt: "consent" })

    const imapConfig = connectionConfigRegistry.get([TEST_ORG_ID, "mail", "imap"])
    expect(imapConfig).toBeDefined()
    expect(imapConfig!.type).toBe("credentials")
  })

  it("kernel declared emits include connected_account events", () => {
    const emits = getDeclaredEmits("*", "kernel")
    expect(emits?.has("connected_account:create")).toBe(true)
    expect(emits?.has("connected_account:disconnect")).toBe(true)
  })

  it("IMAP credential connection creates kernel row and emits event", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: USER_A_ID,
        orgId: TEST_ORG_ID,
        scopes: ["mail:*"],
        dimensionGrants: {},
      },
      async (tx) => {
        const account = await createCredentialConnection(
          tx,
          TEST_ORG_ID,
          USER_A_ID,
          "mail",
          "imap",
          {
            identifier: "alice@example.com",
            credentials: {
              email: "alice@example.com",
              imapHost: "imap.example.com",
              imapPort: "993",
              smtpHost: "smtp.example.com",
              smtpPort: "587",
              username: "alice@example.com",
              password: "secret",
            },
          },
        )

        expect(account.status).toBe("active")
        expect(account.identifier).toBe("alice@example.com")
        expect(account.ownerType).toBe("user")
      },
    )

    const [kernelRow] = await sql`
      SELECT * FROM kernel.connected_accounts
      WHERE org_id = ${TEST_ORG_ID} AND app_name = 'mail' AND connection_name = 'imap'
    `
    expect(kernelRow).toBeDefined()
    expect(kernelRow.identifier).toBe("alice@example.com")

    const events = await sql`
      SELECT * FROM kernel.pending_events
      WHERE org_id = ${TEST_ORG_ID} AND payload->>'app' = 'kernel' AND payload->>'entity' = 'connected_account' AND payload->>'action' = 'create'
    `
    expect(events.length).toBeGreaterThan(0)
  })

  it("org-level credential connection sets ownerType and null ownerId", async () => {
    // Org-level connections use withPrivilegedDb so INSERT...RETURNING works under RLS
    const { withPrivilegedDb } = await import("~/db/privileged")
    const account = await withPrivilegedDb(TEST_ORG_ID, "test-org-conn", async (tx) => {
      return createCredentialConnection(tx as any, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
        identifier: "shared@example.com",
        credentials: {
          email: "shared@example.com",
          imapHost: "imap.example.com",
          imapPort: "993",
          smtpHost: "smtp.example.com",
          smtpPort: "587",
          username: "shared@example.com",
          password: "secret",
        },
        ownerType: "org",
      })
    })

    expect(account.ownerType).toBe("org")
    expect(account.ownerId).toBeNull()
  })

  it("an org holds several shared mailboxes: another address is another account, the same address rotates", async () => {
    const { withPrivilegedDb } = await import("~/db/privileged")
    const orgSave = (email: string, password: string) =>
      withPrivilegedDb(TEST_ORG_ID, "test-org-conn", async (tx) =>
        createCredentialConnection(tx as any, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
          identifier: email,
          ownerType: "org",
          credentials: {
            email,
            username: email,
            password,
            imapHost: "imap.example.com",
            imapPort: "993",
            smtpHost: "smtp.example.com",
            smtpPort: "465",
          },
        }),
      )
    const first = await orgSave("shared-a@example.com", "one")
    const second = await orgSave("shared-b@example.com", "two")
    expect(second.id).not.toBe(first.id)
    const rotated = await orgSave("shared-a@example.com", "three")
    expect(rotated.id).toBe(first.id)
  })

  it("an org mailbox is the same mailbox whatever the address's case: the row rotates and keeps its stored address", async () => {
    const { withPrivilegedDb } = await import("~/db/privileged")
    const orgSave = (email: string, password: string) =>
      withPrivilegedDb(TEST_ORG_ID, "test-org-conn-case", async (tx) =>
        createCredentialConnection(tx as any, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
          identifier: email,
          ownerType: "org",
          credentials: {
            email,
            username: email,
            password,
            imapHost: "imap.example.com",
            imapPort: "993",
            smtpHost: "smtp.example.com",
            smtpPort: "465",
          },
        }),
      )
    // A row saved before the match ignored case, in the case it was typed in.
    const old = await orgSave("Support-Case@Example.com", "one")
    const rotated = await orgSave("support-case@example.com", "two")
    expect(rotated.id).toBe(old.id)
    // Mail's account and its token lookup hold the stored spelling.
    expect(rotated.identifier).toBe("Support-Case@Example.com")
    const rows = await sql<{ identifier: string }[]>`
      SELECT identifier FROM kernel.connected_accounts
      WHERE org_id = ${TEST_ORG_ID} AND lower(identifier) = 'support-case@example.com' AND status = 'active'`
    expect(rows.map((r) => r.identifier)).toEqual(["Support-Case@Example.com"])
  })

  it("a member cannot hold, in another case, a mailbox the org holds", async () => {
    const { withPrivilegedDb } = await import("~/db/privileged")
    const creds = (email: string) => ({
      email,
      username: email,
      password: "p",
      imapHost: "imap.example.com",
      imapPort: "993",
      smtpHost: "smtp.example.com",
      smtpPort: "465",
    })
    await withPrivilegedDb(TEST_ORG_ID, "test-org-conn-case", async (tx) =>
      createCredentialConnection(tx as any, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
        identifier: "desk-case@example.com",
        ownerType: "org",
        credentials: creds("desk-case@example.com"),
      }),
    )
    await expect(
      withPrivilegedDb(TEST_ORG_ID, "test-user-conn-case", async (tx) =>
        createCredentialConnection(tx as any, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
          identifier: "Desk-Case@example.com",
          ownerType: "user",
          credentials: creds("Desk-Case@example.com"),
        }),
      ),
    ).rejects.toMatchObject({ code: "connection_held_by_other_owner" })
  })

  it("generic listConnections filters out org-owned app connections", async () => {
    const { withPrivilegedDb } = await import("~/db/privileged")
    const { listConnections } = await import("~/modules/apps/connections/service")

    // Create an org-owned mail connection
    await withPrivilegedDb(TEST_ORG_ID, "test-org-filter", async (tx) => {
      await createCredentialConnection(tx as any, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
        identifier: "org-filter@example.com",
        credentials: {
          email: "org-filter@example.com",
          imapHost: "h",
          imapPort: "993",
          smtpHost: "s",
          smtpPort: "587",
          username: "u",
          password: "p",
        },
        ownerType: "org",
      })
    })

    // Create a user-owned mail connection
    await withRlsContext(
      {
        actorType: "user",
        userId: USER_A_ID,
        orgId: TEST_ORG_ID,
        scopes: ["mail:*"],
        dimensionGrants: {},
      },
      async (tx) => {
        await createCredentialConnection(tx, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
          identifier: "personal@example.com",
          credentials: {
            email: "personal@example.com",
            imapHost: "h",
            imapPort: "993",
            smtpHost: "s",
            smtpPort: "587",
            username: "u",
            password: "p",
          },
        })
      },
    )

    // Generic list should exclude org-owned app connections
    const accounts = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A_ID,
        orgId: TEST_ORG_ID,
        scopes: ["mail:*"],
        dimensionGrants: {},
      },
      async (tx) => listConnections(tx, TEST_ORG_ID, USER_A_ID),
    )
    const orgOwned = accounts.filter((a) => a.ownerType === "org" && a.appName !== "kernel")
    expect(orgOwned.length).toBe(0)
    const personal = accounts.filter((a) => a.identifier === "personal@example.com")
    expect(personal.length).toBe(1)
  })

  it("listConnectionAccounts returns status field for kernel metadata enrichment", async () => {
    const { listConnectionAccounts } = await import("~/modules/apps/connections/service")

    await withRlsContext(
      {
        actorType: "user",
        userId: USER_A_ID,
        orgId: TEST_ORG_ID,
        scopes: ["mail:*"],
        dimensionGrants: {},
      },
      async (tx) => {
        await createCredentialConnection(tx, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
          identifier: "status-test@example.com",
          credentials: {
            email: "status-test@example.com",
            imapHost: "h",
            imapPort: "993",
            smtpHost: "s",
            smtpPort: "587",
            username: "u",
            password: "p",
          },
        })
        const accounts = await listConnectionAccounts(tx, TEST_ORG_ID, USER_A_ID, "mail", "imap")
        expect(accounts.length).toBeGreaterThan(0)
        expect(accounts[0]).toHaveProperty("status")
        expect(accounts[0].status).toBe("active")
      },
    )
  })

  it("disconnect marks kernel row as disconnected and emits event", async () => {
    let accountId: string
    await withRlsContext(
      {
        actorType: "user",
        userId: USER_A_ID,
        orgId: TEST_ORG_ID,
        scopes: ["mail:*"],
        dimensionGrants: {},
      },
      async (tx) => {
        const account = await createCredentialConnection(
          tx,
          TEST_ORG_ID,
          USER_A_ID,
          "mail",
          "imap",
          {
            identifier: "disconnect-test@example.com",
            credentials: {
              email: "disconnect-test@example.com",
              imapHost: "h",
              imapPort: "993",
              smtpHost: "s",
              smtpPort: "587",
              username: "u",
              password: "p",
            },
          },
        )
        accountId = account.id
      },
    )

    await withRlsContext(
      {
        actorType: "user",
        userId: USER_A_ID,
        orgId: TEST_ORG_ID,
        scopes: ["mail:*"],
        dimensionGrants: {},
      },
      async (tx) => {
        await disconnectConnection(tx, TEST_ORG_ID, USER_A_ID, accountId!)
      },
    )

    const [row] = await sql`
      SELECT status, disconnected_at FROM kernel.connected_accounts WHERE id = ${accountId!}
    `
    expect(row.status).toBe("disconnected")
    expect(row.disconnected_at).not.toBeNull()

    const events = await sql`
      SELECT * FROM kernel.pending_events
      WHERE org_id = ${TEST_ORG_ID} AND payload->>'app' = 'kernel' AND payload->>'entity' = 'connected_account' AND payload->>'action' = 'disconnect'
    `
    expect(events.length).toBeGreaterThan(0)
  })

  it("event handler creates extension row after outbox processing", async () => {
    let kernelAccountId: string
    await withRlsContext(
      {
        actorType: "user",
        userId: USER_A_ID,
        orgId: TEST_ORG_ID,
        scopes: ["mail:*"],
        dimensionGrants: {},
      },
      async (tx) => {
        const account = await createCredentialConnection(
          tx,
          TEST_ORG_ID,
          USER_A_ID,
          "mail",
          "imap",
          {
            identifier: "ext-row@example.com",
            credentials: {
              email: "ext-row@example.com",
              imapHost: "imap.example.com",
              imapPort: "993",
              smtpHost: "smtp.example.com",
              smtpPort: "587",
              username: "ext-row@example.com",
              password: "secret",
            },
          },
        )
        kernelAccountId = account.id
      },
    )
    const { processOutboxBatch } = await import("~/infra/events/outbox-worker")
    await processOutboxBatch()

    // Event handler executes asynchronously via Redis pub/sub — poll for the extension row
    let extensionRows: any[] = []
    for (let i = 0; i < 20; i++) {
      extensionRows = await sql`
        SELECT * FROM app_mail.accounts
        WHERE connected_account_id = ${kernelAccountId!} AND org_id = ${TEST_ORG_ID}
      `
      if (extensionRows.length > 0) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(extensionRows.length).toBe(1)
    expect(extensionRows[0].sync_status).toBe("pre-sync")
    expect(extensionRows[0].email_address).toBe("ext-row@example.com")
  })
  // A MAILBOX BELONGS TO ITS OWNER. The mail row of an address is matched to a
  // connect by owner too, never by address alone: a member's personal connect
  // of an address the organization once connected (and disconnected) used to
  // rebind the org's shared row, so the member's own mail synced into an
  // org-owned mailbox that mail admins see, with no mailbox password.
  describe("a connect binds only to its own owner's mailbox", () => {
    const IMAP = (email: string, password = "secret") => ({
      email,
      imapHost: "imap.example.com",
      imapPort: "993",
      smtpHost: "smtp.example.com",
      smtpPort: "587",
      username: email,
      password,
    })
    const USER_CTX = {
      actorType: "user" as const,
      userId: USER_A_ID,
      orgId: TEST_ORG_ID,
      scopes: ["mail:*"],
      dimensionGrants: {},
    }
    /** IMAP logins the stand-in mail server accepts: no real server in tests. */
    const goodPasswords = new Set(["secret"])

    beforeAll(async () => {
      const { ForeignMailAccountTestAccess } = await import("~/modules/mail/purge-account")
      ForeignMailAccountTestAccess.setImapLoginCheck(async (creds) => {
        if (!goodPasswords.has(creds.password ?? "")) throw new Error("IMAP authentication failed")
      })
    })
    afterAll(async () => {
      const { ForeignMailAccountTestAccess } = await import("~/modules/mail/purge-account")
      ForeignMailAccountTestAccess.setImapLoginCheck(null)
    })

    async function seedRow(
      email: string,
      owner: { type: "org" | "user"; id: string | null },
      syncStatus: string,
      connectedAccountId: string | null = null,
    ): Promise<string> {
      const [row] = await sql`
        INSERT INTO app_mail.accounts
          (org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, disconnected_at)
        VALUES (${TEST_ORG_ID}, COALESCE(${connectedAccountId}::uuid, gen_random_uuid()),
          ${owner.type}, ${owner.id}, 'imap', ${email},
          ${syncStatus}, CASE WHEN ${syncStatus} = 'disconnected' THEN now() END)
        RETURNING id
      `
      return row.id as string
    }

    /** A conversation an old disconnect left behind (before purge-on-disconnect). */
    async function seedConversation(accountId: string): Promise<void> {
      await sql`
        INSERT INTO app_mail.conversations
          (org_id, account_id, owner_type, external_thread_id, status, labels, is_read,
           is_starred, message_count)
        VALUES (${TEST_ORG_ID}, ${accountId}, 'org', ${`thread-${accountId}`}, 'open', '[]'::jsonb,
          false, false, 1)
      `
    }

    async function rowsFor(email: string) {
      return await sql`
        SELECT id, owner_type, owner_id, connected_account_id, encryption_state, sync_status
        FROM app_mail.accounts WHERE org_id = ${TEST_ORG_ID} AND email_address = ${email}
      `
    }

    async function connectionStatus(id: string): Promise<string | undefined> {
      return (await sql`SELECT status FROM kernel.connected_accounts WHERE id = ${id}`)[0]
        ?.status as string | undefined
    }

    async function settle(until: () => Promise<boolean>) {
      const { processOutboxBatch } = await import("~/infra/events/outbox-worker")
      await processOutboxBatch()
      for (let i = 0; i < 60; i++) {
        if (await until()) return
        await new Promise((r) => setTimeout(r, 100))
        if (i % 10 === 9) await processOutboxBatch()
      }
    }

    async function personalImap(email: string, password = "secret") {
      return await withRlsContext(USER_CTX, (tx) =>
        createCredentialConnection(tx, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
          identifier: email,
          credentials: IMAP(email, password),
        }),
      )
    }

    async function orgImap(email: string, takeOver = false) {
      const { withPrivilegedDb } = await import("~/db/privileged")
      return await withPrivilegedDb(TEST_ORG_ID, "test-org-conn", (tx) =>
        createCredentialConnection(tx, TEST_ORG_ID, USER_A_ID, "mail", "imap", {
          identifier: email,
          credentials: IMAP(email),
          ownerType: "org",
          takeOver,
        }),
      )
    }

    async function refusalNotice(connectionId: string) {
      const rows = await sql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${TEST_ORG_ID} AND payload->>'entity' = 'connected_account'
          AND payload->>'action' = 'disconnect' AND payload->'data'->>'id' = ${connectionId}
      `
      return rows[0]?.payload as AppEvent | undefined
    }

    it("a personal connect of an address the org disconnected gets its own personal row, and the old content goes", async () => {
      const email = "was-shared@example.com"
      const staleOrgRow = await seedRow(email, { type: "org", id: null }, "disconnected")
      await seedConversation(staleOrgRow)
      const conn = await personalImap(email)
      await settle(async () =>
        (await rowsFor(email)).some((r: any) => r.connected_account_id === conn.id),
      )
      const rows = await rowsFor(email)
      expect(rows.length).toBe(1)
      expect(rows[0].id).not.toBe(staleOrgRow)
      expect(rows[0].connected_account_id).toBe(conn.id)
      expect(rows[0].owner_type).toBe("user")
      expect(rows[0].owner_id).toBe(USER_A_ID)
      // Born personal: the insert trigger puts it on the encryption track.
      expect(rows[0].encryption_state).not.toBe("none")
      // Nothing of the old mailbox is orphaned (an older disconnect had left it).
      const left = await sql`
        SELECT count(*)::int AS n FROM app_mail.conversations WHERE account_id = ${staleOrgRow}
      `
      expect(left[0].n).toBe(0)
    })

    it("an org connect of an address a member disconnected gets an org row, not the member's", async () => {
      const email = "was-personal@example.com"
      const stalePersonalRow = await seedRow(email, { type: "user", id: USER_A_ID }, "disconnected")
      const conn = await orgImap(email)
      await settle(async () =>
        (await rowsFor(email)).some((r: any) => r.connected_account_id === conn.id),
      )
      const rows = await rowsFor(email)
      expect(rows.length).toBe(1)
      expect(rows[0].id).not.toBe(stalePersonalRow)
      expect(rows[0].owner_type).toBe("org")
      expect(rows[0].owner_id).toBeNull()
      expect(rows[0].encryption_state).toBe("none")
    })

    it("an admin's takeover (credentials, takeOver) replaces the member's mailbox with the org's", async () => {
      const email = "taken-over@example.com"
      const member = await personalImap(email)
      await settle(async () =>
        (await rowsFor(email)).some((r: any) => r.connected_account_id === member.id),
      )
      const memberRow = (await rowsFor(email))[0]?.id
      const org = await orgImap(email, true)
      expect(await connectionStatus(member.id)).toBe("disconnected")
      await settle(async () =>
        (await rowsFor(email)).some((r: any) => r.connected_account_id === org.id),
      )
      const rows = await rowsFor(email)
      expect(rows.length).toBe(1)
      expect(rows[0].id).not.toBe(memberRow)
      expect(rows[0].owner_type).toBe("org")
      expect(await connectionStatus(org.id)).toBe("active")
    })

    it("an admin's OAuth takeover of a member's mailbox replaces it with the org's", async () => {
      const email = "oauth-taken@example.com"
      const member = await personalImap(email)
      await settle(async () =>
        (await rowsFor(email)).some((r: any) => r.connected_account_id === member.id),
      )
      // What the OAuth callback of an org connect does: the member's connection is
      // retired and the org's Gmail connection stored, then announced.
      await sql`UPDATE kernel.connected_accounts SET status = 'disconnected' WHERE id = ${member.id}`
      const [gmail] = await sql`
        INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
           status, created_by)
        VALUES (${TEST_ORG_ID}, 'mail', 'gmail', 'org', NULL, 'oauth2', ${email}, 'active',
          ${USER_A_ID})
        RETURNING id
      `
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { reconcileConnection } = await import("~/modules/apps/connections/service")
      await withPrivilegedDb(TEST_ORG_ID, "test-oauth-connect", (tx) =>
        reconcileConnection(tx, TEST_ORG_ID, USER_A_ID, gmail.id),
      )
      await settle(async () =>
        (await rowsFor(email)).some((r: any) => r.connected_account_id === gmail.id),
      )
      const rows = await rowsFor(email)
      expect(rows.length).toBe(1)
      expect(rows[0].owner_type).toBe("org")
      expect(rows[0].connected_account_id).toBe(gmail.id)
      expect(await connectionStatus(gmail.id)).toBe("active")
    })

    it("a personal connect of an address the org's mailbox still holds binds nothing; the person is told", async () => {
      const email = "still-shared@example.com"
      const [orgGmail] = await sql`
        INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
           status, created_by)
        VALUES (${TEST_ORG_ID}, 'mail', 'gmail', 'org', NULL, 'oauth2', ${email}, 'active',
          ${USER_A_ID})
        RETURNING id
      `
      const liveOrgRow = await seedRow(email, { type: "org", id: null }, "active", orgGmail.id)
      const conn = await personalImap(email)
      await settle(async () => (await connectionStatus(conn.id)) === "disconnected")
      expect(await connectionStatus(conn.id)).toBe("disconnected")
      const rows = await rowsFor(email)
      expect(rows.length).toBe(1)
      expect(rows[0].id).toBe(liveOrgRow)
      expect(rows[0].owner_type).toBe("org")
      const event = await refusalNotice(conn.id)
      expect(event?.data).toMatchObject({ reason: "connect_refused", notifyUserId: USER_A_ID })
      // The person who connected it gets a system alert saying why.
      await processTranslationEvent(event as AppEvent)
      const [alert] = await sql`
        SELECT summary FROM kernel.attention_events
        WHERE org_id = ${TEST_ORG_ID} AND user_id = ${USER_A_ID} AND kind = 'system_alert'
        ORDER BY created_at DESC LIMIT 1`
      expect(String(alert?.summary)).toContain("the organization's mailbox")
    })

    it("an IMAP connect whose login fails cannot squat a disconnected shared address", async () => {
      const email = "squat@example.com"
      const staleOrgRow = await seedRow(email, { type: "org", id: null }, "disconnected")
      const conn = await personalImap(email, "wrong-password")
      await settle(async () => (await connectionStatus(conn.id)) === "disconnected")
      expect(await connectionStatus(conn.id)).toBe("disconnected")
      const rows = await rowsFor(email)
      expect(rows.length).toBe(1)
      expect(rows[0].id).toBe(staleOrgRow)
      expect(rows[0].owner_type).toBe("org")
      expect((await refusalNotice(conn.id))?.data).toMatchObject({ reason: "connect_refused" })
      expect(JSON.stringify((await refusalNotice(conn.id))?.data)).toContain("refused the login")
    })
  })
})
