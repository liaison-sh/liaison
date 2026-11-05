// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * Regular expressions an app manifest declares (tool parameter `pattern`,
 * settings `validation.pattern`, connection template variables, authorize
 * config params) run on the API host's event loop. A JavaScript regex cannot be
 * interrupted, so one backtracking-prone pattern met by a crafted value holds
 * every org on the process for as long as the match lasts.
 *
 * Every such pattern is compiled here, and only a pattern a static ReDoS check
 * (recheck) proves linear is compiled: an exponential or polynomial pattern, one
 * the check cannot settle in time, or one longer than {@link MAX_MANIFEST_PATTERN_LENGTH}
 * is refused. Verdicts are cached per pattern, so the check runs once per
 * pattern per process.
 */
import type { RegExpEngine } from "ajv/dist/types"
import { checkSync } from "recheck"

// recheck's default sync backend runs the check on a Worker while this thread
// sits in Atomics.wait with no deadline. Under Bun that Worker can deadlock in its
// own garbage collection (seen under load, four processes on four CPUs), and then
// the event loop never turns again: no request, no timer, no test timeout. The pure
// backend is the same checker in this thread, bounded by CHECK_TIMEOUT_MS.
process.env.RECHECK_SYNC_BACKEND = "pure"

export const MAX_MANIFEST_PATTERN_LENGTH = 512
/** Wall clock the check may take for one pattern before it is refused as unknown. */
const CHECK_TIMEOUT_MS = 2_000

export class UnsafeManifestPatternError extends Error {
  constructor(
    readonly pattern: string,
    reason: string,
  ) {
    super(`Unsafe pattern ${JSON.stringify(pattern.slice(0, 80))}: ${reason}`)
    this.name = "UnsafeManifestPatternError"
  }
}

const verdicts = new Map<string, string | null>()

function unsafeReason(pattern: string, flags: string): string | null {
  if (pattern.length > MAX_MANIFEST_PATTERN_LENGTH) {
    return `longer than ${MAX_MANIFEST_PATTERN_LENGTH} characters`
  }
  // Compile first: a syntax error is reported as such, not as a ReDoS verdict.
  new RegExp(pattern, flags)
  const key = `${flags}/${pattern}`
  const cached = verdicts.get(key)
  if (cached !== undefined) return cached
  let reason: string | null
  try {
    const r = checkSync(pattern, flags, { timeout: CHECK_TIMEOUT_MS })
    reason =
      r.status === "safe"
        ? null
        : r.status === "vulnerable"
          ? `can backtrack catastrophically (${r.complexity.type}${
              r.complexity.type === "polynomial" ? `, degree ${r.complexity.degree}` : ""
            }); rewrite it so no repeated part can match the same text in two ways`
          : "its matching time could not be proven linear"
  } catch {
    reason = "its matching time could not be proven linear"
  }
  verdicts.set(key, reason)
  return reason
}

/** Throws {@link UnsafeManifestPatternError} (or the RegExp SyntaxError) unless the pattern is safe. */
export function assertSafeManifestPattern(pattern: string, flags = ""): void {
  const reason = unsafeReason(pattern, flags)
  if (reason !== null) throw new UnsafeManifestPatternError(pattern, reason)
}

/** `new RegExp(pattern, flags)` for a manifest-declared pattern, refused when unsafe. */
export function manifestRegExp(pattern: string, flags = ""): RegExp {
  assertSafeManifestPattern(pattern, flags)
  return new RegExp(pattern, flags)
}

/**
 * Ajv's `code.regExp` engine: every `pattern` / `patternProperties` key of a
 * manifest JSON Schema is compiled through {@link manifestRegExp}, so an unsafe
 * one fails the schema compile instead of running.
 */
export const manifestAjvRegExp: RegExpEngine = Object.assign(
  (pattern: string, u: string) => manifestRegExp(pattern, u),
  { code: "new RegExp" },
)

/**
 * Every regex pattern a manifest declares, by where it sits, for refusal at
 * install time: JSON Schema `pattern` / `patternProperties` anywhere under
 * `tools`, settings field `validation.pattern`, `connections.*.templateVars.*.pattern`
 * and `connections.*.authorizeConfigParams.*.pattern`.
 */
export function collectManifestPatterns(manifest: unknown): { where: string; pattern: string }[] {
  const out: { where: string; pattern: string }[] = []
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v)
  const walkSchema = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      for (const [i, n] of node.entries()) walkSchema(n, `${where}[${i}]`)
      return
    }
    if (!isObj(node)) return
    if (typeof node.pattern === "string")
      out.push({ where: `${where}.pattern`, pattern: node.pattern })
    if (isObj(node.patternProperties)) {
      for (const k of Object.keys(node.patternProperties)) {
        out.push({ where: `${where}.patternProperties`, pattern: k })
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "object" && v !== null) walkSchema(v, `${where}.${k}`)
    }
  }
  if (!isObj(manifest)) return out
  if (isObj(manifest.tools)) walkSchema(manifest.tools, "tools")
  // Settings: any `validation.pattern` in the settings tree.
  if (isObj(manifest.settings)) walkSchema(manifest.settings, "settings")
  if (isObj(manifest.connections)) {
    for (const [name, c] of Object.entries(manifest.connections)) {
      if (!isObj(c)) continue
      for (const field of ["templateVars", "authorizeConfigParams"] as const) {
        const decls = c[field]
        if (!isObj(decls)) continue
        for (const [v, d] of Object.entries(decls)) {
          if (isObj(d) && typeof d.pattern === "string") {
            out.push({ where: `connections.${name}.${field}.${v}.pattern`, pattern: d.pattern })
          }
        }
      }
    }
  }
  return out
}

/** Refuses a manifest that declares an unsafe pattern anywhere it runs on the host. */
export function assertManifestPatternsSafe(manifest: unknown): void {
  for (const { where, pattern } of collectManifestPatterns(manifest)) {
    try {
      // Tool param patterns compile with Ajv's "u" flag; the others without flags.
      assertSafeManifestPattern(pattern, where.startsWith("tools") ? "u" : "")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new UnsafeManifestPatternError(pattern, `${where}: ${msg}`)
    }
  }
}
