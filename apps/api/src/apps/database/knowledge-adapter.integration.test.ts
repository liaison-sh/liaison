// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Integration test: the database Knowledge source adapter driven through a
// REAL `validateCatalog`'d fixture catalog (kb-sync) + a fake in-memory
// DbTransport. Proves the adapter runs the two well-known curated reads
// (knowledge_sync_list / knowledge_sync_get) against a genuine catalog —
// params validated, columns projected — and materializes items + bodies,
// including a real keyset page → nextCursor → next page round-trip.
//
// No DB, no `pg` client: the transport is a fake over an in-memory KB table,
// and ALL SQL is owned by the fixture catalog (no raw identifier
// interpolation). Follows the existing __fixtures__ + validateCatalog pattern
// (adapters/__fixtures__/toy-shop.ts, database-app.integration.test.ts).

import { describe, expect, it } from "bun:test"
import { type ReadDefinition, type ResolvedReadCatalog, validateCatalog } from "@liaison/db-core"
import { kbSyncCatalog } from "./adapters/__fixtures__/kb-sync"
import { createDatabaseKnowledgeAdapter } from "./knowledge-adapter"
import type { DbTransport, RunReadResult } from "./transport"

const actor = {
  orgId: "org-1",
  userId: "u1",
  scopes: ["knowledge:sources:read"],
  dimensionGrants: {},
}

interface Article {
  id: string
  title: string
  body: string
  updated_at: string
  public_url: string | null
  secret_token: string
}

// In-memory KB table. Deliberately unsorted so the transport's keyset ORDER
// BY is what produces the sync order.
const ARTICLES: Article[] = [
  {
    id: "b",
    title: "Shipping",
    body: "# Shipping\nWe ship worldwide.",
    updated_at: "2026-05-02T00:00:00.000Z",
    public_url: "https://hub/kb/b",
    secret_token: "sekret-b",
  },
  {
    id: "a",
    title: "Refund Policy",
    body: "# Refunds\n30 days.",
    updated_at: "2026-05-01T00:00:00.000Z",
    public_url: "https://hub/kb/a",
    secret_token: "sekret-a",
  },
  {
    id: "c",
    title: "Warranty",
    body: "# Warranty\nOne year.",
    updated_at: "2026-05-03T00:00:00.000Z",
    public_url: null,
    secret_token: "sekret-c",
  },
]

function project(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of columns) out[c] = row[c]
  return out
}

/**
 * Fake transport that HONORS the fixture catalog's read definitions: it
 * dispatches by read name, applies the same keyset/limit semantics the
 * catalog SQL declares, and projects to `read.columns` (aliasing public_url
 * -> url, exactly as the SQL's `AS url` does). secret_token is never selected
 * because it is not in any read's columns — the catalog owns that.
 */
function makeFakeTransport(): DbTransport & {
  readCalls: Array<{ name: string; params: Record<string, unknown> }>
} {
  const readCalls: Array<{ name: string; params: Record<string, unknown> }> = []
  return {
    readCalls,
    async runRead(
      read: ReadDefinition,
      readName: string,
      params: Record<string, unknown>,
    ): Promise<RunReadResult> {
      readCalls.push({ name: readName, params })
      const start = Date.now()
      let rows: Record<string, unknown>[] = []
      if (readName === "knowledge_sync_list") {
        const afterUpdated = params.after_updated_at as string | null
        const afterId = params.after_id as string | null
        const limit = Number(params.limit)
        const sorted = [...ARTICLES].sort((x, y) =>
          x.updated_at === y.updated_at
            ? x.id.localeCompare(y.id)
            : x.updated_at.localeCompare(y.updated_at),
        )
        const filtered = sorted.filter((r) => {
          if (afterUpdated == null) return true
          // tuple compare (updated_at, id) > (afterUpdated, afterId)
          if (r.updated_at !== afterUpdated) return r.updated_at > afterUpdated
          return afterId != null && r.id > afterId
        })
        rows = filtered
          .slice(0, limit)
          // Alias public_url -> url, matching the catalog SQL's `AS url`.
          .map((r) => project({ ...r, url: r.public_url }, read.columns))
      } else if (readName === "knowledge_sync_get") {
        const id = params.id as string
        const found = ARTICLES.find((r) => r.id === id)
        rows = found ? [project({ ...found, url: found.public_url }, read.columns)] : []
      }
      return { rows, truncated: false, durationMs: Date.now() - start }
    },
    async runQuery() {
      throw new Error("not used")
    },
    async probe() {
      return { ok: true, mode: "direct", warnings: [] }
    },
    async describe() {
      return { tables: [] }
    },
    async close() {},
  }
}

/** Build the adapter deps the production runner builds: bind runRead/hasRead
 *  over a real validated catalog + a transport, exactly like
 *  knowledge-read-runner.ts does. */
function depsFor(catalog: ResolvedReadCatalog, transport: DbTransport) {
  return {
    hasRead: (name: string) => Boolean(catalog.reads[name]),
    runRead: (name: string, params: Record<string, unknown>) =>
      transport.runRead(catalog.reads[name] as ReadDefinition, name, params),
  }
}

describe("database Knowledge adapter — integration (fixture catalog + fake transport)", () => {
  it("kb-sync fixture catalog passes validateCatalog and declares both sync reads", () => {
    const validated = validateCatalog(kbSyncCatalog)
    expect(validated.adapter).toBe("kb-sync")
    expect(validated.reads.knowledge_sync_list).toBeDefined()
    expect(validated.reads.knowledge_sync_get).toBeDefined()
    // secret_token never leaks into any read's projection.
    for (const read of Object.values(validated.reads)) {
      expect(read.columns).not.toContain("secret_token")
    }
  })

  it("lists articles in (updated_at,id) order as text/markdown items with parentExternalId", async () => {
    const catalog = validateCatalog(kbSyncCatalog)
    const transport = makeFakeTransport()
    const adapter = createDatabaseKnowledgeAdapter(depsFor(catalog, transport))

    const page = await adapter.listFolder!({ folderRef: "kb" }, actor)
    expect(page.items.map((i) => i.externalId)).toEqual(["a", "b", "c"])
    expect(page.items.every((i) => i.kind === "file")).toBe(true)
    expect(page.items.every((i) => i.mimeType === "text/markdown")).toBe(true)
    expect(page.items.every((i) => i.parentExternalId === "kb")).toBe(true)
    // public_url null -> url omitted for article "c".
    expect(page.items.find((i) => i.externalId === "c")?.url).toBeUndefined()
    expect(page.items.find((i) => i.externalId === "a")?.url).toBe("https://hub/kb/a")
    // Short page (3 < 200) -> no nextCursor.
    expect(page.nextCursor).toBeUndefined()
    expect(transport.readCalls[0]?.name).toBe("knowledge_sync_list")
  })

  it("keyset cursor threads after_updated_at/after_id and returns the resumed tail", async () => {
    // Simulate the reconciler resuming after article "a": build the same
    // base64 cursor the adapter would emit, and confirm the transport receives
    // after_updated_at/after_id and returns only the tail (b, c) in order.
    const catalog = validateCatalog(kbSyncCatalog)
    const transport = makeFakeTransport()
    const adapter = createDatabaseKnowledgeAdapter(depsFor(catalog, transport))

    const cursor = Buffer.from(
      JSON.stringify({ updated_at: "2026-05-01T00:00:00.000Z", id: "a" }),
      "utf-8",
    ).toString("base64")
    const page = await adapter.listFolder!({ folderRef: "kb", cursor }, actor)
    expect(page.items.map((i) => i.externalId)).toEqual(["b", "c"])
    const lastCall = transport.readCalls[transport.readCalls.length - 1]
    expect(lastCall?.params.after_updated_at).toBe("2026-05-01T00:00:00.000Z")
    expect(lastCall?.params.after_id).toBe("a")
  })

  it("full page (rows.length === PAGE_LIMIT) emits a decodable nextCursor from the last row", async () => {
    // Drive the adapter against a transport that always returns exactly the
    // requested `limit` rows (the adapter's PAGE_LIMIT of 200) so the
    // rows.length === limit branch fires and encodes the last row's keyset.
    const catalog = validateCatalog(kbSyncCatalog)
    const fullPageTransport: DbTransport = {
      async runRead(_read, _name, params): Promise<RunReadResult> {
        const limit = Number(params.limit)
        const rows = Array.from({ length: limit }, (_v, i) => ({
          id: `id-${i}`,
          title: `Doc ${i}`,
          updated_at: `2026-06-01T00:00:00.${String(i).padStart(3, "0")}Z`,
          url: null,
        }))
        return { rows, truncated: false, durationMs: 0 }
      },
      async runQuery() {
        throw new Error("not used")
      },
      async probe() {
        return { ok: true, mode: "direct", warnings: [] }
      },
      async describe() {
        return { tables: [] }
      },
      async close() {},
    }
    const adapter = createDatabaseKnowledgeAdapter(depsFor(catalog, fullPageTransport))
    const page = await adapter.listFolder!({ folderRef: "kb" }, actor)
    expect(page.items).toHaveLength(200)
    expect(page.nextCursor).toBeDefined()
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64").toString("utf-8")) as {
      updated_at: string
      id: string
    }
    expect(decoded.id).toBe("id-199")
    expect(decoded.updated_at).toBe("2026-06-01T00:00:00.199Z")
  })

  it("fetchRemoteContent returns the article body via knowledge_sync_get", async () => {
    const catalog = validateCatalog(kbSyncCatalog)
    const transport = makeFakeTransport()
    const adapter = createDatabaseKnowledgeAdapter(depsFor(catalog, transport))

    const content = await adapter.fetchRemoteContent!({ sourceEntityId: "a" }, actor, "sync")
    expect(content.status).toBe("available")
    expect(content.text).toBe("# Refunds\n30 days.")
    expect(content.title).toBe("Refund Policy")
    expect(content.url).toBe("https://hub/kb/a")
    expect(content.modifiedAt).toBe("2026-05-01T00:00:00.000Z")
    expect(transport.readCalls.some((c) => c.name === "knowledge_sync_get")).toBe(true)
  })

  it("fetchRemoteContent -> unavailable for an unknown id", async () => {
    const catalog = validateCatalog(kbSyncCatalog)
    const adapter = createDatabaseKnowledgeAdapter(depsFor(catalog, makeFakeTransport()))
    const content = await adapter.fetchRemoteContent!({ sourceEntityId: "zzz" }, actor)
    expect(content.status).toBe("unavailable")
  })

  it("a catalog missing the sync reads degrades: listFolder empty, fetch unsupported", async () => {
    // An empty-but-valid catalog would fail validateCatalog (reads can't be
    // empty-shaped in some ways); instead model "reads absent" via hasRead.
    const transport = makeFakeTransport()
    const adapter = createDatabaseKnowledgeAdapter({
      hasRead: () => false,
      runRead: (name, params) => transport.runRead({} as ReadDefinition, name, params),
    })
    const page = await adapter.listFolder!({ folderRef: "kb" }, actor)
    expect(page.items).toEqual([])
    const content = await adapter.fetchRemoteContent!({ sourceEntityId: "a" }, actor)
    expect(content.status).toBe("unsupported")
  })
})
