// SPDX-License-Identifier: FSL-1.1-ALv2
//
// RFC 8785 JSON Canonicalization Scheme (JCS): object members sorted by their
// names' UTF-16 code units, no whitespace, strings and numbers serialized as
// ECMAScript's JSON.stringify does (RFC 8785 section 3.2.2 adopts exactly that
// serialization), UTF-8 bytes. Input outside I-JSON (RFC 7493) is refused:
// non-finite numbers, lone surrogates, and anything that is not a JSON value.

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CanonicalJsonError"
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function serializeString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new CanonicalJsonError("string holds a lone surrogate")
  return JSON.stringify(s)
}

function serialize(value: unknown, depth: number): string {
  if (depth > 64) throw new CanonicalJsonError("value is nested too deeply")
  if (value === null) return "null"
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("number is not finite")
      // ECMAScript Number serialization; -0 serializes as 0.
      return JSON.stringify(value)
    case "string":
      return serializeString(value)
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => serialize(v, depth + 1)).join(",")}]`
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError("only plain objects, arrays and JSON scalars are accepted")
      }
      const record = value as Record<string, unknown>
      // Default sort compares UTF-16 code units, which is what RFC 8785 asks.
      const keys = Object.keys(record).sort()
      const members: string[] = []
      for (const key of keys) {
        const v = record[key]
        if (v === undefined) throw new CanonicalJsonError(`member "${key}" is undefined`)
        members.push(`${serializeString(key)}:${serialize(v, depth + 1)}`)
      }
      return `{${members.join(",")}}`
    }
    default:
      throw new CanonicalJsonError(`a ${typeof value} is not a JSON value`)
  }
}

/** The canonical text of a JSON value. */
export function canonicalJson(value: unknown): string {
  return serialize(value, 0)
}

/** The canonical UTF-8 bytes of a JSON value: what every hash of this module is taken over. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}
