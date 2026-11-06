// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The write-gap budget: the per-step table sums to the
// targets and ceilings of the move, a step past its ceiling rejects, a
// post-commit step is measured but never cut, and the object keys of a delta
// are found in its file rows (the org's own prefix only).
import { describe, expect, it } from "bun:test"
import { objectKeysOf } from "./agent-source"
import { BundleWriter } from "./bundle"
import {
  GAP_STEPS,
  gapTotals,
  StepCeilingExceeded,
  type StepTiming,
  underCeiling,
} from "./ceilings"

describe("write-gap ceilings", () => {
  it("sums to the 9.5 s target and 20 s ceiling", () => {
    expect(gapTotals()).toEqual({ targetMs: 9_500, ceilingMs: 20_000 })
    expect(GAP_STEPS.commit.ceilingMs).toBe(2_500)
  })

  it("a step past its ceiling rejects and is recorded over", async () => {
    const timings: StepTiming[] = []
    const err = await underCeiling("quiesce", () => Bun.sleep(200), timings, { scale: 0.01 }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(StepCeilingExceeded)
    expect((err as StepCeilingExceeded).step).toBe("quiesce")
    expect(timings[0]).toMatchObject({ step: "quiesce", over: true, ceilingMs: 20 })
  })

  it("an unenforced step runs to its end and is only flagged", async () => {
    const timings: StepTiming[] = []
    const v = await underCeiling(
      "unfreeze-acks",
      async () => {
        await Bun.sleep(50)
        return 7
      },
      timings,
      { scale: 0.01, enforce: false },
    )
    expect(v).toBe(7)
    expect(timings[0]?.over).toBe(true)
  })

  it("finds the delta's object keys in its rows, the org's prefix only", () => {
    const org = "11111111-1111-4111-8111-111111111111"
    const w = new BundleWriter()
    w.section("header", ["{}"])
    w.section("rows:kernel.files", [
      JSON.stringify({
        id: "a",
        storage_key: `orgs/${org}/f/a.png`,
        thumbnail_key: `orgs/${org}/t/a.png`,
      }),
      JSON.stringify({ id: "b", storage_key: "orgs/22222222-2222-4222-8222-222222222222/f/b.png" }),
    ])
    w.section("deletes:kernel.files", [JSON.stringify([`orgs/${org}/f/gone.png`])])
    const lines = w.finish({})
    expect(objectKeysOf(lines, org).sort()).toEqual([`orgs/${org}/f/a.png`, `orgs/${org}/t/a.png`])
  })
})
