// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mergeTimings, readTimings, timingsHistoryPath } from "./unit-timings"

const dirs: string[] = []
const scratch = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "unit-timings-")))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("timingsHistoryPath", () => {
  test("a worktree and its main checkout share one file in the git common dir", () => {
    const repo = scratch()
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" })
    git("init", "-q")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x")
    git("worktree", "add", "-q", "wt")
    const expected = path.join(repo, ".git", "liaison-unit-timings.json")
    expect(timingsHistoryPath(repo)).toBe(expected)
    expect(timingsHistoryPath(path.join(repo, "wt"))).toBe(expected)
  })

  test("outside a git checkout it falls back to logs/", () => {
    const dir = scratch()
    expect(timingsHistoryPath(dir)).toBe(path.join(dir, "logs", "unit-timings.json"))
  })
})

describe("mergeTimings", () => {
  test("keeps the union, this run's value wins, and leaves no temp file", () => {
    const dir = scratch()
    const file = path.join(dir, "nested", "timings.json")
    mergeTimings(file, { "a.test.ts": 1_000, "b.test.ts": 2_000 })
    mergeTimings(file, { "b.test.ts": 5_000, "c.test.ts": 3_000 })
    expect(readTimings(file)).toEqual({
      "a.test.ts": 1_000,
      "b.test.ts": 5_000,
      "c.test.ts": 3_000,
    })
    expect(readdirSync(path.dirname(file))).toEqual(["timings.json"])
  })

  test("a missing or corrupt history reads as empty", () => {
    const dir = scratch()
    expect(readTimings(path.join(dir, "none.json"))).toEqual({})
    const bad = path.join(dir, "bad.json")
    writeFileSync(bad, "{not json")
    expect(readTimings(bad)).toEqual({})
    mergeTimings(bad, { "a.test.ts": 1 })
    expect(readTimings(bad)).toEqual({ "a.test.ts": 1 })
  })
})
