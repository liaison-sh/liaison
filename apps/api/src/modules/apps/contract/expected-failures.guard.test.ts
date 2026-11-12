// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contract's expected-failure list only shrinks. Every row must be in the
// frozen baseline (expected-failures.baseline.json, the list as it was first
// measured), and the baseline itself is pinned by its hash: a row added to
// either file turns this red. Fixing an entry means removing its row from
// expected-failures.json, never from the baseline.
//
// The same for the per-app count of trivial passes (trivial-passes.json,
// harness.ts): no app's count may rise above the frozen baseline's
// (trivial-passes.baseline.json, pinned by its hash), and an app the baseline
// does not name may not appear.
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  BASELINE_PATH,
  EXPECTED_FAILURES_PATH,
  keyOf,
  readFailures,
  readTrivialCounts,
  sortFailures,
  TRIVIAL_BASELINE_PATH,
  TRIVIAL_PASSES_PATH,
} from "./expected"

const BASELINE_SHA256 = "f4c942d6ace7f22544b9f47cf296fbf39d8e5ee2eff5dbbb2168f4429c16931c"
const TRIVIAL_BASELINE_SHA256 = "07b5f781fef1e1addf725ca6a2daaec9dfa938a1279fa37e8dde6cb7c997e980"
const REASONS = new Set(["module-state", "wait", "budget", "no-fixture", "missing-export", "load"])

describe("contract expected-failure list", () => {
  it("baseline is the frozen one", () => {
    const sha = createHash("sha256").update(readFileSync(BASELINE_PATH)).digest("hex")
    expect(sha).toBe(BASELINE_SHA256)
  })

  it("holds no row the baseline does not (the list may only shrink)", () => {
    const baseline = new Set(readFailures(BASELINE_PATH).map(keyOf))
    const added = readFailures(EXPECTED_FAILURES_PATH)
      .map(keyOf)
      .filter((k) => !baseline.has(k))
    expect(added).toEqual([])
  })

  it("is sorted, unique and well formed", () => {
    const rows = readFailures(EXPECTED_FAILURES_PATH)
    expect(rows).toEqual(sortFailures(rows))
    expect(new Set(rows.map(keyOf)).size).toBe(rows.length)
    for (const r of rows) {
      expect(REASONS.has(r.reason)).toBe(true)
      expect(r.entry).toMatch(/^[a-z-]+:.+/)
    }
  })
})

describe("contract trivial-pass counts", () => {
  it("baseline is the frozen one", () => {
    const sha = createHash("sha256").update(readFileSync(TRIVIAL_BASELINE_PATH)).digest("hex")
    expect(sha).toBe(TRIVIAL_BASELINE_SHA256)
  })

  it("no app's count rises above the baseline's (the counts may only shrink)", () => {
    const baseline = readTrivialCounts(TRIVIAL_BASELINE_PATH)
    const above = Object.entries(readTrivialCounts(TRIVIAL_PASSES_PATH))
      .filter(([app, n]) => n > (baseline[app] ?? 0))
      .map(([app, n]) => `${app}: ${n} > ${baseline[app] ?? 0}`)
    expect(above).toEqual([])
  })

  it("is well formed: positive integer counts, apps in name order", () => {
    const counts = readTrivialCounts(TRIVIAL_PASSES_PATH)
    const apps = Object.keys(counts)
    expect(apps).toEqual([...apps].sort())
    for (const n of Object.values(counts)) {
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThan(0)
    }
  })
})
