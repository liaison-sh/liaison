// SPDX-License-Identifier: FSL-1.1-ALv2
// Per-app export contract acceptance (Phase 13, E1/E3) for the 5 non-tickets
// shipping apps. Tickets is the seeded RLS/E3 reference in
// `apps/tickets/tickets-export.test.ts`; here each remaining app is asserted
// to (a) validate with its `export` slot, (b) run end-to-end through the
// shared `invokeAppExport` path producing a valid empty file (header-only CSV
// / `[]` JSON) for an empty instance, and (c) round-trip at least one seeded
// row so a row-dropping / RLS-ignoring / wrong-column handler regression
// fails (I1). The `admin()` helper grants ONLY the app scope (no `"*"`) so
// the export scope guard is genuinely exercised, plus an explicit negative
// case asserting a scopeless actor is rejected with 403 (I2).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import contactsManifest from "~/apps/contacts/app.manifest.json"
import driveManifest from "~/apps/google-drive/app.manifest.json"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import mailManifest from "~/apps/mail/app.manifest.json"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { exportRegistry } from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ExportError, invokeAppExport } from "~/modules/export/invoke-export"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await releaseTestLock()
})

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  userId = await withSystemDb("per-app-export-user", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1`,
      ),
    )
    return rows[0].id
  })
})

// Grant ONLY the app scope — NOT `"*"`. The `invokeAppExport` scope guard
// short-circuits on `"*"`, so leaving it in would make the scope check
// tautological (I2). The tickets-export reference test already avoids `"*"`.
function admin(scope: string, dims: Record<string, string[]> = {}): UserContext {
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: [scope],
    dimensionGrants: dims,
  }
}

/**
 * Seed exactly one canonical, admin-visible row for each app's export entity
 * so a `return []` / RLS-ignoring / wrong-column handler regression fails.
 * Returns a predicate proving the seeded row appears in the export rows, plus
 * the minimal dimension grants the app's generated RLS needs to see that row
 * (mirrors the tickets-export reference, which grants `tickets:team` etc.).
 */
type SeedResult = {
  assert: (rows: Array<Record<string, unknown>>) => void
  dims: Record<string, string[]>
}
const SEEDS: Record<string, (oid: string, uid: string) => Promise<SeedResult>> = {
  projects: async (oid, uid) => {
    const projectId = crypto.randomUUID()
    const statusId = crypto.randomUUID()
    const threadId = crypto.randomUUID()
    const taskId = crypto.randomUUID()
    const title = `Export task ${crypto.randomUUID().slice(0, 8)}`
    await withSystemDb("per-app-export-seed-projects", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_projects.projects (id, org_id, name, key, owner_id)
        VALUES (${projectId}, ${oid}, 'Export Project', 'EXP', ${uid})`)
      await tx.execute(drizzleSql`
        INSERT INTO app_projects.project_statuses (id, org_id, project_id, label, "order")
        VALUES (${statusId}, ${oid}, ${projectId}, 'Todo', 0)`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${threadId}, ${oid}, ${`export-task-${threadId}`}, 'thread', ${uid})`)
      await tx.execute(drizzleSql`
        INSERT INTO app_projects.tasks
          (id, org_id, project_id, status_id, number, title, position, thread_id, created_by)
        VALUES (${taskId}, ${oid}, ${projectId}, ${statusId}, 1, ${title}, 1000, ${threadId}, ${uid})`)
    })
    return {
      assert: (rows) => {
        const row = rows.find((r) => r.id === taskId)
        expect(row).toBeDefined()
        expect(row?.title).toBe(title)
      },
      dims: {},
    }
  },

  knowledge: async (oid, uid) => {
    const docId = crypto.randomUUID()
    const title = `Export doc ${crypto.randomUUID().slice(0, 8)}`
    await withSystemDb("per-app-export-seed-knowledge", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_knowledge.documents
          (id, org_id, title, body, document_scope, sensitivity, review_status, created_by, required_scopes)
        VALUES (${docId}, ${oid}, ${title}, 'body', 'organization', 'internal', 'unverified', ${uid}, '{}'::text[])`)
    })
    return {
      assert: (rows) => {
        const row = rows.find((r) => r.id === docId)
        expect(row).toBeDefined()
        expect(row?.title).toBe(title)
      },
      // org-scoped doc with sensitivity='internal' → RLS requires the
      // knowledge:sensitivity dimension to admit 'internal'.
      dims: { "knowledge:sensitivity": ["internal"] },
    }
  },

  mail: async (oid, uid) => {
    const accountId = crypto.randomUUID()
    const connectedAccountId = crypto.randomUUID()
    const convId = crypto.randomUUID()
    const subject = `Export mail ${crypto.randomUUID().slice(0, 8)}`
    await withSystemDb("per-app-export-seed-mail", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id,
           provider_type, identifier, status, created_by)
        VALUES (${connectedAccountId}, ${oid}, 'mail', 'Export Mail', 'user', ${uid},
                'gmail', 'export-mail@test.com', 'active', ${uid})`)
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider,
           email_address, sync_status)
        VALUES (${accountId}, ${oid}, ${connectedAccountId}, 'user', ${uid},
                'gmail', 'export-mail@test.com', 'active')`)
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.conversations
          (id, org_id, account_id, owner_type, owner_id, external_thread_id,
           subject, snippet, status, labels, last_message_at, message_count)
        VALUES (${convId}, ${oid}, ${accountId}, 'user', ${uid}, ${`export-${convId}`},
                ${subject}, 'Snippet', 'open', '["INBOX"]'::jsonb, now(), 1)`)
    })
    return {
      assert: (rows) => {
        const row = rows.find((r) => r.id === convId)
        expect(row).toBeDefined()
        expect(row?.subject).toBe(subject)
      },
      // conversations RLS uses the `inbox` membership dimension on
      // accountId (grant key `mail:inbox`) — admit the seeded account.
      dims: { "mail:inbox": [accountId] },
    }
  },

  contacts: async (oid, uid) => {
    const contactId = crypto.randomUUID()
    const name = `Export Contact ${crypto.randomUUID().slice(0, 8)}`
    await withSystemDb("per-app-export-seed-contacts", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.contacts (id, org_id, handle, name, email, company, created_by)
        VALUES (${contactId}, ${oid}, ${`@export-${contactId.slice(0, 8)}`}, ${name},
                'export-contact@test.com', 'Acme', ${uid})`)
    })
    return {
      assert: (rows) => {
        const row = rows.find((r) => r.id === contactId)
        expect(row).toBeDefined()
        expect(row?.name).toBe(name)
      },
      dims: {},
    }
  },

  "google-drive": async (oid, uid) => {
    const accountId = crypto.randomUUID()
    const displayName = `Export Drive ${crypto.randomUUID().slice(0, 8)}`
    await withSystemDb("per-app-export-seed-drive", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id,
           provider_type, identifier, display_name, status, created_by)
        VALUES (${accountId}, ${oid}, 'google-drive', 'Export Drive', 'user', ${uid},
                'google', 'export-drive@test.com', ${displayName}, 'active', ${uid})`)
    })
    return {
      assert: (rows) => {
        const row = rows.find((r) => r.id === accountId)
        expect(row).toBeDefined()
        expect(row?.displayName).toBe(displayName)
      },
      dims: {},
    }
  },
}

const APPS: Array<{ name: string; manifest: unknown; scope: string }> = [
  { name: "projects", manifest: projectsManifest, scope: "projects:projects:read" },
  { name: "knowledge", manifest: knowledgeManifest, scope: "knowledge:documents:read" },
  // The mail export reads `conversations`; its generated RLS scope-checks
  // that entity, so the actor needs `mail:conversations:read` (not accounts).
  { name: "mail", manifest: mailManifest, scope: "mail:conversations:read" },
  { name: "contacts", manifest: contactsManifest, scope: "contacts:contacts:read" },
  {
    name: "google-drive",
    manifest: driveManifest,
    scope: "google-drive:accounts:read",
  },
]

describe("per-app export contract acceptance (E1/E3)", () => {
  for (const { name, manifest, scope } of APPS) {
    test(`${name}: manifest with export slot validates`, () => {
      const r = validateAppManifest(manifest)
      if (!r.success) throw new Error(`${name} manifest invalid: ${r.error}`)
      expect(r.success).toBe(true)
    })

    test(`${name}: JSON export returns an array (empty instance => [])`, async () => {
      const json = (await invokeAppExport(orgId, name, "json", admin(scope))) as unknown
      expect(Array.isArray(json)).toBe(true)
      expect(json as unknown[]).toEqual([])
    })

    test(`${name}: CSV export returns a header-only file for an empty instance`, async () => {
      const csv = (await invokeAppExport(orgId, name, "csv", admin(scope))) as string
      expect(typeof csv).toBe("string")
      const lines = csv.trim().split("\n")
      expect(lines).toHaveLength(1)
      const declared = Object.keys(
        (manifest as { export: { schema: Record<string, string> } }).export.schema,
      )
      expect(lines[0]).toBe(declared.join(","))
    })

    test(`${name}: JSON export round-trips a seeded admin-visible row (I1)`, async () => {
      const { assert: assertSeeded, dims } = await SEEDS[name](orgId, userId)
      const json = (await invokeAppExport(orgId, name, "json", admin(scope, dims))) as Array<
        Record<string, unknown>
      >
      expect(Array.isArray(json)).toBe(true)
      expect(json.length).toBeGreaterThanOrEqual(1)
      assertSeeded(json)
    })

    test(`${name}: an actor without the app scope is rejected 403 (I2)`, async () => {
      // Seed a row so a missing scope guard cannot pass by returning [].
      await SEEDS[name](orgId, userId)
      const scopeless = admin("unrelated:other:read")
      let thrown: unknown
      try {
        await invokeAppExport(orgId, name, "json", scopeless)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(ExportError)
      expect((thrown as ExportError).status).toBe(403)
    })
  }
})

describe("CSV-bypasses-dimension-grants guard (I3)", () => {
  // Registers a synthetic export entry whose handler returns a pre-serialised
  // CSV string while also declaring `dimensions`. The guard in
  // `invokeAppExport` (lines 135-144 of invoke-export.ts) must detect this
  // and throw ExportError(500) — an app cannot bypass dimension field-masking
  // by returning an already-serialised CSV body.
  const SYNTH_APP = "synth-csv-guard-test"
  const SYNTH_SCOPE = `${SYNTH_APP}:data:read`
  const SYNTH_FORMAT = "csv"

  test("invokeAppExport throws ExportError(500) when a dimension-declaring handler returns CSV", async () => {
    // Register the synthetic entry AFTER ensureAppsForOrg has already
    // initialised the org (done in beforeEach), so our entry is not
    // overwritten by the normal boot path.
    exportRegistry.set([orgId, SYNTH_APP], {
      formats: [SYNTH_FORMAT],
      // dimensions declared → field-masking must be applied; CSV string is
      // opaque to the masker, so this combination must be rejected.
      dimensions: { sensitiveField: "synth:sensitivity" },
      handler: async (_ctx: unknown, _format: string) => {
        // Returns a pre-serialised CSV — the forbidden combination.
        return "id,sensitiveField\n1,secret-value"
      },
    })

    let thrown: unknown
    try {
      await invokeAppExport(orgId, SYNTH_APP, SYNTH_FORMAT, admin(SYNTH_SCOPE))
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(ExportError)
    expect((thrown as ExportError).status).toBe(500)
    expect((thrown as ExportError).message).toContain("dimension-filtered exports must return JSON")
  })
})
