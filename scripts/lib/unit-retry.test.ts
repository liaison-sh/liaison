// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { formatPhaseSplit, planRetries } from "./unit-retry"

describe("planRetries", () => {
  test("a file that failed in a batch and again alone is not retried", () => {
    const plan = planRetries([{ file: "a.test.ts", exitCode: 1, batch: 1, aloneAfterBatch: true }])
    expect(plan.retry).toEqual([])
    expect(plan.reproducedAlone).toEqual(["a.test.ts"])
  })

  test("a solo file that failed once under concurrency gets the retry", () => {
    const plan = planRetries([{ file: "solo.test.ts", exitCode: 1, batch: 1 }])
    expect(plan.retry).toEqual(["solo.test.ts"])
    expect(plan.reproducedAlone).toEqual([])
  })

  test("a batch failure with no alone verdict (bail) gets the retry", () => {
    const plan = planRetries([{ file: "b.test.ts", exitCode: 1, batch: 8 }])
    expect(plan.retry).toEqual(["b.test.ts"])
  })

  test("passing files are in neither list, whatever path got them there", () => {
    const plan = planRetries([
      { file: "ok.test.ts", exitCode: 0, batch: 8 },
      { file: "bleed.test.ts", exitCode: 0, batch: 1, aloneAfterBatch: true },
    ])
    expect(plan).toEqual({ retry: [], reproducedAlone: [] })
  })
})

describe("formatPhaseSplit", () => {
  test("sums the phases and names each one that took time", () => {
    expect(
      formatPhaseSplit([
        { name: "main", ms: 790_100 },
        { name: "alone reruns", ms: 12_000 },
        { name: "retry", ms: 0 },
      ]),
    ).toBe("total 802.1s (main 790.1s, alone reruns 12.0s)")
  })
})
