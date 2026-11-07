// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { BuildBusyError, createBuildGovernor } from "./governance"

const busy = (fn: () => unknown): BuildBusyError => {
  try {
    fn()
  } catch (err) {
    if (err instanceof BuildBusyError) return err
    throw err
  }
  throw new Error("expected build_busy")
}

describe("build governance", () => {
  test("one build at a time per org", () => {
    const g = createBuildGovernor()
    const release = g.acquire("org-a")
    const err = busy(() => g.acquire("org-a"))
    expect(err.code).toBe("build_busy")
    expect(err.status).toBe(429)
    expect(err.reason).toBe("org_build_running")
    release()
    g.acquire("org-a")()
  })

  test("at most 2 builds per process, all orgs together", () => {
    const g = createBuildGovernor()
    const a = g.acquire("org-a")
    g.acquire("org-b")
    expect(busy(() => g.acquire("org-c")).reason).toBe("server_busy")
    a()
    a() // a second release frees nothing more
    g.acquire("org-c")
    expect(busy(() => g.acquire("org-d")).reason).toBe("server_busy")
  })

  test("30 builds per org in a rolling hour", () => {
    let t = 1_000_000
    const g = createBuildGovernor({ now: () => t })
    for (let i = 0; i < 30; i++) {
      g.acquire("org-a")()
      t += 1000
    }
    const err = busy(() => g.acquire("org-a"))
    expect(err.reason).toBe("org_hourly_limit")
    expect(err.retryAfterSeconds).toBeGreaterThan(0)
    g.acquire("org-b")() // other orgs keep their own budget
    t += 60 * 60 * 1000 - 29_000
    g.acquire("org-a")() // the oldest build left the window
  })

  test("run releases the slot when the build throws", async () => {
    const g = createBuildGovernor()
    await expect(g.run("org-a", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    )
    expect(await g.run("org-a", async () => 7)).toBe(7)
  })
})
