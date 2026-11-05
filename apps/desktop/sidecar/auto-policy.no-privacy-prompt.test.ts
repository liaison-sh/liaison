// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Finding the other spellings of the session folder must never resolve an
// unrelated symlink. On macOS, resolving a link into Google Drive, iCloud or a
// network volume raises a privacy prompt that blocks the local session until
// someone answers it (seen on a real Mac: the first turn waited 30 minutes
// behind "… wants to access files managed by Google Drive").
//
// `spyOn` wraps the live `node:fs` export and keeps the original to call
// through. (`mock.module("node:fs", …)` patches that same namespace in place,
// so a spy calling `fs.realpathSync` from inside it recurses into itself: the
// first version of this test spun for minutes.)
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { folderSpellings } from "./auto-policy"

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function world() {
  const base = fs.realpathSync(mkdtempSync(join(tmpdir(), "spellings-")))
  cleanup.push(base)
  const home = join(base, "home")
  const volume = join(base, "volume")
  mkdirSync(home)
  mkdirSync(join(volume, "Documents", "Reports"), { recursive: true })
  mkdirSync(join(base, "cloud-drive"))
  symlinkSync(join(volume, "Documents"), join(home, "Documents"))
  symlinkSync(join(base, "cloud-drive"), join(home, "Google Drive"))
  return { base, home, volume, folder: join(volume, "Documents", "Reports") }
}

describe("folder spellings", () => {
  it("never resolves a symlink under the home folder or the root", () => {
    const { home, folder } = world()
    const spy = spyOn(fs, "realpathSync")
    try {
      const spellings = folderSpellings(folder, home)
      const resolved = spy.mock.calls.map(([path]) => String(path))
      expect(spellings).toEqual(
        expect.arrayContaining([folder, join(home, "Documents", "Reports")]),
      )
      // Only the session folder itself is resolved: no link under home, none under "/".
      expect(resolved).toEqual([folder])
    } finally {
      spy.mockRestore()
    }
  })

  it("finds a home link that points through a root link (~/x -> /tmp/... on macOS)", () => {
    const { base, home, folder } = world()
    const alias = join(base, "alias")
    symlinkSync(join(base, "volume"), alias)
    symlinkSync(join(alias, "Documents"), join(home, "Docs"))
    // `alias` is not directly under "/", so hand it in as the given spelling.
    const viaAlias = join(alias, "Documents", "Reports")
    expect(folderSpellings(viaAlias, home)).toEqual(
      expect.arrayContaining([
        viaAlias,
        folder,
        join(home, "Docs", "Reports"),
        join(home, "Documents", "Reports"),
      ]),
    )
  })
})
