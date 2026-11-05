// SPDX-License-Identifier: FSL-1.1-ALv2
// File rules and the text parser of transform sources, without a database:
// the glob matcher stays linear on a pathological pattern, star runs collapse
// and are capped, and a text file is read only up to the record cap.
import { describe, expect, it } from "bun:test"
import {
  globMatcher,
  MAX_GLOB_STARS,
  planFiles,
  textRecords,
} from "~/modules/imports/transform-run"
import { RecordTooLargeError } from "~/modules/imports/transforms/batch"
import { TRANSFORM_RECORD_MAX_BYTES } from "~/modules/imports/transforms/bridge"
import { ImportError } from "~/modules/imports/types"

describe("glob matcher", () => {
  it("matches like a shell glob: * within a folder, ** across folders, ? one character", () => {
    const m = (g: string, s: string) => globMatcher(g)(s)
    expect(m("*.json", "users.json")).toBe(true)
    expect(m("*.json", "a/users.json")).toBe(false)
    expect(m("**/*.json", "users.json")).toBe(true)
    expect(m("**/*.json", "general/2024-01-02.json")).toBe(true)
    expect(m("**", "a/b/c")).toBe(true)
    expect(m("Tickets?.xml", "tickets0.xml")).toBe(true)
    expect(m("Tickets?.xml", "Tickets10.xml")).toBe(false)
    expect(m("notes/*.json", "notes/a.json")).toBe(true)
    expect(m("a+b(c).csv", "a+b(c).csv")).toBe(true)
  })

  it("stays fast on a pathological pattern (no backtracking)", () => {
    const pattern = `${"*a".repeat(MAX_GLOB_STARS - 1)}*b`
    const name = "a".repeat(4096)
    const started = performance.now()
    expect(globMatcher(pattern)(name)).toBe(false)
    expect(performance.now() - started).toBeLessThan(50)
  })

  it("collapses runs of stars and refuses too many", () => {
    expect(globMatcher("a*****b")("a/x/b")).toBe(true)
    expect(() => globMatcher("*a".repeat(MAX_GLOB_STARS + 1))).toThrow(ImportError)
  })

  it("plans files in rule order, each once", () => {
    const planned = planFiles(
      ["b.json", "users.json", "a.json", "skip.png"].map((name) => ({ name, item: name })),
      [{ match: "users.json" }, { match: "*.json" }],
    )
    expect(planned.map((p) => p.name)).toEqual(["users.json", "a.json", "b.json"])
  })
})

describe("text records", () => {
  it("reads a text file as one record", async () => {
    async function* src() {
      yield new TextEncoder().encode("hello ")
      yield new TextEncoder().encode("world")
    }
    const out = []
    for await (const r of textRecords(src(), "a.txt")) out.push(r)
    expect(out).toEqual([{ number: 1, value: { text: "hello world" } }])
  })

  it("stops reading past the record cap and fails with the record-cap error", async () => {
    let pulled = 0
    const chunk = new Uint8Array(64 * 1024).fill(97)
    async function* huge() {
      // 64 MB on offer; reading must stop just past 1 MB.
      for (let i = 0; i < 1024; i++) {
        pulled += chunk.byteLength
        yield chunk
      }
    }
    const err = await (async () => {
      for await (const _ of textRecords(huge(), "big.txt")) {
        // unreachable
      }
    })().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecordTooLargeError)
    expect(pulled).toBeLessThanOrEqual(TRANSFORM_RECORD_MAX_BYTES + 2 * chunk.byteLength)
  })
})
