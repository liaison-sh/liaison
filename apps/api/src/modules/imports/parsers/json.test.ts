// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { collect, failure } from "./__test-helpers__/collect"
import { bytesOf, type ParserError } from "./common"
import { JSON_WHOLE_FILE_MAX_BYTES, parseJson } from "./json"

describe("parseJson", () => {
  it("a top-level array yields its elements", async () => {
    const rows = await collect(parseJson(bytesOf('[{"id":1},{"id":2}]')))
    expect(rows).toEqual([
      { number: 1, value: { id: 1 } },
      { number: 2, value: { id: 2 } },
    ])
  })

  it("a top-level object yields its arrays' elements by path and the rest as one record", async () => {
    const board = {
      name: "Launch board",
      prefs: { color: "blue" },
      lists: [{ id: "l1" }],
      cards: [{ id: "c1" }, { id: "c2" }],
    }
    const rows = await collect(parseJson(bytesOf(JSON.stringify(board))))
    expect(rows).toEqual([
      { number: 1, value: { name: "Launch board", prefs: { color: "blue" } }, path: "$" },
      { number: 2, value: { id: "l1" }, path: "lists" },
      { number: 3, value: { id: "c1" }, path: "cards" },
      { number: 4, value: { id: "c2" }, path: "cards" },
    ])
  })

  it("a file over 48 MB is refused with the JSON Lines advice", async () => {
    async function* big() {
      const chunk = new Uint8Array(1024 * 1024).fill(0x20)
      for (let i = 0; i <= JSON_WHOLE_FILE_MAX_BYTES / chunk.byteLength; i++) yield chunk
    }
    const err = await failure(parseJson(big(), { name: "export.json" }))
    expect((err as ParserError).code).toBe("json_too_large")
    expect(err.message).toContain("must be JSON Lines")
  })

  it("invalid JSON names the file", async () => {
    const err = await failure(parseJson(bytesOf("{nope"), { name: "export.json" }))
    expect((err as ParserError).code).toBe("invalid_json")
    expect(err.message).toContain("export.json is not valid JSON")
  })
})
