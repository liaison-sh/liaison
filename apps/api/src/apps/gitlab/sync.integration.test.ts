// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for the GitLab sync wiring (Task 3).
 *
 * Covers:
 *  - Production `runSyncWorker({sourceId, trigger:"schedule"}, {})` with NO
 *    injected deps — exercises the real `resolveAdapter` gitlab branch end-to-end.
 *  - `POST /synced-sources` with `appName:"gitlab"` does NOT return SOURCE_UNAVAILABLE
 *    (registry gate via `registerDefaultKnowledgeSources`).
 *  - Org-shared visibility: docs scope=organization, sensitivity=internal, team=[],
 *    owner NULL; binary → source_link; collections mirror subdir.
 *  - Event-based freshness: unchanged re-tick → NO new `knowledge.document.update`
 *    event; changed content → event queued + new body.
 *  - Deletion propagation.
 *  - Sync error → lastSyncStatus='error' + lastError carries the typed code.
 *  - Federated search wiring: registry has source==='gitlab'; stubbed searchRemote
 *    returns the GitLab hit in `federatedKnowledgeSearch`.
 *
 * HTTP boundary is stubbed via `OutboundFetchTestAccess.setFetch`.
 * DB is exercised for real (Postgres/Redis/Meili must be up).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createKnowledgeSourceRegistry,
  federatedKnowledgeSearch,
} from "~/apps/knowledge/federated-search"
import { runSyncWorker } from "~/apps/knowledge/knowledge-jobs"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import type { KnowledgeSearchInput } from "~/apps/knowledge/source-protocol"
import { registerDefaultKnowledgeSources } from "~/apps/knowledge/source-registry"
import { createSyncedSource, loadSyncedSource } from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { createScope } from "~/modules/permissions/types"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgId: string
let alice: string

const SOURCES_MANAGE = "knowledge:sources:manage"
const DOC_READ = "knowledge:documents:read"

const CANNED_TOKEN = "glpat-test-integration-token-99"
const CANNED_GROUP = "acme"
const PROJECT_ID = "123"
const BRANCH = "main"

// Folder ref format: "<projectId>:<branch>:<pathPrefix>"
const FOLDER_REF = `${PROJECT_ID}:${BRANCH}:docs`

function actor(userId: string, scopes: string[]): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: {} })
}

function rlsCtx(userId: string, scopes: string[]) {
  return { actorType: "user" as const, orgId, userId, scopes, dimensionGrants: {} }
}

// ---------------------------------------------------------------------------
// Canned GitLab API responses
// ---------------------------------------------------------------------------

const TREE_DOCS = [
  { id: "aaaa1111", name: "intro.md", type: "blob", path: "docs/intro.md" },
  { id: "bbbb2222", name: "logo.png", type: "blob", path: "docs/logo.png" },
  { id: "cccc3333", name: "chapter-1", type: "tree", path: "docs/chapter-1" },
]

const TREE_CHAPTER1 = [
  { id: "dddd4444", name: "page1.md", type: "blob", path: "docs/chapter-1/page1.md" },
]

const INTRO_BODY = "# Introduction\n\nWelcome to the docs."
const INTRO_B64 = btoa(INTRO_BODY)

const PAGE1_BODY = "# Chapter 1\n\nContent here."
const PAGE1_B64 = btoa(PAGE1_BODY)

const INTRO_BODY_V2 = "# Introduction (revised)\n\nUpdated docs."
const INTRO_B64_V2 = btoa(INTRO_BODY_V2)

const PROJECT_INFO = {
  // GitlabProject.id is a number — the real API returns a numeric id, not the
  // string we use as the URL path segment.
  id: Number(PROJECT_ID),
  path_with_namespace: "acme/my-project",
  web_url: "https://gitlab.com/acme/my-project",
  default_branch: BRANCH,
}

function makeGitlabFetch(opts: {
  treeDocs?: typeof TREE_DOCS
  treeChapter1?: typeof TREE_CHAPTER1
  introB64?: string
  page1B64?: string
  errorStatus?: number
}): typeof fetch {
  return (async (url: string | URL, _init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString()
    // Decode the path so deterministic matching works whether or not the client
    // URL-encoded `/` as `%2F` (e.g. `docs%2Fintro.md`). Matching on the decoded
    // file path also avoids false positives from group/project names.
    const decoded = decodeURIComponent(urlStr)
    const isFileReq = urlStr.includes("/files/")

    if (opts.errorStatus) {
      return new Response(JSON.stringify({ message: "mock gitlab error" }), {
        status: opts.errorStatus,
        headers: { "content-type": "application/json" },
      })
    }

    // Project info (must check before /repository routes)
    if (
      urlStr.includes(`/projects/${PROJECT_ID}`) &&
      !urlStr.includes("/repository") &&
      !urlStr.includes("/tree") &&
      !isFileReq
    ) {
      return new Response(JSON.stringify(PROJECT_INFO), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    // Tree for chapter-1 subdir
    if (urlStr.includes("/tree") && decoded.includes("docs/chapter-1")) {
      const items = opts.treeChapter1 ?? TREE_CHAPTER1
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    // Tree for docs/ (or any other path)
    if (urlStr.includes("/tree")) {
      const items = opts.treeDocs ?? TREE_DOCS
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    // File: page1.md (check the most specific path first)
    if (isFileReq && decoded.includes("docs/chapter-1/page1.md")) {
      return new Response(
        JSON.stringify({
          content: opts.page1B64 ?? PAGE1_B64,
          blob_id: "dddd4444",
          last_commit_id: "commit-def-456",
          file_name: "page1.md",
          file_path: "docs/chapter-1/page1.md",
          size: PAGE1_BODY.length,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    // File: intro.md
    if (isFileReq && decoded.includes("docs/intro.md")) {
      return new Response(
        JSON.stringify({
          content: opts.introB64 ?? INTRO_B64,
          blob_id: "aaaa1111",
          last_commit_id: "commit-abc-123",
          file_name: "intro.md",
          file_path: "docs/intro.md",
          size: INTRO_BODY.length,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    // File: logo.png (binary — adapter treats unknown/binary ext as source_link)
    if (isFileReq && decoded.includes("docs/logo.png")) {
      return new Response(
        JSON.stringify({
          content: btoa("binary-data"),
          blob_id: "bbbb2222",
          last_commit_id: "commit-xyz",
          file_name: "logo.png",
          file_path: "docs/logo.png",
          size: 11,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    // Fallback: empty array
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await acquireTestLock()
  const slug = `gitlab-sync-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'GitlabSyncIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id

  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users
          (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid,
                  ${`alice-${Date.now()}@gitlab-sync.test`},
                  'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id
  // A synced source re-checks its owner's CURRENT scopes before each fetch: the
  // creator has to hold the GitLab read scope for the sync to run.
  await db.execute(
    sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${alice}::uuid, ${orgId}::uuid, 'gitlab:repo:read')`,
  )
})

afterAll(releaseTestLock)

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedGitlabCredentials(): Promise<void> {
  const credentialsJson = JSON.stringify({ token: CANNED_TOKEN, group: CANNED_GROUP })
  const encrypted = encryptSecret(
    credentialsJson,
    env.ENCRYPTION_KEY,
    CryptoContext.connectedAccountCredentials,
  )
  await db.execute(
    sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
         identifier, access_token_encrypted, refresh_token_encrypted, credentials_encrypted,
         status, created_by)
        VALUES (
          ${orgId}::uuid, 'gitlab', 'gitlab', 'org', NULL, 'credentials',
          ${CANNED_GROUP},
          NULL, NULL,
          ${encrypted},
          'active', ${alice}::uuid
        )
        ON CONFLICT DO NOTHING`,
  )
}

async function createGitlabSource(folderRef = FOLDER_REF) {
  return withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
    createSyncedSource(
      tx,
      {
        appName: "gitlab",
        folderRef,
        displayName: "GitLab Manuals",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      },
      actor(alice, [SOURCES_MANAGE, DOC_READ]),
      { skipPrecheck: true },
    ),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitLab sync integration (T3)", () => {
  // -------------------------------------------------------------------------
  // Production runSyncWorker — exercises real resolveAdapter gitlab branch
  // -------------------------------------------------------------------------

  it("production runSyncWorker(payload, {}) materialises docs from canned HTTP", async () => {
    await seedGitlabCredentials()
    const source = await createGitlabSource()
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({}))

    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    const docs = extractRows<{ title: string; body: string }>(
      await db.execute(
        sql`SELECT title, body FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL
            ORDER BY title`,
      ),
    )
    const titles = docs.map((d) => d.title)
    expect(titles).toContain("intro.md")
    expect(titles).toContain("page1.md")
  })

  // -------------------------------------------------------------------------
  // Org-shared visibility
  // -------------------------------------------------------------------------

  it("documents materialised with scope=organization, sensitivity=internal, review owner is the creator", async () => {
    await seedGitlabCredentials()
    const source = await createGitlabSource(`${PROJECT_ID}:${BRANCH}:docs-vis`)
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({}))

    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    const docs = extractRows<{
      document_scope: string
      sensitivity: string | null
      owner_user_id: string | null
    }>(
      await db.execute(
        sql`SELECT document_scope, sensitivity, owner_user_id
            FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL
            LIMIT 1`,
      ),
    )
    expect(docs.length).toBeGreaterThan(0)
    const doc = docs[0]!
    expect(doc.document_scope).toBe("organization")
    expect(doc.sensitivity).toBe("internal")
    // An org-scoped source carries no owner, but the DOCUMENT still needs a
    // REVIEW owner or its review queue belongs to nobody, so the reconciler
    // falls back to whoever created the source
    // (apps/knowledge/sync-reconciler.ts, `source.ownerUserId ?? source.createdBy`).
    // The document is org-scoped either way: `document_scope` above is what
    // decides who can read it, not this column.
    expect(doc.owner_user_id).toBe(alice)
  })

  it("binary file (png) materialised as source_link, not document", async () => {
    await seedGitlabCredentials()
    const source = await createGitlabSource(`${PROJECT_ID}:${BRANCH}:docs-binary`)
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({}))

    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    const links = extractRows<{ title: string }>(
      await db.execute(
        sql`SELECT title FROM ${knowledgeRel("source_links")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(links.some((l) => l.title === "logo.png")).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Event-based freshness
  // -------------------------------------------------------------------------

  it("unchanged re-tick → NO new knowledge.document.update event", async () => {
    await seedGitlabCredentials()
    const source = await createGitlabSource(`${PROJECT_ID}:${BRANCH}:docs-unchanged`)
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({}))

    // First tick — establishes documents.
    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    // Mark a watermark BEFORE the second tick. Counting only events created after
    // this watermark makes the assertion immune to the outbox worker draining
    // earlier events between ticks (a raw count-equality check is fragile to that).
    const { watermark } = extractRows<{ watermark: string }>(
      await db.execute(sql`SELECT now() AS watermark`),
    )[0]!

    // Second tick — identical body → no document content change → no update event.
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({}))
    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    const newUpdateEvents = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM kernel.pending_events
            WHERE payload->>'app' = 'knowledge'
              AND payload->>'entity' = 'document'
              AND payload->>'action' = 'update'
              AND (payload->'data'->>'syncedSourceId')::uuid = ${source.id}::uuid
              AND created_at > ${watermark}`,
      ),
    )[0]!.count

    // No NEW knowledge.document.update event was queued for this source.
    expect(newUpdateEvents).toBe(0)
  })

  it("changed content → new document.update event queued + body reflects new content", async () => {
    await seedGitlabCredentials()
    const source = await createGitlabSource(`${PROJECT_ID}:${BRANCH}:docs-changed`)
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({}))

    // First tick
    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    const countBefore = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM kernel.pending_events
            WHERE payload->>'app' = 'knowledge'
              AND payload->>'entity' = 'document'
              AND payload->>'action' = 'update'
              AND (payload->'data'->>'syncedSourceId')::uuid = ${source.id}::uuid`,
      ),
    )[0]!.count

    // Second tick — changed intro body
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({ introB64: INTRO_B64_V2 }))
    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    const countAfter = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM kernel.pending_events
            WHERE payload->>'app' = 'knowledge'
              AND payload->>'entity' = 'document'
              AND payload->>'action' = 'update'
              AND (payload->'data'->>'syncedSourceId')::uuid = ${source.id}::uuid`,
      ),
    )[0]!.count

    expect(countAfter).toBeGreaterThan(countBefore)

    const doc = extractRows<{ body: string }>(
      await db.execute(
        sql`SELECT body FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid
              AND title = 'intro.md'
              AND archived_at IS NULL`,
      ),
    )[0]
    expect(doc?.body).toBe(INTRO_BODY_V2)
  })

  // -------------------------------------------------------------------------
  // Deletion propagation
  // -------------------------------------------------------------------------

  it("deletion: file removed on second tick → document archived", async () => {
    await seedGitlabCredentials()
    const source = await createGitlabSource(`${PROJECT_ID}:${BRANCH}:docs-del`)
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({}))
    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    // Second tick: empty tree
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({ treeDocs: [], treeChapter1: [] }))
    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    const active = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )[0]!.count
    expect(active).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Sync errors → lastSyncStatus='error' + lastError has typed code
  // -------------------------------------------------------------------------

  it("401 response → lastSyncStatus='error', lastError contains AUTH_REVOKED (not literal 'unauthorized')", async () => {
    await seedGitlabCredentials()
    const source = await createGitlabSource(`${PROJECT_ID}:${BRANCH}:docs-err-401`)
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({ errorStatus: 401 }))

    // The 401 surfaces in Phase A (listTree inside walkFolder), so the reconciler
    // stamps last_error then RE-THROWS — runSyncWorker rejects. Swallow the
    // re-throw; the persisted state is what the contract is about.
    await expect(runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})).rejects.toThrow()

    const reloaded = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      loadSyncedSource(tx, source.id, actor(alice, [SOURCES_MANAGE, DOC_READ])),
    )
    expect(reloaded?.lastSyncStatus).toBe("error")
    // The typed code is embedded in GitlabHttpError.message, which the reconciler
    // copies into last_error verbatim.
    expect(reloaded?.lastError).toMatch(/AUTH_REVOKED/i)
    // SyncedSourceStatus enum has no 'unauthorized' value — must NOT be that literal
    expect(reloaded?.lastError).not.toBe("unauthorized")
  })

  it("429 response → lastSyncStatus='error', lastError contains RATE_LIMITED (not literal 'rate-limited')", async () => {
    await seedGitlabCredentials()
    const source = await createGitlabSource(`${PROJECT_ID}:${BRANCH}:docs-err-429`)
    OutboundFetchTestAccess.setFetch(makeGitlabFetch({ errorStatus: 429 }))

    // A rate limit is transient upstream weather (isTransientUpstreamSyncError):
    // the reconciler stamps it on the source and the worker returns instead of
    // rethrowing, so BullMQ does not rerun the walk at once. The next interval
    // retries it.
    await runSyncWorker({ sourceId: source.id, trigger: "schedule" }, {})

    const reloaded = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      loadSyncedSource(tx, source.id, actor(alice, [SOURCES_MANAGE, DOC_READ])),
    )
    expect(reloaded?.lastSyncStatus).toBe("error")
    expect(reloaded?.lastError).toMatch(/RATE_LIMITED/i)
    expect(reloaded?.lastError).not.toBe("rate-limited")
  })

  // -------------------------------------------------------------------------
  // Create-route registry gate — POST /synced-sources must not throw SOURCE_UNAVAILABLE
  // -------------------------------------------------------------------------

  it("POST /synced-sources with appName:'gitlab' does not return 503 (SOURCE_UNAVAILABLE)", async () => {
    await seedGitlabCredentials()

    const { Hono } = await import("hono")
    const { knowledgeRoutes } = await import("~/apps/knowledge/routes")

    const app = new Hono<{ Variables: Record<string, unknown> }>()
    app.use("*", async (c, next) => {
      c.set("orgId", orgId)
      c.set("userId", alice)
      // Mounting a GitLab source needs GitLab's own read scope (source-registry.ts).
      c.set("scopes", [SOURCES_MANAGE, DOC_READ, "gitlab:repo:read"].map(createScope))
      c.set("dimensionGrants", {})
      await next()
    })
    app.route("/api/knowledge", knowledgeRoutes)

    OutboundFetchTestAccess.setFetch(makeGitlabFetch({}))

    const res = await app.request("/api/knowledge/synced-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: "gitlab",
        folderRef: `${PROJECT_ID}:${BRANCH}:docs-route`,
        displayName: "RouteTest",
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: "internal",
      }),
    })

    // 503 = SOURCE_UNAVAILABLE — the gitlab adapter must be registered.
    expect(res.status).not.toBe(503)
    // 400 would mean the GitLab colon-triple folderRef was rejected by the
    // route's zValidator (the C8 regress). With the widened FOLDER_REF_RE the
    // request reaches the handler and creates the source → 201.
    expect(res.status).toBe(201)
  })

  // -------------------------------------------------------------------------
  // Federated search wiring
  // -------------------------------------------------------------------------

  it("registry has source==='gitlab'; federatedKnowledgeSearch returns GitLab hit", async () => {
    const gitlabHit = {
      source: "gitlab" as const,
      sourceEntityId: `${PROJECT_ID}:${BRANCH}:docs/intro.md`,
      title: "intro.md",
      url: "https://gitlab.com/acme/my-project/-/blob/main/docs/intro.md",
      type: "file" as const,
      snippet: "Introduction",
      canFetchContent: true,
    }

    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "gitlab" as const,
      searchRemote: async (_input: KnowledgeSearchInput) => ({
        hits: [gitlabHit],
        status: { source: "gitlab" as const, state: "complete" as const, retryable: false },
      }),
      listFolder: async () => ({ items: [] }),
    })

    const knowledgeActor = actor(alice, [DOC_READ, SOURCES_MANAGE])
    const enabled = registry.listEnabled(knowledgeActor)
    expect(enabled.some((a) => a.source === "gitlab")).toBe(true)

    const result = await federatedKnowledgeSearch(
      { query: "introduction", limit: 10, cursors: {}, filters: {} },
      {
        actor: knowledgeActor,
        registry,
        localSearch: async () => ({
          hits: [],
          status: { source: "knowledge", state: "complete" as const, retryable: false },
        }),
        timeoutMs: 5000,
      },
    )

    const gitlabHits = result.hits.filter((h) => h.source === "gitlab")
    expect(gitlabHits.length).toBeGreaterThan(0)
    expect(gitlabHits[0]!.title).toBe("intro.md")
  })

  it("registerDefaultKnowledgeSources includes a gitlab adapter (unconditionally registered)", async () => {
    await seedGitlabCredentials()

    const registry = await withRlsContext(rlsCtx(alice, [DOC_READ, SOURCES_MANAGE]), async (tx) =>
      registerDefaultKnowledgeSources({
        tx,
        orgId,
        userId: alice,
        scopes: [DOC_READ, SOURCES_MANAGE, "gitlab:repo:read"],
      }),
    )

    const knowledgeActor = actor(alice, [DOC_READ, SOURCES_MANAGE])
    const adapters = registry.listEnabled(knowledgeActor)
    expect(adapters.some((a) => a.source === "gitlab")).toBe(true)
  })
})
