// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { hashParams } from "~/modules/apps/idempotency"
import { TurnEffectKeys, toolEffectKey } from "./tool-effect-key"

const TURN = "11111111-1111-4111-8111-111111111111"

describe("tool effect keys", () => {
  it("occurrence counts identical calls across complete steps and the current step; key order of args does not change the hash", () => {
    // Steps 1-2 (complete, journaled): two identical sends.
    const before = new TurnEffectKeys(TURN)
    expect(before.reserve("mail:send", { to: "a", body: "x" }).occurrence).toBe(1)
    expect(before.reserve("mail:send", { body: "x", to: "a" }).occurrence).toBe(2)
    expect(before.reserve("mail:send", { to: "b", body: "x" }).occurrence).toBe(1)
    const journaled = before.snapshot()

    // A resume seeded from the journal: the next identical call is the third.
    const resumed = new TurnEffectKeys(TURN, journaled)
    const third = resumed.reserve("mail:send", { body: "x", to: "a" })
    expect(third.occurrence).toBe(3)
    expect(third.key).toBe(toolEffectKey(TURN, "mail:send", hashParams({ to: "a", body: "x" }), 3))
  })

  it("a cut step's call is not in the journal, so its re-call gets the same key", () => {
    const keys = new TurnEffectKeys(TURN)
    keys.reserve("mail:send", { to: "a" })
    const journaled = keys.snapshot()
    const cut = keys.reserve("mail:send", { to: "a" }) // step 2, cut before onStepFinish

    const resumed = new TurnEffectKeys(TURN, journaled)
    expect(resumed.reserve("mail:send", { to: "a" }).key).toBe(cut.key)
  })

  it("a released occurrence is reused by the identical re-call (outcome unknown stays sticky)", () => {
    const keys = new TurnEffectKeys(TURN)
    const first = keys.reserve("mail:send", { to: "a" })
    first.release()
    expect(keys.reserve("mail:send", { to: "a" }).key).toBe(first.key)
    expect(keys.snapshot()).toEqual({ [`mail:send:${hashParams({ to: "a" })}`]: 1 })
  })
})
