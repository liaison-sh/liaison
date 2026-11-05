// SPDX-License-Identifier: FSL-1.1-ALv2
// The guard that keeps a seed process from registering as a BullMQ worker.
//
// The failure it exists for: the demo seed script run inside the app
// container logged `"service":"jobs","worker":"app-kernel"` and
// "No handler registered for job: app-kernel:search-index-upsert … Job
// exhausted all retries" — the seed process had grabbed the search-index jobs
// it had just enqueued for its own tickets and knowledge documents, so those
// items never reached the search index.
//
// Two things must hold, and BOTH are asserted here because either one alone
// lets the bug back: the decision (which processes refuse workers) and the
// PLACEMENT (the guard has to be the first import, because ES imports hoist
// and the app graph creates the worker at module scope).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { NO_JOB_WORKERS_ENV, SEED_ENTRYPOINTS, shouldDisableJobWorkers } from "./no-job-workers"

const REPO = path.resolve(import.meta.dir, "../..")

describe("shouldDisableJobWorkers", () => {
  it("refuses workers for every seed entrypoint", () => {
    for (const entry of SEED_ENTRYPOINTS) {
      expect(shouldDisableJobWorkers(path.join(REPO, entry))).toBe(true)
    }
  })

  it("leaves the api entrypoint and the dev server alone", () => {
    expect(shouldDisableJobWorkers(path.join(REPO, "apps/api/src/index.ts"))).toBe(false)
    expect(shouldDisableJobWorkers(path.join(REPO, "scripts/dev.ts"))).toBe(false)
    // The API server imports the demo seed DYNAMICALLY on visitor signup; the
    // entry is the server, so the server keeps its own workers.
    expect(shouldDisableJobWorkers(path.join(REPO, "apps/api/src/index.ts"))).toBe(false)
  })

  it("honours the env escape hatch for any other one-shot script", () => {
    const other = path.join(REPO, "scripts/db-reset.ts")
    expect(shouldDisableJobWorkers(other)).toBe(false)
    expect(shouldDisableJobWorkers(other, { [NO_JOB_WORKERS_ENV]: "1" })).toBe(true)
  })

  it("does not match a lookalike path that merely contains the name", () => {
    expect(shouldDisableJobWorkers(path.join(REPO, "scripts/seed-qa.integration.test.ts"))).toBe(
      false,
    )
  })
})

describe("seed entrypoints arm the guard first", () => {
  for (const entry of SEED_ENTRYPOINTS) {
    it(`${entry} imports the guard as its FIRST import`, () => {
      const source = readFileSync(path.join(REPO, entry), "utf8")
      const imports = source.split("\n").filter((line) => line.startsWith("import "))
      expect(imports.length).toBeGreaterThan(0)
      expect(imports[0]).toMatch(/^import "\.[./]*\/?lib\/no-job-workers"$/)
    })
  }
})
