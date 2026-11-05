// SPDX-License-Identifier: FSL-1.1-ALv2
//
// openapi.json is the fixture CRM's contract, and the input the authoring
// skill's measured run starts from, so it has to be accurate:
//   - every adapter operation's method + path, mapped query keys, pagination
//     param, auth header and allow-listed fields exist in the document;
//   - every live response of the server conforms to the documented schema
//     (closed objects: an undocumented field fails), so the document cannot
//     drift from server.ts either.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  type Adapter,
  fieldEntries,
  type Operation,
  resolvePointer,
} from "@liaison/api-connector-core"
import { FIXTURE_CRM_OPENAPI_FILE, loadFixtureCrmAdapter } from "./adapter"
import { FIXTURE_CRM_API_KEY_HEADER, FIXTURE_CRM_TEST_REFERENCE_DATE } from "./data"
import { type FixtureCrm, startFixtureCrm } from "./server"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Schema = { [key: string]: Json }

interface OpenApiParameter {
  name: string
  in: string
  required?: boolean
}
interface OpenApiOperation {
  parameters?: (OpenApiParameter | { $ref: string })[]
  requestBody?: { content: Record<string, { schema: Schema }> }
  responses: Record<string, { content?: Record<string, { schema: Schema }> } | { $ref: string }>
}
interface OpenApiDoc {
  openapi: string
  servers: { url: string }[]
  paths: Record<string, Record<string, OpenApiOperation>>
  components: {
    securitySchemes: Record<string, { type: string; in?: string; name?: string }>
    parameters: Record<string, OpenApiParameter>
    schemas: Record<string, Schema>
  }
}

/** A full request body per write operation, every optional key set. */
const SAMPLE_BODIES: Record<string, Json> = {
  create_note: { note: { body: "x", pinned: true } },
  create_company: {
    company: { name: "X", domain: "x.example", industry: "x", city: "x", country: "FR" },
  },
  create_contact: {
    contact: {
      first_name: "X",
      last_name: "Y",
      email: "x@y.example",
      title: "x",
      phone: "1",
      company_id: "cmp_001",
      company: { name: "X", domain: "x.example" },
    },
  },
}

const doc = JSON.parse(readFileSync(FIXTURE_CRM_OPENAPI_FILE, "utf8")) as OpenApiDoc
const adapter: Adapter = loadFixtureCrmAdapter()

function deref<T>(value: T | { $ref: string }): T {
  if (typeof value === "object" && value !== null && "$ref" in value) {
    const target = resolvePointer(doc, value.$ref.slice(1))
    if (target === undefined) throw new Error(`dangling $ref ${value.$ref}`)
    return deref(target as T | { $ref: string })
  }
  return value
}

function schemaOf(value: Json | undefined): Schema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("not a schema")
  }
  return deref<Schema>(value as Schema | { $ref: string })
}

const normalize = (path: string): string => path.replace(/\{[^}]+\}/g, "{}")

function findOperation(o: Operation): { path: string; op: OpenApiOperation } | null {
  const want = normalize(o.path)
  for (const [path, methods] of Object.entries(doc.paths)) {
    if (normalize(path) !== want) continue
    const found = methods[o.method.toLowerCase()]
    if (found) return { path, op: found }
  }
  return null
}

function successSchema(op: OpenApiOperation): Schema {
  const entry = Object.entries(op.responses).find(([code]) => code.startsWith("2"))
  if (!entry) throw new Error("no 2xx response")
  const response = deref(entry[1])
  const schema = response.content?.["application/json"]?.schema
  if (!schema) throw new Error("2xx response without a JSON schema")
  return schemaOf(schema)
}

/** Follow a JSON pointer through a schema (properties, array items). */
function schemaAtPointer(schema: Schema, pointer: string): Schema {
  let cur = schema
  if (pointer === "") return cur
  for (const seg of pointer.slice(1).split("/")) {
    if (cur.type === "array") cur = schemaOf(cur.items)
    const props = cur.properties as Record<string, Json> | undefined
    if (!props?.[seg]) throw new Error(`pointer segment ${seg} not in schema`)
    cur = schemaOf(props[seg])
  }
  return cur.type === "array" ? schemaOf(cur.items) : cur
}

/** Follow a dotted field path through a schema; returns the leaf schema or null. */
function schemaAtField(schema: Schema, field: string): Schema | null {
  let cur: Schema = schema
  for (const seg of field.split(".")) {
    while (cur.type === "array") cur = schemaOf(cur.items)
    const props = cur.properties as Record<string, Json> | undefined
    const next = props?.[seg]
    if (next === undefined) return null
    cur = schemaOf(next)
  }
  return cur
}

function isScalarSchema(schema: Schema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types.includes("object")) return false
  if (types.includes("array")) return isScalarSchema(schemaOf(schema.items))
  return true
}

function parameters(op: OpenApiOperation): OpenApiParameter[] {
  return (op.parameters ?? []).map((p) => deref(p))
}

/** A small JSON Schema check: types, enums, required, closed objects, array items. */
function conformance(value: unknown, schema: Schema, at: string): string[] {
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[]
  const typeOf =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number" && Number.isInteger(value)
          ? "integer"
          : typeof value
  const ok = types.includes(typeOf) || (typeOf === "integer" && types.includes("number"))
  if (!ok) return [`${at}: ${typeOf} is not ${types.join("|")}`]
  const errors: string[] = []
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as Json)) {
    errors.push(`${at}: ${String(value)} not in enum`)
  }
  if (typeOf === "array") {
    ;(value as unknown[]).forEach((v, i) => {
      errors.push(...conformance(v, schemaOf(schema.items), `${at}[${i}]`))
    })
  }
  if (typeOf === "object") {
    const record = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, Json>
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in record)) errors.push(`${at}.${key}: required but missing`)
    }
    for (const [key, v] of Object.entries(record)) {
      const sub = props[key]
      if (sub === undefined) {
        if (schema.additionalProperties === false) errors.push(`${at}.${key}: undocumented field`)
        continue
      }
      errors.push(...conformance(v, schemaOf(sub), `${at}.${key}`))
    }
  }
  return errors
}

describe("openapi.json", () => {
  it("is an OpenAPI 3.1 document whose server matches the adapter baseUrl", () => {
    expect(doc.openapi).toMatch(/^3\.1\./)
    expect(doc.servers[0]?.url).toBe(adapter.baseUrl)
  })

  it("documents the adapter's auth header", () => {
    expect(adapter.auth.type).toBe("apiKey")
    const schemes = Object.values(doc.components.securitySchemes)
    expect(schemes).toContainEqual({
      type: "apiKey",
      in: "header",
      name: adapter.auth.type === "apiKey" ? adapter.auth.name : "",
    })
    expect(FIXTURE_CRM_API_KEY_HEADER).toBe(adapter.auth.type === "apiKey" ? adapter.auth.name : "")
  })

  for (const o of adapter.operations) {
    describe(`adapter operation ${o.name}`, () => {
      it("exists with the same method and path", () => {
        expect(findOperation(o)).not.toBeNull()
      })

      it("maps only documented query parameters", () => {
        const found = findOperation(o)
        if (!found) throw new Error("missing operation")
        const documented = parameters(found.op)
          .filter((p) => p.in === "query")
          .map((p) => p.name)
        const mapped = Object.keys(o.query ?? {})
        if (o.pagination) mapped.push(o.pagination.param)
        for (const key of mapped) expect(documented).toContain(key)
      })

      it("has one documented path parameter per placeholder", () => {
        const found = findOperation(o)
        if (!found) throw new Error("missing operation")
        const pathParams = parameters(found.op).filter((p) => p.in === "path")
        const placeholders = o.path.match(/\{[^}]+\}/g) ?? []
        expect(pathParams.length).toBe(placeholders.length)
      })

      it("allow-lists only fields that exist and end at a scalar", () => {
        const found = findOperation(o)
        if (!found) throw new Error("missing operation")
        const itemSchema = schemaAtPointer(successSchema(found.op), o.items ?? "")
        for (const { source: field } of fieldEntries(o)) {
          const leaf = schemaAtField(itemSchema, field)
          expect({ field, found: leaf !== null }).toEqual({ field, found: true })
          if (leaf) expect({ field, scalar: isScalarSchema(leaf) }).toEqual({ field, scalar: true })
        }
      })

      if (o.pagination?.type === "cursor") {
        it("reads the cursor from a documented response field", () => {
          const found = findOperation(o)
          if (!found) throw new Error("missing operation")
          const pagination = o.pagination
          if (pagination?.type !== "cursor") throw new Error("not cursor")
          expect(() =>
            schemaAtPointer(successSchema(found.op), pagination.cursorPointer),
          ).not.toThrow()
        })
      }

      if (o.body) {
        it("sends a body the request schema documents", () => {
          const found = findOperation(o)
          const schema = found?.op.requestBody?.content["application/json"]?.schema
          if (!schema) throw new Error("no request body schema")
          const sample = SAMPLE_BODIES[o.name]
          if (!sample) throw new Error(`no sample body for ${o.name}`)
          const errors = conformance(sample, schemaOf(schema), "body")
          expect(errors).toEqual([])
          expect(Object.keys(o.body ?? {})).toEqual(
            Object.keys((schemaOf(schema).properties ?? {}) as Record<string, Json>),
          )
        })
      }
    })
  }
})

describe("server responses conform to openapi.json", () => {
  const API_KEY = "drift-key"
  let crm: FixtureCrm
  beforeAll(() => {
    crm = startFixtureCrm({ apiKey: API_KEY, referenceDate: FIXTURE_CRM_TEST_REFERENCE_DATE })
  })
  afterAll(async () => {
    await crm.stop()
  })

  const calls: [string, string, string, unknown?][] = [
    ["get", "/companies", "?limit=2"],
    ["get", "/companies", "?email=jane.doe%40acme-instruments.example"],
    ["get", "/companies/{id}", ""],
    ["get", "/companies/{id}/contacts", ""],
    ["get", "/companies/{id}/deals", ""],
    ["get", "/companies/{id}/orders", "?since=2026-04-01"],
    ["get", "/companies/{id}/invoices", ""],
    ["get", "/orders", "?limit=3"],
    ["get", "/stock", ""],
    ["post", "/companies/{id}/notes", "", { note: { body: "Drift check", pinned: false } }],
    ["post", "/companies", "", { company: { name: "Drift Co", domain: "drift.example" } }],
    [
      "post",
      "/contacts",
      "",
      {
        contact: {
          first_name: "Drift",
          last_name: "Check",
          email: "drift.check@drift-two.example",
          company: { name: "Drift Two", domain: "drift-two.example" },
        },
      },
    ],
    [
      "post",
      "/contacts",
      "",
      {
        contact: {
          first_name: "A",
          last_name: "B",
          email: "a.b@acme.example",
          company_id: "cmp_001",
        },
      },
    ],
  ]

  for (const [method, path, search, body] of calls) {
    it(`${method.toUpperCase()} ${path}${search}`, async () => {
      const documented = doc.paths[path]?.[method]
      if (!documented) throw new Error(`${method} ${path} is not documented`)
      const url = `${crm.baseUrl}${path.replace("{id}", "cmp_001")}${search}`
      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
          [FIXTURE_CRM_API_KEY_HEADER]: API_KEY,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      expect(String(res.status)).toMatch(/^2/)
      expect(Object.keys(documented.responses)).toContain(String(res.status))
      const errors = conformance(await res.json(), successSchema(documented), "response")
      expect(errors).toEqual([])
    })
  }

  it("401 and 404 bodies match the documented error schema", async () => {
    const errorSchema = schemaOf(doc.components.schemas.Error as Json)
    const unauth = await fetch(`${crm.baseUrl}/stock`)
    expect(unauth.status).toBe(401)
    expect(conformance(await unauth.json(), errorSchema, "401")).toEqual([])
    const missing = await fetch(`${crm.baseUrl}/companies/cmp_999`, {
      headers: { [FIXTURE_CRM_API_KEY_HEADER]: API_KEY },
    })
    expect(missing.status).toBe(404)
    expect(conformance(await missing.json(), errorSchema, "404")).toEqual([])
  })

  it("the conformance check catches an undocumented field (discriminator)", () => {
    const companySchema = schemaOf(doc.components.schemas.Company as Json)
    const company = crm.handler.data.companies[0]
    expect(conformance(company, companySchema, "c")).toEqual([])
    expect(conformance({ ...company, secret_flag: true }, companySchema, "c")).toEqual([
      "c.secret_flag: undocumented field",
    ])
  })
})
