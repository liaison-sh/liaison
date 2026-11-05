// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One classification for every seam that logs a failure: an expected outcome is a
// warn with a stable reason, a fault (a 500, 502, 504, an unclassified throw) an error.
import { describe, expect, it } from "bun:test"
import {
  classifyFailure,
  JobRetryLaterError,
  logFailure,
  sandboxCancelledError,
  UPSTREAM_CONNECTION_CLOSED,
} from "~/lib/failure-severity"

describe("classifyFailure", () => {
  it.each([
    [400, "invalid_request"],
    [413, "invalid_request"],
    [422, "invalid_request"],
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "not_found"],
    [410, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [501, "unsupported"],
    [503, "upstream_unavailable"],
  ] as const)("a %d is a warn, reason %s", (status, reason) => {
    expect(classifyFailure({ status })).toEqual({ level: "warn", reason })
  })

  it.each([500, 502, 504])("a %d is an error", (status) => {
    expect(classifyFailure({ status })).toEqual({ level: "error" })
  })

  it("an unknown throw is an error until proven otherwise", () => {
    expect(classifyFailure({ err: new Error("boom") })).toEqual({ level: "error" })
    expect(classifyFailure({})).toEqual({ level: "error" })
  })

  it("a caller that went away is a warn, whatever status it was answered with", () => {
    expect(classifyFailure({ status: 500, err: sandboxCancelledError() })).toEqual({
      level: "warn",
      reason: "caller_cancelled",
    })
    const abortedByCaller = new DOMException("aborted", "AbortError")
    Object.defineProperty(abortedByCaller, "cause", { value: sandboxCancelledError() })
    expect(classifyFailure({ err: abortedByCaller }).reason).toBe("caller_cancelled")
  })

  it("an abort that does not say why is not claimed as the caller's", () => {
    expect(classifyFailure({ err: new DOMException("aborted", "AbortError") })).toEqual({
      level: "warn",
      reason: "aborted",
    })
  })

  it("a timeout is labelled timeout, never caller_cancelled", () => {
    // What a fetch under AbortSignal.timeout() rejects with.
    expect(classifyFailure({ err: new DOMException("timed out", "TimeoutError") })).toEqual({
      level: "warn",
      reason: "timeout",
    })
    // An abort whose reason was a timeout.
    const abort = new DOMException("aborted", "AbortError")
    Object.defineProperty(abort, "cause", { value: new DOMException("t", "TimeoutError") })
    expect(classifyFailure({ err: abort }).reason).toBe("timeout")
    // A socket timeout wrapped by fetch.
    const wrapped = new TypeError("fetch failed", {
      cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    })
    expect(classifyFailure({ err: wrapped }).reason).toBe("timeout")
    // A fetch aborted with the reason "timeout" rejects with that string.
    expect(classifyFailure({ err: "timeout" }).reason).toBe("timeout")
    // Our own component's timeout (a Postgres statement timeout) is not one of these shapes.
    const pgTimeout = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    })
    expect(classifyFailure({ err: pgTimeout })).toEqual({ level: "error" })
  })

  it("a 503 because one of our own dependencies is down stays an error", () => {
    expect(classifyFailure({ status: 503, ownDependencyDown: true })).toEqual({ level: "error" })
    expect(classifyFailure({ status: 503 })).toEqual({
      level: "warn",
      reason: "upstream_unavailable",
    })
  })

  it("a guard that held the call, a dropped upstream, a job retrying later", () => {
    expect(classifyFailure({ status: 403, guardHeld: true }).reason).toBe("guard_held")
    expect(classifyFailure({ status: 503, code: UPSTREAM_CONNECTION_CLOSED }).reason).toBe(
      "upstream_unavailable",
    )
    expect(classifyFailure({ err: new JobRetryLaterError("held", "lock_held") }).reason).toBe(
      "retry_later",
    )
  })
})

describe("logFailure", () => {
  function logger() {
    const lines: Array<[string, Record<string, unknown>, string]> = []
    return {
      lines,
      log: {
        warn: (o: object, m: string) => lines.push(["warn", o as Record<string, unknown>, m]),
        error: (o: object, m: string) => lines.push(["error", o as Record<string, unknown>, m]),
      },
    }
  }

  it("writes an expected outcome at warn with its reason, a fault at error without one", () => {
    const { lines, log } = logger()
    logFailure(log, { status: 404 }, { toolName: "x" }, "failed")
    logFailure(log, { status: 500 }, { toolName: "x" }, "failed")
    expect(lines).toEqual([
      ["warn", { toolName: "x", reason: "not_found" }, "failed"],
      ["error", { toolName: "x" }, "failed"],
    ])
  })
})
