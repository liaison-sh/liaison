// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app data store (modules/data-store/service.ts) on real Postgres, in the
// caller's RLS transaction: CRUD and the usage counter, optimistic versions,
// the size and per-collection limits, the query compiler (operators, numeric
// order, mixed types, a cursor that stays put while documents arrive), field
// names that try to inject SQL, and isolation between orgs (FORCE RLS) and
// between apps of one org.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withRlsContext } from "~/db/rls"
import { appDocuments, appDocumentUsage } from "~/db/schema/kernel"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  countDocuments,
  DataStoreError,
  deleteDocument,
  getDocument,
  listCollections,
  MAX_DOC_BYTES,
  MAX_DOCS_PER_COLLECTION,
  queryDocuments,
  type StoreCaller,
  setDocument,
  updateDocument,
} from "./service"

interface Org {
  orgId: string
  userId: string
}

let orgA: Org
let orgB: Org

function inOrg<T>(org: Org, fn: (tx: RlsClient) => Promise<T>): Promise<T> {
  return withRlsContext(
    { actorType: "user", userId: org.userId, orgId: org.orgId, scopes: ["*"], dimensionGrants: {} },
    fn,
  )
}

function caller(org: Org, app = "store-test"): StoreCaller {
  return { orgId: org.orgId, app, userId: org.userId }
}

async function refusal(p: Promise<unknown>): Promise<DataStoreError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(DataStoreError)
    return err as DataStoreError
  }
  throw new Error("expected a DataStoreError")
}

let seq = 0
/** A collection name no other test uses. */
const fresh = (prefix = "c") => `${prefix}_${Date.now().toString(36)}_${++seq}`

beforeAll(async () => {
  await acquireTestLock()
  const a = await minimal.secondOrg({ name: "Store Org A" })
  const b = await minimal.secondOrg({ name: "Store Org B" })
  orgA = { orgId: a.orgId, userId: a.adminUserId }
  orgB = { orgId: b.orgId, userId: b.adminUserId }
})

afterAll(async () => {
  await releaseTestLock()
})

describe("documents", () => {
  it("creates, reads, replaces, merges and deletes, keeping the usage counter in step", async () => {
    const col = fresh()
    const c = caller(orgA)
    const created = await inOrg(orgA, (tx) => setDocument(tx, c, col, "d1", { title: "One", n: 1 }))
    expect(created).toMatchObject({ id: "d1", data: { title: "One", n: 1 }, version: 1 })

    const got = await inOrg(orgA, (tx) => getDocument(tx, c, col, "d1"))
    expect(got?.data).toEqual({ title: "One", n: 1 })

    const replaced = await inOrg(orgA, (tx) => setDocument(tx, c, col, "d1", { title: "Uno" }))
    expect(replaced).toMatchObject({ data: { title: "Uno" }, version: 2 })

    const merged = await inOrg(orgA, (tx) => updateDocument(tx, c, col, "d1", { n: 7, note: null }))
    expect(merged).toMatchObject({ data: { title: "Uno", n: 7, note: null }, version: 3 })

    await inOrg(orgA, (tx) => setDocument(tx, c, col, "d2", { title: "Two" }))
    const usage = await inOrg(orgA, (tx) => listCollections(tx, { orgId: orgA.orgId, app: c.app }))
    const mine = usage.find((u) => u.collection === col)
    const bytes =
      Buffer.byteLength(JSON.stringify({ title: "Uno", n: 7, note: null })) +
      Buffer.byteLength(JSON.stringify({ title: "Two" }))
    expect(mine).toEqual({ app: c.app, collection: col, docs: 2, bytes })

    expect(await inOrg(orgA, (tx) => deleteDocument(tx, c, col, "d1"))).toEqual({ deleted: true })
    expect(await inOrg(orgA, (tx) => deleteDocument(tx, c, col, "d1"))).toEqual({ deleted: false })
    expect(await inOrg(orgA, (tx) => getDocument(tx, c, col, "d1"))).toBeNull()
    const after = await inOrg(orgA, (tx) => listCollections(tx, { orgId: orgA.orgId, app: c.app }))
    expect(after.find((u) => u.collection === col)).toMatchObject({ docs: 1 })
  })

  it("records who wrote the document", async () => {
    const col = fresh()
    await inOrg(orgA, (tx) => setDocument(tx, caller(orgA), col, "w", { a: 1 }))
    const [row] = await inOrg(orgA, (tx) =>
      tx
        .select({ createdBy: appDocuments.createdBy, updatedBy: appDocuments.updatedBy })
        .from(appDocuments)
        .where(and(eq(appDocuments.collection, col), eq(appDocuments.docId, "w"))),
    )
    expect(row).toEqual({ createdBy: orgA.userId, updatedBy: orgA.userId })
  })

  it("update of a missing document is not_found", async () => {
    const err = await refusal(
      inOrg(orgA, (tx) => updateDocument(tx, caller(orgA), fresh(), "nope", { a: 1 })),
    )
    expect(err.code).toBe("not_found")
  })

  it("refuses data that is not a JSON object, and bad names", async () => {
    const c = caller(orgA)
    expect(
      (await refusal(inOrg(orgA, (tx) => setDocument(tx, c, fresh(), "x", [1, 2])))).code,
    ).toBe("invalid_data")
    expect((await refusal(inOrg(orgA, (tx) => setDocument(tx, c, "Bad-Name", "x", {})))).code).toBe(
      "invalid_name",
    )
    expect(
      (await refusal(inOrg(orgA, (tx) => setDocument(tx, c, fresh(), "x".repeat(201), {})))).code,
    ).toBe("invalid_name")
  })
})

describe("versions", () => {
  it("refuses a write whose ifVersion is stale, as version_conflict", async () => {
    const col = fresh()
    const c = caller(orgA)
    await inOrg(orgA, (tx) => setDocument(tx, c, col, "v", { a: 1 }, { ifVersion: 0 }))
    const create = await refusal(
      inOrg(orgA, (tx) => setDocument(tx, c, col, "v", { a: 2 }, { ifVersion: 0 })),
    )
    expect(create.code).toBe("version_conflict")
    expect(create.details).toEqual({ expected: 0, actual: 1 })

    const ok = await inOrg(orgA, (tx) =>
      updateDocument(tx, c, col, "v", { a: 2 }, { ifVersion: 1 }),
    )
    expect(ok.version).toBe(2)
    const writes: Array<(tx: RlsClient) => Promise<unknown>> = [
      (tx: RlsClient) => setDocument(tx, c, col, "v", { a: 3 }, { ifVersion: 1 }),
      (tx: RlsClient) => updateDocument(tx, c, col, "v", { a: 3 }, { ifVersion: 1 }),
      (tx: RlsClient) => deleteDocument(tx, c, col, "v", { ifVersion: 1 }),
    ]
    for (const write of writes) {
      expect((await refusal(inOrg(orgA, write))).code).toBe("version_conflict")
    }
    expect((await inOrg(orgA, (tx) => getDocument(tx, c, col, "v")))?.data).toEqual({ a: 2 })
  })
})

describe("limits", () => {
  it("refuses a document over 256 KiB serialized and keeps one at the limit", async () => {
    const col = fresh()
    const c = caller(orgA)
    const wrap = Buffer.byteLength(JSON.stringify({ s: "" }))
    const atLimit = { s: "x".repeat(MAX_DOC_BYTES - wrap) }
    await inOrg(orgA, (tx) => setDocument(tx, c, col, "big", atLimit))
    const over = await refusal(
      inOrg(orgA, (tx) => setDocument(tx, c, col, "big2", { s: "x".repeat(MAX_DOC_BYTES) })),
    )
    expect(over.code).toBe("doc_too_large")
    const grown = await refusal(inOrg(orgA, (tx) => updateDocument(tx, c, col, "big", { t: 1 })))
    expect(grown.code).toBe("doc_too_large")
  })

  it("refuses a new document in a full collection; an existing one still changes", async () => {
    const col = fresh()
    const c = caller(orgA)
    await inOrg(orgA, (tx) => setDocument(tx, c, col, "first", { a: 1 }))
    // Stand the counter at the limit rather than writing 100,000 documents.
    await inOrg(orgA, (tx) =>
      tx
        .update(appDocumentUsage)
        .set({ docs: MAX_DOCS_PER_COLLECTION })
        .where(
          and(
            eq(appDocumentUsage.orgId, orgA.orgId),
            eq(appDocumentUsage.app, c.app),
            eq(appDocumentUsage.collection, col),
          ),
        ),
    )
    const full = await refusal(inOrg(orgA, (tx) => setDocument(tx, c, col, "second", { a: 2 })))
    expect(full.code).toBe("collection_full")
    expect(await inOrg(orgA, (tx) => getDocument(tx, c, col, "second"))).toBeNull()
    const changed = await inOrg(orgA, (tx) => setDocument(tx, c, col, "first", { a: 3 }))
    expect(changed.version).toBe(2)
  })
})

describe("query", () => {
  const c = () => caller(orgA, "store-query")
  let col = ""

  beforeAll(async () => {
    col = fresh("q")
    const docs: Array<[string, Record<string, unknown>]> = [
      ["a", { status: "open", amount: 2, name: "apple" }],
      ["b", { status: "open", amount: 10, name: "banana" }],
      ["c", { status: "closed", amount: 1, name: "cherry" }],
      ["d", { status: "open", amount: "5", name: "date" }],
      ["e", { status: "draft", name: "elder" }],
    ]
    for (const [id, data] of docs) {
      await inOrg(orgA, (tx) => setDocument(tx, c(), col, id, data))
    }
  })

  const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id)
  const q = (query: Parameters<typeof queryDocuments>[3]) =>
    inOrg(orgA, (tx) => queryDocuments(tx, c(), col, query))

  it("equality and in", async () => {
    expect(ids(await q({ where: { status: "open" }, orderBy: { field: "doc_id" } }))).toEqual([
      "a",
      "b",
      "d",
    ])
    expect(
      ids(
        await q({ where: { status: { in: ["closed", "draft"] } }, orderBy: { field: "doc_id" } }),
      ),
    ).toEqual(["c", "e"])
    expect(
      ids(await q({ where: { doc_id: { in: ["a", "e", "zz"] } }, orderBy: { field: "doc_id" } })),
    ).toEqual(["a", "e"])
  })

  it("ranges compare numbers as numbers and leave other types out", async () => {
    // "5" is a string: a numeric range never matches it.
    expect(ids(await q({ where: { amount: { gt: 1 } }, orderBy: { field: "doc_id" } }))).toEqual([
      "a",
      "b",
    ])
    expect(
      ids(await q({ where: { amount: { gte: 1, lte: 2 } }, orderBy: { field: "doc_id" } })),
    ).toEqual(["a", "c"])
    // A string operand compares text, and numbers are left out.
    expect(ids(await q({ where: { name: { lt: "c" } }, orderBy: { field: "doc_id" } }))).toEqual([
      "a",
      "b",
    ])
    expect(ids(await q({ where: { amount: { gte: "0" } }, orderBy: { field: "doc_id" } }))).toEqual(
      ["d"],
    )
  })

  it("orders numbers numerically", async () => {
    const r = await q({ where: { amount: { gte: 0 } }, orderBy: { field: "amount", dir: "asc" } })
    expect(ids(r)).toEqual(["c", "a", "b"])
    const down = await q({
      where: { amount: { gte: 0 } },
      orderBy: { field: "amount", dir: "desc" },
    })
    expect(ids(down)).toEqual(["b", "a", "c"])
  })

  it("counts with the same filters", async () => {
    expect(await inOrg(orgA, (tx) => countDocuments(tx, c(), col))).toBe(5)
    expect(await inOrg(orgA, (tx) => countDocuments(tx, c(), col, { status: "open" }))).toBe(3)
    expect(await inOrg(orgA, (tx) => countDocuments(tx, c(), col, { amount: { lt: 5 } }))).toBe(2)
  })

  it("pages with a cursor that stays put while documents arrive", async () => {
    const pcol = fresh("p")
    for (let i = 0; i < 6; i++) {
      await inOrg(orgA, (tx) => setDocument(tx, c(), pcol, `p${i}`, { rank: i * 10 }))
    }
    const order = { field: "rank", dir: "asc" as const }
    const page1 = await inOrg(orgA, (tx) =>
      queryDocuments(tx, c(), pcol, { orderBy: order, limit: 3 }),
    )
    expect(ids(page1)).toEqual(["p0", "p1", "p2"])
    expect(page1.nextCursor).toBeString()
    // One before the cursor (never shown again) and one after (shown next).
    await inOrg(orgA, (tx) => setDocument(tx, c(), pcol, "early", { rank: 5 }))
    await inOrg(orgA, (tx) => setDocument(tx, c(), pcol, "late", { rank: 25 }))
    const page2 = await inOrg(orgA, (tx) =>
      queryDocuments(tx, c(), pcol, { orderBy: order, limit: 3, cursor: page1.nextCursor! }),
    )
    expect(ids(page2)).toEqual(["late", "p3", "p4"])
    const page3 = await inOrg(orgA, (tx) =>
      queryDocuments(tx, c(), pcol, { orderBy: order, limit: 3, cursor: page2.nextCursor! }),
    )
    expect(ids(page3)).toEqual(["p5"])
    expect(page3.nextCursor).toBeNull()
  })

  it("pages the default order (most recently updated first) without loss or repeat", async () => {
    const pcol = fresh("u")
    for (let i = 0; i < 5; i++) {
      await inOrg(orgA, (tx) => setDocument(tx, c(), pcol, `u${i}`, { i }))
    }
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await inOrg(orgA, (tx) =>
        queryDocuments(tx, c(), pcol, { limit: 2, ...(cursor ? { cursor } : {}) }),
      )
      seen.push(...ids(page))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen).toEqual(["u4", "u3", "u2", "u1", "u0"])
  })

  it("refuses a cursor made for another order", async () => {
    const page = await q({ orderBy: { field: "doc_id" }, limit: 1 })
    const err = await refusal(q({ orderBy: { field: "name" }, cursor: page.nextCursor! }))
    expect(err.code).toBe("invalid_cursor")
    expect((await refusal(q({ cursor: "not-a-cursor" }))).code).toBe("invalid_cursor")
  })

  it("refuses field names and directions that try to inject SQL", async () => {
    for (const field of ["a'); DROP TABLE kernel.app_documents; --", "data->>'x'", "1abc", "a b"]) {
      expect((await refusal(q({ where: { [field]: 1 } }))).code).toBe("invalid_field")
      expect((await refusal(q({ orderBy: { field } }))).code).toBe("invalid_field")
    }
    const dir = "asc; DROP TABLE x" as "asc"
    expect((await refusal(q({ orderBy: { field: "name", dir } }))).code).toBe("invalid_query")
    expect((await refusal(q({ where: { amount: { like: "%" } as never } }))).code).toBe(
      "invalid_query",
    )
    expect((await refusal(q({ limit: 201 }))).code).toBe("invalid_query")
    expect(
      (await refusal(q({ where: { status: { in: Array.from({ length: 51 }, (_, i) => i) } } })))
        .code,
    ).toBe("invalid_query")
    // The table is still there and whole.
    expect(await inOrg(orgA, (tx) => countDocuments(tx, c(), col))).toBe(5)
  })

  it("leaves the transaction's statement timeout as it was", async () => {
    const timeout = await inOrg(orgA, async (tx) => {
      await queryDocuments(tx, c(), col, { orderBy: { field: "name" } })
      const res = await tx.execute(sql`SELECT current_setting('statement_timeout') AS v`)
      return (res as unknown as Array<{ v: string }>)[0]?.v
    })
    expect(timeout).not.toBe("2s")
  })
})

describe("isolation", () => {
  it("another org sees none of the documents, even with a raw query in its own context", async () => {
    const col = fresh("iso")
    await inOrg(orgA, (tx) => setDocument(tx, caller(orgA), col, "secret", { v: 1 }))
    const raw = await inOrg(orgB, (tx) =>
      tx.select().from(appDocuments).where(eq(appDocuments.collection, col)),
    )
    expect(raw).toEqual([])
    const usage = await inOrg(orgB, (tx) =>
      tx.select().from(appDocumentUsage).where(eq(appDocumentUsage.collection, col)),
    )
    expect(usage).toEqual([])
    // Naming org A as the caller from org B's context still reads nothing.
    expect(await inOrg(orgB, (tx) => getDocument(tx, caller(orgA), col, "secret"))).toBeNull()
    // And org B cannot write a row into org A.
    await expect(
      inOrg(orgB, (tx) => setDocument(tx, caller(orgA), col, "forged", { v: 2 })),
    ).rejects.toThrow()
    expect(await inOrg(orgA, (tx) => getDocument(tx, caller(orgA), col, "forged"))).toBeNull()
  })

  it("one app never reaches another app's collection of the same name", async () => {
    const col = fresh("apps")
    await inOrg(orgA, (tx) => setDocument(tx, caller(orgA, "app-one"), col, "x", { owner: "one" }))
    expect(await inOrg(orgA, (tx) => getDocument(tx, caller(orgA, "app-two"), col, "x"))).toBeNull()
    const page = await inOrg(orgA, (tx) => queryDocuments(tx, caller(orgA, "app-two"), col))
    expect(page.items).toEqual([])
  })
})
