// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterEach, describe, expect, it } from "bun:test"
import {
  ApprovalDrainTestAccess,
  beginDraining,
  drainApprovalsForShutdown,
  enterApprovalExecution,
  inFlightApprovalIds,
  isDraining,
  leaveApprovalExecution,
  waitForApprovalDrain,
} from "~/modules/approvals/drain"

afterEach(() => {
  ApprovalDrainTestAccess.reset()
})

describe("approval drain registry", () => {
  it("starts not draining with nothing in flight", () => {
    expect(isDraining()).toBe(false)
    expect(inFlightApprovalIds()).toEqual([])
  })

  it("tracks and releases an execution window", () => {
    enterApprovalExecution("a")
    expect(inFlightApprovalIds()).toEqual(["a"])
    leaveApprovalExecution("a")
    expect(inFlightApprovalIds()).toEqual([])
  })

  it("releasing an id that was never entered is a no-op", () => {
    // `finally` blocks run on paths that may not have entered; this must not throw.
    expect(() => leaveApprovalExecution("never-entered")).not.toThrow()
  })

  it("deduplicates a repeated enter for the same approval", () => {
    enterApprovalExecution("a")
    enterApprovalExecution("a")
    expect(inFlightApprovalIds()).toEqual(["a"])
  })
})

describe("waitForApprovalDrain", () => {
  it("returns immediately when nothing is in flight", async () => {
    const r = await waitForApprovalDrain(5_000)
    expect(r.drained).toBe(true)
    expect(r.remaining).toEqual([])
  })

  it("waits until the last execution finishes, then reports drained", async () => {
    enterApprovalExecution("slow")
    setTimeout(() => leaveApprovalExecution("slow"), 120)
    const r = await waitForApprovalDrain(5_000, 20)
    expect(r.drained).toBe(true)
    expect(r.remaining).toEqual([])
  })

  it("gives up at the timeout and NAMES what is still in flight", async () => {
    // A hung handler must not block the exit path forever -- Docker would
    // SIGKILL anyway. The ids are the operator's only breadcrumb.
    enterApprovalExecution("stuck-1")
    enterApprovalExecution("stuck-2")
    const r = await waitForApprovalDrain(150, 20)
    expect(r.drained).toBe(false)
    expect(r.remaining.sort()).toEqual(["stuck-1", "stuck-2"])
  })
})

describe("drainApprovalsForShutdown", () => {
  it("sets the draining flag BEFORE waiting", async () => {
    // Ordering is the whole contract: waiting first would let a fresh claim
    // race into the window we just measured as empty.
    enterApprovalExecution("x")
    const p = drainApprovalsForShutdown(200)
    expect(isDraining()).toBe(true)
    leaveApprovalExecution("x")
    await p
  })

  it("refuses new work even when nothing was in flight", async () => {
    const r = await drainApprovalsForShutdown(100)
    expect(r.drained).toBe(true)
    expect(isDraining()).toBe(true)
  })

  it("reports the survivors when a handler never finishes", async () => {
    enterApprovalExecution("hung")
    const r = await drainApprovalsForShutdown(120)
    expect(r.drained).toBe(false)
    expect(r.remaining).toEqual(["hung"])
  })
})

describe("beginDraining", () => {
  it("is idempotent", () => {
    beginDraining()
    beginDraining()
    expect(isDraining()).toBe(true)
  })
})
