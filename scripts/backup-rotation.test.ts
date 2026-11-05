// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `deploy/backup.sh --keep N` rotates only the archives it names itself, by
// their timestamp, and never the one it just wrote. A hand-named archive
// (`liaison-backup-before-upgrade.tar.gz`) once sorted as the newest and made
// `--keep 1` delete every timestamped archive, the fresh one included.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const COMMON = path.resolve(import.meta.dir, "../deploy/lib/common.sh")
let dir = ""
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function rotate(files: string[], keep: number, current: string): string[] {
  dir = mkdtempSync(path.join(tmpdir(), "liaison-rotate-"))
  for (const f of files) writeFileSync(path.join(dir, f), "x")
  const r = Bun.spawnSync(
    [
      "bash",
      "-c",
      `set -euo pipefail; . "$1"; rotate_archives "$2" "$3" "$2/$4"`,
      "_",
      COMMON,
      dir,
      String(keep),
      current,
    ],
    { stderr: "pipe" },
  )
  expect(r.exitCode).toBe(0)
  return readdirSync(dir).sort()
}

const OLD = "liaison-backup-20261020T031500Z.tar.gz"
const MID = "liaison-backup-20261021T031500Z.tar.gz"
const NEW = "liaison-backup-20261022T031500Z.tar.gz"
const HAND = "liaison-backup-before-upgrade.tar.gz"

describe("backup --keep rotation", () => {
  it("keeps a hand-named archive and the one just written with --keep 1", () => {
    expect(rotate([OLD, MID, NEW, HAND], 1, NEW)).toEqual([HAND, NEW].sort())
  })

  it("keeps the N newest timestamped archives, counting the new one", () => {
    expect(rotate([OLD, MID, NEW, HAND], 2, NEW)).toEqual([HAND, MID, NEW].sort())
  })

  it("never removes the archive just written, even when it sorts oldest", () => {
    expect(rotate([OLD, MID, NEW], 1, OLD)).toEqual([OLD])
  })

  it("leaves other files alone", () => {
    expect(rotate([OLD, NEW, "notes.txt", "liaison-backup-x.tar.gz.age"], 1, NEW)).toEqual(
      ["liaison-backup-x.tar.gz.age", NEW, "notes.txt"].sort(),
    )
  })
})
