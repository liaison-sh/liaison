// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Knowledge synced-source jobs (J-1) — integration tests.
 *
 * These exercise the production worker + scheduler bodies via their exported
 * seams (`tickEnqueueDueSources`, `runSyncWorker`) — NOT by re-implementing
 * predicates inline. Any change to those bodies that violates a spec
 * invariant fails a test here.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { registerAdapter } from "@liaison/db-core"
import { sql } from "drizzle-orm"
import { kbSyncCatalog } from "~/apps/database/adapters/__fixtures__/kb-sync"
import {
  loadSyncedSourceForOrgSystem,
  loadSyncedSourceForWorker,
  runSyncWorker,
  tickEnqueueDueSources,
} from "~/apps/knowledge/knowledge-jobs"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import type { KnowledgeSourceAdapter } from "~/apps/knowledge/source-protocol"
import {
  type CreateSyncedSourceInput,
  type CreateSyncedSourceOptions,
  createSyncedSource,
  type SyncedSourceRow,
} from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
let bob: string
const DOC_READ = "knowledge:documents:read"
const SOURCES_MANAGE = "knowledge:sources:manage"

function actor(userId: string, scopes: string[]): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: {} })
}

// Wrap test-setup createSyncedSource calls in a privileged tx — production
// callers always hold an RLS-scoped or privileged DB handle; this matches the
// sister synced-sources tests' `withRlsContext` pattern without needing to
// hand-roll an actor scope for every fixture row.
function mkSource(
  input: CreateSyncedSourceInput,
  who: KnowledgeActor,
  opts: CreateSyncedSourceOptions = {},
): Promise<SyncedSourceRow> {
  return withPrivilegedDb(orgId, "knowledge-jobs-test-setup", (tx) =>
    createSyncedSource(tx, input, who, opts),
  )
}

// The database-sync case connects the connector to the test database as the
// application's own login, which can reach the privileged roles: the transport
// refuses that unless the operator opt-out is on.
const priorAllowPrivileged = process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION

beforeAll(async () => {
  await acquireTestLock()
  // The knowledge app's manifest columns (synced_sources.source_account) come
  // from its registration, not from the migrated template: register the apps
  // here so this file does not depend on an earlier file having done it.
  await createTestOrg()
  process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION = "true"
  const slug = `knowledge-jobs-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeJobsIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id
  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@jobs.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id
  const [bRow] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`bob-${Date.now()}@jobs.test`}, 'Bob', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  bob = bRow!.id
})

afterAll(async () => {
  if (priorAllowPrivileged === undefined) delete process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION
  else process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION = priorAllowPrivileged
  await releaseTestLock()
})

const fakeAdapter = () => ({
  source: "google-drive",
  searchRemote: async () => ({
    hits: [],
    status: { source: "google-drive", state: "complete" as const, retryable: false },
  }),
  listFolder: async () => ({ items: [] }),
})

describe("knowledge synced-source jobs (J-1)", () => {
  it("loadSyncedSourceForWorker returns the row regardless of RLS context", async () => {
    const created = await mkSource(
      {
        appName: "google-drive",
        folderRef: "WORKERLOAD123",
        displayName: "WorkerLoad",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      actor(alice, [SOURCES_MANAGE, DOC_READ]),
      { skipPrecheck: true },
    )
    const reloaded = await loadSyncedSourceForWorker(created.id)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.id).toBe(created.id)
    expect(reloaded!.ownerUserId).toBeNull()
  })

  it("loadSyncedSourceForOrgSystem refuses to leak rows across orgs (I6 defense in depth)", async () => {
    const created = await mkSource(
      {
        appName: "google-drive",
        folderRef: "ORGSCOPED9999",
        displayName: "OrgScoped",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      actor(alice, [SOURCES_MANAGE, DOC_READ]),
      { skipPrecheck: true },
    )
    expect(await loadSyncedSourceForOrgSystem(orgId, created.id)).not.toBeNull()
    const [otherOrg] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.organizations (id, name, slug)
            VALUES (gen_random_uuid(), 'OtherOrg', ${`other-${Date.now()}`})
            RETURNING id`,
      ),
    )
    expect(await loadSyncedSourceForOrgSystem(otherOrg!.id, created.id)).toBeNull()
  })

  it("tickEnqueueDueSources picks only past-interval, non-running rows AND tags every enqueue with jobId='sync:<id>' (M-5)", async () => {
    const orgActor = actor(alice, [SOURCES_MANAGE, DOC_READ])
    const due = await mkSource(
      {
        appName: "google-drive",
        folderRef: "DUEROW0001",
        displayName: "Due",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      orgActor,
      { skipPrecheck: true },
    )
    const running = await mkSource(
      {
        appName: "google-drive",
        folderRef: "RUNNING0002",
        displayName: "Running",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      orgActor,
      { skipPrecheck: true },
    )
    const fresh = await mkSource(
      {
        appName: "google-drive",
        folderRef: "FRESH00003",
        displayName: "Fresh",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      orgActor,
      { skipPrecheck: true },
    )
    await db.execute(
      sql`UPDATE ${knowledgeRel("synced_sources")}
          SET last_sync_at = now() - interval '2 hours', last_sync_status = 'ok'
          WHERE id = ${due.id}::uuid`,
    )
    await db.execute(
      sql`UPDATE ${knowledgeRel("synced_sources")}
          SET last_sync_at = now(), last_sync_status = 'running'
          WHERE id = ${running.id}::uuid`,
    )
    await db.execute(
      sql`UPDATE ${knowledgeRel("synced_sources")}
          SET last_sync_at = now(), last_sync_status = 'ok'
          WHERE id = ${fresh.id}::uuid`,
    )

    // A source that FAILED its last attempt must respect its interval like any
    // other. Before the fix the error path left last_sync_at untouched, so a
    // permanently-failing source (revoked token) stayed due on EVERY tick and
    // re-enqueued ~1/min forever — the hot loop that buried prod in alerts.
    const failedRecently = await mkSource(
      {
        appName: "google-drive",
        folderRef: "FAILED0004",
        displayName: "Failed recently",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      orgActor,
      { skipPrecheck: true },
    )
    await db.execute(
      sql`UPDATE ${knowledgeRel("synced_sources")}
          SET last_sync_at = now(), last_sync_status = 'error', last_error = 'auth revoked'
          WHERE id = ${failedRecently.id}::uuid`,
    )
    const failedLongAgo = await mkSource(
      {
        appName: "google-drive",
        folderRef: "FAILED0005",
        displayName: "Failed long ago",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      orgActor,
      { skipPrecheck: true },
    )
    await db.execute(
      sql`UPDATE ${knowledgeRel("synced_sources")}
          SET last_sync_at = now() - interval '2 hours', last_sync_status = 'error', last_error = 'auth revoked'
          WHERE id = ${failedLongAgo.id}::uuid`,
    )

    interface Enqueued {
      sourceId: string
      jobId: string | undefined
      trigger: string
    }
    const enqueued: Enqueued[] = []
    await tickEnqueueDueSources(async (_app, _name, data, opts) => {
      enqueued.push({ sourceId: data.sourceId, jobId: opts?.jobId, trigger: data.trigger })
      return opts.jobId
    })
    const ids = enqueued.map((e) => e.sourceId)
    expect(ids).toContain(due.id)
    expect(ids).not.toContain(running.id)
    expect(ids).not.toContain(fresh.id)
    // Errored but inside its interval → NOT retried yet; errored and past it → retried.
    expect(ids).not.toContain(failedRecently.id)
    expect(ids).toContain(failedLongAgo.id)
    // M-5: jobId must always be set to "sync:<sourceId>" — never undefined,
    // never a different prefix. This is the actual dedup contract.
    const dueEnqueue = enqueued.find((e) => e.sourceId === due.id)!
    expect(dueEnqueue.jobId).toBe(`sync:${due.id}`)
    expect(dueEnqueue.trigger).toBe("schedule")
  })

  it("H-1: runSyncWorker REFUSES force-on-open by non-owner of personal source (reconciler never called)", async () => {
    const created = await mkSource(
      {
        appName: "google-drive",
        folderRef: "PERSONALH1AA",
        displayName: "AlicePersonal",
        syncIntervalSeconds: 3600,
        scope: "personal",
      },
      actor(alice, [DOC_READ]),
      { skipPrecheck: true },
    )
    const reconcile = mock<
      (source: SyncedSourceRow, adapter: KnowledgeSourceAdapter) => Promise<undefined>
    >(async () => undefined)
    await expect(
      runSyncWorker(
        { sourceId: created.id, trigger: "force-on-open", enqueuedBy: bob },
        { resolveAdapter: () => fakeAdapter(), reconcile },
      ),
    ).rejects.toThrow(/FORBIDDEN.*non-owner/i)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it("H-1: runSyncWorker PERMITS force-on-open by the owner of a personal source", async () => {
    const created = await mkSource(
      {
        appName: "google-drive",
        folderRef: "PERSONALH1BB",
        displayName: "AlicePersonal2",
        syncIntervalSeconds: 3600,
        scope: "personal",
      },
      actor(alice, [DOC_READ]),
      { skipPrecheck: true },
    )
    const reconcile = mock<
      (source: SyncedSourceRow, adapter: KnowledgeSourceAdapter) => Promise<undefined>
    >(async () => undefined)
    await runSyncWorker(
      { sourceId: created.id, trigger: "force-on-open", enqueuedBy: alice },
      { resolveAdapter: () => fakeAdapter(), reconcile },
    )
    expect(reconcile).toHaveBeenCalledTimes(1)
    const [source] = reconcile.mock.calls[0] ?? []
    expect(source?.id).toBe(created.id)
  })

  it("scheduled tick (trigger='schedule') reaches the reconciler regardless of owner", async () => {
    const created = await mkSource(
      {
        appName: "google-drive",
        folderRef: "PERSONALSCH1",
        displayName: "AlicePersonalSched",
        syncIntervalSeconds: 3600,
        scope: "personal",
      },
      actor(alice, [DOC_READ]),
      { skipPrecheck: true },
    )
    const reconcile = mock<
      (source: SyncedSourceRow, adapter: KnowledgeSourceAdapter) => Promise<undefined>
    >(async () => undefined)
    await runSyncWorker(
      // No enqueuedBy — tick is anonymous; H-1 must not apply.
      { sourceId: created.id, trigger: "schedule" },
      { resolveAdapter: () => fakeAdapter(), reconcile },
    )
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it("an upstream timeout does not fail the job (no BullMQ retry storm), a 4xx still does", async () => {
    const created = await mkSource(
      {
        appName: "google-drive",
        folderRef: "TIMEOUT12345",
        displayName: "SlowUpstream",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      actor(alice, [SOURCES_MANAGE, DOC_READ]),
      { skipPrecheck: true },
    )
    const timeout = new DOMException("The operation timed out.", "TimeoutError")
    await expect(
      runSyncWorker(
        { sourceId: created.id, trigger: "schedule" },
        {
          resolveAdapter: () => fakeAdapter(),
          reconcile: async () => {
            throw timeout
          },
        },
      ),
    ).resolves.toBeUndefined()
    // A revoked token is not weather: it still fails the job.
    const revoked = Object.assign(new Error("OAuth revoked"), { status: 401 })
    await expect(
      runSyncWorker(
        { sourceId: created.id, trigger: "schedule" },
        {
          resolveAdapter: () => fakeAdapter(),
          reconcile: async () => {
            throw revoked
          },
        },
      ),
    ).rejects.toThrow("OAuth revoked")
  })

  it("runSyncWorker on an archived source is a no-op (reconciler not called)", async () => {
    const created = await mkSource(
      {
        appName: "google-drive",
        folderRef: "ARCHIVED1234",
        displayName: "Archived",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      actor(alice, [SOURCES_MANAGE, DOC_READ]),
      { skipPrecheck: true },
    )
    await db.execute(
      sql`UPDATE ${knowledgeRel("synced_sources")}
          SET archived_at = now()
          WHERE id = ${created.id}::uuid`,
    )
    const reconcile = mock<
      (source: SyncedSourceRow, adapter: KnowledgeSourceAdapter) => Promise<undefined>
    >(async () => undefined)
    await runSyncWorker(
      { sourceId: created.id, trigger: "schedule" },
      { resolveAdapter: () => fakeAdapter(), reconcile },
    )
    expect(reconcile).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// `database` app resolver (job-resolver gap fix). This exercises the
// PRODUCTION `resolveAdapter` inside `knowledge-jobs.ts` (no injected
// `deps.resolveAdapter` stub) so a regression that re-breaks the `database`
// branch — or silently reverts to the "No adapter registered" throw — fails
// here, not just in the adapter's own unit tests.
// ---------------------------------------------------------------------------
describe("knowledge synced-source jobs — database app resolver", () => {
  const SECRET_TOKEN = "job-resolver-secret-token"

  async function seedKbArticlesSchema(): Promise<void> {
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS kb`)
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS kb.articles (
        id text PRIMARY KEY,
        title text NOT NULL,
        body text NOT NULL,
        updated_at timestamptz NOT NULL,
        public_url text,
        secret_token text
      )
    `)
    await db.execute(sql`TRUNCATE kb.articles`)
    await db.execute(sql`
      INSERT INTO kb.articles (id, title, body, updated_at, public_url, secret_token)
      VALUES ('job-resolver-a', 'Job Resolver Article', '# Job Resolver Article\n\nBody text.',
              '2026-05-10T00:00:00.000Z'::timestamptz, NULL, ${SECRET_TOKEN})
    `)
  }

  async function seedDatabaseConnection(): Promise<void> {
    const credentialsJson = JSON.stringify({ connectionString: env.DATABASE_URL })
    const encrypted = encryptSecret(
      credentialsJson,
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountCredentials,
    )
    await db.execute(sql`
      INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
         identifier, access_token_encrypted, refresh_token_encrypted, credentials_encrypted,
         status, created_by)
      VALUES (
        ${orgId}::uuid, 'database', 'database', 'org', NULL, 'credentials',
        'default', NULL, NULL, ${encrypted}, 'active', ${alice}::uuid
      )
      ON CONFLICT DO NOTHING
    `)
  }

  it("resolveAdapter('database') degrades to an empty (non-throwing) adapter when the connected catalog has no knowledge_sync_* reads", async () => {
    // Default env: LIAISON_DATABASE_ADAPTER unset -> resolves to `liaison-self`,
    // which does NOT declare knowledge_sync_list/knowledge_sync_get. The job
    // must still resolve an adapter and reconcile cleanly to zero documents —
    // never throw "No adapter registered for app: database".
    const created = await mkSource(
      {
        appName: "database",
        folderRef: "no-catalog-root",
        displayName: "DatabaseNoCatalog",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      actor(alice, [SOURCES_MANAGE, DOC_READ]),
      { skipPrecheck: true },
    )
    // Production resolveAdapter — no injected deps.resolveAdapter/reconcile.
    await runSyncWorker({ sourceId: created.id, trigger: "schedule" })
    const reloaded = await loadSyncedSourceForWorker(created.id)
    expect(reloaded?.lastSyncStatus).toBe("ok")
  })

  it("reconciles a real `database` synced source end-to-end through the JOB path (registered kb-sync catalog -> real documents, no secret column)", async () => {
    await seedKbArticlesSchema()
    await seedDatabaseConnection()
    // Register the fixture catalog (declares knowledge_sync_list/get) and
    // point the org-independent global resolver at it — mirrors how a
    // deployment sets LIAISON_DATABASE_ADAPTER for its self-hosted KB.
    registerAdapter(kbSyncCatalog)
    const prevAdapterEnv = process.env.LIAISON_DATABASE_ADAPTER
    process.env.LIAISON_DATABASE_ADAPTER = "kb-sync"
    try {
      const created = await mkSource(
        {
          appName: "database",
          folderRef: "job-resolver-root",
          displayName: "DatabaseJobResolver",
          syncIntervalSeconds: 3600,
          scope: "organization",
          defaultSensitivity: "internal",
        },
        actor(alice, [SOURCES_MANAGE, DOC_READ]),
        { skipPrecheck: true },
      )

      // Drive the exact JOB entrypoint (production resolveAdapter, production
      // reconcileSyncedSource) — proves the fix closes the resolver gap on the
      // real worker path the scheduler ticks use, not just a unit-level stub.
      await runSyncWorker({ sourceId: created.id, trigger: "schedule" })

      const reloaded = await loadSyncedSourceForWorker(created.id)
      expect(reloaded?.lastSyncStatus).toBe("ok")

      const docs = extractRows<{ title: string; body: string }>(
        await db.execute(sql`
          SELECT title, body FROM ${knowledgeRel("documents")}
          WHERE synced_source_id = ${created.id}::uuid AND archived_at IS NULL
        `),
      )
      expect(docs.length).toBe(1)
      expect(docs[0]!.title).toBe("Job Resolver Article")
      expect(docs[0]!.body).toContain("Body text.")
      // The secret_token column is never selected by knowledge_sync_get/list —
      // confirm it never leaked into the materialized document.
      expect(docs[0]!.body).not.toContain(SECRET_TOKEN)
      expect(docs[0]!.title).not.toContain(SECRET_TOKEN)
    } finally {
      if (prevAdapterEnv === undefined) delete process.env.LIAISON_DATABASE_ADAPTER
      else process.env.LIAISON_DATABASE_ADAPTER = prevAdapterEnv
      await db.execute(sql`DROP TABLE IF EXISTS kb.articles`)
      await db.execute(sql`DROP SCHEMA IF EXISTS kb`)
    }
  })
})

// ---------------------------------------------------------------------------
// A demo workspace reaches no provider and holds no connected account: its
// seeded sources (manuals from GitLab, finance from Google Drive) must stay as
// seeded. Before, a tick or a force-on-open resolved the provider, failed on
// the missing account (or on the owner's scope check) and stamped the source
// `error`, so the demo's Knowledge showed a broken sync.
// ---------------------------------------------------------------------------
describe("knowledge synced-source jobs — demo workspace", () => {
  it("a sync of a demo org's source is a quiet no-op: no provider, no reconcile, the row untouched", async () => {
    const { markOrgAsDemo, visitorMarker } = await import("~/modules/demo/demo-org")
    const [demo] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.organizations (id, name, slug)
            VALUES (gen_random_uuid(), 'KnowledgeJobsDemo', ${`knowledge-jobs-demo-${Date.now()}`})
            RETURNING id`,
      ),
    )
    const demoOrgId = demo!.id
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    const [owner] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
            VALUES (gen_random_uuid(), ${demoOrgId}::uuid, ${`founder-${Date.now()}@jobs.test`}, 'Founder', 'active', 'h', 1, 1)
            RETURNING id`,
      ),
    )
    const created = await withPrivilegedDb(demoOrgId, "knowledge-jobs-test-demo", (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "gitlab",
          folderRef: "resonant/manuals",
          displayName: "resonant/manuals",
          syncIntervalSeconds: 3600,
          scope: "organization",
          defaultSensitivity: "internal",
        },
        knowledgeActorFromContext({
          orgId: demoOrgId,
          userId: owner!.id,
          scopes: [SOURCES_MANAGE, DOC_READ],
          dimensionGrants: {},
        }),
        { skipPrecheck: true },
      ),
    )
    await db.execute(
      sql`UPDATE ${knowledgeRel("synced_sources")}
          SET last_sync_status = 'ok', last_sync_at = now() - interval '2 hours'
          WHERE id = ${created.id}::uuid`,
    )
    const reconcile = mock<
      (source: SyncedSourceRow, adapter: KnowledgeSourceAdapter) => Promise<undefined>
    >(async () => undefined)
    // The production adapter resolver for the scheduled tick, and a reconcile
    // spy for the force-on-open: neither reaches anything.
    await runSyncWorker({ sourceId: created.id, trigger: "schedule" })
    await runSyncWorker(
      { sourceId: created.id, trigger: "force-on-open", enqueuedBy: owner!.id },
      { reconcile },
    )
    expect(reconcile).not.toHaveBeenCalled()
    const after = await loadSyncedSourceForOrgSystem(demoOrgId, created.id)
    expect(after?.lastSyncStatus).toBe("ok")
    expect(after?.lastError).toBeNull()
  })
})
