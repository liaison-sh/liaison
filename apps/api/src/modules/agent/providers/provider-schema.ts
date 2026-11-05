// SPDX-License-Identifier: FSL-1.1-ALv2
import { asSchema, jsonSchema, type Schema } from "ai"
import type { z } from "zod"

/**
 * Tool schemas reach a provider as JSON Schema, and not every provider speaks
 * the whole dialect. Gemini's `function_declarations` are a protobuf
 * projection: `Schema.items` is a SINGLE nested schema there, never a list. A
 * tuple (`z.tuple([...])`) converts to draft-07 as `items: [a, b]` — a list —
 * and Google rejects the entire request with
 * `Unknown name "items" ...: Proto field is not repeating, cannot start list`,
 * which kills the whole turn (finishReason "error") no matter which tool the
 * model actually wanted.
 *
 * So every tool schema is normalized ONCE, here, on the way to the provider:
 * a tuple becomes a homogeneous array (or an `anyOf` array when its positions
 * disagree), and an `items` that is not describing an array is dropped. The
 * Zod schema itself is untouched — validation still accepts exactly the same
 * inputs — and a schema that needs no rewrite is passed through as-is so tools
 * keep their Zod object (and its `.shape`) downstream.
 */

type JsonObject = Record<string, unknown>

const SCHEMA_MAP_KEYS = ["properties", "$defs", "definitions", "patternProperties"] as const
const SCHEMA_LIST_KEYS = ["anyOf", "oneOf", "allOf"] as const

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** One schema standing in for every position of a tuple. */
function collapseTuple(entries: unknown[]): unknown {
  const positions = entries.filter(isPlainObject)
  if (positions.length === 0) return {}
  const first = JSON.stringify(positions[0])
  if (positions.every((p) => JSON.stringify(p) === first)) return positions[0]
  return { anyOf: positions }
}

/**
 * Deep-normalizes a JSON Schema so no `items` is ever a list and no `items`
 * hangs off something that is not an array. Returns a new object; the input is
 * never mutated.
 */
export function sanitizeJsonSchemaForProviders(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeJsonSchemaForProviders)
  if (!isPlainObject(node)) return node

  const out: JsonObject = { ...node }

  // Tuple, in either dialect: draft-07 `items: [...]`, 2020-12 `prefixItems`.
  const tuple = Array.isArray(out.prefixItems)
    ? (out.prefixItems as unknown[])
    : Array.isArray(out.items)
      ? (out.items as unknown[])
      : undefined
  if (tuple) {
    const rest = Array.isArray(out.items)
      ? out.additionalItems
      : isPlainObject(out.items)
        ? out.items
        : undefined
    out.type = "array"
    delete out.prefixItems
    delete out.additionalItems
    const openEnded = isPlainObject(rest) || rest === true
    out.items = collapseTuple(isPlainObject(rest) ? [...tuple, rest] : tuple)
    if (!openEnded) {
      out.minItems = tuple.length
      out.maxItems = tuple.length
    }
  }

  // `items: true` / `items: false` (2020-12 closes a tuple with it) says
  // nothing a provider can use, and Gemini has no boolean schema there.
  if (typeof out.items === "boolean") delete out.items

  // An `items` on a non-array node is meaningless and Gemini rejects it.
  if ("items" in out && typeof out.type === "string" && out.type !== "array") delete out.items

  for (const key of SCHEMA_MAP_KEYS) {
    const map = out[key]
    if (isPlainObject(map)) {
      const next: JsonObject = {}
      for (const [name, value] of Object.entries(map)) {
        next[name] = sanitizeJsonSchemaForProviders(value)
      }
      out[key] = next
    }
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const list = out[key]
    if (Array.isArray(list)) out[key] = list.map(sanitizeJsonSchemaForProviders)
  }
  if (isPlainObject(out.items)) out.items = sanitizeJsonSchemaForProviders(out.items)
  if (isPlainObject(out.additionalProperties)) {
    out.additionalProperties = sanitizeJsonSchemaForProviders(out.additionalProperties)
  }
  if (isPlainObject(out.not)) out.not = sanitizeJsonSchemaForProviders(out.not)

  return out
}

/**
 * Every violation of the provider invariant in a projected JSON Schema:
 * `items` is a single schema, and only ever on a node describing an array.
 * Returned as human-readable paths so a failing catalog-wide assertion names
 * the offending tool and field instead of dumping a schema.
 */
export function findProviderSchemaViolations(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((value, i) => findProviderSchemaViolations(value, `${path}[${i}]`))
  }
  if (!isPlainObject(node)) return []
  const out: string[] = []
  if ("items" in node) {
    if (Array.isArray(node.items)) out.push(`${path}.items is a list`)
    if (typeof node.type === "string" && node.type !== "array") {
      out.push(`${path}.items on type "${node.type}"`)
    }
  }
  if (Array.isArray(node.prefixItems)) out.push(`${path}.prefixItems is a list`)
  for (const [key, value] of Object.entries(node)) {
    // Data keys, not schema positions: their contents are values, not schemas.
    if (key === "enum" || key === "const" || key === "required" || key === "examples") continue
    out.push(...findProviderSchemaViolations(value, `${path}.${key}`))
  }
  return out
}

/**
 * The provider-facing form of a tool's input schema. A schema whose JSON
 * projection is already provider-safe comes back UNCHANGED (still the Zod
 * object, so `.shape` and friends keep working); anything else comes back as
 * an AI SDK `Schema` carrying the normalized JSON projection plus the original
 * schema's validator, so nothing about what the tool accepts changes.
 */
export function toProviderSafeInputSchema(schema: z.ZodTypeAny): z.ZodTypeAny | Schema<unknown> {
  let projected: Schema<unknown>
  try {
    projected = asSchema(schema as never) as Schema<unknown>
  } catch {
    return schema
  }
  const sanitized = sanitizeJsonSchemaForProviders(projected.jsonSchema)
  if (JSON.stringify(sanitized) === JSON.stringify(projected.jsonSchema)) return schema
  return jsonSchema(sanitized as never, { validate: projected.validate })
}
