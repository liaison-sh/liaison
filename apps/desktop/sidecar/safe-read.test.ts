// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readRegularFileNoFollow } from "./safe-read"
import { planText } from "./unattended"

const root = mkdtempSync(path.join(tmpdir(), "safe-read-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("readRegularFileNoFollow", () => {
  it("reads a regular file within the limit", () => {
    const file = path.join(root, "a.txt")
    writeFileSync(file, "héllo")
    expect(readRegularFileNoFollow(file, 100)).toBe("héllo")
  })

  it("refuses a symlink, even one to a readable regular file", () => {
    const target = path.join(root, "target.txt")
    writeFileSync(target, "secret")
    const link = path.join(root, "link.txt")
    symlinkSync(target, link)
    expect(readRegularFileNoFollow(link, 100)).toBeNull()
  })

  it("refuses a directory, a missing file and a FIFO without blocking", () => {
    const dir = path.join(root, "d")
    mkdirSync(dir)
    expect(readRegularFileNoFollow(dir, 100)).toBeNull()
    expect(readRegularFileNoFollow(path.join(root, "missing"), 100)).toBeNull()
    if (process.platform !== "win32") {
      const fifo = path.join(root, "fifo")
      if (spawnSync("mkfifo", [fifo]).status === 0) {
        expect(readRegularFileNoFollow(fifo, 100)).toBeNull()
      }
    }
  })

  it("refuses a file over the limit, or keeps its head with truncate", () => {
    const file = path.join(root, "big.txt")
    writeFileSync(file, "0123456789")
    expect(readRegularFileNoFollow(file, 10)).toBe("0123456789")
    expect(readRegularFileNoFollow(file, 9)).toBeNull()
    expect(readRegularFileNoFollow(file, 4, { truncate: true })).toBe("0123")
  })
})

describe("planText reads the plan file without following a link", () => {
  it("returns the named plan file, cut at 100,000 characters", () => {
    const dir = mkdtempSync(path.join(root, "plans-"))
    const file = path.join(dir, "plan.md")
    writeFileSync(file, "é".repeat(150_000))
    const text = planText({ planFilePath: file }, dir)
    expect(text.length).toBe(100_000)
    expect(text).toBe("é".repeat(100_000))
  })

  it("returns nothing for a plan file that is a symlink", () => {
    const dir = mkdtempSync(path.join(root, "plans-"))
    const outside = path.join(root, "outside.md")
    writeFileSync(outside, "not the plan")
    const link = path.join(dir, "plan.md")
    symlinkSync(outside, link)
    expect(planText({ planFilePath: link }, dir)).toBe("")
    expect(planText({}, dir)).toBe("")
  })

  it("prefers the plan passed in the input", () => {
    expect(planText({ plan: "do it" }, root)).toBe("do it")
  })
})
