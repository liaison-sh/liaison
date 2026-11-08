// SPDX-License-Identifier: FSL-1.1-ALv2
// test:gate's planner, pinned on a fixed map and fixed suite selections: which
// suites a change runs, narrowed to which files, and what it skips and why.

import { describe, expect, it } from "bun:test"
import {
  BROAD_SUITES,
  colocatedTests,
  GATE_LANES,
  gateMatrix,
  laneOrder,
  planGate,
  type SuiteInfo,
} from "./test-gate"

const MAP: Array<{ re: RegExp; suites: string[] }> = [
  { re: /^apps\/api\/src\/tests\/e2e\//, suites: ["e2e-parallel"] },
  { re: /^apps\/api\/src\/tests\//, suites: ["integration", "integration-extra"] },
  { re: /^apps\/api\/src\/modules\//, suites: ["unit", "integration"] },
  { re: /^scripts\/lib\//, suites: ["root"] },
]
const mapFor = (f: string) => MAP.find((m) => m.re.test(f))?.suites ?? null

const INFO: Record<string, SuiteInfo> = {
  unit: { cwd: "apps/api", selects: ["apps/api/src/modules", "apps/api/test-support"] },
  integration: { cwd: "apps/api", selects: ["apps/api/src/tests/contacts.test.ts"] },
  "integration-extra": { cwd: "apps/api", selects: ["apps/api/src/tests/mail-accounts.test.ts"] },
  "e2e-parallel": { cwd: "", selects: [] },
  root: { cwd: "", selects: ["scripts/lib/test-lock.test.ts"] },
}

const DIRS: Record<string, string[]> = {
  "apps/api/src/modules/foo": [
    "service.ts",
    "service.test.ts",
    "service.rls.test.ts",
    "service.soak.test.ts",
    "other.ts",
  ],
}
const listDir = (d: string) => DIRS[d] ?? []

const plan = (changed: string[]) => planGate(changed, INFO, listDir, mapFor)

describe("planGate", () => {
  it("runs a changed scenario on its own in e2e-parallel", () => {
    const p = plan(["apps/api/src/tests/e2e/healthz.scenario.test.ts"])
    expect(p.run).toEqual([
      {
        suite: "e2e-parallel",
        files: ["apps/api/src/tests/e2e/healthz.scenario.test.ts"],
        why: expect.any(Array),
      },
    ])
  })

  it("runs an e2e helper change as the whole e2e-parallel suite", () => {
    const p = plan(["apps/api/src/tests/e2e/helpers/run-cron.ts"])
    expect(p.run.map((r) => [r.suite, r.files])).toEqual([["e2e-parallel", []]])
  })

  it("narrows a unit source change to its co-located tests, and runs the rest whole", () => {
    const p = plan(["apps/api/src/modules/foo/service.ts"])
    const unit = p.run.find((r) => r.suite === "unit")
    expect(unit?.files).toEqual([
      "apps/api/src/modules/foo/service.rls.test.ts",
      "apps/api/src/modules/foo/service.test.ts",
    ])
    // The map also routes modules to integration, which cannot narrow a source file.
    expect(p.run.find((r) => r.suite === "integration")?.files).toEqual([])
  })

  it("runs a unit source change with no co-located test as the whole unit suite", () => {
    const p = plan(["apps/api/src/modules/foo/other.ts"])
    expect(p.run.find((r) => r.suite === "unit")?.files).toEqual([])
  })

  it("runs a changed test file only in the suite that lists it, and says why the others skip", () => {
    const p = plan(["apps/api/src/tests/contacts.test.ts"])
    expect(p.run.map((r) => [r.suite, r.files])).toEqual([
      ["integration", ["apps/api/src/tests/contacts.test.ts"]],
    ])
    expect(p.skipped).toEqual([
      { suite: "integration-extra", why: expect.stringContaining("other suites") },
    ])
  })

  it("ignores docs, and runs the BROAD set for a path the map does not know", () => {
    expect(plan(["docs/testing.md", "README.md"]).run).toEqual([])
    const p = plan(["some/new/thing.ts"])
    expect(p.broad).toEqual(["some/new/thing.ts"])
    expect(p.run.map((r) => r.suite).sort()).toEqual([...BROAD_SUITES].sort())
    for (const r of p.run) expect(r.files).toEqual([])
  })

  it("merges several changes into one plan per suite", () => {
    const p = plan([
      "apps/api/src/modules/foo/service.ts",
      "apps/api/src/modules/foo/service.test.ts",
      "scripts/lib/test-lock.ts",
    ])
    expect(p.run.map((r) => r.suite)).toEqual(["integration", "root", "unit"])
    expect(p.run.find((r) => r.suite === "unit")?.files).toEqual([
      "apps/api/src/modules/foo/service.rls.test.ts",
      "apps/api/src/modules/foo/service.test.ts",
    ])
    // A non-test change in the root suite's area runs the root suite whole.
    expect(p.run.find((r) => r.suite === "root")?.files).toEqual([])
  })
})

describe("colocatedTests", () => {
  it("finds <name>.test.ts and <name>.*.test.ts only, never a soak test", () => {
    expect(colocatedTests("apps/api/src/modules/foo/service.ts", listDir)).toEqual([
      "apps/api/src/modules/foo/service.rls.test.ts",
      "apps/api/src/modules/foo/service.test.ts",
    ])
    expect(colocatedTests("apps/api/src/modules/foo/other.ts", listDir)).toEqual([])
  })
})

describe("laneOrder", () => {
  it("runs the re-cloning suites last in the db lane, after the reusing ones", () => {
    const run = [
      "e2e-parallel",
      "playwright",
      "unit",
      "root",
      "integration",
      "web-unit",
      "security",
    ].map((suite) => ({ suite }))
    const { dbLane, light } = laneOrder(run)
    // e2e-parallel and playwright rename the namespace database aside while
    // they prepare; the light pool (root, web-unit) must be done by then.
    expect(dbLane.map((r) => r.suite)).toEqual([
      "unit",
      "integration",
      "security",
      "e2e-parallel",
      "playwright",
    ])
    expect(light.map((r) => r.suite)).toEqual(["root", "web-unit"])
  })
})

describe("gateMatrix", () => {
  it("shards each heavy lane the plan names, and only those", () => {
    const plan = planGate(
      ["apps/api/src/modules/foo/other.ts", "scripts/lib/x.ts"],
      INFO,
      listDir,
      mapFor,
    )
    const m = gateMatrix(plan, INFO)
    expect(m.filter((e) => e.suite === "integration").map((e) => `${e.shard}/${e.of}`)).toEqual(
      Array.from(
        { length: GATE_LANES.integration ?? 0 },
        (_, i) => `${i + 1}/${GATE_LANES.integration}`,
      ),
    )
    expect(m.every((e) => e.files.length === 0)).toBe(true)
    expect(new Set(m.map((e) => e.suite))).toEqual(new Set(["integration"]))
  })

  it("hands a narrowed lane its files, cwd-relative, with no more shards than files", () => {
    const plan = planGate(["apps/api/src/tests/contacts.test.ts"], INFO, listDir, mapFor)
    const m = gateMatrix(plan, INFO).filter((e) => e.suite === "integration")
    expect(m).toEqual([
      { suite: "integration", shard: 1, of: 1, files: ["src/tests/contacts.test.ts"] },
    ])
  })
})
