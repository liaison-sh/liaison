// SPDX-License-Identifier: FSL-1.1-ALv2
//
// JSON Schema → Zod converter for inbound MCP tool inputSchemas.
//
// Scope: what MCP servers publish. An object root; string / number / integer /
// boolean / null / array / object children; required[]; enum and const;
// `nullable`; type arrays; anyOf / oneOf (a union of the branches) and allOf
// (their intersection); additionalProperties as a boolean or a schema.
//
// `$ref` resolves when it is LOCAL to the document ("#", "#/$defs/...",
// "#/definitions/...", any "#/..." JSON pointer), as draft-07 and 2020-12
// servers write it. A reference that re-enters itself (a recursive schema)
// converts to a permissive shape at the point it loops, so a cyclic schema
// never recurses forever. A remote reference (http..., a relative file) is
// never fetched: the schema is unconvertible, and the caller reports the tool
// as unavailable with the reason rather than registering a tool whose
// arguments it cannot validate.

import { z } from "zod"

export class UnconvertibleSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnconvertibleSchemaError"
  }
}

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!isRecord(schema)) {
    throw new UnconvertibleSchemaError("schema is not an object")
  }
  return convert(schema, { root: schema, depth: 0, refStack: [] })
}

const MAX_DEPTH = 32

type Schema = Record<string, unknown>

interface Ctx {
  /** The document local references resolve against. */
  root: Schema
  depth: number
  /** The references being expanded on the current path: re-entering one is a cycle. */
  refStack: string[]
}

function isRecord(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function child(ctx: Ctx): Ctx {
  return { ...ctx, depth: ctx.depth + 1 }
}

/** Resolve a local reference ("#" or "#/a/b") against the document, else throw. */
function resolveLocalRef(root: Schema, ref: string): Schema {
  if (ref !== "#" && !ref.startsWith("#/")) {
    throw new UnconvertibleSchemaError(`unsupported remote $ref: ${ref}`)
  }
  let node: unknown = root
  const tokens = ref === "#" ? [] : ref.slice(2).split("/")
  for (const raw of tokens) {
    // RFC 6901 escapes, after the URI-fragment percent-decoding.
    let token: string
    try {
      token = decodeURIComponent(raw)
    } catch {
      throw new UnconvertibleSchemaError(`unresolvable $ref: ${ref}`)
    }
    token = token.replace(/~1/g, "/").replace(/~0/g, "~")
    if (Array.isArray(node)) {
      node = /^\d+$/.test(token) ? node[Number(token)] : undefined
    } else if (isRecord(node) && Object.hasOwn(node, token)) {
      node = node[token]
    } else {
      node = undefined
    }
    if (node === undefined) break
  }
  if (!isRecord(node)) {
    throw new UnconvertibleSchemaError(`unresolvable $ref: ${ref}`)
  }
  return node
}

function convert(s: Schema, ctx: Ctx): z.ZodTypeAny {
  if (ctx.depth > MAX_DEPTH) {
    throw new UnconvertibleSchemaError("max schema depth exceeded")
  }
  const zod = convertBody(s, ctx)
  return s.nullable === true ? zod.nullable() : zod
}

function convertBody(s: Schema, ctx: Ctx): z.ZodTypeAny {
  if ("$ref" in s) {
    const ref = s.$ref
    if (typeof ref !== "string") throw new UnconvertibleSchemaError("$ref is not a string")
    // A reference already being expanded on this path: the schema is recursive.
    // Accept anything from here down instead of looping.
    if (ctx.refStack.includes(ref)) return z.any()
    const target = resolveLocalRef(ctx.root, ref)
    return convert(target, { ...child(ctx), refStack: [...ctx.refStack, ref] })
  }
  if ("allOf" in s || "anyOf" in s || "oneOf" in s) {
    // A root composition has no single object shape for the tool's parameters.
    if (ctx.depth === 0) {
      throw new UnconvertibleSchemaError("oneOf/anyOf/allOf at root unsupported")
    }
    return convertComposition(s, ctx)
  }
  if ("const" in s) return literalOf(s.const)
  const enumValues = s.enum
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    if (enumValues.every((v) => typeof v === "string")) {
      return z.enum(enumValues as [string, ...string[]])
    }
    return unionOf(enumValues.map(literalOf))
  }
  const t = s.type
  if (Array.isArray(t)) {
    // ["string", "null"]: each type with the node's other keywords.
    const types = t.filter((x): x is string => typeof x === "string")
    if (types.length === 0) return z.any()
    return unionOf(types.map((one) => convertTyped(s, one, ctx)))
  }
  return convertTyped(s, t, ctx)
}

function convertComposition(s: Schema, ctx: Ctx): z.ZodTypeAny {
  const { allOf, anyOf, oneOf, ...rest } = s
  const parts: z.ZodTypeAny[] = []
  // Keywords beside the composition (a `type`, `properties`) constrain it too.
  const hasOwnShape = "type" in rest || "properties" in rest || "enum" in rest || "const" in rest
  if (hasOwnShape) parts.push(convertBody(rest, child(ctx)))
  for (const [key, list] of [
    ["anyOf", anyOf],
    ["oneOf", oneOf],
  ] as const) {
    if (list === undefined) continue
    if (!Array.isArray(list) || list.length === 0 || !list.every(isRecord)) {
      throw new UnconvertibleSchemaError(`${key} is not a list of schemas`)
    }
    parts.push(unionOf(list.map((b) => convert(b, child(ctx)))))
  }
  if (allOf !== undefined) {
    if (!Array.isArray(allOf) || allOf.length === 0 || !allOf.every(isRecord)) {
      throw new UnconvertibleSchemaError("allOf is not a list of schemas")
    }
    for (const b of allOf) parts.push(convert(b, child(ctx)))
  }
  return parts.slice(1).reduce<z.ZodTypeAny>((acc, p) => z.intersection(acc, p), parts[0])
}

function literalOf(v: unknown): z.ZodTypeAny {
  if (v === null) return z.null()
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return z.literal(v)
  }
  // An object or array constant: no literal type; accept the value's kind.
  return z.any()
}

function unionOf(members: z.ZodTypeAny[]): z.ZodTypeAny {
  if (members.length === 1) return members[0]
  return z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
}

function convertTyped(s: Schema, t: unknown, ctx: Ctx): z.ZodTypeAny {
  if (t === "string") return z.string()
  if (t === "number" || t === "integer") return z.number()
  if (t === "boolean") return z.boolean()
  if (t === "null") return z.null()
  if (t === "array") {
    const items = s.items
    if (isRecord(items)) return z.array(convert(items, child(ctx)))
    return z.array(z.any())
  }
  if (t === "object" || t === undefined) {
    const props = isRecord(s.properties) ? s.properties : {}
    const required = new Set<string>(
      Array.isArray(s.required)
        ? (s.required as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
    )
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [key, sub] of Object.entries(props)) {
      if (!isRecord(sub)) {
        // `true` / `false` property schemas: anything, or nothing.
        shape[key] = sub === false ? z.never().optional() : z.any().optional()
        continue
      }
      let zod = convert(sub, child(ctx))
      if (!required.has(key)) zod = zod.optional()
      shape[key] = zod
    }
    const obj = z.object(shape)
    const extra = s.additionalProperties
    if (extra === true) return obj.passthrough()
    if (extra === false) return obj.strict()
    // A schema for every other key: a map such as { "<property>": "<value>" }.
    if (isRecord(extra)) return obj.catchall(convert(extra, child(ctx)))
    return obj
  }
  throw new UnconvertibleSchemaError(`unsupported type: ${String(t)}`)
}
