// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E2E — Module I: Knowledge bulk/folder ingest + review-queue, install → reach →
// behave, driven over the running `index.e2e.ts` server (spawned by
// `setupScenario`). Knowledge is a default app, auto-installed for every org, so
// its agent tools are already registered and reachable via the production HTTP
// tool path `POST /api/apps/tools/knowledge:<tool>`.
//
// The FULL production path runs for real here:
//   POST /api/apps/tools/knowledge:add_folder_source → executeTool scope gate →
//   QuickJS sandbox handler (`addFolderSource`) → knowledge_addFolderSource bridge
//   → registerDefaultKnowledgeSources (REAL Drive registry) → google-drive adapter
//   → makeDriveFetchers → fetchWithPinnedHost → the mock Drive HTTP server →
//   reconcileSyncedSource (harvest: files → Knowledge docs + source links) →
//   mark `needs_review` → archive source. Then `review_queue` / `verify` exercise
//   the attention + review-transition substrate over the same HTTP path.
//
// The external Google Drive REST API is the ONLY thing mocked. We stand up an
// in-process Bun.serve mock implementing the minimal `files.list` + metadata +
// content-download surface the adapter calls, and point the spawned server's
// `DRIVE_API_BASE_URL` at it (forwarded via `serverEnv`). A seeded Drive
// `connected_accounts` row lets `getTokenForConnection` resolve a bearer token,
// so the registry's real adapter authenticates against the mock. The connector
// capability itself — registry, adapter, reconciler, review queue — is real.
//
// Mock Drive is per-process global state, so these scenarios run SERIALLY within
// one worker (the default for a single describe block under bun:test).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { seedDriveConnection } from "./helpers/attachments"
import { setupScenario, teardownScenario } from "./setup"

// ─── Mock Google Drive REST server ───
//
// Implements the three endpoints the google-drive adapter calls:
//   GET /files?q='<folderRef>' in parents and trashed = false   → folder listing
//   GET /files/<id>?fields=…                                     → file metadata
//   GET /files/<id>?alt=media                                    → file content
// Folder contents are keyed by folderRef; a folderRef with no fixture lists
// empty (the empty-folder no-op edge). `FORBIDDEN_FOLDER` 401s the list so the
// adapter's create-time folder-read precheck rejects it.

interface MockDriveFile {
  id: string
  name: string
  mimeType: string
  body: string
  modifiedTime: string
}

const FOLDER_FIXTURES: Record<string, MockDriveFile[]> = {
  // ≥8 chars [A-Za-z0-9_-] — the adapter + route folderRef charset guard.
  policies_folder_1: [
    {
      id: "file_policy_a",
      name: "Refund Policy.md",
      mimeType: "text/markdown",
      body: "Refunds are honoured within 30 days of purchase.",
      modifiedTime: "2026-06-01T10:00:00.000Z",
    },
  ],
  procedures_multi_1: [
    {
      id: "file_proc_a",
      name: "Onboarding.md",
      mimeType: "text/markdown",
      body: "Step 1: create the account. Step 2: assign a role.",
      modifiedTime: "2026-06-02T10:00:00.000Z",
    },
    {
      id: "file_proc_b",
      name: "Escalation.md",
      mimeType: "text/markdown",
      body: "Escalate P1 incidents to the on-call lead immediately.",
      modifiedTime: "2026-06-03T10:00:00.000Z",
    },
    {
      id: "file_proc_c",
      name: "Glossary.txt",
      mimeType: "text/plain",
      body: "SLA: service level agreement.",
      modifiedTime: "2026-06-04T10:00:00.000Z",
    },
  ],
  empty_folder_x: [],
}

function findFileById(id: string): MockDriveFile | undefined {
  for (const files of Object.values(FOLDER_FIXTURES)) {
    const hit = files.find((f) => f.id === id)
    if (hit) return hit
  }
  return undefined
}

function startMockDrive(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0, // OS-assigned ephemeral port — never collides with worker ports.
    async fetch(req) {
      const u = new URL(req.url)
      // Bearer auth must be present (the registry resolves the seeded token).
      const auth = req.headers.get("authorization") ?? ""
      if (!auth.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "missing token" }), { status: 401 })
      }

      // GET /files?q=… → folder listing
      if (u.pathname.endsWith("/files") || u.pathname === "/files") {
        const q = u.searchParams.get("q") ?? ""
        // q is "'<folderRef>' in parents and trashed = false"
        const m = q.match(/^'([^']+)' in parents/)
        const folderRef = m?.[1] ?? ""
        if (folderRef === "FORBIDDEN_FOLDER") {
          return new Response(JSON.stringify({ error: "revoked" }), { status: 401 })
        }
        const files = FOLDER_FIXTURES[folderRef] ?? []
        return Response.json({
          files: files.map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            modifiedTime: f.modifiedTime,
          })),
        })
      }

      // GET /files/<id>?alt=media → content ; or metadata otherwise
      const fileMatch = u.pathname.match(/\/files\/([^/?]+)$/)
      if (fileMatch) {
        const file = findFileById(decodeURIComponent(fileMatch[1]!))
        if (!file) {
          return new Response(JSON.stringify({ error: "not found" }), { status: 404 })
        }
        if (u.searchParams.get("alt") === "media") {
          return new Response(file.body, {
            status: 200,
            headers: { "content-type": file.mimeType },
          })
        }
        // metadata — `canDownload:true` so the adapter's download path engages.
        return Response.json({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          webViewLink: `https://drive.example/${file.id}`,
          modifiedTime: file.modifiedTime,
          capabilities: { canDownload: true },
        })
      }

      return new Response(JSON.stringify({ error: "unhandled", path: u.pathname }), {
        status: 404,
      })
    },
  })
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

describe("Knowledge ingest E2E — Drive-folder bulk ingest + review-queue (real app, mocked Drive)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let prefix: string
  let mock: { url: string; stop: () => void }

  // Full-capability ingest/verify user.
  let manager: { id: string; token: string }
  // Reader-only user — exercises the documents:update + sources:manage scope gates.
  let reader: { id: string; token: string }

  function knowledgeSchema(): string {
    return prefix ? `"${prefix}app_knowledge"` : "app_knowledge"
  }

  async function callTool(token: string, tool: string, params: Record<string, unknown>) {
    return api(url, `/api/apps/tools/knowledge:${tool}`, {
      method: "POST",
      token,
      body: { params },
    })
  }

  beforeAll(async () => {
    // Start the mock Drive BEFORE the server spawns so its URL is known and can
    // be forwarded via serverEnv (the spawned process reads DRIVE_API_BASE_URL
    // at boot to point the real Drive adapter at our mock).
    mock = startMockDrive()

    const result = await setupScenario({
      seed: 73,
      org: { name: "Knowledge Ingest E2E Org" },
      populate: { users: { count: 1 } },
      serverEnv: { DRIVE_API_BASE_URL: mock.url },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    prefix = env.schemaPrefix ?? ""

    // The knowledge-admin persona: bulk-ingests org-wide folders AND verifies
    // the harvested docs. Verifying an ORGANIZATION-scoped document (owner_user_id
    // IS NULL) requires `knowledge:documents:admin` — the documents UPDATE RLS
    // policy gates non-owner writes behind admin (a non-admin can only verify a
    // doc they own). `:admin` is the realistic capability for this role.
    manager = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "knowledge:documents:read",
        "knowledge:documents:create",
        "knowledge:documents:update",
        "knowledge:documents:admin",
        "knowledge:sources:read",
        "knowledge:sources:manage",
        "knowledge:collections:manage",
        // Mounting a Drive folder needs Drive's own read scope (source-registry.ts).
        "google-drive:accounts:read",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    reader = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["knowledge:documents:read", "knowledge:sources:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // Seed a user-owned Drive connection for the manager so the real registry
    // resolves a bearer token (RLS: must be owner_type='user' owned by the
    // resolving user — see seedDriveConnection's contract).
    await seedDriveConnection(env, { orgId: world.org.id, userId: manager.id })
  }, 180_000)

  afterAll(async () => {
    mock?.stop()
    await teardownScenario(env, world)
  }, 15_000)

  // ─── S1: one-shot multi-file harvest → docs + source links + review entries ───
  // Spec success criterion 11 — the named gate: a folder with several files →
  // multiple knowledge docs, each with a source link AND a review_queue entry.

  it("S1: add_folder_source oneShot harvests a multi-file folder → docs + source links + review-queue entries", async () => {
    const res = await callTool(manager.token, "add_folder_source", {
      folderId: "procedures_multi_1",
      scope: "organization",
      defaultSensitivity: "internal",
      oneShot: true,
    })
    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    const d = res.body.data as {
      sourceId: string
      oneShot: boolean
      archivedAfterImport: boolean
      documentsCreated: number
    }
    expect(/^[0-9a-f-]{36}$/.test(d.sourceId)).toBe(true)
    expect(d.oneShot).toBe(true)
    expect(d.archivedAfterImport).toBe(true)
    // 3 text files in the fixture → multi-file ingest (>1).
    expect(d.documentsCreated).toBeGreaterThan(1)
    expect(d.documentsCreated).toBe(3)

    const ks = knowledgeSchema()
    // Each ingested file materialized a real Knowledge document carrying its
    // source link: synced_source_id (which source) + source_identity_id (which
    // Drive file). That per-doc provenance IS the "source link" of criterion 11
    // for text content — a text file becomes a document; only non-text files are
    // materialized into the separate source_links table.
    const docs = (await env.db.sql.unsafe(
      `SELECT id, title, body, review_status, synced_source_id, source_identity_id
         FROM ${ks}.documents
        WHERE synced_source_id = $1 AND org_id = $2 AND archived_at IS NULL
        ORDER BY title`,
      [d.sourceId, world.org.id],
    )) as unknown as Array<{
      id: string
      title: string
      body: string
      review_status: string
      synced_source_id: string
      source_identity_id: string | null
    }>
    expect(docs.length).toBe(3)
    expect(docs.map((r) => r.title)).toEqual(["Escalation.md", "Glossary.txt", "Onboarding.md"])
    // Real content flowed through the mock-Drive download path into the doc body.
    const onboarding = docs.find((r) => r.title === "Onboarding.md")
    expect(onboarding?.body).toContain("create the account")
    // Every ingested doc is flagged needs_review (the review-queue entry per doc).
    expect(docs.every((r) => r.review_status === "needs_review")).toBe(true)
    // Each doc is linked back to a distinct Drive source identity (its source link).
    expect(docs.every((r) => r.source_identity_id != null)).toBe(true)
    const identityIds = docs.map((r) => r.source_identity_id)
    expect(new Set(identityIds).size).toBe(3)

    // Those source identities resolve to real google-drive rows for each file id.
    const identities = (await env.db.sql.unsafe(
      `SELECT external_id FROM ${ks}.source_identities
        WHERE id = ANY($1::uuid[]) AND org_id = $2 AND source = 'google-drive'`,
      [identityIds, world.org.id],
    )) as unknown as Array<{ external_id: string }>
    expect(identities.map((r) => r.external_id).sort()).toEqual([
      "file_proc_a",
      "file_proc_b",
      "file_proc_c",
    ])

    // The review_queue tool surfaces every just-ingested doc by entityId.
    const queue = await callTool(manager.token, "review_queue", { limit: 50 })
    expect(queue.status).toBe(200)
    const items = queue.body.data.items as Array<{ entityId: string }>
    const queuedIds = new Set(items.map((i) => i.entityId))
    for (const doc of docs) {
      expect(queuedIds.has(doc.id)).toBe(true)
    }

    // One-shot archive-after: the synced source is archived (no perpetual sync).
    const srcRows = (await env.db.sql.unsafe(
      `SELECT archived_at FROM ${ks}.synced_sources WHERE id = $1`,
      [d.sourceId],
    )) as unknown as Array<{ archived_at: string | null }>
    expect(srcRows[0]?.archived_at).not.toBeNull()
  }, 60_000)

  // ─── S2: empty folder → no-op ───

  it("S2: empty folder → no-op (zero docs, no error)", async () => {
    const res = await callTool(manager.token, "add_folder_source", {
      folderId: "empty_folder_x",
      scope: "organization",
      oneShot: true,
    })
    expect(res.status).toBe(200)
    const d = res.body.data as { documentsCreated: number; archivedAfterImport: boolean }
    expect(d.documentsCreated).toBe(0)
    // Still archives the (empty) one-shot source — no perpetual sync left behind.
    expect(d.archivedAfterImport).toBe(true)

    const ks = knowledgeSchema()
    const docs = (await env.db.sql.unsafe(
      `SELECT id FROM ${ks}.documents
        WHERE synced_source_id = $1 AND org_id = $2`,
      [(res.body.data as { sourceId: string }).sourceId, world.org.id],
    )) as unknown as Array<{ id: string }>
    expect(docs.length).toBe(0)
  }, 60_000)

  // ─── S3: re-ingest same folder updates existing docs, no duplicates ───

  it("S3: re-ingesting the same folder updates existing docs, never creates duplicates", async () => {
    const ks = knowledgeSchema()
    const countDocs = async (): Promise<number> => {
      const rows = (await env.db.sql.unsafe(
        `SELECT COUNT(*)::text AS n FROM ${ks}.documents
          WHERE org_id = $1 AND archived_at IS NULL`,
        [world.org.id],
      )) as unknown as Array<{ n: string }>
      return Number(rows[0]?.n ?? "0")
    }

    // First harvest of a single-file folder.
    const first = await callTool(manager.token, "add_folder_source", {
      folderId: "policies_folder_1",
      scope: "organization",
      oneShot: true,
    })
    expect(first.status).toBe(200)
    expect((first.body.data as { documentsCreated: number }).documentsCreated).toBe(1)
    const afterFirst = await countDocs()

    // Second harvest of the SAME folder — the bridge reuses+reactivates the
    // existing source so the reconciler's per-source dedupe (source_identity)
    // updates the existing doc instead of materializing a duplicate.
    const second = await callTool(manager.token, "add_folder_source", {
      folderId: "policies_folder_1",
      scope: "organization",
      oneShot: true,
    })
    expect(second.status).toBe(200)
    const afterSecond = await countDocs()
    expect(afterSecond).toBe(afterFirst)

    // Exactly one active doc carries this folder's content (no dupe).
    const policyDocs = (await env.db.sql.unsafe(
      `SELECT id FROM ${ks}.documents
        WHERE org_id = $1 AND archived_at IS NULL AND title = 'Refund Policy.md'`,
      [world.org.id],
    )) as unknown as Array<{ id: string }>
    expect(policyDocs.length).toBe(1)
  }, 60_000)

  // ─── S4: verify transitions a review-queue entry to verified ───

  it("S4: verify flips a needs_review doc to verified and removes it from the review queue", async () => {
    const ks = knowledgeSchema()
    // Seed an OWNER-bearing org doc in needs_review so its ONLY review-queue
    // reason is the review status (an owner-less doc also surfaces for the
    // separate "owner missing" reason — covered by S1 — which would keep it in
    // the queue regardless of verify; an owned doc isolates the verify effect).
    const seeded = (await env.db.sql.unsafe(
      `INSERT INTO ${ks}.documents
         (org_id, title, body, document_scope, sensitivity, review_status, owner_user_id, created_by, required_scopes)
       VALUES ($1, 'Owned procedure', 'Follow these steps.', 'organization', 'internal',
               'needs_review', $2, $2, '{}'::text[])
       RETURNING id`,
      [world.org.id, manager.id],
    )) as unknown as Array<{ id: string }>
    const docId = seeded[0]!.id

    // Pre-condition: the doc IS in the review queue.
    const before = await callTool(manager.token, "review_queue", { limit: 100 })
    const beforeIds = new Set(
      (before.body.data.items as Array<{ entityId: string }>).map((i) => i.entityId),
    )
    expect(beforeIds.has(docId)).toBe(true)

    // Verify it.
    const verifyRes = await callTool(manager.token, "verify", { documentId: docId })
    expect(verifyRes.status).toBe(200)
    expect((verifyRes.body.data as { reviewStatus: string }).reviewStatus).toBe("verified")
    expect((verifyRes.body.data as { verifiedAt: string | null }).verifiedAt).toBeTruthy()

    // DB state transitioned: review_status=verified, verified_at + verified_by stamped.
    const row = (await env.db.sql.unsafe(
      `SELECT review_status, verified_at, verified_by
         FROM ${ks}.documents WHERE id = $1 AND org_id = $2`,
      [docId, world.org.id],
    )) as unknown as Array<{
      review_status: string
      verified_at: string | null
      verified_by: string | null
    }>
    expect(row[0]?.review_status).toBe("verified")
    expect(row[0]?.verified_at).not.toBeNull()
    expect(row[0]?.verified_by).toBe(manager.id)

    // Post-condition: a verified doc is excluded from the review queue.
    const after = await callTool(manager.token, "review_queue", { limit: 100 })
    const afterIds = new Set(
      (after.body.data.items as Array<{ entityId: string }>).map((i) => i.entityId),
    )
    expect(afterIds.has(docId)).toBe(false)
  }, 60_000)

  // ─── S5: review_queue is read-only ───

  it("S5: review_queue is read-only — listing does not mutate review state", async () => {
    const ks = knowledgeSchema()
    const res = await callTool(manager.token, "add_folder_source", {
      folderId: "policies_folder_1",
      scope: "organization",
      oneShot: true,
    })
    expect(res.status).toBe(200)
    const sourceId = (res.body.data as { sourceId: string }).sourceId
    const docs = (await env.db.sql.unsafe(
      `SELECT id, review_status, verified_at FROM ${ks}.documents
        WHERE synced_source_id = $1 AND org_id = $2 LIMIT 1`,
      [sourceId, world.org.id],
    )) as unknown as Array<{ id: string; review_status: string; verified_at: string | null }>
    expect(docs.length).toBe(1)
    const docId = docs[0]!.id
    const before = { review_status: docs[0]!.review_status, verified_at: docs[0]!.verified_at }

    // List the queue twice — a read-only surface must not touch the very state
    // it reports.
    await callTool(manager.token, "review_queue", { limit: 50 })
    await callTool(manager.token, "review_queue", { limit: 50 })

    const after = (await env.db.sql.unsafe(
      `SELECT review_status, verified_at FROM ${ks}.documents
        WHERE id = $1 AND org_id = $2`,
      [docId, world.org.id],
    )) as unknown as Array<{ review_status: string; verified_at: string | null }>
    expect({
      review_status: after[0]?.review_status,
      verified_at: after[0]?.verified_at,
    }).toEqual(before)
  }, 60_000)

  // ─── S6: scope gates — reader-only is forbidden from verify + org ingest ───

  it("S6: reader-only actor is forbidden from verify and org-scope add_folder_source (403)", async () => {
    const ks = knowledgeSchema()
    // Seed a needs_review doc directly so verify has a real target.
    const inserted = (await env.db.sql.unsafe(
      `INSERT INTO ${ks}.documents
         (org_id, title, body, document_scope, sensitivity, review_status, owner_user_id, created_by, required_scopes)
       VALUES ($1, 'Scope guard doc', 'x', 'organization', 'internal', 'needs_review', $2, $2, '{}'::text[])
       RETURNING id`,
      [world.org.id, manager.id],
    )) as unknown as Array<{ id: string }>
    const docId = inserted[0]!.id

    // verify requires knowledge:documents:update — reader lacks it → 403.
    const verifyForbidden = await callTool(reader.token, "verify", { documentId: docId })
    expect(verifyForbidden.status).toBe(403)

    // org-scope add_folder_source requires knowledge:sources:manage — reader
    // lacks it → 403 (the manifest tool scope gate at the HTTP boundary).
    const ingestForbidden = await callTool(reader.token, "add_folder_source", {
      folderId: "policies_folder_1",
      scope: "organization",
      oneShot: true,
    })
    expect(ingestForbidden.status).toBe(403)

    // The doc was never mutated by the forbidden verify attempt.
    const row = (await env.db.sql.unsafe(
      `SELECT review_status FROM ${ks}.documents WHERE id = $1 AND org_id = $2`,
      [docId, world.org.id],
    )) as unknown as Array<{ review_status: string }>
    expect(row[0]?.review_status).toBe("needs_review")
  }, 60_000)
})
