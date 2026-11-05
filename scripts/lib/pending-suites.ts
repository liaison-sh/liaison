// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Suites whose test files are not on this branch yet.
//
// `scripts/test-run.ts` names its files by hand. When every file a suite names
// belongs to a parallel line of work in the same repo, `bun test` matches no
// file and exits 1, so the suite fails on every run and the entry cannot be
// deleted either: the branch that owns the file needs the entry to be there
// the day it lands. The answer is the same shape the integration suite already
// uses for files a later phase owes: declare the absence, with a reason, and
// let the runner skip the suite instead of failing it.
//
// The declaration is the loud half. `scripts/test-run.suites.test.ts` asserts
// that the files listed here are exactly the files the suite names and cannot
// find on disk, so the day one of them lands the assertion goes red and the
// entry has to be removed, which is what puts the suite back in the run.

export interface PendingSuite {
  /** Test files the suite names, relative to the suite cwd. */
  files: string[]
  /** Why they are absent. Printed by the runner when it skips the suite. */
  reason: string
}

export const PENDING_SUITES: Record<string, PendingSuite> = {
  "report-skills": {
    files: ["scripts/report-skills.test.ts"],
    reason:
      "scripts/report-skills.test.ts is owned by a parallel line of work and has not landed on this branch yet",
  },
}

/**
 * The reason to skip `suite`, or null to run it.
 *
 * A suite is skipped only when EVERY test file it names is declared pending
 * and is really absent from disk. One file landing is enough to put the whole
 * suite back in the run, which is the behaviour a half-landed branch wants.
 */
export function pendingSuiteReason(
  suite: string,
  namedFiles: string[],
  exists: (file: string) => boolean,
): string | null {
  const pending = PENDING_SUITES[suite]
  if (!pending || namedFiles.length === 0) return null
  const allPending = namedFiles.every((f) => pending.files.includes(f) && !exists(f))
  return allPending ? pending.reason : null
}

/** The test files a suite command names, in command order. */
export function namedTestFiles(cmd: string[]): string[] {
  return cmd.filter((arg) => /\.test\.tsx?$/.test(arg) && !arg.startsWith("-"))
}
