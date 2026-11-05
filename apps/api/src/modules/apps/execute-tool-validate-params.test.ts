// SPDX-License-Identifier: FSL-1.1-ALv2
// Verbose, model-readable tool-parameter validation errors — covers both the
// manifest/ajv path and the Zod kernel-tool path: which field, expected vs.
// received, allowed enum values, did-you-mean for a typo'd param, and the
// JSON-encoded-string pitfall. Also covers the silent coercion that accepts a
// stringified array/object a weak model emits.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { validateParamsForTool } from "./execute-tool"

// A manifest tool: `isManifestHandler` keys on a `{ bundlePath, exportName }`
// handler; `params` is a JSON Schema validated by ajv.
function manifestTool(params: unknown): any {
  return { handler: { bundlePath: "b", exportName: "e" }, params }
}

// A kernel tool: a plain function handler + a Zod `params` schema.
function zodTool(params: unknown): any {
  return { handler: async () => ({}), params }
}

// A unique tool name per call, so each case's error text names its own tool.
let toolSeq = 0
function validate(tool: any, rawParams: unknown): unknown {
  return validateParamsForTool(tool, "org", "app", `tool-${toolSeq++}`, rawParams)
}

/** Invoke validate(), assert it threw, return the error message. */
function invalidMessage(tool: any, rawParams: unknown): string {
  try {
    validate(tool, rawParams)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error("expected validateParamsForTool to throw")
}

describe("validateParamsForTool — manifest (ajv) error messages", () => {
  const schema = {
    type: "object",
    properties: {
      ticketId: { type: "string" },
      priority: { type: "string", enum: ["low", "high"] },
      attachments: { type: "array", items: { type: "string" } },
    },
    required: ["ticketId"],
  }

  it("names a missing required parameter", () => {
    const msg = invalidMessage(manifestTool(schema), {})
    expect(msg).toContain("Invalid parameters for app:")
    expect(msg).toContain('"ticketId" is required but was not provided')
  })

  it("reports expected vs. received type", () => {
    const msg = invalidMessage(manifestTool(schema), { ticketId: 123 })
    expect(msg).toContain('"ticketId" must be string, but number was provided')
  })

  // Walk 5 (D41): a weak model staged a carton as { "width1": 14, "height /": 6 }; a
  // nested shape that is closed now says which key it does not know and which it does.
  it("names an unknown field inside a closed nested object, and the fields it takes", () => {
    const closed = {
      type: "object",
      properties: {
        override: {
          type: "object",
          additionalProperties: false,
          properties: { length: { type: "number" }, width: { type: "number" } },
        },
      },
    }
    const msg = invalidMessage(manifestTool(closed), { override: { length: 20, width1: 14 } })
    expect(msg).toContain('"override.width1" is not a recognised field')
    expect(msg).toContain("length, width")
  })

  it("lists allowed values for an enum mismatch", () => {
    const msg = invalidMessage(manifestTool(schema), { ticketId: "t", priority: "banana" })
    expect(msg).toContain('"priority" must be one of: low, high')
  })

  it("still flags a JSON-OBJECT string passed where an array is declared", () => {
    // `{"a":1}` parses to an object — not an array, not a scalar — so it is NOT wrapped;
    // ajv sees object-vs-array and the helpful hint is rendered.
    const msg = invalidMessage(manifestTool(schema), { ticketId: "t", attachments: '{"a":1}' })
    expect(msg).toContain('"attachments" must be an array')
  })

  it("BL-29: wraps a single bare string into a one-element array (the to:'a@b.com' mistake)", () => {
    // A weak model routinely passes ONE id/recipient as a bare string where an array is
    // declared. That isn't JSON, so it can't be parsed — it is wrapped into [value] instead
    // of dead-ending on 'must be an array' (which the model looped on forever in dunning).
    const result = validate(manifestTool(schema), {
      ticketId: "t",
      attachments: "single-id",
    }) as { attachments: unknown }
    expect(result.attachments).toEqual(["single-id"])
  })

  it("BL-29: wraps a double-quoted JSON string scalar into a one-element array", () => {
    const result = validate(manifestTool(schema), {
      ticketId: "t",
      attachments: '"quoted-id"',
    }) as { attachments: unknown }
    expect(result.attachments).toEqual(["quoted-id"])
  })

  it("rejects an unrecognised (typo'd) parameter and suggests the closest name", () => {
    // No `additionalProperties: false` on the schema — strictness is enforced
    // centrally, so a typo is flagged rather than silently dropped.
    const msg = invalidMessage(manifestTool(schema), { ticketId: "t", tickteId: "x" })
    expect(msg).toContain('"tickteId" is not a recognised parameter')
    expect(msg).toContain('did you mean "ticketId"?')
  })

  it("respects an explicit additionalProperties:true opt-out — unknown param allowed", () => {
    const open = { ...schema, additionalProperties: true }
    expect(() => validate(manifestTool(open), { ticketId: "t", anythingElse: "ok" })).not.toThrow()
  })

  it("coerces a stringified array a weak model emits — no error thrown", () => {
    const result = validate(manifestTool(schema), {
      ticketId: "t",
      attachments: '["a","b"]',
    }) as { attachments: unknown }
    expect(result.attachments).toEqual(["a", "b"])
  })

  // UNION type (2026-07-24): a param declared `type: ["object","array"]` (one
  // carton OR many — boxtal set_package.override) round-trips over MCP as a
  // STRING. The coercion only matched a single "array"/"object" `type`, so a
  // union param was never parsed and ajv rejected the raw string ('must be
  // object,array, but string was provided'), breaking the tool for BOTH forms.
  describe("UNION object|array param coercion (set_package.override class)", () => {
    const unionSchema = {
      type: "object",
      properties: {
        override: { type: ["object", "array"], additionalProperties: true },
      },
      required: ["override"],
    }

    it("coerces a stringified ARRAY (the multi-carton form)", () => {
      const result = validate(manifestTool(unionSchema), {
        override: '[{"length":62,"weight":20,"quantity":6},{"length":62,"weight":7}]',
      }) as { override: unknown }
      expect(result.override).toEqual([
        { length: 62, weight: 20, quantity: 6 },
        { length: 62, weight: 7 },
      ])
    })

    it("coerces a stringified OBJECT (the single-carton form)", () => {
      const result = validate(manifestTool(unionSchema), {
        override: '{"length":62,"width":39,"height":36,"weight":20}',
      }) as { override: unknown }
      expect(result.override).toEqual({ length: 62, width: 39, height: 36, weight: 20 })
    })

    it("passes a real array through untouched (no double-coercion)", () => {
      const arr = [{ length: 62, weight: 20 }]
      const result = validate(manifestTool(unionSchema), { override: arr }) as { override: unknown }
      expect(result.override).toEqual(arr)
    })
  })

  // DEFECT 2 (2026-07-15): knowledge:update's `revision` (JSON-Schema
  // `{ type: "integer" }`) rejected every MCP call with '"revision" must be
  // integer, but string was provided' even for a caller passing a plain
  // number, because the MCP transport can round-trip a number as a string and
  // ajv's strict `integer` check has no coercion step. Both a number and a
  // numeric STRING must now validate and land as a real number.
  describe("DEFECT 2: numeric-string coercion for a JSON-Schema integer/number param", () => {
    const revisionSchema = {
      type: "object",
      properties: { id: { type: "string" }, revision: { type: "integer" } },
      required: ["id", "revision"],
    }

    it("accepts revision as a number", () => {
      const result = validate(manifestTool(revisionSchema), {
        id: "doc-1",
        revision: 2,
      }) as { revision: unknown }
      expect(result.revision).toBe(2)
    })

    it("accepts revision as a numeric STRING and coerces it to a number", () => {
      const result = validate(manifestTool(revisionSchema), {
        id: "doc-1",
        revision: "2",
      }) as { revision: unknown }
      expect(result.revision).toBe(2)
      expect(typeof result.revision).toBe("number")
    })

    it("still rejects a non-numeric string — the coercion is precise, not a blanket bypass", () => {
      const msg = invalidMessage(manifestTool(revisionSchema), {
        id: "doc-1",
        revision: "not-a-number",
      })
      expect(msg).toContain('"revision" must be integer')
    })
  })
})

describe("validateParamsForTool — kernel (Zod) error messages", () => {
  const schema = z.object({
    threadId: z.string(),
    priority: z.enum(["low", "high"]).optional(),
    attachments: z.array(z.string()).optional(),
  })

  it("names a missing required parameter", () => {
    const msg = invalidMessage(zodTool(schema), {})
    expect(msg).toContain("Invalid parameters for app:")
    expect(msg).toContain('"threadId" is required but was not provided')
  })

  it("reports expected vs. received type", () => {
    const msg = invalidMessage(zodTool(schema), { threadId: 123 })
    expect(msg).toContain('"threadId" must be string, but number was provided')
  })

  it("lists allowed values for an enum mismatch", () => {
    const msg = invalidMessage(zodTool(schema), { threadId: "t", priority: "banana" })
    expect(msg).toContain("low")
    expect(msg).toContain("high")
  })

  it("recognises the JSON-encoded-string pitfall for an array param", () => {
    // `{"a":1}` parses to an object — not a string array — so the coercion
    // leaves it and Zod sees string-vs-array.
    const msg = invalidMessage(zodTool(schema), { threadId: "t", attachments: '{"a":1}' })
    expect(msg).toContain('"attachments" must be an array')
    expect(msg).toContain("pass a real JSON array")
  })

  it("coerces a stringified array a weak model emits — no error thrown", () => {
    const result = validate(zodTool(schema), {
      threadId: "t",
      attachments: '["x","y"]',
    }) as { attachments: unknown }
    expect(result.attachments).toEqual(["x", "y"])
  })

  it("BL-29: wraps a single bare string into a one-element array (kernel-tool array field)", () => {
    const result = validate(zodTool(schema), {
      threadId: "t",
      attachments: "single-id",
    }) as { attachments: unknown }
    expect(result.attachments).toEqual(["single-id"])
  })

  it("rejects an unrecognised (typo'd) parameter and suggests the closest name", () => {
    const msg = invalidMessage(zodTool(schema), { threadId: "t", thraedId: "x" })
    expect(msg).toContain('"thraedId" is not a recognised parameter')
    expect(msg).toContain('did you mean "threadId"?')
  })

  it("leaves a genuine string parameter untouched", () => {
    const result = validate(zodTool(schema), { threadId: "thread-1" }) as { threadId: unknown }
    expect(result.threadId).toBe("thread-1")
  })

  // DEFECT 2 sibling fix — the same numeric-string coercion, generalized to
  // kernel (Zod) tools so MCP string transport can't break an integer param
  // regardless of which validation path a tool uses.
  describe("DEFECT 2: numeric-string coercion for a Zod number/integer field", () => {
    const revisionSchema = z.object({
      id: z.string(),
      revision: z.number().int(),
    })

    it("accepts revision as a number", () => {
      const result = validate(zodTool(revisionSchema), { id: "doc-1", revision: 2 }) as {
        revision: unknown
      }
      expect(result.revision).toBe(2)
    })

    it("accepts revision as a numeric STRING and coerces it to a number", () => {
      const result = validate(zodTool(revisionSchema), { id: "doc-1", revision: "2" }) as {
        revision: unknown
      }
      expect(result.revision).toBe(2)
      expect(typeof result.revision).toBe("number")
    })

    it("still rejects a non-numeric string", () => {
      const msg = invalidMessage(zodTool(revisionSchema), { id: "doc-1", revision: "not-a-number" })
      expect(msg).toContain('"revision"')
    })
  })
})

// Ajv in strict mode refuses to compile a schema that names a format it does not
// know, and the validator is only compiled on a tool's first call, so a manifest
// tool declaring an unregistered format failed every call while installing fine.
describe("validateParamsForTool: bundled manifest tool schemas", () => {
  it("compiles every bundled-apps tool param schema through the real validator", () => {
    const root = path.resolve(import.meta.dir, "../../../../../bundled-apps")
    const failures: string[] = []
    let checked = 0
    for (const app of readdirSync(root)) {
      const file = path.join(root, app, "app.manifest.json")
      if (!existsSync(file)) continue
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        tools?: Record<string, { params?: unknown }>
      }
      for (const [name, tool] of Object.entries(manifest.tools ?? {})) {
        const params = tool?.params
        if (!params || typeof params !== "object" || !("type" in params)) continue
        checked++
        try {
          validateParamsForTool(manifestTool(params), "org", app, name, {})
        } catch (err) {
          // An empty call may fail validation with a 400. Anything else means the
          // schema never compiled.
          if (!(err instanceof HTTPException && err.status === 400)) {
            failures.push(`${app}:${name}: ${(err as Error).message}`)
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200)
    expect(failures).toEqual([])
  })

  it("a uuid format param accepts a valid uuid and rejects not-a-uuid", () => {
    const tool = manifestTool({
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
      required: ["id"],
    })
    const id = "3f2b8c1e-9d4a-4c6b-8e2f-1a2b3c4d5e6f"
    expect(validate(tool, { id })).toEqual({ id })
    const msg = invalidMessage(tool, { id: "not-a-uuid" })
    expect(msg).toContain("Invalid parameters for app:")
    expect(msg).toContain('"id"')
  })
})
