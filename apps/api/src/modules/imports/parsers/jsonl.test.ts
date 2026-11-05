// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { collect, failure } from "./__test-helpers__/collect"
import { bytesOf, PARSER_RECORD_MAX_BYTES, type ParserError } from "./common"
import { parseJsonl } from "./jsonl"

describe("parseJsonl", () => {
  it("yields one record per line across chunk boundaries, skipping blank lines", async () => {
    const text = '{"id":1,"name":"Ada"}\n\n{"id":2,"name":"Grace"}\r\n{"id":3}'
    const rows = await collect(parseJsonl(bytesOf(text, 5)))
    expect(rows).toEqual([
      { number: 1, value: { id: 1, name: "Ada" } },
      { number: 2, value: { id: 2, name: "Grace" } },
      { number: 3, value: { id: 3 } },
    ])
  })

  it("an invalid line fails with its line number", async () => {
    const err = await failure(parseJsonl(bytesOf('{"a":1}\n{oops}\n'), { name: "events.jsonl" }))
    expect((err as ParserError).code).toBe("invalid_json")
    expect(err.message).toContain("Line 2 of events.jsonl")
  })

  it("a line over 1 MB fails before it is buffered whole", async () => {
    const big = JSON.stringify({ s: "q".repeat(PARSER_RECORD_MAX_BYTES + 100) })
    const err = await failure(parseJsonl(bytesOf(`{"a":1}\n${big}\n`), { name: "events.jsonl" }))
    expect((err as ParserError).code).toBe("record_too_large")
    expect(err.message).toContain("Line 2 of events.jsonl")
  })
})
