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

/**
 * Per app, how many entries pass only trivially (harness.ts: no fixture, every
 * run rejected its empty input). An app is not done with the contract while
 * its count is above zero, even with no expected failure left. The count only
 * shrinks (expected-failures.guard.test.ts against the frozen baseline).
 */
export const TRIVIAL_PASSES_PATH = join(import.meta.dir, "trivial-passes.json")
export const TRIVIAL_BASELINE_PATH = join(import.meta.dir, "trivial-passes.baseline.json")

export type TrivialCounts = Record<string, number>

export function readTrivialCounts(path: string): TrivialCounts {
  return JSON.parse(readFileSync(path, "utf8")) as TrivialCounts
}

/** Apps in name order, zero counts left out. */
export function writeTrivialCounts(path: string, counts: TrivialCounts): void {
  const sorted = Object.fromEntries(
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`)
}

/** The trivially passing entries of one app's verdicts. */
export function trivialEntriesOf(verdicts: EntryVerdict[]): string[] {
  return verdicts
    .filter((v) => v.trivial)
    .map((v) => v.entry)
    .sort()
}

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
