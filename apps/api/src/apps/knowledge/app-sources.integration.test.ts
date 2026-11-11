// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * App knowledge sources against the database (app-sources.ts): a fixture app's
 * source kind syncs N pages into Knowledge over several jobs through the real
 * sync worker, with its cursor persisted on the source; a run that failed is
 * resumed from the last written page; deletes and prune archive; a stale page
 * is refused by the compare-and-set; creation checks the kind, scope and
 * config; and the synced documents stay inside their org (RLS) and, for a
 * personal source, with their owner.
 *
 * The app's handler is a host function registered as the kind's dispatch:
 * the sandboxed run itself (QuickJS and Workers) is covered by
 * modules/apps/workers/executor-parity.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import {
  AppSourceConflictError,
  type AppSourceSyncInput,
  dbAppSourceStore,
} from "~/apps/knowledge/app-sources"
import { runSyncWorker } from "~/apps/knowledge/knowledge-jobs"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import {
  createSyncedSource,
  type SyncedSourceRow,
  type SyncedSourceScope,
} from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { knowledgeSourceKindRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "notes-app"
const READ_SCOPE = "notes_app:notes:read"
const SOURCES_MANAGE = "knowledge:sources:manage"
const DOC_READ = "knowledge:documents:read"

let orgA = ""
let orgB = ""
let alice = ""
let bob = ""
let carol = ""

/** The fixture provider: per source, its notes by page (`pages[n]` = page n's notes). */
const provider = new Map<
  string,
  { pages: string[][]; deletes?: Record<number, string[]>; failAt?: number }
>()
const calls: Array<{ sourceId: string; cursor: unknown; userId: string }> = []

async function notesHandler(input: AppSourceSyncInput, tenant: { orgId: string; userId: string }) {
  calls.push({ sourceId: input.sourceId, cursor: input.cursor, userId: tenant.userId })
  const spec = provider.get(input.sourceId)
  if (!spec) throw new Error("no notes for this source")
  const page = typeof input.cursor === "number" ? input.cursor % spec.pages.length : 0
  if (spec.failAt === page) {
    spec.failAt = undefined
    throw new Error(`provider failed on page ${page}`)
  }
  const prefix = String(input.config.prefix ?? "")
  return {
    documents: {
      upsert: (spec.pages[page] ?? []).map((id) => ({
        externalId: id,
        title: `${prefix}${id}`,
        body: `# ${id}\n\nbody of ${id}`,
        rev: `r-${page}`,
      })),
      delete: spec.deletes?.[page] ?? [],
    },
    nextCursor: page + 1,
    done: page + 1 >= spec.pages.length,
    prune: input.config.prune === true,
  }
}

function registerKind(orgId: string) {
  knowledgeSourceKindRegistry.set([orgId, APP], {
    kinds: {
      notes: {
        title: "Notes",
        handler: "syncNotes",
        readScope: READ_SCOPE,
        configSchema: {
          type: "object",
          properties: {
            prefix: { type: "string", default: "" },
            prune: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    dispatch: (_kind, input, tenant) => notesHandler(input, tenant),
  })
}

function actorOf(orgId: string, userId: string, scopes: string[]): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: {} })
}

async function newSource(opts: {
  orgId: string
  userId: string
  scope?: SyncedSourceScope
  config?: Record<string, unknown>
  scopes?: string[]
}): Promise<SyncedSourceRow> {
  const scopes = opts.scopes ?? [SOURCES_MANAGE, DOC_READ, READ_SCOPE]
  const scope = opts.scope ?? "organization"
  return withRlsContext(
    { actorType: "user", orgId: opts.orgId, userId: opts.userId, scopes, dimensionGrants: {} },
    (tx) =>
      createSyncedSource(
        tx,
        {
          appName: APP,
          folderRef: "app-source:notes",
          sourceKind: "notes",
          sourceConfig: opts.config ?? {},
          displayName: `Notes ${crypto.randomUUID().slice(0, 6)}`,
          syncIntervalSeconds: 3600,
          scope,
          ...(scope === "organization" ? { defaultSensitivity: "internal" } : {}),
        },
        actorOf(opts.orgId, opts.userId, scopes),
      ),
  )
}

/**
 * Run the sync job for a source the way the queue would: the scheduled run,
 * then each continuation it enqueued, until none is left.
 */
async function drive(
  sourceId: string,
  opts: { maxPagesPerJob?: number; ownerScopes?: string[] } = {},
): Promise<{ jobs: number; continuations: string[] }> {
  const queue: Array<{ trigger: "schedule" | "continue" }> = [{ trigger: "schedule" }]
  const continuations: string[] = []
  let jobs = 0
  while (queue.length > 0) {
    const next = queue.shift()!
    jobs++
    await runSyncWorker(
      { sourceId, trigger: next.trigger },
      {
        appSource: {
          setUpAppSourceOrg: async () => undefined,
          ownerScopes: async () => opts.ownerScopes ?? [READ_SCOPE, DOC_READ],
          enqueueContinuation: async (id, generation) => {
            continuations.push(`sync:${id}:g${generation}`)
            queue.push({ trigger: "continue" })
          },
          limits: { maxPagesPerJob: opts.maxPagesPerJob ?? 2 },
        },
      },
    )
  }
  return { jobs, continuations }
}

async function sourceState(id: string) {
  const [row] = extractRows<{
    sync_cursor: unknown
    sync_generation: number
    sync_pass_started_at: string | null
    last_sync_status: string
    last_error: string | null
  }>(
    await db.execute(sql`
      SELECT sync_cursor, sync_generation, sync_pass_started_at, last_sync_status, last_error
      FROM ${knowledgeRel("synced_sources")} WHERE id = ${id}::uuid`),
  )
  return row!
}

async function docsOf(sourceId: string) {
  return extractRows<{
    title: string
    body: string
    archived: boolean
    external_id: string
    source: string
    in_root: boolean
    org_id: string
  }>(
    await db.execute(sql`
      SELECT d.title, d.body, d.archived_at IS NOT NULL AS archived, si.external_id, si.source,
             d.org_id::text AS org_id,
             EXISTS (
               SELECT 1 FROM ${knowledgeRel("collection_memberships")} cm
               JOIN ${knowledgeRel("synced_sources")} s ON s.root_collection_id = cm.collection_id
               WHERE s.id = d.synced_source_id AND cm.target_id = d.id
             ) AS in_root
      FROM ${knowledgeRel("documents")} d
      JOIN ${knowledgeRel("source_identities")} si ON si.id = d.source_identity_id
      WHERE d.synced_source_id = ${sourceId}::uuid
      ORDER BY si.external_id`),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  orgA = (await createTestOrg()).id
  alice = (await minimal.orgAdmin(orgA)).id
  bob = (await minimal.person(orgA)).id
  const second = await minimal.secondOrg({ name: "App sources B" })
  orgB = second.orgId
  carol = second.adminUserId
  registerKind(orgA)
  registerKind(orgB)
})

afterAll(async () => {
  knowledgeSourceKindRegistry.delete([orgA, APP])
  knowledgeSourceKindRegistry.delete([orgB, APP])
  await releaseTestLock()
})

describe("an app source syncs into Knowledge", () => {
  it("syncs N pages over several jobs, the cursor persisted on the source", async () => {
    const source = await newSource({ orgId: orgA, userId: alice, config: { prefix: "N:" } })
    expect(source.sourceKind).toBe("notes")
    expect(source.sourceConfig).toEqual({ prefix: "N:" })
    provider.set(source.id, { pages: [["a1", "a2"], ["b1"], ["c1", "c2"], ["d1"], ["e1"]] })

    const run = await drive(source.id, { maxPagesPerJob: 2 })
    expect(run.jobs).toBe(3)
    expect(run.continuations).toEqual([`sync:${source.id}:g2`, `sync:${source.id}:g4`])
    expect(calls.filter((c) => c.sourceId === source.id).map((c) => c.cursor)).toEqual([
      null,
      1,
      2,
      3,
      4,
    ])
    // The run acts for the source's creator (an org source has no owner).
    expect(new Set(calls.filter((c) => c.sourceId === source.id).map((c) => c.userId))).toEqual(
      new Set([alice]),
    )
    const docs = await docsOf(source.id)
    expect(docs.map((d) => d.external_id)).toEqual(["a1", "a2", "b1", "c1", "c2", "d1", "e1"])
    expect(
      docs.every((d) => d.source === APP && d.in_root && !d.archived && d.org_id === orgA),
    ).toBe(true)
    expect(docs[0]?.title).toBe("N:a1")
    const state = await sourceState(source.id)
    expect(state.last_sync_status).toBe("ok")
    expect(state.sync_cursor).toBe(5)
    expect(state.sync_generation).toBe(5)
    expect(state.sync_pass_started_at).toBeNull()
  })

  it("resumes from the last written page after a failed run, in the same pass", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    provider.set(source.id, { pages: [["p0"], ["p1"], ["p2"], ["p3"]], failAt: 2 })
    await expect(drive(source.id, { maxPagesPerJob: 10 })).rejects.toThrow(
      "provider failed on page 2",
    )
    const failed = await sourceState(source.id)
    expect(failed.last_sync_status).toBe("error")
    expect(failed.last_error).toBe("provider failed on page 2")
    expect(failed.sync_cursor).toBe(2)
    expect(failed.sync_pass_started_at).not.toBeNull()
    expect((await docsOf(source.id)).map((d) => d.external_id)).toEqual(["p0", "p1"])

    await drive(source.id, { maxPagesPerJob: 10 })
    expect(calls.filter((c) => c.sourceId === source.id).map((c) => c.cursor)).toEqual([
      null,
      1,
      2,
      2,
      3,
    ])
    expect((await docsOf(source.id)).map((d) => d.external_id)).toEqual(["p0", "p1", "p2", "p3"])
    const done = await sourceState(source.id)
    expect(done.last_sync_status).toBe("ok")
    expect(done.last_error).toBeNull()
  })

  it("archives deleted ids, and with prune what the pass did not list", async () => {
    const source = await newSource({ orgId: orgA, userId: alice, config: { prune: true } })
    provider.set(source.id, {
      pages: [
        ["k1", "k2"],
        ["k3", "k4"],
      ],
    })
    await drive(source.id)
    expect((await docsOf(source.id)).filter((d) => !d.archived)).toHaveLength(4)

    // The next pass starts from the kept cursor (2 -> page 0): it deletes k2
    // and no longer lists k4, which prune archives at the end of the pass.
    provider.set(source.id, { pages: [["k1"], ["k3"]], deletes: { 0: ["k2"] } })
    await drive(source.id)
    const docs = await docsOf(source.id)
    expect(docs.map((d) => [d.external_id, d.archived])).toEqual([
      ["k1", false],
      ["k2", true],
      ["k3", false],
      ["k4", true],
    ])
    const [events] = extractRows<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM kernel.pending_events
        WHERE org_id = ${orgA}::uuid
          AND payload->>'action' = 'archive'
          AND payload->'data'->>'syncedSourceId' = ${source.id}`),
    )
    expect(events?.n).toBe(2)
  })

  it("refuses a page whose generation moved: nothing is written", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    const begun = await dbAppSourceStore.beginAppSourcePass(source)
    const page = {
      upserts: [{ externalId: "x1", title: "X1", body: "x" }],
      deletes: [],
      nextCursor: 1,
      done: false,
      prune: false,
    }
    await dbAppSourceStore.applyAppSourcePage(source, begun, page)
    await expect(
      dbAppSourceStore.applyAppSourcePage(source, begun, {
        ...page,
        upserts: [{ externalId: "x2", title: "X2", body: "x" }],
      }),
    ).rejects.toBeInstanceOf(AppSourceConflictError)
    expect((await docsOf(source.id)).map((d) => d.external_id)).toEqual(["x1"])
    expect((await sourceState(source.id)).sync_generation).toBe(1)
  })

  it("stops syncing when the owner no longer holds the kind's read scope", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    provider.set(source.id, { pages: [["z1"]] })
    await drive(source.id, { ownerScopes: [DOC_READ] })
    const state = await sourceState(source.id)
    expect(state.last_sync_status).toBe("error")
    expect(state.last_error).toBe(`the source owner no longer holds ${READ_SCOPE}`)
    expect(await docsOf(source.id)).toEqual([])
  })
})

describe("creating an app source", () => {
  it("checks the kind, the read scope and the config", async () => {
    const create = (over: { kind?: string; scopes?: string[]; config?: Record<string, unknown> }) =>
      withRlsContext(
        {
          actorType: "user",
          orgId: orgA,
          userId: alice,
          scopes: over.scopes ?? [SOURCES_MANAGE, DOC_READ, READ_SCOPE],
          dimensionGrants: {},
        },
        (tx) =>
          createSyncedSource(
            tx,
            {
              appName: APP,
              folderRef: "app-source:notes",
              sourceKind: over.kind ?? "notes",
              sourceConfig: over.config ?? {},
              displayName: "Notes",
              syncIntervalSeconds: 3600,
              scope: "organization",
              defaultSensitivity: "internal",
            },
            actorOf(orgA, alice, over.scopes ?? [SOURCES_MANAGE, DOC_READ, READ_SCOPE]),
          ),
      )
    await expect(create({ kind: "wiki" })).rejects.toMatchObject({ code: "SOURCE_NOT_ENABLED" })
    await expect(create({ scopes: [SOURCES_MANAGE, DOC_READ] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(create({ config: { unknown: 1 } })).rejects.toMatchObject({ code: "VALIDATION" })
    // Defaults from the config schema are kept.
    expect((await create({})).sourceConfig).toEqual({ prefix: "" })
  })
})

describe("synced documents stay where they belong", () => {
  it("another org reads none of them; a personal source's documents are its owner's", async () => {
    const orgSource = await newSource({ orgId: orgA, userId: alice })
    provider.set(orgSource.id, { pages: [["iso-org-1", "iso-org-2"]] })
    await drive(orgSource.id)
    const personal = await newSource({ orgId: orgA, userId: alice, scope: "personal" })
    provider.set(personal.id, { pages: [["iso-mine-1"]] })
    await drive(personal.id)
    // The same kind in another org syncs into that org only.
    const other = await newSource({ orgId: orgB, userId: carol })
    provider.set(other.id, { pages: [["iso-b-1"]] })
    await drive(other.id)

    const visible = (orgId: string, userId: string) =>
      withRlsContext(
        { actorType: "user", orgId, userId, scopes: [DOC_READ], dimensionGrants: {} },
        async (tx) =>
          extractRows<{ title: string }>(
            await tx.execute(sql`
              SELECT title FROM ${knowledgeRel("documents")}
              WHERE synced_source_id IN (${orgSource.id}::uuid, ${personal.id}::uuid, ${other.id}::uuid)
              ORDER BY title`),
          ).map((r) => r.title),
      )
    const carolSees = await visible(orgB, carol)
    expect(carolSees).toEqual(["iso-b-1"])
    expect(await visible(orgA, bob)).not.toContain("iso-mine-1")
    expect(await visible(orgA, alice)).toContain("iso-mine-1")
    expect(await visible(orgA, alice)).not.toContain("iso-b-1")
    expect((await docsOf(personal.id)).map((d) => d.org_id)).toEqual([orgA])
  })
})
