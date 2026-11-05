// SPDX-License-Identifier: FSL-1.1-ALv2
// Projection: only allow-listed leaf paths survive; object-valued leaves,
// nested extras and prototype keys never do. Pagination helpers stay bounded.
import { describe, expect, it } from "bun:test"
import {
  type Adapter,
  MAX_ITEMS_PER_CALL,
  MAX_PAGES_PER_CALL,
  nextPageQuery,
  type Operation,
  project,
  resolvePointer,
  validateAdapter,
} from "./index"

function adapterWith(opPatch: Record<string, unknown>): Adapter {
  const r = validateAdapter({
    id: "crm",
    name: "CRM",
    version: "1",
    baseUrl: "https://crm.example.com",
    auth: { type: "bearer" },
    operations: [
      {
        name: "list",
        description: "List.",
        kind: "read",
        method: "GET",
        path: "/things",
        params: { type: "object", properties: {} },
        items: "/data/rows",
        fields: ["id", "name", "address.city", "tags", "lines.sku", "lines.qty"],
        ...opPatch,
      },
    ],
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
}

function op(patch: Record<string, unknown> = {}): Operation {
  const o = adapterWith(patch).operations[0]
  if (!o) throw new Error("no op")
  return o
}

describe("project", () => {
  it("keeps allowed leaves, drops everything else including nested extras", () => {
    const response = {
      data: {
        rows: [
          {
            id: 1,
            name: "Acme",
            secret: "s3cr3t",
            address: { city: "Lyon", street: "1 rue X", geo: { lat: 1 } },
            tags: ["a", "b"],
            lines: [
              { sku: "A1", qty: 2, cost: 10 },
              { sku: "B2", qty: 1, cost: 99 },
            ],
          },
        ],
      },
    }
    const r = project(response, op())
    expect(r.items).toEqual([
      {
        id: 1,
        name: "Acme",
        address: { city: "Lyon" },
        tags: ["a", "b"],
        lines: [
          { sku: "A1", qty: 2 },
          { sku: "B2", qty: 1 },
        ],
      },
    ])
    expect(JSON.stringify(r.items)).not.toContain("s3cr3t")
    expect(JSON.stringify(r.items)).not.toContain("rue X")
    expect(r.truncated).toBe(false)
  })

  it("drops a leaf whose value is an object or an array of objects", () => {
    const r = project(
      { data: { rows: [{ id: 1, name: { first: "x", ssn: "123" }, tags: [{ k: "v" }] }] } },
      op(),
    )
    expect(r.items).toEqual([{ id: 1 }])
  })

  it("keeps only the scalar members of a mixed array", () => {
    const r = project(
      { data: { rows: [{ id: 1, tags: ["ok", { hidden: true }, 3, null] }] } },
      op(),
    )
    expect(r.items).toEqual([{ id: 1, tags: ["ok", 3, null] }])
  })

  it("ignores inherited and prototype keys", () => {
    const row = JSON.parse('{"id":1,"__proto__":{"name":"polluted"}}')
    const r = project({ data: { rows: [row] } }, op())
    expect(r.items).toEqual([{ id: 1 }])
  })

  it("treats an object at the items pointer as a single item; a missing pointer as none", () => {
    expect(project({ data: { rows: { id: 7, name: "One" } } }, op()).items).toEqual([
      { id: 7, name: "One" },
    ])
    expect(project({ other: [] }, op()).items).toEqual([])
    expect(project("not json", op()).items).toEqual([])
  })

  it("defaults items to the response root", () => {
    const r = project([{ id: 1 }, { id: 2 }], op({ items: undefined }))
    expect(r.items).toEqual([{ id: 1 }, { id: 2 }])
  })

  it("caps items per call", () => {
    const rows = Array.from({ length: MAX_ITEMS_PER_CALL + 5 }, (_, i) => ({ id: i }))
    const r = project({ data: { rows } }, op())
    expect(r.items).toHaveLength(MAX_ITEMS_PER_CALL)
    expect(r.truncated).toBe(true)
  })

  it("never returns a row with only non-allowed fields as data", () => {
    const r = project({ data: { rows: [{ password: "x" }] } }, op())
    expect(r.items).toEqual([{}])
  })
})

describe("resolvePointer", () => {
  it("follows RFC 6901 escapes and own keys only", () => {
    expect(resolvePointer({ "a/b": { "c~d": 1 } }, "/a~1b/c~0d")).toBe(1)
    expect(resolvePointer({ a: [10, 20] }, "/a/1")).toBe(20)
    expect(resolvePointer({}, "/constructor")).toBeUndefined()
    expect(resolvePointer({ a: 1 }, "")).toEqual({ a: 1 })
  })
})

describe("pagination", () => {
  it("cursor: reads the next cursor from the response, stops when absent", () => {
    const o = op({ pagination: { type: "cursor", param: "cursor", cursorPointer: "/meta/next" } })
    expect(nextPageQuery(o, { meta: { next: "abc" } }, 1, 10)).toEqual([["cursor", "abc"]])
    expect(nextPageQuery(o, { meta: { next: null } }, 1, 10)).toBeNull()
    expect(nextPageQuery(o, { meta: { next: { evil: 1 } } }, 1, 10)).toBeNull()
  })

  it("page: asks for the next page while the last one was full", () => {
    const o = op({ pagination: { type: "page", param: "page", sizeParam: "per_page", size: 2 } })
    expect(nextPageQuery(o, {}, 1, 2)).toEqual([
      ["page", "2"],
      ["per_page", "2"],
    ])
    expect(nextPageQuery(o, {}, 1, 1)).toBeNull()
  })

  it("never goes past the operation's maxPages nor the hard cap", () => {
    const o = op({
      pagination: { type: "cursor", param: "cursor", cursorPointer: "/next", maxPages: 2 },
    })
    expect(nextPageQuery(o, { next: "x" }, 2, 10)).toBeNull()
    const p = op({ pagination: { type: "cursor", param: "cursor", cursorPointer: "/next" } })
    expect(nextPageQuery(p, { next: "x" }, MAX_PAGES_PER_CALL, 10)).toBeNull()
  })

  it("no pagination → no next page", () => {
    expect(nextPageQuery(op(), { next: "x" }, 1, 10)).toBeNull()
  })
})
