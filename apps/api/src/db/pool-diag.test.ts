// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import {
  getPoolDiagState,
  getPoolGauges,
  PoolDiagTestAccess,
  poolSlot,
  recordAcquireTimeout,
  recordPoolAcquireTimeout,
  recordRlsTxEnd,
  recordRlsTxStart,
  recordStatementTimeout,
} from "~/db/pool-diag"

describe("pool-diag", () => {
  beforeEach(() => {
    PoolDiagTestAccess.reset()
  })

  it("starts at zero / null", () => {
    const state = getPoolDiagState()
    expect(state).toEqual({
      inFlight: 0,
      acquireTimeouts: 0,
      lastAcquireTimeoutAgoMs: null,
      statementTimeouts: 0,
      lastStatementTimeoutAgoMs: null,
    })
  })

  it("tracks inFlight across start/end pairs", () => {
    recordRlsTxStart()
    recordRlsTxStart()
    expect(getPoolDiagState().inFlight).toBe(2)
    recordRlsTxEnd()
    expect(getPoolDiagState().inFlight).toBe(1)
    recordRlsTxEnd()
    expect(getPoolDiagState().inFlight).toBe(0)
  })

  it("never goes negative on an unmatched end (floored at 0)", () => {
    recordRlsTxEnd()
    recordRlsTxEnd()
    expect(getPoolDiagState().inFlight).toBe(0)
  })

  it("counts acquire timeouts and reports recency", () => {
    const t0 = 1_000_000
    recordAcquireTimeout(t0)
    let state = getPoolDiagState(t0 + 500)
    expect(state.acquireTimeouts).toBe(1)
    expect(state.lastAcquireTimeoutAgoMs).toBe(500)

    recordAcquireTimeout(t0 + 1000)
    state = getPoolDiagState(t0 + 1500)
    expect(state.acquireTimeouts).toBe(2)
    expect(state.lastAcquireTimeoutAgoMs).toBe(500)
  })

  it("counts statement timeouts independently from acquire timeouts", () => {
    const t0 = 2_000_000
    recordStatementTimeout(t0)
    const state = getPoolDiagState(t0 + 250)
    expect(state.statementTimeouts).toBe(1)
    expect(state.lastStatementTimeoutAgoMs).toBe(250)
    expect(state.acquireTimeouts).toBe(0)
    expect(state.lastAcquireTimeoutAgoMs).toBeNull()
  })

  it("PoolDiagTestAccess.reset throws in production (no live test-only seam in prod)", () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      expect(() => PoolDiagTestAccess.reset()).toThrow()
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it("counts each pool's held, peak, waiting and acquire timeouts, with its planned max", () => {
    const a = poolSlot("jobs")
    const b = poolSlot("jobs")
    expect(getPoolGauges().jobs).toMatchObject({ held: 0, waiting: 2, peak: 0 })
    a.acquired()
    b.acquired()
    expect(getPoolGauges().jobs).toMatchObject({ held: 2, waiting: 0, peak: 2 })
    a.released()
    a.settled()
    b.released()
    expect(getPoolGauges().jobs).toMatchObject({ held: 0, waiting: 0, peak: 2 })
    // A transaction that never got a slot stops waiting when it settles.
    const lost = poolSlot("privileged")
    lost.settled()
    lost.acquired()
    expect(getPoolGauges().privileged).toMatchObject({ held: 0, waiting: 0 })
    recordPoolAcquireTimeout("privileged")
    expect(getPoolGauges().privileged.acquireTimeouts).toBe(1)
    expect(getPoolGauges().request.acquireTimeouts).toBe(0)
    for (const g of Object.values(getPoolGauges())) expect(g.max).toBeGreaterThan(0)
  })

  it("counts every transaction that got a slot since boot (a boot's database work, S19)", () => {
    expect(getPoolGauges().jobs.transactions).toBe(0)
    for (let i = 0; i < 3; i++) {
      const s = poolSlot("jobs")
      s.acquired()
      s.acquired()
      s.released()
    }
    const never = poolSlot("jobs")
    never.settled()
    expect(getPoolGauges().jobs.transactions).toBe(3)
    expect(getPoolGauges().request.transactions).toBe(0)
  })
})
