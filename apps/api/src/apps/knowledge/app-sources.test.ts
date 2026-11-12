// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app knowledge source contract (app-sources.ts) without a database: the
// page check, and the sync loop over an in-memory store that applies a page
// and its cursor atomically behind the same generation compare-and-set.
import { describe, expect, it } from "bun:test"
import {
  APP_SOURCE_LIMITS,
  AppSourceConflictError,
  AppSourceContractError,
  type AppSourceDocument,
  type AppSourcePage,
  type AppSourceState,
  type AppSourceStore,
  type AppSourceSyncInput,
  parseSyncResult,
  runAppSourceSync,
} from "~/apps/knowledge/app-sources"
import type { SyncedSourceRow } from "~/apps/knowledge/synced-sources"

const SOURCE: SyncedSourceRow = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  appName: "notes-app",
  folderRef: "app-source:notes",
  displayName: "Notes",
  rootCollectionId: "33333333-3333-4333-8333-333333333333",
  ownerUserId: null,
  sourceAccount: null,
  defaultSensitivity: "internal",
  syncIntervalSeconds: 3600,
  lastSyncAt: null,
  lastSyncStatus: "idle",
  lastError: null,
  createdBy: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  archivedAt: null,
  sourceKind: "notes",
  sourceConfig: { total: 5 },
}

/** The store's committed state, as the database would hold it. */
function memoryStore() {
  const db = {
    cursor: null as unknown,
    generation: 0,
    passStartedAt: null as string | null,
    status: "idle",
    lastError: null as string | null,
    docs: new Map<string, { doc: AppSourceDocument; archived: boolean; pass: number }>(),
    pass: 0,
  }
  const store: AppSourceStore = {
    async beginAppSourcePass() {
      db.status = "running"
      if (!db.passStartedAt) {
        db.pass += 1
        db.passStartedAt = `pass-${db.pass}`
      }
      return { cursor: db.cursor, generation: db.generation, passStartedAt: db.passStartedAt }
    },
    async applyAppSourcePage(_source, from: AppSourceState, page: AppSourcePage) {
      if (db.generation !== from.generation) throw new AppSourceConflictError(SOURCE.id)
      for (const doc of page.upserts)
        db.docs.set(doc.externalId, { doc, archived: false, pass: db.pass })
      let archived = 0
      for (const id of page.deletes) {
        const d = db.docs.get(id)
        if (d && !d.archived) {
          d.archived = true
          archived++
        }
      }
      if (page.done && page.prune) {
        for (const d of db.docs.values()) {
          if (!d.archived && d.pass !== db.pass) {
            d.archived = true
            archived++
          }
        }
      }
      db.cursor = page.nextCursor
      db.generation += 1
      if (page.done) {
        db.passStartedAt = null
        db.status = "ok"
        db.lastError = null
      }
      return {
        state: { cursor: db.cursor, generation: db.generation, passStartedAt: db.passStartedAt },
        upserted: page.upserts.length,
        archived,
      }
    },
    async failAppSourceSync(_source, message) {
      db.status = "error"
      db.lastError = message
    },
  }
  return { db, store }
}

/** A fixture app: one note per page, `total` pages, cursor = the next page number. */
function notesApp(
  total: number,
  opts: { failAt?: number; deleteAt?: Record<number, string[]> } = {},
) {
  const seen: unknown[] = []
  const dispatch = async (input: AppSourceSyncInput) => {
    seen.push(input.cursor)
    const page = typeof input.cursor === "number" ? input.cursor : 0
    if (opts.failAt === page) throw new Error(`provider down at page ${page}`)
    return {
      documents: {
        upsert: [{ externalId: `note-${page}`, title: `Note ${page}`, body: `body ${page}` }],
        delete: opts.deleteAt?.[page] ?? [],
      },
      nextCursor: page + 1,
      done: page + 1 >= total,
    }
  }
  return { dispatch, seen }
}

describe("parseSyncResult", () => {
  it("normalises a page: defaults, a null cursor, prune only on the final page", () => {
    expect(parseSyncResult({ done: true })).toEqual({
      upserts: [],
      deletes: [],
      nextCursor: null,
      done: true,
      prune: false,
    })
    expect(
      parseSyncResult({
        documents: {
          upsert: [{ externalId: "a", title: "A", body: "x", rev: "r1", extra: 1 }],
          delete: ["b"],
        },
        nextCursor: { after: "a" },
        done: false,
        prune: true,
      }),
    ).toEqual({
      upserts: [{ externalId: "a", title: "A", body: "x", rev: "r1" }],
      deletes: ["b"],
      nextCursor: { after: "a" },
      done: false,
      prune: false,
    })
  })

  it("refuses a page that breaks the contract", () => {
    const bad =
      (raw: unknown, limits = APP_SOURCE_LIMITS) =>
      () =>
        parseSyncResult(raw, limits)
    expect(bad(null)).toThrow(AppSourceContractError)
    expect(bad({})).toThrow("done must be a boolean")
    expect(bad({ done: false })).toThrow("must return a nextCursor")
    expect(bad({ done: true, documents: { upsert: [{ externalId: "a", body: "x" }] } })).toThrow(
      "title",
    )
    expect(
      bad({
        done: true,
        documents: {
          upsert: [
            { externalId: "a", title: "A", body: "" },
            { externalId: "a", title: "A2", body: "" },
          ],
        },
      }),
    ).toThrow("appears twice")
    expect(
      bad({
        done: true,
        documents: { upsert: [{ externalId: "a", title: "A", body: "" }], delete: ["a"] },
      }),
    ).toThrow("both upserted and deleted")
    expect(bad({ done: true, documents: { delete: [""] } })).toThrow("non-empty string")
    expect(bad({ done: false, nextCursor: "x".repeat(20_000) })).toThrow("larger than")
    const small = { ...APP_SOURCE_LIMITS, maxUpserts: 1, maxBodyChars: 3 }
    expect(
      bad(
        {
          done: true,
          documents: {
            upsert: [
              { externalId: "a", title: "A", body: "" },
              { externalId: "b", title: "B", body: "" },
            ],
          },
        },
        small,
      ),
    ).toThrow("at most 1 per page")
    expect(
      bad(
        { done: true, documents: { upsert: [{ externalId: "a", title: "A", body: "long" }] } },
        small,
      ),
    ).toThrow("at most 3")
  })
})

describe("runAppSourceSync", () => {
  it("syncs N pages over several jobs, the cursor persisted after each page", async () => {
    const { db, store } = memoryStore()
    const app = notesApp(5)
    const continuations: number[] = []
    const enqueueContinuation = async (_id: string, generation: number) => {
      continuations.push(generation)
    }
    const deps = {
      dispatch: app.dispatch,
      store,
      enqueueContinuation,
      limits: { maxPagesPerJob: 2 },
    }
    expect((await runAppSourceSync(SOURCE, deps)).state).toBe("continued")
    expect(db.cursor).toBe(2)
    expect(db.status).toBe("running")
    expect((await runAppSourceSync(SOURCE, deps)).state).toBe("continued")
    const last = await runAppSourceSync(SOURCE, deps)
    expect(last).toEqual({ state: "done", pages: 1, upserted: 1, archived: 0 })
    expect(app.seen).toEqual([null, 1, 2, 3, 4])
    expect(continuations).toEqual([2, 4])
    expect([...db.docs.keys()]).toEqual(["note-0", "note-1", "note-2", "note-3", "note-4"])
    expect(db.status).toBe("ok")
    expect(db.passStartedAt).toBeNull()
    // The final cursor is kept: the next pass starts from it (an incremental sync).
    expect(db.cursor).toBe(5)
  })

  it("resumes from the last written page after a run that failed mid-pass", async () => {
    const { db, store } = memoryStore()
    const enqueueContinuation = async () => undefined
    const broken = notesApp(4, { failAt: 2 })
    await expect(
      runAppSourceSync(SOURCE, { dispatch: broken.dispatch, store, enqueueContinuation }),
    ).rejects.toThrow("provider down at page 2")
    expect(db.status).toBe("error")
    expect(db.lastError).toBe("provider down at page 2")
    expect(db.cursor).toBe(2)
    expect(db.passStartedAt).toBe("pass-1")
    // The next run asks for page 2 again, in the same pass.
    const healthy = notesApp(4)
    const out = await runAppSourceSync(SOURCE, {
      dispatch: healthy.dispatch,
      store,
      enqueueContinuation,
    })
    expect(out.state).toBe("done")
    expect(healthy.seen).toEqual([2, 3])
    expect(db.docs.size).toBe(4)
    expect(db.pass).toBe(1)
  })

  it("resumes when the job died after a page committed but before its continuation", async () => {
    const { db, store } = memoryStore()
    const app = notesApp(3)
    await expect(
      runAppSourceSync(SOURCE, {
        dispatch: app.dispatch,
        store,
        enqueueContinuation: async () => {
          throw new Error("queue unreachable")
        },
        limits: { maxPagesPerJob: 1 },
      }),
    ).rejects.toThrow("queue unreachable")
    expect(db.cursor).toBe(1)
    expect(db.lastError).toContain("Could not schedule the next page")
    const out = await runAppSourceSync(SOURCE, {
      dispatch: app.dispatch,
      store,
      enqueueContinuation: async () => undefined,
    })
    expect(out.state).toBe("done")
    expect(app.seen).toEqual([null, 1, 2])
  })

  it("applies deletes, and prune on the final page archives what the pass did not see", async () => {
    const { db, store } = memoryStore()
    const enqueueContinuation = async () => undefined
    await runAppSourceSync(SOURCE, { dispatch: notesApp(3).dispatch, store, enqueueContinuation })
    db.cursor = null
    // Second pass: page 0 deletes note-1, and the pass lists only page 0 then prunes.
    const out = await runAppSourceSync(SOURCE, {
      dispatch: async () => ({
        documents: {
          upsert: [{ externalId: "note-0", title: "Note 0", body: "v2" }],
          delete: ["note-1"],
        },
        nextCursor: null,
        done: true,
        prune: true,
      }),
      store,
      enqueueContinuation,
    })
    expect(out).toEqual({ state: "done", pages: 1, upserted: 1, archived: 2 })
    expect([...db.docs].map(([id, d]) => [id, d.archived])).toEqual([
      ["note-0", false],
      ["note-1", true],
      ["note-2", true],
    ])
    expect(db.docs.get("note-0")?.doc.body).toBe("v2")
  })

  it("stops at the job's time budget and hands over", async () => {
    const { db, store } = memoryStore()
    let clock = 0
    const app = notesApp(10)
    const dispatch = async (input: AppSourceSyncInput) => {
      clock += 20_000
      return app.dispatch(input)
    }
    const continuations: number[] = []
    const out = await runAppSourceSync(SOURCE, {
      dispatch,
      store,
      enqueueContinuation: async (_id, g) => {
        continuations.push(g)
      },
      now: () => clock,
    })
    expect(out.state).toBe("continued")
    expect(out.pages).toBe(3)
    expect(continuations).toEqual([3])
    expect(db.cursor).toBe(3)
  })

  it("writes nothing for a page that breaks the contract, and says why on the source", async () => {
    const { db, store } = memoryStore()
    await expect(
      runAppSourceSync(SOURCE, {
        dispatch: async () => ({ documents: { upsert: "nope" }, done: true }),
        store,
        enqueueContinuation: async () => undefined,
      }),
    ).rejects.toThrow(AppSourceContractError)
    expect(db.generation).toBe(0)
    expect(db.lastError).toBe("Sync page refused: documents.upsert must be a list")
  })

  it("a run that loses the compare-and-set stops quietly", async () => {
    const { db, store } = memoryStore()
    const out = await runAppSourceSync(SOURCE, {
      dispatch: async (input) => {
        // Another run applies a page while this one waits on the app.
        if (db.generation === 0) db.generation = 1
        return notesApp(3).dispatch(input)
      },
      store,
      enqueueContinuation: async () => undefined,
    })
    expect(out.state).toBe("conflict")
    expect(db.docs.size).toBe(0)
    expect(db.status).toBe("running")
  })
})
