// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { UnsafeManifestPatternError } from "~/lib/manifest-regex"
import {
  _validatorCacheSize,
  injectFinalizeTool,
  validateFinalizePayload,
} from "~/modules/agent/subruns/finalize-tool"

const schema = {
  type: "object",
  required: ["draft", "confidence"],
  properties: {
    draft: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
}

describe("injectFinalizeTool", () => {
  it("adds a `finalize` tool whose description explains termination semantics", () => {
    const tools: Record<string, unknown> = {}
    const augmented = injectFinalizeTool(tools, schema)
    expect(augmented.finalize).toBeDefined()
    expect((augmented.finalize as { description: string }).description).toMatch(
      /Terminate this sub-run/,
    )
  })

  it("preserves the existing tool entries when augmenting", () => {
    const existing = { foo: "bar" }
    const augmented = injectFinalizeTool(existing, schema)
    expect(augmented.foo).toBe("bar")
    expect(augmented.finalize).toBeDefined()
  })
})

describe("validateFinalizePayload", () => {
  it("accepts a conforming payload", () => {
    const result = validateFinalizePayload({ draft: "hi", confidence: 0.5 }, schema)
    expect(result.ok).toBe(true)
  })

  it("rejects missing required field with path + keyword in the message", () => {
    const result = validateFinalizePayload({ draft: "hi" }, schema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/confidence/)
      expect(result.error).toMatch(/required/i)
    }
  })

  it("rejects an out-of-range value with the failing field in the message", () => {
    const result = validateFinalizePayload({ draft: "x", confidence: 2 }, schema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/confidence/)
      expect(result.error).toMatch(/maximum/i)
    }
  })

  it("rejects additional properties when schema forbids them", () => {
    const result = validateFinalizePayload({ draft: "x", confidence: 0.5, extra: true }, schema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0)
    }
  })

  it("joins multiple errors into a single diagnostic string", () => {
    const result = validateFinalizePayload({}, schema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Both `draft` and `confidence` are required — both should appear
      expect(result.error).toMatch(/draft/)
      expect(result.error).toMatch(/confidence/)
    }
  })

  it("reports each error as path, message and keyword", () => {
    const result = validateFinalizePayload({ draft: "", confidence: 2 }, schema)
    expect(result).toEqual({
      ok: false,
      error:
        "/draft must NOT have fewer than 1 characters [minLength]; /confidence must be <= 1 [maximum]",
    })
  })

  it("bounds the validator cache however many distinct schemas the model writes", () => {
    for (let i = 0; i < 1000; i++) {
      const own = { type: "object", required: [`field${i}`] }
      expect(validateFinalizePayload({}, own)).toEqual({
        ok: false,
        error: `(root)/field${i} must have required property 'field${i}' [required]`,
      })
    }
    expect(_validatorCacheSize()).toBe(256)
    // The most recently used schema is still cached and still validates.
    expect(
      validateFinalizePayload({ field999: 1 }, { type: "object", required: ["field999"] }),
    ).toEqual({ ok: true })
    expect(_validatorCacheSize()).toBe(256)
  })

  it("refuses a schema that is not a valid JSON Schema with Ajv's own message", () => {
    expect(() => validateFinalizePayload({}, { type: "nope" })).toThrow(/^schema is invalid: /)
  })

  // The schema is written by the model, so its `pattern` keywords get the same
  // linear-time guard as app manifest patterns: a backtracking one is refused at
  // compile time and never runs against a payload.
  it("refuses a backtracking-prone pattern before it runs", () => {
    const evil = {
      type: "object",
      properties: { s: { type: "string", pattern: "^(a|a)+$" } },
    }
    const started = performance.now()
    expect(() => validateFinalizePayload({ s: `${"a".repeat(18)}!` }, evil)).toThrow(
      UnsafeManifestPatternError,
    )
    expect(performance.now() - started).toBeLessThan(2_500)
  })

  it("refuses an over-long pattern", () => {
    const long = { type: "string", pattern: `^${"[a-z]".repeat(200)}$` }
    expect(() => validateFinalizePayload("abc", long)).toThrow(UnsafeManifestPatternError)
  })

  it("still validates a linear pattern", () => {
    const ok = {
      type: "object",
      properties: { id: { type: "string", pattern: "^[A-Z]{2}-\\d+$" } },
    }
    expect(validateFinalizePayload({ id: "AB-12" }, ok)).toEqual({ ok: true })
    expect(validateFinalizePayload({ id: "nope" }, ok).ok).toBe(false)
  })
})
