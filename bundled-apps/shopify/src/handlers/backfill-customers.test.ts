// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B11 — Customer backfill job tests.
//
// The job is one resumable step (`ctx.steps.run`): the fake below keeps the
// step's cursor like the platform does and `runUntilSettled` plays the job's
// continuations (wake-ups) one after another. No run waits on Shopify.
//
// Behaviour exercised:
//   - bulkOperationRunQuery, a later wake polls the operation → COMPLETED
//   - fetchToBlob + iterateJsonl → one resolveContact call per row
//   - cursor checkpoint every batch
//   - resume from cursor (skip already-imported rows)
//   - bulk-op FAILED → status=failed; row persisted; event emitted
//   - cached URL expired (404 on blob fetch) → re-runs bulkOperationRunQuery
//   - empty store → completes cleanly, status=completed
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { createEnforcingEmit } from "../lib/emit.testutil"
import { validateFields } from "../lib/validate-fields.testutil"
import { BACKFILL_STEP, backfillCustomersJob, IMPORT_ROWS_PER_CHUNK } from "./backfill-customers"

interface FetchResponse {
  status?: number
  body: unknown
}

interface ResolveCall {
  email?: string
  name?: string
  externalId?: string
}

interface DbRow extends Record<string, unknown> {
  id: string
}

interface UpdateLogEntry {
  entity: string
  id: string
  data: Record<string, unknown>
}

function makeCtx(opts: {
  shopifyFetch: FetchResponse[]
  blobs?: Record<string, unknown[]> // url -> JSONL rows
  blobErrors?: Record<string, "404">
  preload?: Record<string, DbRow[]>
  /** Chunks one run takes before its budget is spent. */
  chunksPerRun?: number
}): {
  ctx: AppContext
  resolveContact: { calls: ResolveCall[] }
  updateLog: UpdateLogEntry[]
  events: Array<{ entity: string; action: string; entityId?: string; data?: unknown; metadata?: Record<string, unknown> }>
  tables: Map<string, DbRow[]>
  fetchCount: { current: number }
  steps: FakeSteps
} {
  const responses = [...opts.shopifyFetch]
  const blobs = opts.blobs ?? {}
  const blobErrors = opts.blobErrors ?? {}
  const resolveCalls: ResolveCall[] = []
  const updateLog: UpdateLogEntry[] = []
  // Enforcing emit: throws if the job emits an `${entity}:${action}` not in the
  // real app.manifest.json. This is the M4 guard — customer:backfill_completed
  // was previously undeclared, so a permissive mock let the drift ship.
  const { emit, emits: events } = createEnforcingEmit()
  const tables = new Map<string, DbRow[]>()
  tables.set("install_metadata", [
    { id: "i1", shopDomain: "demo.myshopify.com", connectionId: "ca1", apiVersion: "2026-04" } as DbRow,
  ])
  if (opts.preload) {
    for (const [k, v] of Object.entries(opts.preload)) tables.set(k, [...v])
  }
  let counter = 1
  const fetchCount = { current: 0 }

  // url → blobId map (deterministic).
  const blobIdByUrl = new Map<string, string>()
  let blobCounter = 1
  function blobIdFor(url: string): string {
    let id = blobIdByUrl.get(url)
    if (!id) {
      id = `blob-${blobCounter++}`
      blobIdByUrl.set(url, id)
    }
    return id
  }

  const steps = makeSteps(opts.chunksPerRun ?? 1000)
  const ctx = {
    userId: "u",
    orgId: "o",
    steps: steps.client,
    db: {
      findMany: async (entity: string, query?: { where?: Record<string, unknown> }) => {
        const rows = tables.get(entity) ?? []
        if (!query?.where) return rows
        return rows.filter((row) => {
          for (const [k, v] of Object.entries(query.where!)) {
            if (row[k] !== v) return false
          }
          return true
        })
      },
      findOne: async (entity: string, id: string) => {
        return (tables.get(entity) ?? []).find((r) => r.id === id) ?? null
      },
      insert: async (entity: string, data: Record<string, unknown>) => {
        // Enforce the kernel's write-path field allowlist (rpc-bridge.ts):
        // undeclared columns throw at runtime, so they must throw here too.
        validateFields(entity, data)
        const id = `${entity}-${counter++}`
        const row = { id, ...data } as DbRow
        tables.set(entity, [...(tables.get(entity) ?? []), row])
        return { id }
      },
      update: async (entity: string, id: string, data: Record<string, unknown>) => {
        validateFields(entity, data)
        updateLog.push({ entity, id, data })
        const rows = tables.get(entity) ?? []
        const idx = rows.findIndex((r) => r.id === id)
        if (idx >= 0) rows[idx] = { ...rows[idx], ...data } as DbRow
      },
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit,
    enqueueJob: async () => undefined,
    resolveContact: (async (params: ResolveCall) => {
      resolveCalls.push(params)
      return {}
    }) as AppContext["resolveContact"],
    connections: {
      shop: {
        getAccounts: async () => [
          {
            id: "ca1",
            ownerType: "org" as const,
            ownerId: null,
            identifier: "demo.myshopify.com",
            displayName: null,
          },
        ],
        getToken: async () => "test-token",
      },
    },
    fetch: async (_url: string) => {
      fetchCount.current++
      const next = responses.shift() ?? { body: {} }
      return { status: next.status ?? 200, headers: {}, body: JSON.stringify(next.body) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async (url: string) => {
        const err = blobErrors[url]
        if (err === "404") {
          const e = new Error(`blob fetch failed: 404 for ${url}`) as Error & { code?: string; status?: number }
          e.code = "BLOB_FETCH_404"
          e.status = 404
          throw e
        }
        const rows = blobs[url] ?? []
        return { blobId: blobIdFor(url), sizeBytes: JSON.stringify(rows).length }
      },
      iterateJsonl: async function* (blobId: string, iterOpts?: { batchSize?: number }) {
        // Find the URL by reverse lookup.
        const url = [...blobIdByUrl.entries()].find(([, id]) => id === blobId)?.[0]
        const rows = url ? blobs[url] ?? [] : []
        const batchSize = iterOpts?.batchSize ?? 50
        for (let i = 0; i < rows.length; i += batchSize) {
          yield rows.slice(i, i + batchSize)
        }
      },
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext

  return { ctx, resolveContact: { calls: resolveCalls }, updateLog, events, tables, fetchCount, steps }
}

/** The platform's step state, in memory: `run` loops chunks until done, a `wakeIn`, or the run's chunk budget. */
interface FakeSteps {
  client: AppContext["steps"]
  state: Map<string, { cursor: unknown; done: boolean }>
  /** The `wakeIn` of every chunk that asked for one, in order. */
  wakes: number[]
  runs: number
}

function makeSteps(chunksPerRun: number): FakeSteps {
  const state = new Map<string, { cursor: unknown; done: boolean }>()
  const fake: FakeSteps = {
    state,
    wakes: [],
    runs: 0,
    client: {
      run: (async (name: string, _opts: unknown, chunk: (c: unknown) => Promise<{ done: boolean; cursor?: unknown; wakeIn?: number }>) => {
        fake.runs++
        const st = state.get(name) ?? { cursor: null, done: false }
        state.set(name, st)
        if (st.done) return { state: "done", cursor: st.cursor, chunks: 0 }
        let chunks = 0
        while (chunks < chunksPerRun) {
          const r = await chunk(st.cursor)
          chunks++
          st.cursor = r.cursor ?? null
          if (r.done) {
            st.done = true
            return { state: "done", cursor: st.cursor, chunks }
          }
          if (r.wakeIn !== undefined) {
            fake.wakes.push(r.wakeIn)
            break
          }
        }
        return { state: "scheduled", cursor: st.cursor, chunks }
      }) as AppContext["steps"]["run"],
      get: (async (name: string) => {
        const st = state.get(name)
        return st ? { cursor: st.cursor, done: st.done, running: false, updatedAt: "" } : null
      }) as AppContext["steps"]["get"],
      reset: async (name: string) => ({ reset: state.delete(name) }),
    },
  }
  return fake
}

/** Run the job, then its continuations, until the step settles (as the platform's wake-ups would). */
async function runUntilSettled(ctx: AppContext, maxRuns = 50) {
  let result = await backfillCustomersJob({}, ctx)
  for (let i = 0; result.status === "scheduled" && i < maxRuns; i++) {
    result = await backfillCustomersJob({ _steps: { [BACKFILL_STEP]: { epoch: "e" } } }, ctx)
  }
  return result
}

const bulkRunQueryOk = (id = "bo1"): FetchResponse => ({
  body: {
    data: { bulkOperationRunQuery: { bulkOperation: { id, status: "CREATED" }, userErrors: [] } },
  },
})

const currentBulkCompleted = (id = "bo1", url: string | null = "https://cdn/jsonl/bo1.jsonl"): FetchResponse => ({
  body: { data: { node: { id, status: "COMPLETED", url, errorCode: null } } },
})

const currentBulkFailed = (id = "bo1"): FetchResponse => ({
  body: { data: { node: { id, status: "FAILED", url: null, errorCode: "INTERNAL_SERVER_ERROR" } } },
})

const currentBulkRunning = (id = "bo1"): FetchResponse => ({
  body: { data: { node: { id, status: "RUNNING", url: null, errorCode: null } } },
})

describe("backfillCustomersJob", () => {
  it("issues bulkOperationRunQuery, awaits completion, streams JSONL via ctx.bulk", async () => {
    const url = "https://cdn/jsonl/bo1.jsonl"
    const { ctx, resolveContact, events } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: [{ id: "gid://shopify/Customer/c1", email: "a@b.com" }, { id: "gid://shopify/Customer/c2", email: "c@d.com" }] },
    })
    await runUntilSettled(ctx)
    expect(resolveContact.calls.length).toBe(2)
    expect(resolveContact.calls[0]!.externalId).toBe("c1")
    expect(resolveContact.calls[0]!.email).toBe("a@b.com")
    expect(resolveContact.calls[1]!.externalId).toBe("c2")
    // M4 — completion emits customer:backfill_completed. The enforcing emit mock
    // would THROW here if that key were missing from app.manifest.json#events.emits.
    expect(events.find((e) => e.entity === "customer" && e.action === "backfill_completed")).toBeDefined()
  })

  it("saves the cursor after every chunk (250, 500, then the final one)", async () => {
    const url = "https://cdn/jsonl/big.jsonl"
    const rows = Array.from({ length: IMPORT_ROWS_PER_CHUNK * 2 + 100 }, (_, i) => ({
      id: `gid://shopify/Customer/${i + 1}`,
      email: `c${i + 1}@x`,
    }))
    const { ctx, updateLog } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: rows },
    })
    await runUntilSettled(ctx)
    const cursors = updateLog
      .filter((u) => u.entity === "backfill_progress" && u.data.cursorExternalId)
      .map((u) => u.data.cursorExternalId)
    expect(cursors).toEqual([String(IMPORT_ROWS_PER_CHUNK), String(IMPORT_ROWS_PER_CHUNK * 2), String(rows.length)])
    // No progress write may carry the kernel-managed updated_at column (the
    // sandbox rejects undeclared fields; the enforcing mock throws on them too).
    for (const u of updateLog) expect(u.data).not.toHaveProperty("updatedAt")
  })

  it("resumes from cursor; rows with external id <= cursor are skipped (numeric ids)", async () => {
    // Realistic Shopify customer ids are numeric (the trailing GID segment), so
    // resume skips every id `<= cursor` rather than depending on observing the
    // exact cursor row — robust to the cursor row being deleted between runs.
    const url = "https://cdn/jsonl/resume.jsonl"
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `gid://shopify/Customer/${1000 + i + 1}`, // 1001..1100
      email: `c${i + 1}@x`,
    }))
    const { ctx, resolveContact } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: rows },
      preload: {
        backfill_progress: [
          { id: "bp1", entityType: "customers", cursorExternalId: "1050", status: "running" } as DbRow,
        ],
      },
    })
    await runUntilSettled(ctx)
    expect(resolveContact.calls[0]!.externalId).toBe("1051")
    expect(resolveContact.calls.length).toBe(50)
  })

  it("resume is robust when the exact cursor row was deleted between runs", async () => {
    // The cursor id (1050) is absent from the export; everything `> 1050` must
    // still be imported. The previous exact-equality skip would wait forever to
    // observe 1050 and import NOTHING.
    const url = "https://cdn/jsonl/resume-gap.jsonl"
    const rows = [1048, 1049, 1051, 1052, 1053].map((n) => ({
      id: `gid://shopify/Customer/${n}`,
      email: `c${n}@x`,
    }))
    const { ctx, resolveContact } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: rows },
      preload: {
        backfill_progress: [
          { id: "bp1", entityType: "customers", cursorExternalId: "1050", status: "running" } as DbRow,
        ],
      },
    })
    await runUntilSettled(ctx)
    expect(resolveContact.calls.map((c) => c.externalId)).toEqual(["1051", "1052", "1053"])
  })

  it("on bulk-op FAILED, marks backfill_progress.status=failed and emits an event", async () => {
    const { ctx, events, tables } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkFailed()],
    })
    await runUntilSettled(ctx)
    const row = (tables.get("backfill_progress") ?? []).find((r) => r.entityType === "customers")
    expect(row).toBeDefined()
    expect(row!.status).toBe("failed")
    expect(events.find((e) => e.action === "backfill_failed")).toBeDefined()
  })

  it("empty store → completes cleanly with status=completed and no resolveContact calls", async () => {
    const url = "https://cdn/jsonl/empty.jsonl"
    const { ctx, resolveContact, tables } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: [] },
    })
    await runUntilSettled(ctx)
    expect(resolveContact.calls.length).toBe(0)
    const row = (tables.get("backfill_progress") ?? []).find((r) => r.entityType === "customers")
    expect(row!.status).toBe("completed")
  })

  it("an expired export URL (404 on blob fetch) runs the bulk operation again, keeping the cursor", async () => {
    const oldUrl = "https://cdn/jsonl/old.jsonl"
    const newUrl = "https://cdn/jsonl/new.jsonl"
    const rows = [1, 2, 3].map((n) => ({ id: `gid://shopify/Customer/${n}`, email: `c${n}@x` }))
    const { ctx, resolveContact, fetchCount } = makeCtx({
      shopifyFetch: [
        bulkRunQueryOk("bo1"),
        currentBulkCompleted("bo1", oldUrl),
        bulkRunQueryOk("bo2"),
        currentBulkCompleted("bo2", newUrl),
      ],
      blobs: { [newUrl]: rows },
      blobErrors: { [oldUrl]: "404" },
      preload: {
        backfill_progress: [
          { id: "bp1", entityType: "customers", cursorExternalId: "1", status: "running" } as DbRow,
        ],
      },
    })
    const result = await runUntilSettled(ctx)
    expect(result.status).toBe("completed")
    expect(resolveContact.calls.map((c) => c.externalId)).toEqual(["2", "3"])
    expect(fetchCount.current).toBe(4)
  })

  it("a COMPLETED operation with no url (nothing matched) completes with no import", async () => {
    const { ctx, resolveContact, tables } = makeCtx({ shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", null)] })
    const result = await runUntilSettled(ctx)
    expect(result.status).toBe("completed")
    expect(resolveContact.calls).toHaveLength(0)
    expect((tables.get("backfill_progress") ?? [])[0]!.status).toBe("completed")
  })
})

describe("backfillCustomersJob as resumable steps (no waiting in a run)", () => {
  const url = "https://cdn/jsonl/bo1.jsonl"
  const rows = [{ id: "gid://shopify/Customer/c1", email: "a@b.com" }]

  it("the first run starts the bulk operation and ends, asking to be woken; nothing is polled in that run", async () => {
    const { ctx, fetchCount, steps } = makeCtx({ shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)], blobs: { [url]: rows } })
    const first = await backfillCustomersJob({}, ctx)
    expect(first.status).toBe("scheduled")
    expect(fetchCount.current).toBe(1)
    expect(steps.wakes).toEqual([5])
  })

  it("a running operation is looked at once per wake, backing off 5, 10, 20 s", async () => {
    const { ctx, resolveContact, steps } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkRunning(), currentBulkRunning(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: rows },
    })
    const result = await runUntilSettled(ctx)
    expect(result.status).toBe("completed")
    expect(steps.wakes).toEqual([5, 10, 20])
    expect(resolveContact.calls).toHaveLength(1)
  })

  it("a large export is imported across runs, the cursor carried between them", async () => {
    const big = Array.from({ length: IMPORT_ROWS_PER_CHUNK * 2 + 10 }, (_, i) => ({
      id: `gid://shopify/Customer/${i + 1}`,
      email: `c${i + 1}@x`,
    }))
    // One chunk per run: every run after the first fetches the export again and skips what is done.
    const { ctx, resolveContact, steps, tables } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: big },
      chunksPerRun: 1,
    })
    const result = await runUntilSettled(ctx)
    expect(result).toEqual({ status: "completed", cursor: String(big.length) })
    expect(resolveContact.calls).toHaveLength(big.length)
    expect(new Set(resolveContact.calls.map((c) => c.externalId)).size).toBe(big.length)
    expect(steps.runs).toBeGreaterThan(3)
    expect((tables.get("backfill_progress") ?? [])[0]).toMatchObject({ status: "completed", cursorExternalId: String(big.length) })
  })

  it("a fresh trigger after a finished backfill starts a new one from the last imported id", async () => {
    const { ctx, resolveContact, steps } = makeCtx({
      shopifyFetch: [bulkRunQueryOk("bo1"), currentBulkCompleted("bo1", url), bulkRunQueryOk("bo2"), currentBulkCompleted("bo2", "https://cdn/2")],
      blobs: { [url]: rows, "https://cdn/2": [...rows, { id: "gid://shopify/Customer/c2", email: "n@x" }] },
    })
    await runUntilSettled(ctx)
    expect(steps.state.get(BACKFILL_STEP)?.done).toBe(true)
    const again = await runUntilSettled(ctx)
    expect(again.status).toBe("completed")
    expect(resolveContact.calls.map((c) => c.externalId)).toEqual(["c1", "c2"])
  })
})
