// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where a run's console lines go: the process log (per-process cap, 512-byte
// lines) for every app, the app logs (source "console") for a run with a log
// sink, never a shared line under one run's tags.

import { afterEach, describe, expect, it } from "bun:test"
import { attachRunLogSink, type RunLogSink } from "~/modules/app-builder/logs"
import {
  cutConsoleLine,
  deliverRunLogs,
  PROCESS_CONSOLE_LINE_MAX_BYTES,
  parseWorkerLogs,
  WorkerLogsTestAccess,
  writeConsoleToProcessLog,
} from "./worker-logs"

function fakeSink(): RunLogSink & { got: Array<[string, unknown, unknown]> } {
  const got: Array<[string, unknown, unknown]> = []
  return {
    runId: "00000000-0000-4000-8000-000000000099",
    got,
    append(level, message, fields) {
      got.push([level, message, fields])
    },
    lines: () => [],
    dropped: () => 0,
    flush: async () => {},
  }
}

afterEach(() => WorkerLogsTestAccess.resetProcessCap())

describe("parseWorkerLogs", () => {
  it("keeps well-formed lines, skips the rest, defaults the level", () => {
    expect(
      parseWorkerLogs([
        { level: "warn", msg: "a", at: 5 },
        { level: "loud", msg: "b", at: 6, shared: true },
        { msg: 7 },
        null,
      ]),
    ).toEqual([
      { level: "warn", msg: "a", at: 5 },
      { level: "info", msg: "b", at: 6, shared: true },
    ])
    expect(parseWorkerLogs("nope")).toEqual([])
  })
})

describe("process log", () => {
  it("cuts a line at 512 bytes, on a character boundary", () => {
    const cut = cutConsoleLine("é".repeat(1000))
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(PROCESS_CONSOLE_LINE_MAX_BYTES)
    expect(cut.endsWith("…")).toBe(true)
    expect(cut).not.toContain("\uFFFD")
    expect(cutConsoleLine("short")).toBe("short")
  })

  it("past the per-minute cap, lines are counted and dropped", () => {
    let now = 0
    WorkerLogsTestAccess.resetProcessCap(3, () => now)
    for (let i = 0; i < 5; i++) {
      writeConsoleToProcessLog({ app: "a", orgId: "o", executor: "workers" }, "info", `l${i}`)
    }
    expect(WorkerLogsTestAccess.droppedInWindow()).toBe(2)
    now = 60_000
    writeConsoleToProcessLog({ app: "a", orgId: "o", executor: "workers" }, "info", "next")
    expect(WorkerLogsTestAccess.droppedInWindow()).toBe(0)
  })
})

describe("deliverRunLogs", () => {
  it("files attributable lines in the run's app logs as console lines; shared ones are left out", () => {
    const bridge = {}
    const sink = fakeSink()
    attachRunLogSink(bridge, sink)
    deliverRunLogs({
      bridge,
      app: "custom-x",
      orgId: "o",
      runId: "i:r",
      logs: [
        { level: "info", msg: "mine", at: 0 },
        { level: "warn", msg: "someone's", at: 1, shared: true },
      ],
      dropped: 3,
    })
    expect(sink.got.map(([lvl, msg, f]) => [lvl, msg, (f as { source: string }).source])).toEqual([
      ["info", "mine", "console"],
      ["warn", expect.stringContaining("1 console line(s)"), "console"],
      ["warn", expect.stringContaining("3 console line(s) past the per-run cap"), "console"],
    ])
  })

  it("an app without a sink writes the process log only", () => {
    WorkerLogsTestAccess.resetProcessCap(1, () => 0)
    deliverRunLogs({
      bridge: {},
      app: "shopify",
      orgId: "o",
      logs: [
        { level: "info", msg: "a", at: 0 },
        { level: "info", msg: "b", at: 0 },
      ],
    })
    expect(WorkerLogsTestAccess.droppedInWindow()).toBe(1)
  })

  it("without a bound sink, lines go through the bridge's own log methods as console lines", () => {
    const got: Array<[string, string, unknown]> = []
    const bridge = {
      log_info: (msg: string, data: string) => got.push(["info", msg, JSON.parse(data)]),
      log_warn: (msg: string, data: string) => got.push(["warn", msg, JSON.parse(data)]),
    }
    deliverRunLogs({
      bridge,
      app: "custom-y",
      orgId: "o",
      logs: [
        { level: "info", msg: "mine", at: 0 },
        { level: "info", msg: "overlapping", at: 0, shared: true },
      ],
    })
    expect(got.map(([l, m, d]) => [l, m, (d as { source: string }).source])).toEqual([
      ["info", "mine", "console"],
      ["warn", expect.stringContaining("1 console line(s)"), "console"],
    ])
  })
})
