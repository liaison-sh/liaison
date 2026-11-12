// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { batchPreconditionFailure } from "./db-batch"

describe("batchPreconditionFailure", () => {
  it("reads the op, kind, entity and count of a guard failure", () => {
    const err = Object.assign(
      new Error(
        "ctx.db.batch: precondition_failed at ops[2] (update subscriptions): expected at least 1 row, matched 0",
      ),
      { code: "precondition_failed", status: 409 },
    )
    expect(batchPreconditionFailure(err)).toEqual({
      op: 2,
      kind: "update",
      entity: "subscriptions",
      matched: 0,
    })
  })

  it("is null for any other error", () => {
    expect(batchPreconditionFailure(new Error("boom"))).toBeNull()
    expect(batchPreconditionFailure("precondition_failed at ops[1]")).toBeNull()
    expect(
      batchPreconditionFailure(Object.assign(new Error("x"), { code: "precondition_failed" })),
    ).toBeNull()
  })
})
