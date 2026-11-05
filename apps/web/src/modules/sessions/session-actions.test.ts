// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T06 (P2-D1): P2's cards and header render an action's control only once
// P3 registers it here; nothing is registered by default.
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerSessionActions, resetSessionActions, sessionActions } from "./session-actions"

afterEach(() => resetSessionActions())

describe("session actions registry", () => {
  it("no action registered by default", () => {
    const a = sessionActions()
    expect(a.stop).toBeUndefined()
    expect(a.decidePermission).toBeUndefined()
    expect(a.answerQuestion).toBeUndefined()
    expect(a.decidePlan).toBeUndefined()
    expect(a.fullOutput).toBeUndefined()
  })

  it("register then unregister", async () => {
    const stop = vi.fn(async () => {})
    const decidePlan = vi.fn(async () => {})
    const off1 = registerSessionActions({ stop })
    const off2 = registerSessionActions({ decidePlan })
    expect(sessionActions().stop).toBe(stop)
    expect(sessionActions().decidePlan).toBe(decidePlan)
    off1()
    expect(sessionActions().stop).toBeUndefined()
    expect(sessionActions().decidePlan).toBe(decidePlan)
    off2()
    expect(sessionActions().decidePlan).toBeUndefined()
  })
})
