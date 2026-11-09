// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { getRecentLogs, log } from "~/lib/logger"

describe("logger", () => {
  it("does not throw when logging at each level", () => {
    expect(() => log.info("test message")).not.toThrow()
    expect(() => log.warn("warning")).not.toThrow()
    expect(() => log.error("error")).not.toThrow()
    expect(() => log.debug("debug")).not.toThrow()
  })

  it("child logger inherits parent level", () => {
    const child = log.child({ component: "Test" })
    expect(() => child.info("from child")).not.toThrow()
  })

  it("captures logged lines into the recent-logs ring buffer", () => {
    log.info({ detail: 42 }, "ring buffer probe")
    const lines = getRecentLogs()
    const hit = lines.find((l) => l.includes("ring buffer probe"))
    expect(hit).toBeTruthy()
    expect(hit).toContain("[info]")
    expect(hit).toContain('{"detail":42}')
  })

  it("cuts a long line to at most 2000 characters, the ellipsis included (the server's cap)", () => {
    log.info(`long line probe ${"x".repeat(5_000)}`)
    const hit = getRecentLogs().find((l) => l.includes("long line probe"))
    expect(hit?.length).toBeLessThanOrEqual(2_000)
    expect(hit?.endsWith("…")).toBe(true)
  })

  it("captures window error events into the buffer", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "boom from window" }))
    expect(getRecentLogs().some((l) => l.includes("boom from window"))).toBe(true)
  })
})
