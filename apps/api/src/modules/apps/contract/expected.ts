// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contract's expected failures: every (app, entry, reason) that does not
// keep the wake-up contract yet. It is the backlog the apps work through; it
// only ever shrinks (expected-failures.guard.test.ts). An entry is
// `<kind>:<name>` (contract/entries.ts) or, for a wait-lint finding,
// `lint:<file>` (contract/wait-lint.ts).

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractReason, EntryVerdict } from "./harness"
import type { WaitSite } from "./wait-lint"

export interface ExpectedFailure {
  app: string
  entry: string
  reason: ContractReason
}

export const EXPECTED_FAILURES_PATH = join(import.meta.dir, "expected-failures.json")
export const BASELINE_PATH = join(import.meta.dir, "expected-failures.baseline.json")

export const keyOf = (f: ExpectedFailure) => `${f.app} ${f.entry} ${f.reason}`

export function readFailures(path: string): ExpectedFailure[] {
  return JSON.parse(readFileSync(path, "utf8")) as ExpectedFailure[]
}

export function sortFailures(rows: ExpectedFailure[]): ExpectedFailure[] {
  return [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
}

export function writeFailures(path: string, rows: ExpectedFailure[]): void {
  writeFileSync(path, `${JSON.stringify(sortFailures(rows), null, 2)}\n`)
}

/** The failure rows of one app's verdicts and wait-lint findings. */
export function failuresOf(
  app: string,
  verdicts: EntryVerdict[],
  waits: WaitSite[],
): ExpectedFailure[] {
  const rows: ExpectedFailure[] = []
  for (const v of verdicts)
    for (const reason of v.reasons) rows.push({ app, entry: v.entry, reason })
  for (const file of new Set(waits.map((w) => w.file))) {
    rows.push({ app, entry: `lint:${file}`, reason: "wait" })
  }
  return sortFailures(rows)
}
