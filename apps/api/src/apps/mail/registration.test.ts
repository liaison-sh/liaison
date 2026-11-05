// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { sql } from "~/db"
import {
  getDeclaredEmits,
  resetAppRegistries,
  setDeclaredEmits,
} from "~/modules/apps/app-registries"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000201"

async function registerMailAppsForTest() {
  resetAppRegistries()
  await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG_ID} AND name IN ('mail', 'tickets')`
  setDeclaredEmits(
    "*",
    "kernel",
    new Set(["connected_account:create", "connected_account:disconnect"]),
  )
  await registerApps(
    [mailAppManifest as unknown as AppDescriptor, ticketsAppManifest as unknown as AppDescriptor],
    TEST_ORG_ID,
  )
}

describe("mail app registration", () => {
  // Run the destructive DROP + registerApps ONCE under exclusive lock.
  // All 13 tests below are read-only assertions against the resulting
  // schema/registry state, so we don't need per-test re-registration.
  // Holding the lock only for the brief window of beforeAll/afterAll
  // means concurrent test files queue for ~1–2s instead of the ~10–15s
  // a per-test DROP cycle would impose.
  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    await acquireAppSchemaJsLock("app_tickets")
    try {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${TEST_ORG_ID}, 'Mail Reg Org', 'mail-reg-test')
        ON CONFLICT (id) DO NOTHING`
      await sql`DELETE FROM kernel.apps WHERE name IN ('mail', 'tickets')`
      await registerMailAppsForTest()
    } catch (err) {
      await releaseAppSchemaJsLock("app_tickets")
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 120_000)

  afterAll(async () => {
    try {
      await sql`DELETE FROM kernel.apps WHERE name IN ('mail', 'tickets')`
      await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
    } finally {
      await releaseAppSchemaJsLock("app_tickets")
      await releaseAppSchemaJsLock("app_mail")
    }
  }, 60_000)

  it("creates app_mail schema and accounts table", async () => {
    const [tableCheck] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_mail' AND table_name = 'accounts'
      ) AS "exists"
    `
    expect(tableCheck.exists).toBe(true)
  })

  it("creates conversations and messages tables", async () => {
    const [conversationsCheck] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_mail' AND table_name = 'conversations'
      ) AS "exists"
    `
    const [messagesCheck] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_mail' AND table_name = 'messages'
      ) AS "exists"
    `

    expect(conversationsCheck.exists).toBe(true)
    expect(messagesCheck.exists).toBe(true)
  })

  it("creates accounts table with correct columns", async () => {
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app_mail' AND table_name = 'accounts'
      ORDER BY ordinal_position
    `
    const colNames = cols.map((c: any) => c.column_name)
    expect(colNames).toContain("connected_account_id")
    expect(colNames).toContain("owner_type")
    expect(colNames).toContain("owner_id")
    expect(colNames).toContain("provider")
    expect(colNames).toContain("email_address")
    expect(colNames).toContain("sync_status")
  })

  it("creates unique constraint on (org_id, email_address)", async () => {
    const constraintCols = await sql`
      SELECT c.constraint_name, array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns
      FROM information_schema.table_constraints c
      JOIN information_schema.key_column_usage kcu
        ON c.constraint_name = kcu.constraint_name AND c.table_schema = kcu.table_schema
      WHERE c.table_schema = 'app_mail' AND c.table_name = 'accounts' AND c.constraint_type = 'UNIQUE'
      GROUP BY c.constraint_name
    `
    expect(constraintCols.length).toBeGreaterThan(0)
    const uniqueCols = constraintCols[0].columns as string[]
    expect(uniqueCols).toContain("org_id")
    expect(uniqueCols).toContain("email_address")
  })

  it("creates indexes on (org_id, sync_status) and (org_id, connected_account_id)", async () => {
    const indexes = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'app_mail' AND tablename = 'accounts'
    `
    const indexDefs = indexes.map((i: any) => ({ name: i.indexname, def: i.indexdef }))
    const syncIdx = indexDefs.find((i: any) => i.name.includes("sync_status"))
    expect(syncIdx).toBeDefined()
    expect(syncIdx!.def).toContain("org_id")
    expect(syncIdx!.def).toContain("sync_status")
    const connIdx = indexDefs.find((i: any) => i.name.includes("connected_account_id"))
    expect(connIdx).toBeDefined()
    expect(connIdx!.def).toContain("org_id")
    expect(connIdx!.def).toContain("connected_account_id")
  })

  it("populates connection config registry for gmail and imap", async () => {
    const gmailConfig = (mailAppManifest as any).connections.gmail
    expect(gmailConfig).toBeDefined()
    expect(gmailConfig.type).toBe("oauth2")
    expect(gmailConfig.extraParams).toEqual({ access_type: "offline", prompt: "consent" })

    const imapConfig = (mailAppManifest as any).connections.imap
    expect(imapConfig).toBeDefined()
    expect(imapConfig.type).toBe("credentials")
  })

  it("registers runtime oauth client resolvers from descriptor-only metadata", async () => {
    const gmailResolver = (mailAppManifest as any)._oauthClientResolvers.gmail
    expect(gmailResolver).toBeDefined()
  })

  it("populates tool registry for mail tools", async () => {
    const listTool = (mailAppManifest as any).tools.listAccounts
    expect(listTool).toBeDefined()
    expect(listTool.requiredScopes).toEqual(["mail:accounts:read"])

    for (const [name, expectedScope, expectedGated] of [
      ["search", "mail:conversations:read", false],
      ["read", "mail:conversations:read", false],
      ["reply", "mail:conversations:write", true],
      ["compose", "mail:conversations:write", true],
    ] as const) {
      const tool = (mailAppManifest as any).tools[name]
      expect(tool).toBeDefined()
      expect(tool.requiredScopes).toEqual([expectedScope])
      expect(tool.gated ?? false).toBe(expectedGated)
    }
  })

  it("registers manifest-declared approval summarizers", async () => {
    expect((mailAppManifest as any).tools.reply.summarizer).toBeDefined()
    expect((mailAppManifest as any).tools.compose.summarizer).toBeDefined()
  })

  it("populates inbox dimension def as membership", async () => {
    const dim = (mailAppManifest as any).schema.accounts.dimensions.inbox
    expect(dim).toBeDefined()
    expect(dim.type).toBe("membership")
  })

  it("a personal mailbox is born ready or pending_enrollment, never none (accounts INSERT trigger)", async () => {
    // A personal mailbox connected AFTER its owner enrolled used to land at the
    // column default `none`: sync suspended, no legal edge for the enroll route
    // to lift it, the wizard hidden for an owner who has keys, and the boot step
    // only moving it to pending_enrollment on the next restart. The trigger
    // stamps the state at birth from the owner's identity. Explicit states and
    // shared mailboxes are left exactly as written.
    const enrolled = "00000000-0000-0000-0000-000000000211"
    const notEnrolled = "00000000-0000-0000-0000-000000000212"
    for (const [id, email] of [
      [enrolled, "enrolled@mail-reg.test"],
      [notEnrolled, "not-enrolled@mail-reg.test"],
    ]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${TEST_ORG_ID}, ${email}, 'Reg', 'active', 'hash')
        ON CONFLICT (id) DO NOTHING`
    }
    await sql`INSERT INTO kernel.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${TEST_ORG_ID}, ${enrolled}, 1, ${Buffer.from("ecdh")}, ${Buffer.from("sign")},
              ${Buffer.from("att")}, 'active')`
    const insert = (owner: string | null, ownerType: string, email: string, state: string | null) =>
      sql`INSERT INTO app_mail.accounts
            (org_id, connected_account_id, owner_type, owner_id, provider, email_address,
             sync_status, encryption_state)
          VALUES (${TEST_ORG_ID}, gen_random_uuid(), ${ownerType}, ${owner}, 'gmail', ${email},
                  'pre-sync', ${state ?? "none"})
          RETURNING encryption_state`
    try {
      const [readyRow] = await insert(enrolled, "user", "born-ready@mail-reg.test", null)
      expect(readyRow.encryption_state).toBe("ready")
      const [pendingRow] = await insert(notEnrolled, "user", "born-pending@mail-reg.test", null)
      expect(pendingRow.encryption_state).toBe("pending_enrollment")
      const [explicitRow] = await insert(enrolled, "user", "explicit@mail-reg.test", "paused")
      expect(explicitRow.encryption_state).toBe("paused")
      const [sharedRow] = await insert(null, "org", "shared@mail-reg.test", null)
      expect(sharedRow.encryption_state).toBe("none")
    } finally {
      await sql`DELETE FROM app_mail.accounts WHERE org_id = ${TEST_ORG_ID}`
      await sql`DELETE FROM kernel.user_mailbox_identities WHERE user_id = ${enrolled}`
      await sql`DELETE FROM kernel.users WHERE id IN (${enrolled}, ${notEnrolled})`
    }
  })

  it("mail is reachable through the real initAppsForOrg startup path", async () => {
    const { initAppsForOrg, getDefaultApps } = await import("~/modules/apps/init")

    // Verify mail is included in getDefaultApps()
    const defaultApps = await getDefaultApps()
    expect(defaultApps.some((a: any) => a.name === "mail")).toBe(true)

    // Run through the real startup path
    await initAppsForOrg(TEST_ORG_ID, defaultApps)

    // Verify schema was created via startup wiring
    const [tableCheck] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_mail' AND table_name = 'accounts'
      ) AS "exists"
    `
    expect(tableCheck.exists).toBe(true)

    // Verify kernel emits registered during startup (for subscription validation)
    const kernelEmits = getDeclaredEmits("*", "kernel")
    expect(kernelEmits?.has("connected_account:create")).toBe(true)
    expect(kernelEmits?.has("connected_account:disconnect")).toBe(true)
  })
})
