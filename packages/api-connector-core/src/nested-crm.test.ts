// SPDX-License-Identifier: FSL-1.1-ALv2
// Adapters for an API whose records nest their values (`properties.name`,
// a v3-style CRM object): field maps, chained lookups, the built-in `{$now}`
// values and `$when` optional body parts. The fixture responses follow the
// shape of such a CRM's search and get endpoints.
import { describe, expect, it } from "bun:test"
import {
  type Adapter,
  chainStepCalls,
  chainStepParams,
  fieldOutputs,
  finalOutputs,
  MAX_CHAIN_FANOUT,
  type Operation,
  operationSummaries,
  project,
  render,
  validateAdapter,
} from "./index"

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

/** A search response of contacts, as a v3-style CRM answers it. */
const CONTACT_SEARCH = {
  total: 2,
  results: [
    {
      id: "501",
      properties: {
        email: "anna@northwind.example",
        firstname: "Anna",
        lastname: "Weber",
        associatedcompanyid: "9001",
        hs_internal_score: "41",
      },
      emails: [{ value: "anna@northwind.example" }, { value: "a.weber@northwind.example" }],
      createdAt: "2026-01-02T10:00:00Z",
      archived: false,
    },
    {
      id: "502",
      properties: {
        email: "joel@northwind.example",
        firstname: "Joel",
        associatedcompanyid: 9001,
      },
      createdAt: "2026-01-03T10:00:00Z",
      archived: false,
    },
  ],
  paging: { next: { after: "2" } },
}

const COMPANY = {
  id: "9001",
  properties: { name: "Northwind Music Retail", domain: "northwind.example", secret_margin: "0.4" },
  createdAt: "2026-01-01T00:00:00Z",
  archived: false,
}

function ops(): Json[] {
  return [
    {
      name: "find_customer",
      description: "Customers by contact email or email domain.",
      kind: "read",
      method: "POST",
      readOnlyPost: true,
      path: "/crm/v3/objects/contacts/search",
      role: "customer.lookup",
      params: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          domain: { type: "string", maxLength: 253 },
        },
      },
      body: {
        filterGroups: [
          {
            $when: "email",
            filters: [{ propertyName: "email", operator: "EQ", value: "{email}" }],
          },
          {
            $when: "domain",
            filters: [{ propertyName: "hs_email_domain", operator: "EQ", value: "{domain}" }],
          },
        ],
        limit: 5,
      },
      items: "/results",
      fields: { contactId: "id", companyId: "properties.associatedcompanyid" },
      chain: [{ operation: "get_company", params: { customerId: "{companyId}" } }],
    },
    {
      name: "get_company",
      description: "One company by id.",
      kind: "read",
      method: "GET",
      path: "/crm/v3/objects/companies/{customerId}",
      role: "customer.summary",
      params: {
        type: "object",
        properties: { customerId: { type: "string", maxLength: 32 } },
        required: ["customerId"],
      },
      items: "",
      fields: { id: "id", name: "properties.name", domain: "properties.domain" },
    },
    {
      name: "list_contacts",
      description: "Contacts, nested values kept under their own names.",
      kind: "read",
      method: "POST",
      readOnlyPost: true,
      path: "/crm/v3/objects/contacts/search",
      params: { type: "object", properties: {} },
      items: "/results",
      fields: {
        id: "id",
        name: "properties.firstname",
        "person.last": "properties.lastname",
        primaryEmail: "emails.0.value",
        allEmails: "emails.value",
      },
    },
    {
      name: "add_note",
      description: "A note on a company.",
      kind: "write",
      method: "POST",
      path: "/crm/v3/objects/notes",
      params: {
        type: "object",
        properties: { customerId: { type: "string" }, text: { type: "string" } },
        required: ["customerId", "text"],
      },
      body: {
        properties: { hs_note_body: "{text}", hs_timestamp: "{$now}", at_ms: "{$nowMs}" },
        label: "note at {$now}",
        associations: [{ to: { id: "{customerId}" } }],
      },
      items: "",
      fields: ["id"],
    },
  ]
}

function doc(patch: (operations: Json[]) => void = () => {}): { [k: string]: Json } {
  const operations = ops()
  patch(operations)
  return {
    id: "nested-crm",
    name: "Nested CRM",
    version: "1",
    baseUrl: "https://api.crm.example",
    auth: { type: "bearer" },
    operations,
  }
}

function valid(d = doc()): Adapter {
  const r = validateAdapter(d)
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
}

function issues(d: { [k: string]: Json }): { path: string; message: string }[] {
  const r = validateAdapter(d)
  return r.ok ? [] : r.issues
}

function opNamed(a: Adapter, name: string): Operation {
  const o = a.operations.find((x) => x.name === name)
  if (!o) throw new Error(name)
  return o
}

function patchOp(name: string, patch: Record<string, Json>): (operations: Json[]) => void {
  return (operations) => {
    const o = operations.find(
      (x) => typeof x === "object" && x !== null && !Array.isArray(x) && x.name === name,
    ) as Record<string, Json>
    Object.assign(o, patch)
  }
}

describe("field map", () => {
  it("validates, and exposes its output names", () => {
    const a = valid()
    expect(fieldOutputs(opNamed(a, "get_company"))).toEqual(["id", "name", "domain"])
    expect(finalOutputs(a, opNamed(a, "find_customer"))).toEqual(["id", "name", "domain"])
  })

  it("projects nested values to their output names, and nothing else", () => {
    const a = valid()
    expect(project(COMPANY, opNamed(a, "get_company")).items).toEqual([
      { id: "9001", name: "Northwind Music Retail", domain: "northwind.example" },
    ])
  })

  it("indexes an array, walks one, and nests a dotted output name", () => {
    const items = project(CONTACT_SEARCH, opNamed(valid(), "list_contacts")).items
    expect(items[0]).toEqual({
      id: "501",
      name: "Anna",
      person: { last: "Weber" },
      primaryEmail: "anna@northwind.example",
      allEmails: ["anna@northwind.example", "a.weber@northwind.example"],
    })
    // A missing source leaves its output out (no null, no key).
    expect(items[1]).toEqual({ id: "502", name: "Joel" })
  })

  it("never returns an object or an unmapped value", () => {
    const op = opNamed(
      valid(doc(patchOp("get_company", { fields: { id: "id", name: "properties" } }))),
      "get_company",
    )
    expect(project(COMPANY, op).items).toEqual([{ id: "9001" }])
  })

  it("never reads an inherited or prototype key", () => {
    const r = validateAdapter(
      doc(patchOp("get_company", { fields: { id: "id", name: "properties.__proto__" } })),
    )
    expect(r.ok).toBe(false)
    const r2 = validateAdapter(
      doc(patchOp("get_company", { fields: { id: "id", constructor: "properties.name" } })),
    )
    expect(r2.ok).toBe(false)
  })

  it("refuses a role whose required field is neither listed nor mapped", () => {
    const found = issues(
      doc(patchOp("get_company", { role: "customer.lookup", fields: { id: "id" } })),
    )
    const lookup = found.filter((i) => i.message.includes("role customer.lookup needs the fields"))
    expect(lookup.length).toBeGreaterThan(0)
    expect(lookup.some((i) => i.message.includes("name"))).toBe(true)
  })

  it("accepts the same role once the field is mapped", () => {
    const r = validateAdapter(
      doc((o) => {
        patchOp("find_customer", { role: null })(o)
        const fc = o.find(
          (x) =>
            typeof x === "object" && x !== null && !Array.isArray(x) && x.name === "find_customer",
        ) as Record<string, Json>
        delete fc.role
        fc.params = {
          type: "object",
          properties: { email: { type: "string" }, domain: { type: "string" } },
          required: ["email"],
        }
        patchOp("get_company", {
          role: "customer.lookup",
          params: {
            type: "object",
            properties: { customerId: { type: "string" }, email: { type: "string" } },
            required: ["customerId"],
          },
        })(o)
      }),
    )
    expect(r.ok).toBe(true)
  })

  it("refuses an object-valued output, an index as the first segment, and an empty map", () => {
    expect(
      issues(
        doc(patchOp("list_contacts", { fields: { a: "id", "a.b": "properties.firstname" } })),
      ).some((i) => i.message.includes("object-valued")),
    ).toBe(true)
    expect(issues(doc(patchOp("list_contacts", { fields: { a: "0.id" } }))).length).toBeGreaterThan(
      0,
    )
    expect(issues(doc(patchOp("list_contacts", { fields: {} }))).length).toBeGreaterThan(0)
  })
})

describe("chained lookup", () => {
  it("feeds each distinct value of the previous step into the next, typed by its params", () => {
    const a = valid()
    const lookup = opNamed(a, "find_customer")
    const step = lookup.chain?.[0]
    if (!step) throw new Error("no chain")
    const items = project(CONTACT_SEARCH, lookup).items
    // Two contacts of one company (one id a string, one a number): one call.
    expect(chainStepCalls(step, opNamed(a, "get_company"), items, MAX_CHAIN_FANOUT)).toEqual([
      { customerId: "9001" },
    ])
  })

  it("skips an item without the referenced field, and caps the fan-out", () => {
    const a = valid()
    const step = opNamed(a, "find_customer").chain?.[0]
    if (!step) throw new Error("no chain")
    const target = opNamed(a, "get_company")
    expect(chainStepParams(step, target, { contactId: "1" })).toBeNull()
    expect(chainStepParams(step, target, { companyId: null })).toBeNull()
    expect(chainStepParams(step, target, { companyId: "" })).toBeNull()
    expect(chainStepParams(step, target, { companyId: ["1", "2"] })).toBeNull()
    expect(chainStepParams(step, target, { companyId: { id: "1" } })).toBeNull()
    const many = Array.from({ length: 10 }, (_, i) => ({ companyId: `c${i}` }))
    expect(chainStepCalls(step, target, many, MAX_CHAIN_FANOUT)).toHaveLength(MAX_CHAIN_FANOUT)
  })

  it("renders a chained value like any param: one encoded path segment", () => {
    const a = valid()
    const step = opNamed(a, "find_customer").chain?.[0]
    if (!step) throw new Error("no chain")
    const target = opNamed(a, "get_company")
    const params = chainStepParams(step, target, { companyId: "../admin?x=1" })
    if (!params) throw new Error("no params")
    expect(render(target, params).path).toBe("/crm/v3/objects/companies/..%2Fadmin%3Fx%3D1")
    expect(() => render(target, { customerId: ".." })).toThrow()
  })

  it("refuses a chain to an unknown op, a write, itself, a chained step, or a field the step lacks", () => {
    const withChain = (chain: Json) => issues(doc(patchOp("find_customer", { chain })))
    expect(
      withChain([{ operation: "nope", params: { customerId: "{companyId}" } }]).some((i) =>
        i.path.startsWith("operations.0.chain.0"),
      ),
    ).toBe(true)
    expect(
      withChain([{ operation: "add_note", params: { customerId: "{companyId}", text: "x" } }]).some(
        (i) => i.message.includes("runs a read"),
      ),
    ).toBe(true)
    expect(
      withChain([{ operation: "find_customer", params: {} }]).some((i) =>
        i.message.includes("its own operation"),
      ),
    ).toBe(true)
    expect(
      withChain([{ operation: "get_company", params: { customerId: "{nothere}" } }]).some((i) =>
        i.message.includes("is not a field of find_customer"),
      ),
    ).toBe(true)
    expect(
      withChain([{ operation: "get_company", params: {} }]).some((i) =>
        i.message.includes('required param "customerId"'),
      ),
    ).toBe(true)
    expect(
      withChain([{ operation: "get_company", params: { customerId: "x-{companyId}" } }]).some((i) =>
        i.message.includes("exactly {field}"),
      ),
    ).toBe(true)
    expect(
      withChain([
        { operation: "get_company", params: { customerId: "{companyId}" } },
        { operation: "get_company", params: { customerId: "{id}" } },
        { operation: "get_company", params: { customerId: "{id}" } },
      ]).length,
    ).toBeGreaterThan(0)
    // A step cannot itself be chained (no recursion through a second chain).
    expect(
      issues(
        doc((o) => {
          patchOp("find_customer", {
            chain: [{ operation: "list_contacts", params: {} }],
          })(o)
          patchOp("list_contacts", {
            chain: [{ operation: "get_company", params: { customerId: "{id}" } }],
          })(o)
        }),
      ).some((i) => i.message.includes("cannot itself be chained")),
    ).toBe(true)
    // A write cannot chain.
    expect(
      issues(
        doc(
          patchOp("add_note", {
            chain: [{ operation: "get_company", params: { customerId: "1" } }],
          }),
        ),
      ).some((i) => i.message.includes("belongs to a read")),
    ).toBe(true)
  })

  it("lists a chained read's fields as the last step's in the operation summaries", () => {
    const a = valid()
    const find = operationSummaries(a).find((o) => o.name === "find_customer")
    expect(find?.fields).toEqual(["id", "name", "domain"])
    expect(operationSummaries(a).find((o) => o.name === "list_contacts")?.fields).toEqual(
      fieldOutputs(opNamed(a, "list_contacts")),
    )
  })

  it("checks a chained role's fields against the last step", () => {
    const found = issues(
      doc(patchOp("get_company", { fields: { id: "id", domain: "properties.domain" } })),
    )
    expect(found.some((i) => i.path === "operations.0.chain" && i.message.includes("name"))).toBe(
      true,
    )
  })
})

describe("body built-ins and $when", () => {
  const NOW = new Date("2026-10-26T09:30:00.000Z")

  it("renders {$now} as RFC 3339 and {$nowMs} as a number", () => {
    const r = render(opNamed(valid(), "add_note"), { customerId: "9001", text: "hi" }, { now: NOW })
    expect(r.body).toEqual({
      properties: {
        hs_note_body: "hi",
        hs_timestamp: "2026-10-26T09:30:00.000Z",
        at_ms: NOW.getTime(),
      },
      label: "note at 2026-10-26T09:30:00.000Z",
      associations: [{ to: { id: "9001" } }],
    })
  })

  it("keeps {$now} out of the path and query, and refuses an unknown built-in", () => {
    expect(
      issues(doc(patchOp("get_company", { query: { since: "{$now}" } }))).some((i) =>
        i.message.includes("body only"),
      ),
    ).toBe(true)
    expect(
      issues(doc(patchOp("add_note", { body: { at: "{$today}" } }))).some((i) =>
        i.message.includes("not a built-in"),
      ),
    ).toBe(true)
  })

  it("drops a $when object whose param is unset, and never sends the $when key", () => {
    const op = opNamed(valid(), "find_customer")
    expect(render(op, { email: "anna@northwind.example" }).body).toEqual({
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: "anna@northwind.example" }] },
      ],
      limit: 5,
    })
    expect(render(op, { domain: "northwind.example" }).body).toEqual({
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_email_domain", operator: "EQ", value: "northwind.example" },
          ],
        },
      ],
      limit: 5,
    })
  })

  it("keeps a $when value inside its slot (no injection through the filter)", () => {
    const op = opNamed(valid(), "find_customer")
    const body = render(op, { domain: '"},{"propertyName":"x' }).body as Record<string, Json>
    const groups = body.filterGroups as { filters: { value: string }[] }[]
    expect(groups).toHaveLength(1)
    expect(groups[0]?.filters[0]?.value).toBe('"},{"propertyName":"x')
  })

  it("refuses a body whose every param is behind $when when no param is required", () => {
    // Not a role: a call without params would send no filter at all.
    const noRole = doc((o) => {
      const fc = o.find(
        (x) =>
          typeof x === "object" && x !== null && !Array.isArray(x) && x.name === "find_customer",
      ) as Record<string, Json>
      delete fc.role
    })
    expect(
      issues(noRole).some(
        (i) => i.path === "operations.0.body" && i.message.includes("would be unfiltered"),
      ),
    ).toBe(true)
    // A lookup role is exempt: the host refuses it without one of its params.
    expect(validateAdapter(doc()).ok).toBe(true)
    // One filter without $when, or a required param, makes it filtered.
    const oneUnguarded = doc((o) => {
      const fc = o.find(
        (x) =>
          typeof x === "object" && x !== null && !Array.isArray(x) && x.name === "find_customer",
      ) as Record<string, Json>
      delete fc.role
      fc.body = {
        filterGroups: [
          { $when: "email", filters: [{ value: "{email}" }] },
          { filters: [{ value: "{domain}" }] },
        ],
      }
    })
    expect(issues(oneUnguarded).some((i) => i.message.includes("would be unfiltered"))).toBe(false)
  })

  it("refuses a $when naming an undeclared param", () => {
    expect(
      issues(
        doc(
          patchOp("find_customer", {
            body: { filterGroups: [{ $when: "phone", filters: [] }] },
          }),
        ),
      ).some((i) => i.message.includes("$when")),
    ).toBe(true)
  })
})
