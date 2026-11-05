// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"
import { pruneGhostDocuments, reindexOrg } from "./reindex"
import type { SearchableEntityRegistration } from "./searchable-entities"

// Document-building parity semantics (null participant_ids skipped, empty
// dimension arrays skipped, org_wide=false emitted) now live in
// `doc-builder.test.ts` — reindex.ts and indexer.ts both delegate to the one
// shared `buildSearchDocument`, so there is nothing reindex-specific left to
// test here beyond the ghost-document sweep.

describe("pruneGhostDocuments — full-reindex ghost sweep", () => {
  // Fake Meili index: getDocuments returns whatever `existing` holds (paginated),
  // deleteDocuments removes ids from it. Mirrors the real client's shape closely
  // enough for pruneGhostDocuments' calls (getDocuments({filter,fields,limit,offset}),
  // deleteDocuments(ids), and the taskUid + tasks.waitForTask() plumbing).
  function fakeMeiliWith(existingIds: string[]) {
    const existing = new Set(existingIds)
    const deleteDocuments = mock(async (ids: string[]) => {
      for (const id of ids) existing.delete(id)
      return { taskUid: 1 }
    })
    const getDocuments = mock(async ({ limit, offset }: { limit: number; offset: number }) => {
      const all = Array.from(existing).map((id) => ({ id }))
      return { results: all.slice(offset, offset + limit) }
    })
    const index = { getDocuments, deleteDocuments }
    const meili = { tasks: { waitForTask: mock(async () => undefined) } }
    return { index, meili, existing, deleteDocuments, getDocuments }
  }

  const reg: SearchableEntityRegistration = {
    app: "knowledge",
    entityType: "document",
    readScope: "knowledge:documents:read",
    permissionFields: {},
  }

  it("deletes a Meili document with no backing Postgres row (the ghost-index bug)", async () => {
    // Ghost ids matching the reported symptom: present in the index, absent from
    // the live set built by streaming app_knowledge.documents.
    const ghostId = "org-1_knowledge_document_d41c5e89-c91a-43d2-9e1f-02b796e19c87"
    const liveId = "org-1_knowledge_document_11111111-1111-1111-1111-111111111111"
    const { index, meili, existing, deleteDocuments } = fakeMeiliWith([ghostId, liveId])

    const pruned = await pruneGhostDocuments(
      index as any,
      meili as any,
      "org-1",
      reg,
      new Set([liveId]),
    )

    expect(pruned).toBe(1)
    expect(deleteDocuments).toHaveBeenCalledTimes(1)
    expect(deleteDocuments.mock.calls[0][0]).toEqual([ghostId])
    expect(existing.has(ghostId)).toBe(false)
    expect(existing.has(liveId)).toBe(true) // the live doc must survive the sweep
  })

  it("is a no-op when every indexed document has a live backing row", async () => {
    const liveId = "org-1_knowledge_document_22222222-2222-2222-2222-222222222222"
    const { index, meili, deleteDocuments } = fakeMeiliWith([liveId])

    const pruned = await pruneGhostDocuments(
      index as any,
      meili as any,
      "org-1",
      reg,
      new Set([liveId]),
    )

    expect(pruned).toBe(0)
    expect(deleteDocuments).not.toHaveBeenCalled()
  })

  it("passes an org/app/entityType-scoped filter to getDocuments so unrelated documents are never fetched", async () => {
    const liveId = "org-1_knowledge_document_33333333-3333-3333-3333-333333333333"
    const { index, meili, getDocuments } = fakeMeiliWith([liveId])

    await pruneGhostDocuments(index as any, meili as any, "org-1", reg, new Set([liveId]))

    expect(getDocuments).toHaveBeenCalled()
    const call = getDocuments.mock.calls[0][0] as unknown as { filter: string }
    expect(call.filter).toContain('org_id = "org-1"')
    expect(call.filter).toContain('app = "knowledge"')
    expect(call.filter).toContain('entity_type = "document"')
  })
})

describe("reindexOrg — a bulk delete then a re-seed leaves one document per row", () => {
  it("prunes the documents of rows a reset deleted, so a re-seeded result is listed once, not three times", async () => {
    // The demo box after two nightly resets: the same seeded project, created
    // under a fresh random id by each seed, and the index still holding the
    // two documents the plain-SQL deletes never told it about.
    const org = "org-1"
    const docId = (id: string) => `${org}_projects_project_${id}`
    const index = new Map<string, Record<string, unknown>>()
    for (const id of ["night-1", "night-2", "night-3"]) {
      index.set(docId(id), { id: docId(id), title: "Field Preamp launch" })
    }
    const fakeIndex = {
      addDocuments: mock(async (docs: Array<Record<string, unknown>>) => {
        for (const d of docs) index.set(d.id as string, d)
        return { taskUid: 1 }
      }),
      getDocuments: mock(async ({ limit, offset }: { limit: number; offset: number }) => ({
        results: Array.from(index.keys())
          .map((id) => ({ id }))
          .slice(offset, offset + limit),
      })),
      deleteDocuments: mock(async (ids: string[]) => {
        for (const id of ids) index.delete(id)
        return { taskUid: 2 }
      }),
    }
    const meili = { tasks: { waitForTask: mock(async () => undefined) } }
    const projects: SearchableEntityRegistration = {
      app: "projects",
      entityType: "project",
      readScope: "projects:projects:read",
      tableName: "projects",
      permissionFields: {},
    }
    // Postgres holds only tonight's row.
    const stream = mock(
      async (
        _reg: SearchableEntityRegistration,
        _orgId: string,
        onBatch: (docs: Record<string, unknown>[]) => Promise<void>,
        onLiveIds?: (ids: string[]) => void,
      ) => {
        const live = [{ id: docId("night-3"), title: "Field Preamp launch" }]
        onLiveIds?.(live.map((d) => d.id))
        await onBatch(live)
        return live.length
      },
    )

    const result = await reindexOrg(org, {
      meili: meili as any,
      index: fakeIndex as any,
      registrations: [projects],
      stream: stream as any,
    })

    expect(result).toEqual({ docs: 1, pruned: 2 })
    const titles = Array.from(index.values()).filter((d) => d.title === "Field Preamp launch")
    expect(titles).toHaveLength(1)
    expect(index.has(docId("night-3"))).toBe(true)
  })
})

// W2 review finding 5: the demo reset's in-place resync writes the live index
// directly; while a rebuild runs, its writes must be noted for the rebuild's
// replay, or the swap brings back what the resync just removed.
describe("reindexOrg during a rebuild", () => {
  it("notes every document it writes and every ghost it prunes", async () => {
    const { redis } = await import("~/lib/redis")
    const { IndexWriterTestAccess, REBUILD_KEYS } = await import("./index-writer")
    await redis.del(REBUILD_KEYS.touched)
    await redis.set(REBUILD_KEYS.lock, "rebuild", "PX", 10_000)
    IndexWriterTestAccess.resetRebuildCache()
    try {
      const ghost = "org-1_knowledge_document_ghost"
      const index = {
        uid: "fake",
        addDocuments: mock(async () => ({ taskUid: 1 })),
        getDocuments: mock(async () => ({ results: [{ id: ghost }] })),
        deleteDocuments: mock(async () => ({ taskUid: 2 })),
      }
      const meili = { tasks: { waitForTask: mock(async () => ({ status: "succeeded" })) } }
      const reg: SearchableEntityRegistration = {
        app: "knowledge",
        entityType: "document",
        readScope: "knowledge:documents:read",
        tableName: "documents",
        permissionFields: {},
      }
      const stream = mock(async (_r: unknown, _o: string, onBatch: any, onLive: any) => {
        const doc = { id: "org-1_knowledge_document_d1", entity_id: "d1" }
        onLive([doc.id])
        await onBatch([doc])
        return 1
      })
      await reindexOrg("org-1", {
        meili: meili as any,
        index: index as any,
        registrations: [reg],
        stream: stream as any,
      })
      const noted = await redis.hgetall(REBUILD_KEYS.touched)
      expect(Object.keys(noted).some((k) => k === "org-1_knowledge_document_d1")).toBe(true)
      const del = Object.values(noted)
        .map((v) => JSON.parse(v))
        .find((i) => i.t === "raw")
      expect(del?.payload.ids).toEqual([ghost])
    } finally {
      await redis.del(REBUILD_KEYS.lock, REBUILD_KEYS.touched)
      IndexWriterTestAccess.resetRebuildCache()
    }
  })
})
