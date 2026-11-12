// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Generate parity-complete `fr` namespace dictionaries from the canonical
 * `en` ones (Phase 13, Task 10b / I6). Preserves the exact key structure
 * (the i18n en/fr parity test requires identical key sets), translating
 * every leaf via the curated table in scripts/i18n-fr-table.ts, plus the
 * per-feature tables in scripts/i18n-fr/*.json (below).
 *
 * New French goes in a file of its own, `scripts/i18n-fr/<feature>.json`:
 *   { "text": { "<English>": "<French>" }, "key": { "<ns>.<key.path>": "<French>" } }
 * ("text" translates every leaf with that English value, "key" one leaf, like
 * FR and FR_BY_KEY). Two pull requests then add different files instead of
 * lines next to each other in one 8,000-line table. The same English (or key)
 * given two different French values across the tables is an error.
 *
 * Values that are pure `{{param}}` interpolations or code-ish tokens
 * (hex colours, ISO dates, single non-alphabetic atoms) are preserved
 * verbatim — they carry no translatable copy. Anything alphabetic that is
 * NOT in the table aborts with a hard error so no English leaks into `fr`.
 *
 * Run: bun run scripts/i18n-gen-fr.ts [--check]
 *   --check : exit non-zero if any en value lacks a French translation
 *             (CI gate; does not write files).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FR_BY_KEY as FR_BY_KEY_TABLE, FR as FR_TABLE } from "./i18n-fr-table"

const FEATURE_TABLES = join(import.meta.dir, "i18n-fr")

/** The legacy table merged with every `scripts/i18n-fr/*.json`; a clash is an error. */
function loadFrTables(dir: string = FEATURE_TABLES): {
  FR: Record<string, string>
  FR_BY_KEY: Record<string, string>
  clashes: string[]
} {
  const FR: Record<string, string> = { ...FR_TABLE }
  const FR_BY_KEY: Record<string, string> = { ...FR_BY_KEY_TABLE }
  const clashes: string[] = []
  const merge = (into: Record<string, string>, from: unknown, where: string) => {
    if (from === undefined) return
    if (!from || typeof from !== "object" || Array.isArray(from)) {
      clashes.push(`${where}: must be an object of strings`)
      return
    }
    for (const [en, fr] of Object.entries(from as Record<string, unknown>)) {
      if (typeof fr !== "string") clashes.push(`${where}: ${JSON.stringify(en)} is not a string`)
      else if (into[en] !== undefined && into[en] !== fr)
        clashes.push(
          `${where}: ${JSON.stringify(en)} already translated as ${JSON.stringify(into[en])}`,
        )
      else into[en] = fr
    }
  }
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : []
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>
    for (const k of Object.keys(parsed)) {
      if (k !== "text" && k !== "key") clashes.push(`scripts/i18n-fr/${file}: unknown key "${k}"`)
    }
    merge(FR, parsed.text, `scripts/i18n-fr/${file} text`)
    merge(FR_BY_KEY, parsed.key, `scripts/i18n-fr/${file} key`)
  }
  return { FR, FR_BY_KEY, clashes }
}

const { FR, FR_BY_KEY, clashes } = loadFrTables()
if (clashes.length > 0) {
  console.error("French tables that disagree:")
  for (const c of clashes) console.error(`  ${c}`)
  process.exit(1)
}

const LOCALES = `${import.meta.dir}/../packages/shared/src/i18n/locales`
const NS = ["kernel", "tickets", "mail", "projects", "contacts", "knowledge"]
const CHECK = process.argv.includes("--check")

// Keys intentionally English-only — must be ABSENT from `fr` so the i18n
// en/fr parity test (which allowlists exactly these) stays green.
const EN_ONLY = new Set<string>(["enonly.key"])

function pruneEnOnly(node: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (EN_ONLY.has(path)) continue
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const child = pruneEnOnly(v as Record<string, unknown>, path)
      if (Object.keys(child).length > 0) out[k] = child
    } else {
      out[k] = v
    }
  }
  return out
}

// Tokens that are not translatable copy (kept verbatim).
function isCodeToken(s: string): boolean {
  const t = s.trim()
  if (t === "") return true
  if (/^\{\{[^}]+\}\}$/.test(t)) return true // pure {{param}}
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return true // hex colour
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(t)) return true // ISO date prefix
  if (!/[A-Za-z]/.test(t)) return true // no letters at all
  if (/^trigger:[a-z]+$/.test(t)) return true // enum-ish token
  if (/^e\.g\., /.test(t)) return false // still translatable
  return false
}

// Translate a single leaf value; substitute params back if the source
// embeds them (the table strings keep the same {{param}} tokens).
function translate(value: string, ns: string, keyPath: string): string {
  const byKey = FR_BY_KEY[`${ns}.${keyPath}`]
  if (byKey !== undefined) return byKey
  if (isCodeToken(value)) return value
  const fr = FR[value]
  if (fr !== undefined) return fr
  // Code-ish tokens with letters we still pass through (header names,
  // provider strings like "e.g., Google" handled in table; anything left
  // is a real miss).
  if (/^e\.g\., /.test(value)) return value // e.g., Google / e.g., en-US
  missing.push(`${ns}.${keyPath} = ${JSON.stringify(value)}`)
  return value
}

const missing: string[] = []
const drifted: string[] = []

function deepTranslate(node: unknown, ns: string, path: string): unknown {
  if (typeof node === "string") return translate(node, ns, path)
  if (Array.isArray(node)) {
    return node.map((v, i) => deepTranslate(v, ns, `${path}[${i}]`))
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = deepTranslate(v, ns, path ? `${path}.${k}` : k)
    }
    return out
  }
  return node
}

for (const ns of NS) {
  const en = JSON.parse(readFileSync(`${LOCALES}/en/${ns}.json`, "utf8")) as Record<string, unknown>
  let fr = deepTranslate(en, ns, "") as Record<string, unknown>
  fr = pruneEnOnly(fr, "")
  const out = `${JSON.stringify(fr, null, 2)}\n`
  if (!CHECK) {
    writeFileSync(`${LOCALES}/fr/${ns}.json`, out)
  } else if (readFileSync(`${LOCALES}/fr/${ns}.json`, "utf8") !== out) {
    // A committed fr file that regenerating would change: hand-written
    // French missing from the tables would be overwritten on the next run
    // (2026-10-01: 2,424 such strings, and 106 context-specific ones that a
    // per-string table flattened). Record them in FR or FR_BY_KEY.
    drifted.push(ns)
  }
}

if (drifted.length > 0) {
  console.error(`\nfr files that regenerating would change: ${drifted.join(", ")}`)
  console.error(
    "Run `bun run i18n:fr` and review the diff, or record the French in scripts/i18n-fr-table.ts.",
  )
  process.exit(1)
}

if (missing.length > 0) {
  console.error(`\n${missing.length} English value(s) with no French translation:`)
  for (const m of missing) console.error(`  ${m}`)
  console.error("\nAdd them to scripts/i18n-fr-table.ts.")
  process.exit(1)
}

console.log(
  CHECK ? "All en values have French translations." : `Wrote fr dictionaries for: ${NS.join(", ")}`,
)
