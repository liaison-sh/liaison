// SPDX-License-Identifier: FSL-1.1-ALv2
//
// prep-cache: the persisted (localStorage) worklist cache. Storage is injected as a
// StorageLike, so these run without a DOM -- a plain in-memory Map stands in for localStorage.
import { describe, expect, it } from "bun:test"
import {
  decodeOrgIdFromToken,
  evictShippedRowFromCache,
  loadPrepCache,
  prepCacheKey,
  type StorageLike,
  savePrepCache,
} from "./prep-cache"
import type { PrepListResult, PrepRow } from "./prep-row-logic"

function fakeStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

function makeRow(overrides: Partial<PrepRow> = {}): PrepRow {
  return {
    order_key: "so:5001",
    document_ref: "doc-1",
    anchor_kind: "invoice",
    invoice_ref: "INV-001",
    order_name: "#1001",
    order_created_at: "2026-07-01T00:00:00.000Z",
    customer: "Alice Example",
    destination: "US",
    order_tags: [],
    products: "1xES",
    grand_total_minor: 1000,
    currency: "EUR",
    parcels: [],
    package_count: 1,
    category: "sale",
    status: "to_prepare",
    status_note: null,
    staff_note: null,
    quote: {
      cheapest: null,
      alternates: [],
      offers: [],
      selected_offer_code: null,
      selected: null,
      quoted_at: null,
      stale: false,
    },
    state: "quote_missing",
    excluded: false,
    validated: false,
    invoice: { state: "missing", document_id: null, number: null, approval_id: null, kind: null },
    shipment: null,
    recipient: null,
    ...overrides,
  }
}

function makeList(rows: PrepRow[]): PrepListResult {
  return {
    rows,
    total: rows.length,
    last_sync_at: "2026-09-10T08:00:00.000Z",
    truncated: false,
    last_sync_error: null,
    invoicing_available: true,
  }
}

// A base64url JWT with an arbitrary header and { orgId } in the payload -- HMAC/signature is
// irrelevant here, decodeOrgIdFromToken never verifies it.
function fakeToken(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`
}

describe("decodeOrgIdFromToken", () => {
  it("reads the orgId claim out of a well-formed access token", () => {
    expect(decodeOrgIdFromToken(fakeToken({ orgId: "org_42", sub: "user_1" }))).toBe("org_42")
  })

  it("returns null for a malformed token without throwing", () => {
    expect(decodeOrgIdFromToken("not-a-jwt")).toBeNull()
    expect(decodeOrgIdFromToken(null)).toBeNull()
    expect(decodeOrgIdFromToken("a.b")).toBeNull()
    expect(decodeOrgIdFromToken("a.!!!not-base64!!!.c")).toBeNull()
  })
})

describe("the persisted cache survives a reload", () => {
  it("write, drop all in-memory state, read back through the same fake storage", () => {
    const storage = fakeStorage()
    const list = makeList([makeRow()])
    savePrepCache(storage, "org_1", false, list, 1_000)

    // Simulate a full reload: nothing survives except `storage` itself.
    const reloaded = loadPrepCache(storage, "org_1", false)

    expect(reloaded).not.toBeNull()
    expect(reloaded?.value.rows).toHaveLength(1)
    expect(reloaded?.value.rows[0]?.order_key).toBe("so:5001")
    expect(reloaded?.savedAt).toBe(1_000)
  })

  it("keys true and false includeExcluded separately", () => {
    const storage = fakeStorage()
    savePrepCache(storage, "org_1", false, makeList([makeRow({ order_key: "so:1" })]), 1)
    savePrepCache(
      storage,
      "org_1",
      true,
      makeList([makeRow({ order_key: "so:1" }), makeRow({ order_key: "so:2", excluded: true })]),
      2,
    )

    expect(loadPrepCache(storage, "org_1", false)?.value.rows).toHaveLength(1)
    expect(loadPrepCache(storage, "org_1", true)?.value.rows).toHaveLength(2)
  })

  it("never persists and never reads back without an org id", () => {
    const storage = fakeStorage()
    savePrepCache(storage, null, false, makeList([makeRow()]), 1)
    expect(loadPrepCache(storage, null, false)).toBeNull()
    // Nothing was written at all -- a later call with the real org id would still find nothing.
    expect(loadPrepCache(storage, "org_1", false)).toBeNull()
  })
})

describe("a corrupt cache entry is discarded and does not throw", () => {
  it("unparseable JSON", () => {
    const storage = fakeStorage()
    storage.setItem(prepCacheKey("org_1", false), "{not json")
    expect(() => loadPrepCache(storage, "org_1", false)).not.toThrow()
    expect(loadPrepCache(storage, "org_1", false)).toBeNull()
  })

  it("valid JSON missing the shape this module wrote", () => {
    const storage = fakeStorage()
    storage.setItem(prepCacheKey("org_1", false), JSON.stringify({ hello: "world" }))
    expect(loadPrepCache(storage, "org_1", false)).toBeNull()
  })

  it("rows is not an array", () => {
    const storage = fakeStorage()
    storage.setItem(
      prepCacheKey("org_1", false),
      JSON.stringify({ savedAt: 1, value: { rows: "nope", total: 0 } }),
    )
    expect(loadPrepCache(storage, "org_1", false)).toBeNull()
  })

  it("a storage whose getItem throws is treated as empty, not fatal", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError: private mode")
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(() => loadPrepCache(throwing, "org_1", false)).not.toThrow()
    expect(loadPrepCache(throwing, "org_1", false)).toBeNull()
  })
})

describe("savePrepCache guards", () => {
  it("a setItem that throws (quota exceeded, private mode) does not propagate", () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
      removeItem: () => {},
    }
    expect(() => savePrepCache(throwing, "org_1", false, makeList([makeRow()]), 1)).not.toThrow()
  })

  it("skips persisting a payload over the size cap", () => {
    const storage = fakeStorage()
    const hugeRows = Array.from({ length: 20000 }, (_, i) =>
      makeRow({ order_key: `so:${i}`, products: "x".repeat(200) }),
    )
    savePrepCache(storage, "org_1", false, makeList(hugeRows), 1)
    expect(loadPrepCache(storage, "org_1", false)).toBeNull()
  })
})

describe("a shipped row is evicted from the persisted cache", () => {
  it("removes the row from both includeExcluded variants and re-saves the rest", () => {
    const storage = fakeStorage()
    const shipped = makeRow({ order_key: "so:shipped" })
    const other = makeRow({ order_key: "so:other" })
    savePrepCache(storage, "org_1", false, makeList([shipped, other]), 1)
    savePrepCache(storage, "org_1", true, makeList([shipped, other]), 1)

    evictShippedRowFromCache(storage, "org_1", "so:shipped", 2)

    const unexcluded = loadPrepCache(storage, "org_1", false)
    const withExcluded = loadPrepCache(storage, "org_1", true)
    expect(unexcluded?.value.rows.map((r) => r.order_key)).toEqual(["so:other"])
    expect(withExcluded?.value.rows.map((r) => r.order_key)).toEqual(["so:other"])
  })

  it("is a no-op when the row is not cached at all", () => {
    const storage = fakeStorage()
    savePrepCache(storage, "org_1", false, makeList([makeRow({ order_key: "so:other" })]), 1)
    expect(() => evictShippedRowFromCache(storage, "org_1", "so:not-cached", 2)).not.toThrow()
    expect(loadPrepCache(storage, "org_1", false)?.value.rows).toHaveLength(1)
  })
})
