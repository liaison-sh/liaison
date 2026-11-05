// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { warmLiveOrgsBeforeReady } from "./ready-warm"

/** A sleep that never ends unless the test says so. */
function manualSleep() {
  const pending: Array<() => void> = []
  return {
    sleep: () => new Promise<void>((resolve) => pending.push(resolve)),
    fire: () => {
      for (const wake of pending.splice(0)) wake()
    },
  }
}

describe("warming the orgs with live sockets before a process turns ready", () => {
  it("registers every org with a live socket before it resolves, one after the other", async () => {
    const order: string[] = []
    const result = await warmLiveOrgsBeforeReady({
      liveOrgIds: async () => ["org-a", "org-b", "org-c"],
      awaitOrg: async (orgId) => {
        order.push(`start ${orgId}`)
        await Bun.sleep(1)
        order.push(`done ${orgId}`)
      },
      budgetMs: 10_000,
    })
    expect(order).toEqual([
      "start org-a",
      "done org-a",
      "start org-b",
      "done org-b",
      "start org-c",
      "done org-c",
    ])
    expect(result).toMatchObject({ total: 3, warmed: 3, timedOut: false })
  })

  it("turns ready at the budget even when registrations are still running", async () => {
    const clock = manualSleep()
    let release: () => void = () => {}
    const warming = warmLiveOrgsBeforeReady({
      liveOrgIds: async () => ["org-a", "org-b"],
      awaitOrg: (orgId) =>
        orgId === "org-a" ? Promise.resolve() : new Promise<void>((r) => (release = r)),
      budgetMs: 30_000,
      sleep: clock.sleep,
    })
    await Bun.sleep(5)
    clock.fire()
    expect(await warming).toMatchObject({ total: 2, warmed: 1, timedOut: true })
    release()
  })

  it("an org that fails to register is skipped, the next one still warms", async () => {
    const warmed: string[] = []
    const result = await warmLiveOrgsBeforeReady({
      liveOrgIds: async () => ["broken", "org-b"],
      awaitOrg: async (orgId) => {
        if (orgId === "broken") throw new Error("registration failed")
        warmed.push(orgId)
      },
      budgetMs: 10_000,
    })
    expect(warmed).toEqual(["org-b"])
    expect(result).toMatchObject({ total: 2, warmed: 1, failed: 1, timedOut: false })
  })

  it("no live-socket answer (Redis down) warms nothing and never blocks readiness", async () => {
    const result = await warmLiveOrgsBeforeReady({
      liveOrgIds: async () => {
        throw new Error("redis down")
      },
      awaitOrg: async () => {
        throw new Error("never called")
      },
      budgetMs: 10_000,
    })
    expect(result).toMatchObject({ total: 0, warmed: 0, timedOut: false })
  })

  it("a zero budget skips the warm-up", async () => {
    let asked = false
    const result = await warmLiveOrgsBeforeReady({
      liveOrgIds: async () => {
        asked = true
        return ["org-a"]
      },
      awaitOrg: async () => {},
      budgetMs: 0,
    })
    expect(asked).toBe(false)
    expect(result).toMatchObject({ total: 0, warmed: 0 })
  })
})
