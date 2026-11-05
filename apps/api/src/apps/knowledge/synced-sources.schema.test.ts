// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Schema-invariant tests for synced_sources + the documents columns it adds.
 *
 * Gap #13 fix: previous version asserted only that constraints / indexes had
 * the expected NAMES. That doesn't catch a buggy migration where the body of
 * a CHECK is wrong (e.g. inverted, always-true). Now each invariant is
 * exercised by attempting a violating INSERT and asserting the DB rejects.
 *
 * Drizzle's `DrizzleQueryError` wraps the underlying PostgresError; its
 * `.message` is just `Failed query: …` so we walk the cause chain via
 * `findPgError(err)` and assert against the *real* error.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireTestLock()
  const slug = `synced-schema-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'SchemaTest', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`schema-${Date.now()}@t.test`}, 'U', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  userId = u!.id
})

afterAll(releaseTestLock)

/**
 * Walk the cause chain to find the underlying postgres error. Drizzle wraps
 * with DrizzleQueryError → cause = PostgresError; postgres.js puts the
 * constraint name + code on the wrapped error.
 */
interface PgErrorShape {
  code?: string
  constraint?: string
  constraint_name?: string
  message?: string
  detail?: string
  // biome-ignore lint/suspicious/noExplicitAny: walking unknown cause chain
  cause?: any
}
function findPgError(err: unknown): PgErrorShape | null {
  let cur: PgErrorShape | null = (err as PgErrorShape) ?? null
  while (cur) {
    if (cur.code || cur.constraint || cur.constraint_name) return cur
    cur = cur.cause ?? null
  }
  return (err as PgErrorShape) ?? null
}

/** Run a promise that should fail and return the underlying pg error. */
async function expectPgError(
  promise: PromiseLike<unknown>,
  matcher: { code?: string; constraint?: RegExp },
): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  if (caught === undefined) {
    throw new Error("Expected query to reject, but it succeeded")
  }
  const pg = findPgError(caught)
  if (!pg) {
    throw new Error(`No pg error found in chain: ${String(caught)}`)
  }
  if (matcher.code && pg.code !== matcher.code) {
    throw new Error(
      `Expected pg error code ${matcher.code}, got ${pg.code}. ` +
        `Constraint: ${pg.constraint ?? pg.constraint_name ?? "(none)"}. ` +
        `Message: ${pg.message ?? "(none)"}`,
    )
  }
  if (matcher.constraint) {
    const name = pg.constraint ?? pg.constraint_name ?? pg.message ?? ""
    if (!matcher.constraint.test(name)) {
      throw new Error(
        `Expected constraint match ${matcher.constraint}, got "${name}". Code: ${pg.code}.`,
      )
    }
  }
}

async function insertSyncedSource(overrides: {
  ownerUserId?: string | null
  defaultSensitivity?: string | null
  syncIntervalSeconds?: number
  displayName?: string
}): Promise<{ id: string }> {
  const rows = extractRows<{ id: string }>(
    await db.execute(sql`
      WITH new_col AS (
        INSERT INTO app_knowledge.collections (id, org_id, name, maintainer_user_ids)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${overrides.displayName ?? "schema-test"}, '[]'::jsonb)
        RETURNING id
      )
      INSERT INTO app_knowledge.synced_sources (
        id, org_id, app_name, folder_ref, display_name, root_collection_id,
        owner_user_id, default_sensitivity, sync_interval_seconds, created_by
      )
      SELECT gen_random_uuid(),
             ${orgId}::uuid,
             'google-drive',
             ${`SCHEMATEST${Date.now()}`},
             ${overrides.displayName ?? "schema-test"},
             new_col.id,
             ${overrides.ownerUserId ?? null}::uuid,
             ${overrides.defaultSensitivity ?? null},
             ${overrides.syncIntervalSeconds ?? 3600},
             ${userId}::uuid
      FROM new_col
      RETURNING id
    `),
  )
  return rows[0]!
}

describe("synced_sources schema invariants (rewritten as violation tests — gap #13)", () => {
  it("all expected columns exist on synced_sources", async () => {
    const cols = extractRows<{ column_name: string }>(
      await db.execute(
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'app_knowledge' AND table_name = 'synced_sources'`,
      ),
    ).map((r) => r.column_name)
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "org_id",
        "app_name",
        "folder_ref",
        "display_name",
        "root_collection_id",
        "owner_user_id",
        "default_sensitivity",
        "sync_interval_seconds",
        "last_sync_at",
        "last_sync_status",
        "last_error",
        "created_by",
        "created_at",
        "updated_at",
        "archived_at",
      ]),
    )
  })

  it("documents gained the synced_source_id / source_identity_id / external_path / external_rev / last_synced_at columns", async () => {
    const rows = extractRows<{ column_name: string }>(
      await db.execute(
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'app_knowledge' AND table_name = 'documents'
              AND column_name IN ('synced_source_id', 'source_identity_id',
                                  'external_path', 'external_rev', 'last_synced_at')`,
      ),
    )
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      "external_path",
      "external_rev",
      "last_synced_at",
      "source_identity_id",
      "synced_source_id",
    ])
  })

  // -----------------------------------------------------------------------
  // Violation tests — these would fail under a mutated CHECK body where the
  // constraint NAME is right but the clause is wrong.
  // -----------------------------------------------------------------------

  it("scope/sensitivity CHECK: org-shared row WITHOUT default_sensitivity is rejected", async () => {
    await expectPgError(insertSyncedSource({ ownerUserId: null, defaultSensitivity: null }), {
      code: "23514",
      constraint: /scope_sensitivity_check/,
    })
  })

  it("scope/sensitivity CHECK: personal row WITH default_sensitivity is rejected", async () => {
    await expectPgError(
      insertSyncedSource({ ownerUserId: userId, defaultSensitivity: "internal" }),
      { code: "23514", constraint: /scope_sensitivity_check/ },
    )
  })

  it("scope/sensitivity CHECK: valid combinations are accepted", async () => {
    await insertSyncedSource({ ownerUserId: null, defaultSensitivity: "internal" })
    await insertSyncedSource({ ownerUserId: userId, defaultSensitivity: null })
  })

  it("sync_interval_seconds CHECK: < 60 is rejected", async () => {
    await expectPgError(
      insertSyncedSource({
        ownerUserId: null,
        defaultSensitivity: "internal",
        syncIntervalSeconds: 30,
      }),
      { code: "23514" },
    )
  })

  it("last_sync_status CHECK: an unrecognised status is rejected", async () => {
    const created = await insertSyncedSource({
      ownerUserId: null,
      defaultSensitivity: "internal",
    })
    await expectPgError(
      db.execute(
        sql`UPDATE app_knowledge.synced_sources
            SET last_sync_status = 'banana'
            WHERE id = ${created.id}::uuid`,
      ),
      { code: "23514" },
    )
  })

  it("documents pair CHECK: setting synced_source_id WITHOUT source_identity_id is rejected", async () => {
    const src = await insertSyncedSource({ ownerUserId: null, defaultSensitivity: "internal" })
    await expectPgError(
      db.execute(
        sql`INSERT INTO app_knowledge.documents
              (id, org_id, title, body, document_scope, sensitivity, created_by,
               synced_source_id, source_identity_id, required_scopes)
            VALUES (gen_random_uuid(), ${orgId}::uuid, 'half-synced', '',
                    'organization', 'internal', ${userId}::uuid,
                    ${src.id}::uuid, NULL, '{}'::text[])`,
      ),
      { code: "23514", constraint: /synced_pair_check/ },
    )
  })

  it("documents pair CHECK: setting source_identity_id WITHOUT synced_source_id is rejected", async () => {
    const [identity] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
            VALUES (gen_random_uuid(), ${orgId}::uuid, 'google-drive', ${`SCHEMAID${Date.now()}`})
            RETURNING id`,
      ),
    )
    await expectPgError(
      db.execute(
        sql`INSERT INTO app_knowledge.documents
              (id, org_id, title, body, document_scope, sensitivity, created_by,
               synced_source_id, source_identity_id, required_scopes)
            VALUES (gen_random_uuid(), ${orgId}::uuid, 'half-synced-2', '',
                    'organization', 'internal', ${userId}::uuid,
                    NULL, ${identity!.id}::uuid, '{}'::text[])`,
      ),
      { code: "23514", constraint: /synced_pair_check/ },
    )
  })

  it("documents synced-revision CHECK: bumping revision on a synced doc is rejected", async () => {
    const src = await insertSyncedSource({ ownerUserId: null, defaultSensitivity: "internal" })
    const [identity] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
            VALUES (gen_random_uuid(), ${orgId}::uuid, 'google-drive', ${`REV${Date.now()}`})
            RETURNING id`,
      ),
    )
    const [doc] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO app_knowledge.documents
              (id, org_id, title, body, document_scope, sensitivity, created_by,
               synced_source_id, source_identity_id, required_scopes)
            VALUES (gen_random_uuid(), ${orgId}::uuid, 'syncedone', '',
                    'organization', 'internal', ${userId}::uuid,
                    ${src.id}::uuid, ${identity!.id}::uuid, '{}'::text[])
            RETURNING id`,
      ),
    )
    await expectPgError(
      db.execute(
        sql`UPDATE app_knowledge.documents
            SET revision = revision + 1
            WHERE id = ${doc!.id}::uuid`,
      ),
      { code: "23514", constraint: /synced_revision_check/ },
    )
  })

  it("partial unique index: two ACTIVE synced documents with the same (source, identity) are rejected", async () => {
    const src = await insertSyncedSource({ ownerUserId: null, defaultSensitivity: "internal" })
    const [identity] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
            VALUES (gen_random_uuid(), ${orgId}::uuid, 'google-drive', ${`UNIQ${Date.now()}`})
            RETURNING id`,
      ),
    )
    await db.execute(
      sql`INSERT INTO app_knowledge.documents
            (id, org_id, title, body, document_scope, sensitivity, created_by,
             synced_source_id, source_identity_id, required_scopes)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'uniq-a', '',
                  'organization', 'internal', ${userId}::uuid,
                  ${src.id}::uuid, ${identity!.id}::uuid, '{}'::text[])`,
    )
    await expectPgError(
      db.execute(
        sql`INSERT INTO app_knowledge.documents
              (id, org_id, title, body, document_scope, sensitivity, created_by,
               synced_source_id, source_identity_id, required_scopes)
            VALUES (gen_random_uuid(), ${orgId}::uuid, 'uniq-b', '',
                    'organization', 'internal', ${userId}::uuid,
                    ${src.id}::uuid, ${identity!.id}::uuid, '{}'::text[])`,
      ),
      { code: "23505", constraint: /uniq_knowledge_documents_synced_identity_active/ },
    )
  })

  it("partial unique index: archived rows do NOT conflict with a new active row (H-4 resurrect path)", async () => {
    const src = await insertSyncedSource({ ownerUserId: null, defaultSensitivity: "internal" })
    const [identity] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
            VALUES (gen_random_uuid(), ${orgId}::uuid, 'google-drive', ${`RESURRECT${Date.now()}`})
            RETURNING id`,
      ),
    )
    const [first] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO app_knowledge.documents
              (id, org_id, title, body, document_scope, sensitivity, created_by,
               synced_source_id, source_identity_id, archived_at, required_scopes)
            VALUES (gen_random_uuid(), ${orgId}::uuid, 'resurr', '',
                    'organization', 'internal', ${userId}::uuid,
                    ${src.id}::uuid, ${identity!.id}::uuid, now(), '{}'::text[])
            RETURNING id`,
      ),
    )
    await db.execute(
      sql`INSERT INTO app_knowledge.documents
            (id, org_id, title, body, document_scope, sensitivity, created_by,
             synced_source_id, source_identity_id, required_scopes)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'resurr-2', '',
                  'organization', 'internal', ${userId}::uuid,
                  ${src.id}::uuid, ${identity!.id}::uuid, '{}'::text[])`,
    )
    expect(first!.id).toBeTruthy()
  })
})
