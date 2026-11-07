// SPDX-License-Identifier: FSL-1.1-ALv2
//
// readOwnerOnlyFile checks the mode of the file it reads, not of whatever the
// path names by the time it reads: a file swapped in right after the check is
// never what comes back.

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import * as realFs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Taken before the mock below: the namespace is live, so it would see the wrappers.
const { chmodSync, fstatSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } = realFs

/** Runs once, right after the next mode check, whichever way it is made. */
let afterCheck: (() => void) | null = null
function checked<T>(result: T): T {
  const hook = afterCheck
  afterCheck = null
  hook?.()
  return result
}
mock.module("node:fs", () => ({
  ...realFs,
  statSync: (...args: Parameters<typeof statSync>) => checked(statSync(...args)),
  fstatSync: (...args: Parameters<typeof fstatSync>) => checked(fstatSync(...args)),
}))

const { readOwnerOnlyFile, NotOwnerOnlyError } = await import("~/cli/owner-only-file")

let dir: string
let n = 0
function file(content: string, mode: number): string {
  const p = join(dir, `f-${n++}`)
  writeFileSync(p, content)
  chmodSync(p, mode)
  return p
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "owner-only-file-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("readOwnerOnlyFile", () => {
  it("reads a file only its owner can read", () => {
    expect(readOwnerOnlyFile(file("key\n", 0o600))).toBe("key\n")
    expect(readOwnerOnlyFile(file("key", 0o400))).toBe("key")
  })

  it("refuses a file a group or others can read", () => {
    expect(() => readOwnerOnlyFile(file("key", 0o640))).toThrow(NotOwnerOnlyError)
    expect(() => readOwnerOnlyFile(file("key", 0o604))).toThrow(NotOwnerOnlyError)
  })

  it("lets a missing file fail as a read error, not as a mode refusal", () => {
    let thrown: unknown
    try {
      readOwnerOnlyFile(join(dir, "missing"))
    } catch (err) {
      thrown = err
    }
    expect((thrown as NodeJS.ErrnoException).code).toBe("ENOENT")
  })

  it("returns the file it checked when the path is swapped right after the check", () => {
    const path = file("the checked key", 0o600)
    const planted = file("a planted key", 0o644)
    afterCheck = () => renameSync(planted, path)
    expect(readOwnerOnlyFile(path)).toBe("the checked key")
  })
})
