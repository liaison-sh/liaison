// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regexes the repo ships load by the verdict in manifest-regex-proven.json, never by
// a check on the server that boots them. This guard is what makes that list honest:
// it is exactly what ships, every entry proves safe today, and none is so costly to
// check that it would only pass on a fast machine.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { APP_PATTERN_CEILING_MS, provePatternUnbounded } from "../apps/api/src/lib/manifest-regex"
import { PROVEN_LIST_PATH, shippedManifestPatterns } from "./lib/shipped-manifest-patterns"

const REGENERATE = "bun run manifest-regex:prove"

const list = JSON.parse(readFileSync(PROVEN_LIST_PATH, "utf8")) as {
  patterns: { flags: string; pattern: string }[]
}
const shipped = shippedManifestPatterns()
const keyOf = (p: { flags: string; pattern: string }) => `${p.flags}/${p.pattern}`

/**
 * A check's wall clock says little about the runner that measures it, so the cost is
 * taken relative to a reference pattern on the same runner, and read at the speed of
 * the smallest server we run: two shared vCPUs, where this reference checks in about
 * 300 ms once warm and a first check in a process costs about 3 s more.
 */
const REFERENCE = { pattern: "^[0-9]{1,30}$", flags: "" }
const SMALL_SERVER_REFERENCE_MS = 300
/** Well under the whole ceiling, because a cold or busy server takes several times longer. */
const MAX_SHARE_OF_CEILING = 0.3

function fastestCheckMs(p: { pattern: string; flags: string }): number {
  let fastest = Number.POSITIVE_INFINITY
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    provePatternUnbounded(p.pattern, p.flags)
    fastest = Math.min(fastest, performance.now() - started)
  }
  return fastest
}

describe("the proven list of shipped manifest patterns", () => {
  test("lists exactly what the repo ships", () => {
    const listed = new Set(list.patterns.map(keyOf))
    const missing = shipped.filter((p) => !listed.has(keyOf(p)))
    expect(
      missing.map((p) => `${p.where}: ${JSON.stringify(p.pattern)}: run ${REGENERATE}`),
    ).toEqual([])
    const shippedKeys = new Set(shipped.map(keyOf))
    expect(
      list.patterns.filter((p) => !shippedKeys.has(keyOf(p))).map((p) => JSON.stringify(p)),
    ).toEqual([])
    // A walker that stopped finding patterns would satisfy both of the above.
    expect(shipped.length).toBeGreaterThan(5)
  })

  test("every listed pattern still proves linear", () => {
    const refused = list.patterns.flatMap((p) => {
      const reason = provePatternUnbounded(p.pattern, p.flags)
      return reason === null ? [] : [`${JSON.stringify(p.pattern)}: ${reason}`]
    })
    expect(refused).toEqual([])
  }, 120_000)

  test("no shipped pattern takes more than a small share of the ceiling on a small server", () => {
    // The first checks of a process are mostly the JIT warming up.
    for (const p of list.patterns) provePatternUnbounded(p.pattern, p.flags)
    const referenceMs = fastestCheckMs(REFERENCE)
    const limitMs = APP_PATTERN_CEILING_MS * MAX_SHARE_OF_CEILING
    const costs = list.patterns
      .map((p) => ({
        pattern: p.pattern,
        estimateMs: Math.round((fastestCheckMs(p) / referenceMs) * SMALL_SERVER_REFERENCE_MS),
      }))
      .sort((a, b) => b.estimateMs - a.estimateMs)
    expect(
      costs
        .filter((c) => c.estimateMs > limitMs)
        .map((c) => `${c.estimateMs} ms of ${limitMs}: ${JSON.stringify(c.pattern)}`),
    ).toEqual([])
  }, 180_000)
})
