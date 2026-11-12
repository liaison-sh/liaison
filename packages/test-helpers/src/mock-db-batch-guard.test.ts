// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The in-memory `ctx.db.batch` keeps the bridge's `expect` guard: a guarded op
// outside its row count rejects with the bridge's precondition_failed error and
// undoes every write of the batch, the sequence included.
import { describe, expect, it } from "bun:test"
import { createMockDb } from "./mock-db"

describe("mock ctx.db.batch expect", () => {
  it("rolls back every op and the sequence when a guarded update matched nothing", async () => {
    const db = createMockDb({ seed: { subs: [{ id: "s1", status: "active" }] } })
    const spec = (id: string) => ({
      sequence: { key: "mrr" },
      ops: [
        { insert: "moves", data: { n: { $seq: "value" } } },
        { update: "subs", id, data: { status: "past_due" }, expect: { minRows: 1, maxRows: 1 } },
      ],
    })
    const err = (await db.batch(spec("missing")).catch((e) => e)) as Error & {
      code?: string
      status?: number
    }
    expect(err.code).toBe("precondition_failed")
    expect(err.status).toBe(409)
    expect(err.message).toBe(
      "ctx.db.batch: precondition_failed at ops[1] (update subs): expected exactly 1 row, matched 0",
    )
    expect(await db.findMany("moves", {})).toEqual([])
    const ok = await db.batch(spec("s1"))
    expect(ok.sequence).toEqual({ value: 1 })
    expect(((await db.findOne("subs", "s1")) as { status: string }).status).toBe("past_due")
  })

  it("guards delete and updateMany by the rows they matched", async () => {
    const db = createMockDb({
      seed: {
        subs: [
          { id: "a", plan: "x" },
          { id: "b", plan: "x" },
        ],
      },
    })
    await expect(
      db.batch({
        ops: [
          { updateMany: "subs", where: { plan: "x" }, data: { plan: "y" }, expect: { maxRows: 1 } },
        ],
      }),
    ).rejects.toThrow("ops[0] (updateMany subs): expected at most 1 row, matched 2")
    await expect(
      db.batch({ ops: [{ delete: "subs", id: "zzz", expect: { minRows: 1 } }] }),
    ).rejects.toThrow("ops[0] (delete subs): expected at least 1 row, matched 0")
    expect(((await db.findOne("subs", "a")) as { plan: string }).plan).toBe("x")
  })
})
