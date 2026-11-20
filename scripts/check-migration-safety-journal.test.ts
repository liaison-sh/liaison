// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import {
  branchWhenProblems,
  type JournalEntry,
  journalOrderProblems,
  migrationFiles,
  readJournal,
  readMainJournal,
  safetyBaselineIdx,
} from "./check-migration-safety-journal"

const ROOT = resolve(import.meta.dir, "..")
const MAIN_REF = process.env.LIAISON_MIGRATION_MAIN_REF ?? "origin/main"

const e = (idx: number, when: number, tag: string): JournalEntry => ({ idx, when, tag })

describe("migration journal order", () => {
  it("journal whens are strictly increasing and tags, idx and file names agree", () => {
    expect(
      journalOrderProblems(readJournal(ROOT), migrationFiles(ROOT), safetyBaselineIdx(ROOT)),
    ).toEqual([])
  })

  it("every branch-only migration's when is above the newest when on origin/main", () => {
    const main = readMainJournal(ROOT, MAIN_REF)
    if (!main) throw new Error(`${MAIN_REF} is not reachable from this checkout: fetch it first`)
    expect(branchWhenProblems(readJournal(ROOT), main)).toEqual([])
  })

  it("reports two migrations that took the same number and the same when", () => {
    const entries = [e(0, 10, "0001_a"), e(1, 20, "0002_main_side"), e(2, 20, "0002_branch_side")]
    const files = ["0001_a.sql", "0002_main_side.sql", "0002_branch_side.sql"]
    expect(journalOrderProblems(entries, files)).toEqual([
      "0002_branch_side: when 20 is not above 0002_main_side's 20",
      "0002_branch_side: its number does not climb after 0002_main_side",
    ])
  })

  it("leaves numbers before the baseline as they were applied", () => {
    const entries = [e(0, 10, "0005_old"), e(1, 20, "0004_older_number"), e(2, 30, "0006_new")]
    const files = entries.map((x) => `${x.tag}.sql`)
    expect(journalOrderProblems(entries, files, 1)).toEqual([])
    expect(journalOrderProblems(entries, files)).toEqual([
      "0004_older_number: its number does not climb after 0005_old",
    ])
  })

  it("reports a gap in idx, a file the journal does not list and a paired test with no migration", () => {
    const entries = [e(0, 10, "0001_a"), e(2, 20, "0002_b")]
    const files = ["0001_a.sql", "0002_b.sql", "0003_stray.sql", "0004_gone.test.ts"]
    expect(journalOrderProblems(entries, files)).toEqual([
      "0002_b: idx 2 follows idx 0",
      "0003_stray.sql: no journal entry lists it",
      "0004_gone.test.ts: names a migration the journal does not list",
    ])
  })

  it("reports a branch migration dated at or below main's newest, and a main entry re-dated", () => {
    const main = [e(0, 10, "0001_a"), e(1, 20, "0002_main")]
    const branch = [e(0, 10, "0001_a"), e(1, 21, "0002_main"), e(2, 20, "0003_branch")]
    expect(branchWhenProblems(branch, main)).toEqual([
      "0002_main: when 21 here, 20 on main",
      "0003_branch: when 20 is not above main's newest 20",
    ])
    const fixed = [e(0, 10, "0001_a"), e(1, 20, "0002_main"), e(2, 21, "0003_branch")]
    expect(branchWhenProblems(fixed, main)).toEqual([])
  })
})
