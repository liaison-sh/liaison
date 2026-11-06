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
 * is refused.
 *
 * The check is slow and machine-bound: the same pattern took 70 ms on a laptop and
 * 5 s on a cold two-vCPU server, all of it on this thread. So a pattern the repo
 * itself ships carries its verdict: `manifest-regex-proven.json` lists each one,
 * exactly as it compiles (flags and text), and it is proven when the list is
 * generated and again in CI (`scripts/manifest-regex-proven.test.ts`). Whether a
 * shipped app loads never depends on this machine's speed, and booting runs no
 * check for it. Every other pattern (a third-party app's, a model's) is checked
 * here, once per process, and refused unless proven.
 */
import type { RegExpEngine } from "ajv/dist/types"
import { checkSync } from "recheck"
import proven from "./manifest-regex-proven.json"

// recheck's default sync backend runs the check on a Worker while this thread
// sits in Atomics.wait with no deadline. Under Bun that Worker can deadlock in its
// own garbage collection (seen under load, four processes on four CPUs), and then
// the event loop never turns again: no request, no timer, no test timeout. The pure
// backend is the same checker in this thread, bounded by CHECK_TIMEOUT_MS.
process.env.RECHECK_SYNC_BACKEND = "pure"

export const MAX_MANIFEST_PATTERN_LENGTH = 512

/**
 * The longest an app's unlisted pattern may hold this thread on its first compile
 * (install, or the first registration in a process). Past it the pattern is
 * refused, so a slow machine can only refuse more, never admit more.
 */
export const APP_PATTERN_CEILING_MS = 10_000

/**
 * The same ceiling for a schema a model writes during a run. That compile happens
 * while serving other orgs and the model chooses how many patterns it sends, so it
 * gets a fifth of an app's: such a schema may be refused where an app would not be.
 */
export const MODEL_PATTERN_CEILING_MS = 2_000

/**
 * recheck's per-stage wall clocks are off, so the stages stop on its step limits
 * and its seed is fixed: one pattern gets one verdict on every machine, and the
 * ceiling above is the only clock left.
 */
const STEP_LIMITS_ONLY = { attackTimeout: null, incubationTimeout: null, seedingTimeout: null }

const patternKey = (pattern: string, flags: string) => `${flags}/${pattern}`

const provenPatterns = new Set(
  proven.patterns.map(({ flags, pattern }) => patternKey(pattern, flags)),
)

export class UnsafeManifestPatternError extends Error {
  constructor(
    readonly pattern: string,
    reason: string,
  ) {
    super(`Unsafe pattern ${JSON.stringify(pattern.slice(0, 80))}: ${reason}`)
    this.name = "UnsafeManifestPatternError"
  }
}

function checkPattern(pattern: string, flags: string, ceilingMs: number | null): string | null {
  try {
    const r = checkSync(pattern, flags, { ...STEP_LIMITS_ONLY, timeout: ceilingMs })
    if (r.status === "safe") return null
    if (r.status === "vulnerable") {
      return `can backtrack catastrophically (${r.complexity.type}${
        r.complexity.type === "polynomial" ? `, degree ${r.complexity.degree}` : ""
      }); rewrite it so no repeated part can match the same text in two ways`
    }
    return "its matching time could not be proven linear"
  } catch {
    return "its matching time could not be proven linear"
  }
}

/**
 * The check with no ceiling: why the pattern is unsafe, or null when it is proven
 * linear. It can run for a long time, so it is for the proven list and its guard,
 * never for a process serving requests.
 */
export function provePatternUnbounded(pattern: string, flags: string): string | null {
  return checkPattern(pattern, flags, null)
}

const verdicts = new Map<string, string | null>()

function unsafeReason(pattern: string, flags: string, ceilingMs: number): string | null {
  if (pattern.length > MAX_MANIFEST_PATTERN_LENGTH) {
    return `longer than ${MAX_MANIFEST_PATTERN_LENGTH} characters`
  }
  // Compile first: a syntax error is reported as such, not as a ReDoS verdict.
  new RegExp(pattern, flags)
  const key = patternKey(pattern, flags)
  if (provenPatterns.has(key)) return null
  // By ceiling too: a refusal under a short one says nothing about a longer one.
  const verdictKey = `${ceilingMs}:${key}`
  const cached = verdicts.get(verdictKey)
  if (cached !== undefined) return cached
  const reason = checkPattern(pattern, flags, ceilingMs)
  verdicts.set(verdictKey, reason)
  return reason
}

/** Throws {@link UnsafeManifestPatternError} (or the RegExp SyntaxError) unless the pattern is safe. */
export function assertSafeManifestPattern(
  pattern: string,
  flags = "",
  ceilingMs = APP_PATTERN_CEILING_MS,
): void {
  const reason = unsafeReason(pattern, flags, ceilingMs)
  if (reason !== null) throw new UnsafeManifestPatternError(pattern, reason)
}

/** `new RegExp(pattern, flags)` for a manifest-declared pattern, refused when unsafe. */
export function manifestRegExp(
  pattern: string,
  flags = "",
  ceilingMs = APP_PATTERN_CEILING_MS,
): RegExp {
  assertSafeManifestPattern(pattern, flags, ceilingMs)
  return new RegExp(pattern, flags)
}

/**
 * A declared authorize param as it is matched: the WHOLE value, whatever the
 * pattern's own alternatives (`^a|.*$` must not match anything).
 */
export function wholeValueSource(pattern: string): string {
  return `^(?:${pattern})$`
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

/** {@link manifestAjvRegExp} for a schema a model writes: {@link MODEL_PATTERN_CEILING_MS}. */
export const modelSchemaAjvRegExp: RegExpEngine = Object.assign(
  (pattern: string, u: string) => manifestRegExp(pattern, u, MODEL_PATTERN_CEILING_MS),
  { code: "new RegExp" },
)

/**
 * Every regex pattern a manifest declares, by where it sits, for refusal at
 * install time, with the flags it compiles under: JSON Schema `pattern` /
 * `patternProperties` anywhere under `tools` and `import` (Ajv's "u"), settings
 * field `validation.pattern`, `connections.*.templateVars.*.pattern` and
 * `connections.*.authorizeConfigParams.*.pattern` (no flags).
 */
export function collectManifestPatterns(
  manifest: unknown,
): { where: string; pattern: string; flags: string }[] {
  const out: { where: string; pattern: string; flags: string }[] = []
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v)
  const walkSchema = (node: unknown, where: string, flags: string): void => {
    if (Array.isArray(node)) {
      for (const [i, n] of node.entries()) walkSchema(n, `${where}[${i}]`, flags)
      return
    }
    if (!isObj(node)) return
    if (typeof node.pattern === "string")
      out.push({ where: `${where}.pattern`, pattern: node.pattern, flags })
    if (isObj(node.patternProperties)) {
      for (const k of Object.keys(node.patternProperties)) {
        out.push({ where: `${where}.patternProperties`, pattern: k, flags })
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "object" && v !== null) walkSchema(v, `${where}.${k}`, flags)
    }
  }
  if (!isObj(manifest)) return out
  // Tool params and import kinds compile with Ajv, whose regExp engine gets "u".
  if (isObj(manifest.tools)) walkSchema(manifest.tools, "tools", "u")
  if (isObj(manifest.import)) walkSchema(manifest.import, "import", "u")
  // Settings: any `validation.pattern` in the settings tree.
  if (isObj(manifest.settings)) walkSchema(manifest.settings, "settings", "")
  if (isObj(manifest.connections)) {
    for (const [name, c] of Object.entries(manifest.connections)) {
      if (!isObj(c)) continue
      for (const field of ["templateVars", "authorizeConfigParams"] as const) {
        const decls = c[field]
        if (!isObj(decls)) continue
        for (const [v, d] of Object.entries(decls)) {
          if (isObj(d) && typeof d.pattern === "string") {
            out.push({
              where: `connections.${name}.${field}.${v}.pattern`,
              pattern: d.pattern,
              flags: "",
            })
          }
        }
      }
    }
  }
  return out
}

/** Refuses a manifest that declares an unsafe pattern anywhere it runs on the host. */
export function assertManifestPatternsSafe(manifest: unknown): void {
  for (const { where, pattern, flags } of collectManifestPatterns(manifest)) {
    try {
      assertSafeManifestPattern(pattern, flags)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new UnsafeManifestPatternError(pattern, `${where}: ${msg}`)
    }
  }
}
