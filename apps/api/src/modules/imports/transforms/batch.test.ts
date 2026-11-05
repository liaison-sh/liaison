// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { batchRecords, type ParsedRecord, RecordTooLargeError, type TransformBatch } from "./batch"
import { TRANSFORM_RECORD_MAX_BYTES } from "./bridge"

async function* recs(list: ParsedRecord[]): AsyncGenerator<ParsedRecord> {
  for (const r of list) yield r
}

async function all(it: AsyncIterable<TransformBatch>): Promise<TransformBatch[]> {
  const out: TransformBatch[] = []
  for await (const b of it) out.push(b)
  return out
}

describe("batchRecords", () => {
  it("cuts at 200 records", async () => {
    const list = Array.from({ length: 450 }, (_, i) => ({ number: i + 1, value: { i } }))
    const batches = await all(batchRecords("a.jsonl", recs(list)))
    expect(batches.map((b) => b.records.length)).toEqual([200, 200, 50])
    expect(batches.map((b) => b.firstRecord)).toEqual([1, 201, 401])
  })

  it("cuts at 1 MB and keeps records whole", async () => {
    const big = "x".repeat(300 * 1024)
    const list = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, value: { big } }))
    const batches = await all(batchRecords("a.jsonl", recs(list)))
    expect(batches.map((b) => b.records.length)).toEqual([3, 3, 1])
    for (const b of batches) expect(b.bytes).toBeLessThanOrEqual(1024 * 1024)
  })

  it("a record of exactly 1 MB passes; one byte more fails with its number and size", async () => {
    const overhead = JSON.stringify({ s: "" }).length
    const exact = { s: "y".repeat(TRANSFORM_RECORD_MAX_BYTES - overhead) }
    expect(JSON.stringify(exact).length).toBe(TRANSFORM_RECORD_MAX_BYTES)
    const ok = await all(batchRecords("a.jsonl", recs([{ number: 1, value: exact }])))
    expect(ok).toHaveLength(1)

    const over = { s: "y".repeat(TRANSFORM_RECORD_MAX_BYTES - overhead + 1) }
    const err = await all(
      batchRecords(
        "a.jsonl",
        recs([
          { number: 1, value: { a: 1 } },
          { number: 2, value: over },
        ]),
      ),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecordTooLargeError)
    expect((err as Error).message).toBe(
      `Record 2 of a.jsonl is ${TRANSFORM_RECORD_MAX_BYTES + 1} bytes serialized; a record may be at most ${TRANSFORM_RECORD_MAX_BYTES} bytes (1 MB).`,
    )
  })

  it("starts a new batch when the path changes", async () => {
    const batches = await all(
      batchRecords(
        "board.json",
        recs([
          { number: 1, value: { id: 1 }, path: "lists" },
          { number: 2, value: { id: 2 }, path: "lists" },
          { number: 3, value: { id: 3 }, path: "cards" },
        ]),
      ),
    )
    expect(batches.map((b) => [b.path, b.records.length])).toEqual([
      ["lists", 2],
      ["cards", 1],
    ])
  })
})
