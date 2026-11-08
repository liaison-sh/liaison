// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseShard, pickShard, pickShardByTime, shardBunTestCmd } from "./test-shard"

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

describe("pickShardByTime", () => {
  const seconds: Record<string, number> = {
    "a.ts": 560,
    "b.ts": 300,
    "c.ts": 200,
    "d.ts": 180,
    "e.ts": 90,
    "f.ts": 60,
    "g.ts": 30,
    "h.ts": 10,
  }
  const files = [...Object.keys(seconds), "new.ts"]
  const time = (s: string[]) => s.reduce((sum, f) => sum + (seconds[f] ?? 180), 0)

  it("covers every file once and balances measured time, not file count", () => {
    for (const total of [1, 2, 3, 6]) {
      const all = Array.from({ length: total }, (_, i) =>
        pickShardByTime(files, { index: i + 1, total }, seconds),
      )
      expect(all.flat().sort()).toEqual([...files].sort())
    }
    const two = [1, 2].map((index) => pickShardByTime(files, { index, total: 2 }, seconds))
    // new.ts counts as the median (180): 560 + 180 + 60 + 10 against 300 + 200 + 180 + 90 + 30.
    expect(two[0]).toContain("a.ts")
    expect(two[1]).toContain("b.ts")
    expect(Math.abs(time(two[0] as string[]) - time(two[1] as string[]))).toBeLessThanOrEqual(90)
  })

  it("with several workers a shard ends no sooner than its longest file", () => {
    // Four workers: a 560 s file alone ends at 560 whatever runs beside it, so
    // the short files go where they end soonest, the other shard.
    const two = [1, 2].map((index) =>
      pickShardByTime(["a.ts", "b.ts", "c.ts", "d.ts"], { index, total: 2 }, seconds, 4),
    )
    expect(two).toEqual([["a.ts"], ["b.ts", "c.ts", "d.ts"]])
  })

  it("is deterministic and keeps the given order", () => {
    const one = pickShardByTime(files, { index: 2, total: 3 }, seconds)
    expect(pickShardByTime(files, { index: 2, total: 3 }, seconds)).toEqual(one)
    expect([...one].sort((x, y) => files.indexOf(x) - files.indexOf(y))).toEqual(one)
  })

  it("counts a file the table does not know as the median", () => {
    const shards = [1, 2].map((index) =>
      pickShardByTime(["x.ts", "y.ts", "z.ts"], { index, total: 2 }, { "x.ts": 100 }),
    )
    // x (100) first, then y and z at the median (100): y to shard 2, z back to 1.
    expect(shards).toEqual([["x.ts", "z.ts"], ["y.ts"]])
  })
})
