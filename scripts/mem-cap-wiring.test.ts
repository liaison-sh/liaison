// SPDX-License-Identifier: FSL-1.1-ALv2
// Source-level oracle for the memory cap wiring. The budget and the lock are
// only worth anything if every entry point actually applies them, and every one
// of these assertions was red before the wiring landed: the orchestrator took
// no lock, test-e2e-parallel.ts hardcoded 4 children, vitest set no
// maxWorkers, playwright defaulted to 2 on CI, and docker-compose.yml capped
// no service.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8")

describe("memory cap wiring", () => {
  for (const entry of [
    "scripts/test-run.ts",
    "scripts/strobe-runner.ts",
    "scripts/with-test-lock.ts",
  ]) {
    it(`${entry} takes the lock and computes the budget`, () => {
      const src = read(entry)
      expect(src).toContain("acquireTestLock")
      expect(src).toContain("computeMemBudget")
      expect(src).toContain("formatMemBudget")
      // Children must be told the lock is already held, or the composite flow
      // queues behind itself forever.
      expect(src).toContain("LIAISON_TEST_LOCK_HELD")
    })
  }

  // The plan was respected and the machine still OOM'd, because nothing watched
  // the run while it ran. Both suite entry points must arm the runtime guard.
  for (const entry of ["scripts/test-run.ts", "scripts/strobe-runner.ts"]) {
    it(`${entry} arms the runtime memory guard and prints its banner`, () => {
      const src = read(entry)
      // The call, not a mention: an earlier version of this oracle was satisfied
      // by the word appearing in a comment.
      expect(src).toContain("startMemGuard({")
      expect(src).toContain("console.log(formatMemGuard(")
      expect(src).toContain("memGuard?.stop()")
    })
  }

  it("test-run.ts points the guard report at the per-run log directory", () => {
    const src = read("scripts/test-run.ts")
    expect(src).toContain("memGuard?.setLogDir(runDir)")
  })

  it("test-run.ts injects the budget into both the suite child and the full flow children", () => {
    const src = read("scripts/test-run.ts")
    expect(src.match(/\.\.\.MEM_ENV/g)?.length).toBe(2)
  })

  it("test-e2e-parallel.ts reads TEST_E2E_WORKERS and hardcodes no worker count", () => {
    const src = read("scripts/test-e2e-parallel.ts")
    expect(src).toContain("TEST_E2E_WORKERS")
    expect(src).not.toContain("--workers=4")
  })

  it("test-run.ts passes no --workers flag to the e2e-parallel child", () => {
    expect(read("scripts/test-run.ts")).not.toContain('test-e2e-parallel.ts", "--workers')
  })

  it("vitest reads VITEST_MAX_WORKERS into maxWorkers and drops file parallelism at one", () => {
    const src = read("apps/web/vitest.config.ts")
    expect(src).toContain("VITEST_MAX_WORKERS")
    expect(src).toContain("maxWorkers")
    expect(src).toContain("fileParallelism: false")
  })

  it("playwright sizes its workers from the memory budget, an explicit PLAYWRIGHT_WORKERS winning", () => {
    const src = read("apps/web/playwright.config.ts")
    expect(src).toContain("computeMemBudget")
    // The explicit override first, so PLAYWRIGHT_WORKERS=1 still forces one.
    expect(src).toMatch(
      /workers:\s*Number\(process\.env\.PLAYWRIGHT_WORKERS\)\s*\|\|\s*computeMemBudget\([\s\S]*?\)\s*\.playwrightWorkers/,
    )
    // The budget is divided by the same slot count the runner uses.
    expect(src).toContain("LIAISON_TEST_SLOTS")
  })

  it("docker-compose caps every service a test run uses", () => {
    const src = read("docker-compose.yml")
    for (const limit of [
      "mem_limit: 1.5g",
      "mem_limit: 1g",
      "mem_limit: 768m",
      "mem_limit: 256m",
    ]) {
      expect(src).toContain(limit)
    }
    expect(src.match(/mem_limit:/g)?.length).toBe(4)
  })
})
