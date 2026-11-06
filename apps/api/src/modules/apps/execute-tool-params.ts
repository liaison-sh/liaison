// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Tool-argument coercion and validation, run before a tool's handler: the
 * weak-model JSON-string and bare-scalar repairs, the unknown-parameter check
 * and the readable ajv / Zod error messages.
 */
import { minorAmountRefusal, readMinorAmount } from "@liaison/app-sdk"
import type { ErrorObject, SchemaObject } from "ajv"
import { HTTPException } from "hono/http-exception"
import { isManifestHandler, type toolRegistry } from "~/modules/apps/app-registries"
import { createParamValidatorCache } from "~/modules/apps/param-validator"

// allowUnionTypes: a manifest param may legitimately declare `type: ["object","string"]`
// (with `properties`) so a weak model can pass either the structured object OR a bare-string
// shorthand — e.g. tickets:create initialMessage (BL-91). Without this, ajv strict mode logs a
// noisy strictTypes warning on every compile of such a tool.
//
// Validators are compiled once per registered schema object, never per org/app/tool
// name: re-registering an app at a new version in the same process installs a new
// schema object under the same name, so it gets its own validator, and the old one
// is collected with the old registry entry (see param-validator.ts).
const paramValidator = createParamValidatorCache({ allErrors: true, allowUnionTypes: true })

/**
 * Coerce JSON-string tool arguments back to their declared array/object shape.
 * A weak model often emits `attachments: "[\"id\"]"` (a string) where the tool
 * schema declares an array; this parses the string when — and only when — the
 * result matches the declared type, so a sound argument is never altered and an
 * unparseable one is left for ajv to report.
 *
 * SINGLE-VALUE → ARRAY (BL-29): the other commonest weak-model mistake is passing
 * ONE recipient/id as a BARE string where an array is declared (`to: "a@b.com"`,
 * not `to: ["a@b.com"]`). That string isn't JSON, so the parse above can't help —
 * yet the intent is unambiguous: a single element. So for an array-declared field,
 * a plain (non-JSON) string OR a JSON STRING scalar is wrapped into a one-element
 * array. (A JSON array string still parses through the array branch; a JSON object
 * string for an array field stays malformed and is left for ajv. Object fields are
 * never wrapped.) Observed: the dunning chaos scenario looped forever because the
 * agent passed `mail:compose` `to` as a string and never recovered the array form.
 */
/** True for a string that parses to a finite number with no stray characters (`"2"`, `"2.0"`, `"-3"` — not `"2px"`). */
function isNumericString(value: string): boolean {
  if (value.trim() === "") return false
  return Number.isFinite(Number(value))
}

function coerceJsonStringParams(params: unknown, schema: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params
  const props = (schema as { properties?: Record<string, { type?: string | string[] }> })
    ?.properties
  if (!props) return params
  const src = params as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const [key, propSchema] of Object.entries(props)) {
    const declared = propSchema?.type
    // A JSON-Schema `type` can be a single string OR a UNION array (e.g.
    // ["object","array"] for a param that accepts one carton or many). Normalise
    // to a set so a union param coerces exactly like a single-typed one — ajv
    // itself already validates the union fine; only this pre-validation string
    // coercion needed teaching about it (without this, an MCP-stringified value
    // for a union param is never parsed and ajv then rejects the raw string).
    const declaredTypes = Array.isArray(declared) ? declared : declared != null ? [declared] : []
    const wantsNumber = declaredTypes.includes("number") || declaredTypes.includes("integer")
    const wantsArray = declaredTypes.includes("array")
    const wantsObject = declaredTypes.includes("object")
    const value = src[key]
    // MCP arg transport can round-trip a JSON-Schema `number`/`integer` param
    // as a numeric STRING ("2" instead of 2) depending on the client. ajv's
    // strict type check rejects that outright ("must be integer, but string
    // was provided") even though the intent is unambiguous — coerce it to a
    // real number/integer before validation, same spirit as the array/object
    // coercion below. `Number("2.0")` -> 2, satisfying an `integer` schema; a
    // non-numeric string (a genuine string field, or a typo) is left for ajv.
    // (Scoped to a purely-numeric param so a number|array/object union still
    // reaches the JSON-parse branch below.)
    if (wantsNumber && !wantsArray && !wantsObject && typeof value === "string") {
      // A minor-unit amount never comes through as a number from a string with a decimal point:
      // "899.00" must not become 899 (8.99) when it may well mean 899.00.
      if (isNumericString(value) && (!key.endsWith("_minor") || readMinorAmount(value) !== null)) {
        out ??= { ...src }
        out[key] = Number(value)
      }
      continue
    }
    if (typeof value !== "string" || (!wantsArray && !wantsObject)) continue
    try {
      const parsed = JSON.parse(value)
      const ok =
        (wantsArray && Array.isArray(parsed)) ||
        (wantsObject && parsed != null && typeof parsed === "object" && !Array.isArray(parsed))
      if (ok) {
        out ??= { ...src }
        out[key] = parsed
      } else if (wantsArray && typeof parsed === "string") {
        // JSON string scalar (e.g. the model double-quoted: `"\"a@b.com\""`) → one-element array.
        out ??= { ...src }
        out[key] = [parsed]
      }
      // (a parsed value matching neither declared type: leave for ajv.)
    } catch {
      // Not JSON. A plain string where an ARRAY is declared is the single-recipient/id
      // mistake (`to: "a@b.com"`) → wrap as a one-element array. Object-only fields: leave for ajv.
      if (wantsArray) {
        out ??= { ...src }
        out[key] = [value]
      }
    }
  }
  return out ?? params
}

/**
 * The Zod-schema sibling of `coerceJsonStringParams`, for kernel tools whose
 * `params` is a `z.object`. Walks the object's `shape` and, for any field whose
 * current value is a string, coerces it to the JSON-parsed value **only when**
 * the raw string fails that field's own sub-schema and the parsed array/object
 * passes it. Probing each field via its own `safeParse` keeps this precise (a
 * genuine string field is never touched) and free of Zod-internal `_def` access.
 */
function coerceZodStringParams(params: unknown, schema: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params
  const shape = (schema as { shape?: Record<string, unknown> })?.shape
  if (!shape || typeof shape !== "object") return params
  const src = params as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const value = src[key]
    if (typeof value !== "string") continue
    const field = fieldSchema as { safeParse?: (v: unknown) => { success: boolean } }
    if (typeof field?.safeParse !== "function") continue
    // The string already satisfies the field — a genuine string param, leave it.
    if (field.safeParse(value).success) continue
    let parsed: unknown
    let isJson = true
    try {
      parsed = JSON.parse(value)
    } catch {
      isJson = false
    }
    // Only ever coerce to an array/object, and only when it validates.
    if (isJson && parsed != null && typeof parsed === "object" && field.safeParse(parsed).success) {
      out ??= { ...src }
      out[key] = parsed
      continue
    }
    // A `number`/`z.number().int()` field can arrive as a numeric STRING over
    // MCP transport ("2" instead of 2). `JSON.parse("2")` -> 2 (a number) —
    // coerce when that number satisfies the field's own schema. Precise like
    // the array/object branch above: a genuine string field already returned
    // above (safeParse(value).success), so this only fires for a real
    // number-typed field.
    if (isJson && typeof parsed === "number" && field.safeParse(parsed).success) {
      out ??= { ...src }
      out[key] = parsed
      continue
    }
    // SINGLE-VALUE → ARRAY (BL-29): one id/recipient passed as a bare string where an array
    // field is declared (`ids: "x"`). A plain non-JSON string, or a JSON string scalar, is
    // wrapped into a one-element array when that validates. A JSON object/array string is NOT
    // wrapped (handled above, or genuinely malformed → left for Zod to report).
    const wrapped: unknown[] | null = !isJson
      ? [value]
      : typeof parsed === "string"
        ? [parsed]
        : null
    if (wrapped && field.safeParse(wrapped).success) {
      out ??= { ...src }
      out[key] = wrapped
    }
  }
  return out ?? params
}

// --- Param-validation error formatting -------------------------------------
// A weak model retries blindly when a format error is opaque ("Invalid
// parameters"). These render an ajv / Zod validation failure into a specific,
// model-readable message — which field, expected vs. received, allowed enum
// values, a did-you-mean for a typo'd parameter, and an explicit hint for the
// commonest pitfall: a JSON-encoded string passed where an array/object is
// expected. The resulting `invalid_params` error is marked retryable so the
// model knows it can fix the call and try again.

/** The value at a dotted path inside `params`, or undefined. */
function valueAtPath(params: unknown, dottedPath: string): unknown {
  let cur: unknown = params
  for (const seg of dottedPath ? dottedPath.split(".") : []) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** Runtime JS type of the value at a dotted path inside `params`. */
function jsTypeAtPath(params: unknown, dottedPath: string): string {
  const cur = valueAtPath(params, dottedPath)
  if (cur === undefined) return "undefined"
  if (cur === null) return "null"
  return Array.isArray(cur) ? "array" : typeof cur
}

/** Levenshtein distance — bounded helper for the did-you-mean suggestion. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]!
}

/** `" — did you mean "<x>"?"` for the closest declared param within edit-distance 2. */
function suggestParam(name: string, declared: string[]): string {
  let best = ""
  let bestDist = 3
  for (const candidate of declared) {
    const d = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (d < bestDist) {
      bestDist = d
      best = candidate
    }
  }
  return best ? ` — did you mean "${best}"?` : ""
}

/** Hint for the JSON-encoded-string-where-collection-expected pitfall. */
function jsonStringHint(kind: "array" | "object"): string {
  const example = kind === "array" ? '["id1","id2"]' : '{"key":"value"}'
  return (
    ` It was passed as a string — pass a real JSON ${kind} (e.g. ${example}), ` +
    `not a quoted or escaped string.`
  )
}

function renderParamError(toolName: string, lines: string[]): string {
  const body = lines.length > 0 ? lines : ["- the parameters do not match the tool's schema."]
  return `Invalid parameters for ${toolName}:\n${body.join("\n")}`
}

/**
 * Reject an unrecognised top-level parameter outright. Without this a typo'd
 * argument (`tickteId`) is silently dropped — ajv is default-permissive and Zod
 * `z.object` strips unknown keys — so the call runs with the parameter missing
 * and the model never learns it made a mistake. Enforced centrally for every
 * tool that declares a parameter shape; a manifest schema can still opt into
 * open params with `additionalProperties: true`. Top-level only — nested object
 * shapes keep their own (schema-declared) strictness.
 */
function assertKnownParams(toolName: string, params: unknown, declared: string[]): void {
  if (declared.length === 0) return // no declared shape — nothing to compare against
  if (params == null || typeof params !== "object" || Array.isArray(params)) return
  const unknown = Object.keys(params as Record<string, unknown>).filter(
    (k) => !declared.includes(k),
  )
  if (unknown.length === 0) return
  throw new HTTPException(400, {
    message: renderParamError(
      toolName,
      unknown.map((k) => `- "${k}" is not a recognised parameter${suggestParam(k, declared)}.`),
    ),
  })
}

/** The sub-schema an ajv `schemaPath` (`#/properties/override/additionalProperties`) points into. */
function schemaAtPath(schema: unknown, schemaPath: string, dropLast: number): unknown {
  const parts = schemaPath.replace(/^#\/?/, "").split("/").filter(Boolean)
  let at: unknown = schema
  for (const part of parts.slice(0, parts.length - dropLast)) {
    if (typeof at !== "object" || at === null) return undefined
    at = (at as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")]
  }
  return at
}

/** Render an ajv validation failure (manifest tools) into a model-readable message. */
function formatAjvParamError(
  toolName: string,
  errors: ErrorObject[] | null | undefined,
  params: unknown,
  schema?: unknown,
): string {
  const lines: string[] = []
  for (const e of errors ?? []) {
    const field = (e.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".")
    const p = (e.params ?? {}) as Record<string, unknown>
    if (e.keyword === "required") {
      lines.push(`- "${String(p.missingProperty)}" is required but was not provided.`)
    } else if (e.keyword === "enum") {
      const allowed = (Array.isArray(p.allowedValues) ? p.allowedValues : []).map(String)
      lines.push(`- "${field}" must be one of: ${allowed.join(", ")}.`)
    } else if (e.keyword === "type") {
      const want = String(p.type ?? "the declared type")
      const got = jsTypeAtPath(params, field)
      if (field.endsWith("_minor") && readMinorAmount(valueAtPath(params, field)) === null) {
        lines.push(`- ${minorAmountRefusal(`"${field}"`, valueAtPath(params, field))}`)
      } else if ((want === "array" || want === "object") && got === "string") {
        lines.push(
          `- "${field}" must be ${want === "array" ? "an array" : "an object"}.${jsonStringHint(want)}`,
        )
      } else {
        lines.push(`- "${field}" must be ${want}, but ${got} was provided.`)
      }
    } else if (e.keyword === "additionalProperties") {
      // A closed nested shape (a carton, a customs patch): name the key it
      // does not know, and the keys it takes, so the model corrects the call.
      const key = String(p.additionalProperty ?? "")
      const parent = schemaAtPath(schema, e.schemaPath ?? "", 1) as
        | { properties?: Record<string, unknown> }
        | undefined
      const known = Object.keys(parent?.properties ?? {})
      const path = field ? `${field}.${key}` : key
      lines.push(
        `- "${path}" is not a recognised field${known.length ? `; use one of: ${known.join(", ")}` : ""}.`,
      )
    } else if (e.keyword === "pattern") {
      // A value in the wrong form (a document number where a file id goes): show what was
      // sent and the field's own description of the expected form, when it has one.
      const node = schemaAtPath(schema, e.schemaPath ?? "", 1) as
        | { description?: unknown }
        | undefined
      const sent = valueAtPath(params, field)
      const shown = typeof sent === "string" ? ` holds "${sent.slice(0, 80)}", which` : ""
      const expected =
        typeof node?.description === "string" ? ` ${node.description}` : ` ${e.message ?? ""}.`
      lines.push(`- "${field}"${shown} is not in the expected form.${expected}`)
    } else {
      lines.push(`- "${field || "(parameters)"}" ${e.message ?? "is invalid"}.`)
    }
  }
  return renderParamError(toolName, lines)
}

/** Render a Zod validation failure (kernel tools) into a model-readable message. */
function formatZodParamError(
  toolName: string,
  zodError: { issues?: Array<Record<string, unknown>> },
  params: unknown,
): string {
  const lines: string[] = []
  for (const issue of zodError.issues ?? []) {
    const field = Array.isArray(issue.path) ? (issue.path as unknown[]).join(".") : ""
    const got = jsTypeAtPath(params, field)
    if (got === "undefined") {
      lines.push(`- "${field}" is required but was not provided.`)
      continue
    }
    // Zod 4 enum/literal: `values`; Zod 3: `options`.
    const enumValues = (issue.values ?? issue.options) as unknown[] | undefined
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      lines.push(`- "${field}" must be one of: ${enumValues.map(String).join(", ")}.`)
      continue
    }
    const expected = typeof issue.expected === "string" ? issue.expected : undefined
    if (expected && (expected === "array" || expected === "object") && got === "string") {
      lines.push(
        `- "${field}" must be ${expected === "array" ? "an array" : "an object"}.${jsonStringHint(expected)}`,
      )
      continue
    }
    if (expected) {
      lines.push(`- "${field}" must be ${expected}, but ${got} was provided.`)
      continue
    }
    lines.push(`- "${field || "(parameters)"}" ${String(issue.message ?? "is invalid")}.`)
  }
  return renderParamError(toolName, lines)
}

export function validateParamsForTool(
  tool: NonNullable<ReturnType<typeof toolRegistry.get>>,
  _orgId: string,
  appName: string,
  name: string,
  rawParams: unknown,
): unknown {
  let validatedParams = rawParams

  if (isManifestHandler(tool.handler)) {
    if (tool.params && typeof tool.params === "object" && "type" in tool.params) {
      // Weak models routinely serialise array/object tool arguments as a JSON
      // *string* (e.g. `attachments: "[\"<id>\"]"`). Coerce such values back to
      // the declared shape before validation so a stringified array is accepted
      // rather than failing ajv with an opaque "Invalid parameters". Only ever
      // turns a guaranteed rejection into a possible success.
      validatedParams = coerceJsonStringParams(validatedParams, tool.params)
      const manifestSchema = tool.params as {
        properties?: Record<string, unknown>
        additionalProperties?: unknown
      }
      // A typo'd parameter would otherwise be silently dropped — flag it.
      if (manifestSchema.additionalProperties !== true) {
        assertKnownParams(
          `${appName}:${name}`,
          validatedParams,
          Object.keys(manifestSchema.properties ?? {}),
        )
      }
      const validate = paramValidator(tool.params as unknown as SchemaObject)
      if (!validate(validatedParams)) {
        throw new HTTPException(400, {
          message: formatAjvParamError(
            `${appName}:${name}`,
            validate.errors,
            validatedParams,
            tool.params,
          ),
        })
      }
    }
  } else if (tool.params && typeof (tool.params as any).safeParse === "function") {
    // Same weak-model coercion as the manifest/ajv branch above, for Zod-typed
    // kernel tools (e.g. `threads_reply`'s `attachments`). A field is coerced
    // only when the raw string fails its own sub-schema AND the JSON-parsed
    // value passes it — so a genuine string field is never altered.
    validatedParams = coerceZodStringParams(validatedParams, tool.params)
    // A typo'd parameter would otherwise be silently stripped by `z.object` —
    // flag it instead of running the tool with the argument missing.
    assertKnownParams(
      `${appName}:${name}`,
      validatedParams,
      Object.keys((tool.params as { shape?: Record<string, unknown> }).shape ?? {}),
    )
    const parseResult = (tool.params as any).safeParse(validatedParams) as
      | { success: true; data: unknown }
      | { success: false; error: { issues?: Array<Record<string, unknown>> } }
    if (!parseResult.success) {
      throw new HTTPException(400, {
        message: formatZodParamError(`${appName}:${name}`, parseResult.error, validatedParams),
      })
    }
    validatedParams = parseResult.data
  } else if (
    tool.params &&
    typeof tool.params === "object" &&
    !("safeParse" in tool.params) &&
    !("type" in tool.params)
  ) {
    const fieldMap = tool.params as unknown as Record<string, string>
    const input = validatedParams as Record<string, unknown> | undefined
    if (!input || typeof input !== "object") {
      throw new HTTPException(400, { message: "Invalid parameters" })
    }
    for (const key of Object.keys(fieldMap)) {
      if (!(key in input)) {
        throw new HTTPException(400, { message: `Missing required parameter: ${key}` })
      }
    }
  }

  return validatedParams
}
