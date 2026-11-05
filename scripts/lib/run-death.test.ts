// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A full run once looked like a 12 minute stall. It was not a stall: the runner
// had been killed by its own memory guard, and the suite child it had just
// spawned inherited the log file and kept writing to it, so the log looked alive
// while nothing was sequencing suites any more. Nothing in the log said the
// runner was dead, and a failing suite was suspected for hours.
//
// These tests pin the two rules that come out of it: a runner that dies says
// why, and a suite that merely FAILS never stops the run.
import { describe, expect, it } from "bun:test"
import path from "node:path"
import {
  formatDeathLine,
  installRunDeathLogging,
  RUN_DEATH_EXIT_CODE,
  shouldContinueFullRun,
} from "./run-death"

describe("formatDeathLine", () => {
  it("names the signal", () => {
    expect(formatDeathLine("test-run.ts full", { kind: "signal", signal: "SIGTERM" })).toContain(
      "received SIGTERM",
    )
  })

  it("names the memory guard", () => {
    const line = formatDeathLine("test-run.ts full", {
      kind: "memory-guard",
      detail: "trip reason available",
    })
    expect(line).toContain("stopped by the memory guard")
    expect(line).toContain("trip reason available")
  })

  it("carries the error message for an unhandled rejection", () => {
    const line = formatDeathLine("test-run.ts full", {
      kind: "unhandledRejection",
      error: new Error("redis gone"),
    })
    expect(line).toContain("unhandledRejection")
    expect(line).toContain("redis gone")
  })

  it("always says no further suite will start", () => {
    expect(formatDeathLine("r", { kind: "signal", signal: "SIGINT" })).toContain(
      "No further suite will start",
    )
  })
})

describe("installRunDeathLogging", () => {
  function fakeTarget() {
    const handlers = new Map<string, (...args: any[]) => void>()
    return {
      handlers,
      target: {
        on(event: string, handler: (...args: any[]) => void) {
          handlers.set(event, handler)
          return this
        },
      },
    }
  }

  it("logs the cause and kills the in flight child on an uncaught exception", () => {
    const { handlers, target } = fakeTarget()
    const lines: string[] = []
    let killed = 0
    const got: { code: number | null } = { code: null }
    installRunDeathLogging({
      label: "test-run.ts full",
      log: (m) => lines.push(m),
      killCurrentChild: () => killed++,
      exit: (code) => {
        got.code = code
      },
      target,
    })
    handlers.get("uncaughtException")?.(new Error("boom"))
    expect(lines.join("\n")).toContain("RUNNER DIED")
    expect(lines.join("\n")).toContain("boom")
    expect(killed).toBe(1)
    expect(got.code).toBe(RUN_DEATH_EXIT_CODE)
  })

  it("handles every way a runner dies", () => {
    const { handlers, target } = fakeTarget()
    installRunDeathLogging({ label: "r", log: () => {}, exit: () => {}, target })
    for (const event of [
      "uncaughtException",
      "unhandledRejection",
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
    ]) {
      expect(handlers.has(event)).toBe(true)
    }
  })

  it("reports once, so the first cause is the one in the log", () => {
    const { handlers, target } = fakeTarget()
    const lines: string[] = []
    installRunDeathLogging({
      label: "r",
      log: (m) => lines.push(m),
      exit: () => {},
      target,
    })
    handlers.get("SIGTERM")?.()
    handlers.get("uncaughtException")?.(new Error("second"))
    expect(lines.filter((l) => l.startsWith("RUNNER DIED")).length).toBe(1)
    expect(lines.join("\n")).toContain("SIGTERM")
  })
})

describe("shouldContinueFullRun", () => {
  it("keeps going after a suite FAILS: the summary is the point", () => {
    expect(shouldContinueFullRun({ code: 1, guardTripped: false })).toBe(true)
    expect(shouldContinueFullRun({ code: 137, guardTripped: false })).toBe(true)
  })

  it("stops only when the memory guard took the machine away", () => {
    expect(shouldContinueFullRun({ code: 0, guardTripped: true })).toBe(false)
  })
})

describe("test-run.ts wiring", () => {
  it("installs the death logging and checks the guard before the next suite", async () => {
    const src = await Bun.file(path.resolve(import.meta.dir, "../test-run.ts")).text()
    expect(src).toContain("installRunDeathLogging(")
    expect(src).toContain("if (guardTripped) break")
    expect(src).toContain("shouldContinueFullRun(")
    expect(src).toContain("onTrip:")
  })
})
