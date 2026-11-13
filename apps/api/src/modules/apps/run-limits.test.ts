// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-run limit table pins the budgets each site used before it existed,
// and keeps every env override working.
import { describe, expect, it } from "bun:test"
import {
  DEFAULT_BACKGROUND_QUEUE_MS,
  egressLimits,
  entryKindOf,
  RUN_ENTRY_KINDS,
  RUN_LANE_OF_KIND,
  resolveBackgroundQueueMs,
  resolveSandboxMemoryLimit,
  resolveToolTimeoutMs,
  resolveTransformCallBudgetMs,
  runLaneOf,
  runLimits,
  runQueueBoundMs,
  workersLoaderLimits,
} from "./run-limits"

const PROD = { NODE_ENV: "production" } as NodeJS.ProcessEnv
const DEV = { NODE_ENV: "development" } as NodeJS.ProcessEnv
const MiB = 1024 * 1024

describe("run limit table", () => {
  it("has a row for every entry kind with the shared CPU, subrequest and bridge-call caps", () => {
    for (const kind of RUN_ENTRY_KINDS) {
      const l = runLimits(kind, { env: PROD })
      expect(l.cpuMs).toBe(30_000)
      expect(l.subrequests).toBe(10_000)
      expect(l.bridgeCalls).toBe(10_000)
      expect(l.wallMs).toBeGreaterThan(0)
      expect(l.memoryBytes).toBe(32 * MiB)
    }
  })

  it("keeps the wall clocks the sites used", () => {
    const wall = (kind: (typeof RUN_ENTRY_KINDS)[number], declaredMs?: number) =>
      runLimits(kind, { env: PROD, declaredMs }).wallMs
    expect(wall("tool")).toBe(5_000)
    expect(wall("tool", 60_000)).toBe(60_000)
    expect(wall("tool", 600_000)).toBe(120_000)
    expect(wall("tool", 1_000)).toBe(5_000)
    expect(wall("webhook")).toBe(5_000)
    expect(wall("job")).toBe(60_000)
    expect(wall("job", 120_000)).toBe(120_000)
    expect(wall("event")).toBe(30_000)
    expect(wall("poll")).toBe(60_000)
    expect(wall("reconcile")).toBe(60_000)
    expect(wall("search")).toBe(5_000)
    expect(wall("search", 8_000)).toBe(8_000)
    expect(wall("export")).toBe(5_000)
    expect(wall("attention")).toBe(5_000)
    expect(wall("disconnect")).toBe(20_000)
    expect(wall("preview")).toBe(30_000)
    expect(wall("pdf-template")).toBe(30_000)
    expect(wall("summarizer")).toBe(5_000)
    expect(wall("import-transform")).toBe(30_000)
    expect(wall("knowledge-sync")).toBe(60_000)
    expect(wall("knowledge-sync", 90_000)).toBe(90_000)
    expect(runLimits("tool", { env: DEV }).wallMs).toBe(60_000)
  })

  it("honours the env overrides", () => {
    expect(runLimits("tool", { env: { ...DEV, LIAISON_SANDBOX_TIMEOUT_MS: "90000" } }).wallMs).toBe(
      90_000,
    )
    // Production ignores the default override.
    expect(
      runLimits("tool", { env: { ...PROD, LIAISON_SANDBOX_TIMEOUT_MS: "90000" } }).wallMs,
    ).toBe(5_000)
    expect(
      resolveToolTimeoutMs(100_000, { ...PROD, LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS: "45000" }),
    ).toBe(45_000)
    expect(resolveSandboxMemoryLimit({ SANDBOX_MEMORY_LIMIT_MB: "64" } as NodeJS.ProcessEnv)).toBe(
      64 * MiB,
    )
    // The transform pool's heap stays fixed.
    expect(
      runLimits("import-transform", {
        env: { ...PROD, SANDBOX_MEMORY_LIMIT_MB: "64" },
      }).memoryBytes,
    ).toBe(32 * MiB)
    expect(runLimits("tool", { env: { ...PROD, SANDBOX_MEMORY_LIMIT_MB: "64" } }).memoryBytes).toBe(
      64 * MiB,
    )
    expect(
      resolveTransformCallBudgetMs(undefined, {
        ...PROD,
        LIAISON_TRANSFORM_CALL_BUDGET_MS: "50000",
      }),
    ).toBe(50_000)
    expect(
      egressLimits({ LIAISON_SANDBOX_FETCH_TIMEOUT_MS: "15000" } as NodeJS.ProcessEnv)
        .fetchTimeoutMs,
    ).toBe(15_000)
    expect(
      egressLimits({ LIAISON_SANDBOX_FETCH_TIMEOUT_MS: "999999" } as NodeJS.ProcessEnv)
        .fetchTimeoutMs,
    ).toBe(120_000)
    expect(egressLimits({} as NodeJS.ProcessEnv).fetchTimeoutMs).toBe(10_000)
  })

  it("hands the Workers loader its part and reads a run's entry label", () => {
    expect(workersLoaderLimits(runLimits("job", { env: PROD }))).toEqual({
      cpuMs: 30_000,
      subRequests: 10_000,
    })
    expect(entryKindOf("job:sync")).toBe("job")
    expect(entryKindOf("webhook-verify:orders")).toBe("webhook-verify")
    expect(entryKindOf("knowledge-sync:notes")).toBe("knowledge-sync")
    expect(entryKindOf("handler:foo")).toBeNull()
    expect(entryKindOf("tool")).toBeNull()
  })
})

describe("runLaneOf", () => {
  it("puts every entry kind in a lane: interactive when someone waits, background otherwise", () => {
    for (const kind of RUN_ENTRY_KINDS) {
      expect(["interactive", "background"]).toContain(RUN_LANE_OF_KIND[kind])
    }
    expect(runLaneOf({})).toBe("interactive")
    expect(runLaneOf({ entry: "tool:orders_get" })).toBe("interactive")
    expect(runLaneOf({ entry: "attention:computeItems" })).toBe("interactive")
    expect(runLaneOf({ entry: "webhook-verify:verify" })).toBe("interactive")
    expect(runLaneOf({ entry: "handler:go" })).toBe("interactive")
    expect(runLaneOf({ entry: "job:sync" })).toBe("background")
    expect(runLaneOf({ entry: "event:onCreated" })).toBe("background")
    expect(runLaneOf({ entry: "webhook:onOrder" })).toBe("background")
    expect(runLaneOf({ entry: "tool:x", priority: "background" })).toBe("background")
    expect(runLaneOf({ entry: "job:sync", priority: "interactive" })).toBe("background")
  })
})

describe("runQueueBoundMs: a background run's own queue bound", () => {
  const env = {} as NodeJS.ProcessEnv
  it("jobs and knowledge syncs wait on their own clock, 10 minutes by default", () => {
    expect(DEFAULT_BACKGROUND_QUEUE_MS).toBe(600_000)
    expect(runQueueBoundMs({ entry: "job:sync", holdsTx: false }, env)).toBe(600_000)
    expect(runQueueBoundMs({ entry: "knowledge-sync:page", holdsTx: false }, env)).toBe(600_000)
  })

  it("every other run counts its wait in its wall clock", () => {
    // A held transaction, a nested run, interactive kinds, and the background
    // kinds a request or the event bus bounds.
    expect(runQueueBoundMs({ entry: "job:sync", holdsTx: true }, env)).toBeUndefined()
    expect(runQueueBoundMs({ entry: "job:sync", nested: true }, env)).toBeUndefined()
    for (const entry of ["tool:x", "webhook:x", "event:x", "poll:x", "import:x", "attention:x"]) {
      expect(runQueueBoundMs({ entry }, env)).toBeUndefined()
    }
    // A routine's background tool call: an agent still waits on it.
    expect(runQueueBoundMs({ entry: "tool:x", priority: "background" }, env)).toBeUndefined()
    expect(runQueueBoundMs({}, env)).toBeUndefined()
  })

  it("LIAISON_SANDBOX_BACKGROUND_QUEUE_MS sets it, between 1 s and 60 minutes", () => {
    const at = (v: string) => ({ LIAISON_SANDBOX_BACKGROUND_QUEUE_MS: v }) as NodeJS.ProcessEnv
    expect(resolveBackgroundQueueMs(at("120000"))).toBe(120_000)
    expect(resolveBackgroundQueueMs(at("5"))).toBe(1_000)
    expect(resolveBackgroundQueueMs(at("999999999"))).toBe(3_600_000)
    expect(resolveBackgroundQueueMs(at("nope"))).toBe(600_000)
    expect(runQueueBoundMs({ entry: "job:sync" }, at("90000"))).toBe(90_000)
  })
})
