// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import fixtures from "./fixtures/ref-schemas.json"
import { jsonSchemaToZod, UnconvertibleSchemaError } from "./json-schema-to-zod"

// Two input schemas as a live MCP server publishes them (names made generic):
// `$ref: "#/$defs/..."` into a `$defs` block, a single-branch `anyOf` around a
// reference, and `additionalProperties` as a schema for a key/value map.
const reports = fixtures.get_attribution_reports.inputSchema
const records = fixtures.manage_records.inputSchema

describe("jsonSchemaToZod — local $ref", () => {
  it("converts a reports schema whose enums sit behind #/$defs references", () => {
    const zod = jsonSchemaToZod(reports)
    const ok = zod.safeParse({
      metrics: ["REVENUE"],
      dimensions: ["ASSET_TYPE"],
      sortByMetric: "DEAL_COUNT",
      filters: [{ dimension: "UTM_SOURCE", operator: "EQ", value: "newsletter" }],
    })
    expect(ok.success).toBe(true)
    // The referenced enums validate: an unknown metric or dimension is refused.
    expect(zod.safeParse({ metrics: ["NOT_A_METRIC"] }).success).toBe(false)
    expect(zod.safeParse({ sortByMetric: "NOPE" }).success).toBe(false)
    expect(zod.safeParse({ filters: [{ dimension: "NOPE", operator: "EQ" }] }).success).toBe(false)
  })

  it("converts a write schema whose items are a #/$defs object, and validates a call", () => {
    const zod = jsonSchemaToZod(records)
    const call = {
      createRequest: {
        objects: [
          {
            objectType: "notes",
            properties: { body: "Call recap", timestamp: "2026-10-25T10:00:00Z" },
            associations: [{ targetObjectId: 42, targetObjectType: "COMPANY" }],
          },
        ],
      },
      confirmationStatus: "CONFIRMED",
    }
    const parsed = zod.safeParse(call)
    expect(parsed.success).toBe(true)
    // The key/value map keeps its keys (additionalProperties: {type: string}).
    expect(parsed.data).toEqual(call)
    // The referenced object's required fields and closed shape hold.
    const missingTarget = structuredClone(call)
    ;(
      missingTarget.createRequest.objects[0].associations[0] as Record<string, unknown>
    ).targetObjectId = undefined
    expect(zod.safeParse(missingTarget).success).toBe(false)
    const extraKey = structuredClone(call)
    ;(extraKey.createRequest.objects[0].associations[0] as Record<string, unknown>).bogus = 1
    expect(zod.safeParse(extraKey).success).toBe(false)
    // A map value of the wrong type is refused.
    const badValue = structuredClone(call)
    ;(badValue.createRequest.objects[0].properties as Record<string, unknown>).body = 5
    expect(zod.safeParse(badValue).success).toBe(false)
    expect(zod.safeParse({ confirmationStatus: "MAYBE" }).success).toBe(false)
  })

  it("the converted schemas still render as JSON Schema for the model", () => {
    for (const s of [reports, records]) {
      expect(() => z.toJSONSchema(jsonSchemaToZod(s))).not.toThrow()
    }
  })

  it("resolves draft-07 #/definitions references", () => {
    const zod = jsonSchemaToZod({
      type: "object",
      definitions: { Color: { type: "string", enum: ["red", "blue"] } },
      properties: { color: { $ref: "#/definitions/Color" } },
      required: ["color"],
    })
    expect(zod.safeParse({ color: "red" }).success).toBe(true)
    expect(zod.safeParse({ color: "green" }).success).toBe(false)
  })

  it("converts a cyclic $ref schema without hanging (the loop becomes permissive)", () => {
    const tree = {
      type: "object",
      $defs: {
        Node: {
          type: "object",
          properties: {
            label: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
          required: ["label"],
        },
      },
      properties: { root: { $ref: "#/$defs/Node" }, self: { $ref: "#" } },
    }
    const zod = jsonSchemaToZod(tree)
    expect(
      zod.safeParse({ root: { label: "a", children: [{ label: "b", children: [{}] }] } }).success,
    ).toBe(true)
    // The first level still validates.
    expect(zod.safeParse({ root: { children: [] } }).success).toBe(false)
  })

  it("refuses a remote $ref with a reason, never fetching it", () => {
    expect(() =>
      jsonSchemaToZod({
        type: "object",
        properties: { x: { $ref: "https://schemas.example.com/x.json" } },
      }),
    ).toThrow(
      new UnconvertibleSchemaError("unsupported remote $ref: https://schemas.example.com/x.json"),
    )
  })

  it("refuses a local $ref that points nowhere", () => {
    expect(() =>
      jsonSchemaToZod({ type: "object", properties: { x: { $ref: "#/$defs/Missing" } } }),
    ).toThrow(UnconvertibleSchemaError)
  })
})

describe("jsonSchemaToZod — other keywords", () => {
  it("converts anyOf / oneOf / allOf, const, nullable and type arrays", () => {
    const zod = jsonSchemaToZod({
      type: "object",
      properties: {
        id: { anyOf: [{ type: "string" }, { type: "integer" }] },
        kind: { oneOf: [{ const: "a" }, { const: "b" }] },
        both: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
          ],
        },
        note: { type: "string", nullable: true },
        maybe: { type: ["string", "null"] },
        level: { enum: [1, 2, "max"] },
      },
    })
    expect(
      zod.safeParse({
        id: 3,
        kind: "a",
        both: { a: "x", b: 1 },
        note: null,
        maybe: null,
        level: 2,
      }).success,
    ).toBe(true)
    expect(zod.safeParse({ id: true }).success).toBe(false)
    expect(zod.safeParse({ kind: "c" }).success).toBe(false)
    expect(zod.safeParse({ both: { a: "x" } }).success).toBe(false)
    expect(zod.safeParse({ level: 3 }).success).toBe(false)
  })
})
