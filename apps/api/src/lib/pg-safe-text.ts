// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TEXT POSTGRES WILL STORE.
//
// Postgres refuses two things a JavaScript string can hold:
// - U+0000 (NUL), in `text` and in `jsonb` alike ("\u0000 cannot be converted
//   to text", 22P05);
// - a lone UTF-16 surrogate, in `jsonb` (JSON.stringify escapes it as
//   "\udXXX", which jsonb rejects as an invalid Unicode escape).
//
// Model output carries both now and then (a tool call whose argument is a
// bare "\u0000"), and one such character in a turn's metadata used to fail
// the whole reply write. Values that are written as they came from a model
// go through `pgSafe` first: NUL is dropped and a lone surrogate becomes
// U+FFFD, everything else is kept as it is.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function safeString(s: string): string {
  // The common case allocates nothing.
  if (!s.includes("\u0000") && s.isWellFormed()) return s
  return s.replaceAll("\u0000", "").replace(LONE_SURROGATE, "�")
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return safeString(value)
  if (typeof value !== "object" || value === null) return value
  // A cycle cannot be serialised anyway: it is left for the writer to refuse.
  if (seen.has(value)) return value
  if (Array.isArray(value)) {
    seen.add(value)
    let out: unknown[] | null = null
    for (let i = 0; i < value.length; i++) {
      const next = walk(value[i], seen)
      if (next !== value[i]) {
        out ??= value.slice()
        out[i] = next
      }
    }
    seen.delete(value)
    return out ?? value
  }
  // Dates, buffers and other class instances serialise through their own rules.
  if (!isPlainObject(value)) return value
  seen.add(value)
  let out: Record<string, unknown> | null = null
  for (const [key, child] of Object.entries(value)) {
    const safeKey = safeString(key)
    const next = walk(child, seen)
    if (next !== child || safeKey !== key) {
      out ??= { ...value }
      if (safeKey !== key) delete out[key]
      out[safeKey] = next
    }
  }
  seen.delete(value)
  return out ?? value
}

/**
 * `value` with every string in it (object keys included) made storable by
 * Postgres. Returns the same reference when nothing needed changing, and new
 * objects only along the paths that did: the input is never mutated.
 */
export function pgSafe(value: string): string
export function pgSafe<T>(value: T): T
export function pgSafe(value: unknown): unknown {
  return walk(value, new WeakSet())
}
