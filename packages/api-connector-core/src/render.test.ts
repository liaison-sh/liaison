// SPDX-License-Identifier: FSL-1.1-ALv2
// Request templating: params validated against the operation's schema, path
// values URL-encoded per segment, query through URLSearchParams, body built
// structurally. Every injection attempt must stay inside its slot.
import { describe, expect, it } from "bun:test"
import {
  type Adapter,
  buildRequestUrl,
  ConnectorRenderError,
  render,
  validateAdapter,
} from "./index"

function adapter(): Adapter {
  const r = validateAdapter({
    id: "crm",
    name: "CRM",
    version: "1",
    baseUrl: "https://crm.example.com/api/v2",
    auth: { type: "bearer" },
    operations: [
      {
        name: "get_company",
        description: "One company.",
        kind: "read",
        method: "GET",
        path: "/companies/{customerId}",
        params: {
          type: "object",
          properties: {
            customerId: { type: "string" },
            include: { type: "array", items: { type: "string", enum: ["deals", "orders"] } },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            q: { type: "string" },
          },
          required: ["customerId"],
        },
        query: { include: "{include}", limit: "{limit}", search: "name:{q}" },
        fields: ["id", "name"],
      },
      {
        name: "create_note",
        description: "Note on a company.",
        kind: "write",
        method: "POST",
        path: "/companies/{customerId}/notes",
        params: {
          type: "object",
          properties: {
            customerId: { type: "string" },
            text: { type: "string" },
            pinned: { type: "boolean" },
            score: { type: "number" },
          },
          required: ["customerId", "text"],
        },
        body: {
          note: {
            body: "{text}",
            pinned: "{pinned}",
            score: "{score}",
            label: "From {customerId}",
          },
          v: 2,
        },
        fields: ["id"],
      },
    ],
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
}

function op(name: string) {
  const a = adapter()
  const o = a.operations.find((x) => x.name === name)
  if (!o) throw new Error(name)
  return o
}

function renderCode(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof ConnectorRenderError) return err.code
    throw err
  }
  return "no_error"
}

describe("render", () => {
  it("renders path, typed query and repeated array keys", () => {
    const r = render(op("get_company"), {
      customerId: "c 1",
      include: ["deals", "orders"],
      limit: 5,
      q: "acme",
    })
    expect(r.method).toBe("GET")
    expect(r.path).toBe("/companies/c%201")
    expect(r.query).toEqual([
      ["include", "deals"],
      ["include", "orders"],
      ["limit", "5"],
      ["search", "name:acme"],
    ])
    expect(r.body).toBeUndefined()
  })

  it("omits query keys whose params are absent", () => {
    const r = render(op("get_company"), { customerId: "c1" })
    expect(r.query).toEqual([])
  })

  it("refuses unknown params", () => {
    expect(renderCode(() => render(op("get_company"), { customerId: "c1", admin: true }))).toBe(
      "unknown_param",
    )
  })

  it("names the operation's accepted and required params when refusing a name", () => {
    const message = (fn: () => unknown): string => {
      try {
        fn()
      } catch (err) {
        if (err instanceof ConnectorRenderError) return err.message
        throw err
      }
      return "no_error"
    }
    expect(message(() => render(op("get_company"), { customerId: "c1", first_name: "A" }))).toBe(
      'unknown param "first_name" for get_company. get_company accepts required: customerId; optional: include, limit, q.',
    )
    expect(message(() => render(op("get_company"), { limit: 5 }))).toBe(
      'missing required param "customerId" for get_company. get_company accepts required: customerId; optional: include, limit, q.',
    )
  })

  it("refuses missing required params and wrong types", () => {
    expect(renderCode(() => render(op("get_company"), {}))).toBe("missing_param")
    expect(renderCode(() => render(op("get_company"), { customerId: 3 }))).toBe("invalid_param")
    expect(renderCode(() => render(op("get_company"), { customerId: "c", limit: 2.5 }))).toBe(
      "invalid_param",
    )
    expect(renderCode(() => render(op("get_company"), { customerId: "c", limit: 99 }))).toBe(
      "invalid_param",
    )
    expect(
      renderCode(() => render(op("get_company"), { customerId: "c", include: ["admin"] })),
    ).toBe("invalid_param")
  })

  it("keeps traversal and host injection inside the path segment", () => {
    for (const v of ["../admin", "%2e%2e%2fadmin", "//evil.example.org", "a/b", "?x=1", "#f"]) {
      const r = render(op("get_company"), { customerId: v })
      const url = buildRequestUrl(adapter(), r)
      expect(url.host).toBe("crm.example.com")
      expect(url.pathname.startsWith("/api/v2/companies/")).toBe(true)
      expect(url.pathname.split("/")).toHaveLength(5)
      expect(url.search).toBe("")
    }
  })

  it("refuses dot segments, empty segments and control characters in path values", () => {
    for (const v of ["..", ".", "", "a\r\nHost: evil", "a\u0000"]) {
      expect(renderCode(() => render(op("get_company"), { customerId: v }))).toBe("invalid_param")
    }
  })

  it("refuses CRLF in query values", () => {
    expect(
      renderCode(() => render(op("get_company"), { customerId: "c", q: "x\r\nSet-Cookie: a" })),
    ).toBe("invalid_param")
  })

  it("encodes query injection as data, never as new parameters", () => {
    const r = render(op("get_company"), { customerId: "c", q: "acme&limit=1000#x" })
    const url = buildRequestUrl(adapter(), r)
    expect(url.searchParams.getAll("limit")).toEqual([])
    expect(url.searchParams.get("search")).toBe("name:acme&limit=1000#x")
  })

  it("builds the body structurally with typed values", () => {
    const r = render(op("create_note"), {
      customerId: "c1",
      text: 'He said "hi"}, "admin": true, {"',
      pinned: true,
      score: 4.5,
    })
    expect(r.method).toBe("POST")
    expect(r.body).toEqual({
      note: {
        body: 'He said "hi"}, "admin": true, {"',
        pinned: true,
        score: 4.5,
        label: "From c1",
      },
      v: 2,
    })
  })

  it("drops body keys whose params are absent", () => {
    const r = render(op("create_note"), { customerId: "c1", text: "x" })
    expect(r.body).toEqual({ note: { body: "x", label: "From c1" }, v: 2 })
  })
})

describe("buildRequestUrl", () => {
  it("keeps the base path and the base host", () => {
    const r = render(op("get_company"), { customerId: "c1", limit: 3 })
    const url = buildRequestUrl(adapter(), r)
    expect(url.toString()).toBe("https://crm.example.com/api/v2/companies/c1?limit=3")
  })

  it("appends extra query pairs (pagination) through URLSearchParams", () => {
    const r = render(op("get_company"), { customerId: "c1" })
    const url = buildRequestUrl(adapter(), r, [["cursor", "a&b=c"]])
    expect(url.searchParams.get("cursor")).toBe("a&b=c")
    expect(url.searchParams.get("b")).toBeNull()
  })
})

describe("param formats are enforced (P2-SK10)", () => {
  function withFormat(format: string) {
    const r = validateAdapter({
      id: "crm",
      name: "CRM",
      version: "1",
      baseUrl: "https://crm.example.com",
      auth: { type: "bearer" },
      operations: [
        {
          name: "find",
          description: "Find.",
          kind: "read",
          method: "GET",
          path: "/x",
          params: { type: "object", properties: { v: { type: "string", format } } },
          query: { v: "{v}" },
          fields: ["id"],
        },
      ],
    })
    if (!r.ok) throw new Error(JSON.stringify(r.issues))
    const o = r.adapter.operations[0]
    if (!o) throw new Error("no op")
    return o
  }

  const cases: [string, string[], string[]][] = [
    [
      "email",
      ["jane@acme.test", "a.b+c@sub.example.co"],
      ["jane", '"x y"@acme.test', "a@b", "a@b.c"],
    ],
    [
      "date",
      ["2026-10-23", "2024-02-29"],
      ["2026-13-01", "2025-02-29", "23/10/2026", "2026-10-23T00:00:00Z"],
    ],
    [
      "date-time",
      ["2026-10-23T10:00:00Z", "2026-10-23T10:00:00.123+02:00"],
      ["2026-10-23", "2026-10-23T25:00:00Z", "yesterday", "2026-10-23T10:00:00"],
    ],
    [
      "uri",
      ["https://example.com/a?b=c", "mailto:a@b.test"],
      ["not a uri", "/relative/path", "example.com"],
    ],
    [
      "uuid",
      ["0f8fad5b-d9cb-469f-a165-70867728950e"],
      ["0f8fad5b", "zzzzzzzz-d9cb-469f-a165-70867728950e"],
    ],
  ]
  for (const [format, good, bad] of cases) {
    it(`format ${format}`, () => {
      const o = withFormat(format)
      for (const v of good) expect(renderCode(() => render(o, { v }))).toBe("no_error")
      for (const v of bad) expect(renderCode(() => render(o, { v }))).toBe("invalid_param")
    })
  }
})

describe("buildRequestUrl: leaving the base URL (P2-SK8)", () => {
  it("throws outside_base_url for a path that resolves outside the base path", () => {
    const a = adapter()
    const r = { method: "GET" as const, path: "/../../admin", query: [] as [string, string][] }
    expect(renderCode(() => buildRequestUrl(a, r))).toBe("outside_base_url")
  })
})
