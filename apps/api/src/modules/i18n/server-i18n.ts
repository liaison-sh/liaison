// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Server-side translator (Phase 13, I6). Renders kernel-originated
 * user-facing copy (digest / notification emails) in the recipient's
 * language. Loads the SAME `packages/shared/src/i18n/locales/**` JSON
 * dictionaries the web `t()` consumes (imported via `@liaison/shared` —
 * one shared copy, no duplication) and applies the identical per-KEY
 * fallback to English plus `{{param}}` interpolation.
 */
import { dictionariesFor, type LocaleDict, type ShippedLocale } from "@liaison/shared"

type FlatDict = Record<string, string>

/** Flatten one namespace `{ a: { b: "x" } }` → `{ "ns.a.b": "x" }`. */
function buildFlat(ns: string, dict: LocaleDict | undefined): FlatDict {
  const out: FlatDict = {}
  const walk = (node: unknown, prefix: string) => {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, `${prefix}.${k}`)
      }
    } else if (typeof node === "string") {
      out[prefix] = node
    }
  }
  if (dict) walk(dict, ns)
  return out
}

// Flattened lazily, one namespace at a time on its first lookup: server code
// reads only a few namespaces, so most are never copied.
const flatByLocale = new Map<ShippedLocale, Map<string, FlatDict>>()

function flatFor(locale: ShippedLocale, ns: string): FlatDict {
  let byNs = flatByLocale.get(locale)
  if (!byNs) {
    byNs = new Map()
    flatByLocale.set(locale, byNs)
  }
  let f = byNs.get(ns)
  if (!f) {
    f = buildFlat(ns, dictionariesFor(locale)[ns])
    byNs.set(ns, f)
  }
  return f
}

export type ServerTParams = Record<string, string | number | boolean>

function interpolate(template: string, params: ServerTParams): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, name: string) => {
    const v = params[name]
    return v === undefined ? m : String(v)
  })
}

/**
 * Translate `key` for `locale`. Per-key fallback to English when the
 * active locale lacks the key; returns the key itself if missing
 * everywhere (mirrors the web translator's contract).
 */
export function serverT(locale: ShippedLocale, key: string, params?: ServerTParams): string {
  const dot = key.indexOf(".")
  if (dot < 0) return key
  const ns = key.slice(0, dot)
  const raw = flatFor(locale, ns)[key] ?? flatFor("en", ns)[key]
  if (raw === undefined) return key
  return params ? interpolate(raw, params) : raw
}
