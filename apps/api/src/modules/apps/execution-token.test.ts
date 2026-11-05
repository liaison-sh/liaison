// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The observation seam for the execution-token mint. `arm` used to overwrite
// whatever was watching and its disarm nulled the slot unconditionally, so two
// armers in one process silently disabled each other: the outer one stopped
// receiving tokens the moment an inner one armed, and the inner one's disarm
// left the outer one dead. Two suites that both watch the mint then depend on
// which of them ran first, which is not a property a test may have.
import { afterEach, describe, expect, test } from "bun:test"
import {
  armExecutionTokenObserver,
  clearExecutionTokenObserver,
  mintExecutionToken,
} from "~/modules/apps/execution-token"

afterEach(() => {
  clearExecutionTokenObserver()
})

describe("execution token observation", () => {
  test("two nested armers each see every token, and neither disables the other", () => {
    const outer: string[] = []
    const inner: string[] = []
    const disarmOuter = armExecutionTokenObserver((t) => outer.push(t))
    const first = mintExecutionToken()

    const disarmInner = armExecutionTokenObserver((t) => inner.push(t))
    const second = mintExecutionToken()
    expect(outer).toEqual([first, second])
    expect(inner).toEqual([second])

    // The inner one goes away; the outer one is still watching.
    disarmInner()
    const third = mintExecutionToken()
    expect(inner).toEqual([second])
    expect(outer).toEqual([first, second, third])

    disarmOuter()
    mintExecutionToken()
    expect(outer).toEqual([first, second, third])
  })

  test("a disarm is idempotent and takes only its own armer down", () => {
    const seen: string[] = []
    const disarm = armExecutionTokenObserver((t) => seen.push(t))
    const other: string[] = []
    const disarmOther = armExecutionTokenObserver((t) => other.push(t))
    disarm()
    disarm()
    const token = mintExecutionToken()
    expect(seen).toEqual([])
    expect(other).toEqual([token])
    disarmOther()
  })

  test("every token is a fresh identity", () => {
    const seen: string[] = []
    const disarm = armExecutionTokenObserver((t) => seen.push(t))
    mintExecutionToken()
    mintExecutionToken()
    disarm()
    expect(seen.length).toBe(2)
    expect(new Set(seen).size).toBe(2)
  })

  test("arming is refused in production", () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      expect(() => armExecutionTokenObserver(() => {})).toThrow("cannot be armed in production")
    } finally {
      process.env.NODE_ENV = previous
    }
  })
})
