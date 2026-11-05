// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import {
  exitWhenParentDies,
  ORPHAN_EXIT_ENV_VARS,
  orphanExitEnabled,
} from "~/lib/parent-death-watchdog"

describe("exitWhenParentDies", () => {
  const orig = { ...process.env }
  afterEach(() => {
    for (const name of ORPHAN_EXIT_ENV_VARS) {
      if (orig[name] === undefined) delete process.env[name]
      else process.env[name] = orig[name]
    }
  })

  function clearGates(): void {
    for (const name of ORPHAN_EXIT_ENV_VARS) delete process.env[name]
  }

  it("is a no-op with no gate set - a production process must never self-exit", () => {
    clearGates()
    expect(orphanExitEnabled()).toBe(false)
    const stop = exitWhenParentDies(10)
    expect(typeof stop).toBe("function")
    stop() // returns a no-op cleanup; clearing it must not throw
  })

  it("installs a watchdog under CHAOS_DEBUG=1 and returns a stop() that clears the timer", () => {
    clearGates()
    process.env.CHAOS_DEBUG = "1"
    const stop = exitWhenParentDies(60_000) // long interval - does not fire during the test
    expect(typeof stop).toBe("function")
    stop()
  })

  // The e2e worker env sets this one. Before it existed the gate was chaos-only,
  // so the e2e API server never armed a watchdog and an aborted run left it
  // running as an orphan for as long as the machine stayed up.
  it("installs a watchdog under LIAISON_EXIT_WHEN_ORPHANED=1", () => {
    clearGates()
    process.env.LIAISON_EXIT_WHEN_ORPHANED = "1"
    expect(orphanExitEnabled()).toBe(true)
    const stop = exitWhenParentDies(60_000)
    expect(typeof stop).toBe("function")
    stop()
  })

  it("treats any value other than exactly '1' as off", () => {
    clearGates()
    process.env.LIAISON_EXIT_WHEN_ORPHANED = "0"
    expect(orphanExitEnabled()).toBe(false)
    process.env.LIAISON_EXIT_WHEN_ORPHANED = "true"
    expect(orphanExitEnabled()).toBe(false)
  })
})
