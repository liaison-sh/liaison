// SPDX-License-Identifier: FSL-1.1-ALv2
// Per-file unit wall times from earlier runs, which order the unit runner's
// queue longest first and run the slowest files alone. The history lives in the
// repository's git common dir, shared by every worktree of the checkout: a
// per-checkout file (logs/ is gitignored) started empty in every fresh
// worktree, so every file was estimated at the same default. Outside a git
// checkout it falls back to <root>/logs/.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export type UnitTimings = Record<string, number>

export function timingsHistoryPath(root: string): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  })
  const commonDir = git.exitCode === 0 ? git.stdout.toString().trim() : ""
  return commonDir
    ? path.join(commonDir, "liaison-unit-timings.json")
    : path.join(root, "logs", "unit-timings.json")
}

export function readTimings(file: string): UnitTimings {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as UnitTimings
  } catch {
    return {}
  }
}

/**
 * Merges this run's wall times into the history file (union, this run wins).
 * It re-reads the file first so a concurrent run's entries survive, and writes
 * a temp file renamed into place so a reader never sees a half-written file.
 */
export function mergeTimings(file: string, run: UnitTimings): void {
  const merged = { ...readTimings(file), ...run }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(merged, null, 1))
  renameSync(tmp, file)
}
