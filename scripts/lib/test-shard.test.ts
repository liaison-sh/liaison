// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseShard, pickShard, shardBunTestCmd } from "./test-shard"

describe("parseShard", () => {
  it("reads i/n and refuses anything else", () => {
    expect(parseShard("2/4")).toEqual({ index: 2, total: 4 })
    expect(parseShard("0/4")).toBeNull()
    expect(parseShard("5/4")).toBeNull()
    expect(parseShard("1/0")).toBeNull()
    expect(parseShard("2")).toBeNull()
    expect(parseShard(undefined)).toBeNull()
  })
})

describe("pickShard", () => {
  const files = Array.from(
    { length: 23 },
    (_, i) => `src/tests/f${String(i).padStart(2, "0")}.test.ts`,
  )
  const order = [files[7], ...files.filter((f) => f !== files[7])] as string[]

  it("shards of a lane cover every file once", () => {
    for (const total of [1, 2, 4, 6, 30]) {
      const all = Array.from({ length: total }, (_, i) => pickShard(order, { index: i + 1, total }))
      expect(all.flat().sort()).toEqual([...files].sort())
      const sizes = all.map((s) => s.length)
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    }
  })

  it("keeps the suite's own order inside a shard", () => {
    const shard = pickShard(order, { index: 4, total: 4 })
    expect(shard[0]).toBe(files[7])
  })
})

describe("shardBunTestCmd", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-shard-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, "src/tests/security/deep"), { recursive: true })
  for (const f of ["a.test.ts", "b.test.ts", "deep/c.test.ts", "helper.ts"]) {
    writeFileSync(path.join(dir, "src/tests/security", f), "")
  }

  it("keeps flags and their values, expands directories, keeps missing files", () => {
    const cmd = [
      "bun",
      "test",
      "--timeout",
      "60000",
      "--bail=1",
      "-t",
      "name",
      "src/tests/security",
      "src/missing.test.ts",
    ]
    const parts = [1, 2].map((index) => shardBunTestCmd(cmd, dir, { index, total: 2 }).cmd)
    for (const p of parts) expect(p.slice(0, 7)).toEqual(cmd.slice(0, 7))
    expect(parts.flatMap((p) => p.slice(7)).sort()).toEqual([
      "src/missing.test.ts",
      "src/tests/security/a.test.ts",
      "src/tests/security/b.test.ts",
      "src/tests/security/deep/c.test.ts",
    ])
  })
})
