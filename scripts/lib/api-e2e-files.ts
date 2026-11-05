// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which apps/api/src/tests/e2e files belong to which runner.
//
// The `cell` suite owns `src/tests/e2e/cell/`: scenarios that boot several
// `src/index.ts` processes each (createRoleCell), about three bun servers per
// file. The `e2e` suite and the `e2e-parallel` lanes must never pick them up:
// a lane runs N files at once, and N cells at once is 3N servers on a box sized
// for N. Both runners read their file lists from here, so the exclusion has one
// definition, and scripts/test-run.suites.test.ts keeps it in force.
import { readdirSync } from "node:fs"
import path from "node:path"

/** The cell suite's directory, relative to apps/api/src/tests/e2e. */
export const CELL_DIR = "cell"

/** What `bun test` treats as a test file. */
const BUN_TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/

/** True for a path (relative to the e2e directory) inside the cell suite's directory. */
export function isCellPath(relative: string): boolean {
  const parts = relative.split(/[\\/]/)
  return parts[0] === CELL_DIR
}

function walk(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || isCellPath(rel)) continue
      walk(path.join(dir, entry.name), rel, out)
    } else if (entry.isFile() && BUN_TEST_FILE.test(entry.name)) {
      out.push(rel)
    }
  }
}

/**
 * Every bun test file under `e2eDir` except the cell suite's, relative to
 * `e2eDir` and sorted: what `bun test <e2eDir>` would run, minus `cell/`.
 */
export function apiE2eTestFiles(e2eDir: string): string[] {
  const out: string[] = []
  walk(e2eDir, "", out)
  return out.sort()
}

/** The `*.scenario.test.ts` files the e2e-parallel lanes run, absolute and sorted. */
export function apiE2eScenarioFiles(e2eDir: string): string[] {
  return apiE2eTestFiles(e2eDir)
    .filter((f) => f.endsWith(".scenario.test.ts"))
    .map((f) => path.join(e2eDir, f))
}
