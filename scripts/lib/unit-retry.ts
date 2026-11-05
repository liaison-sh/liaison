// SPDX-License-Identifier: FSL-1.1-ALv2
// scripts/lib/unit-retry.ts
//
// Which failed unit files the sharded runner retries, and the wall-clock split it
// prints. A retry exists for load-sensitive files: a file that flakes under N-way
// concurrency and passes on a fresh database. It is not for a deterministic
// failure, which fails the same way every time and only adds its own run time to
// the wall clock (a full run once spent its whole budget re-running 33 such files
// one after another, twice).
//
// A file has already reproduced its failure alone when it failed inside a batch
// and then failed again in its own process: that is two runs, the second one
// alone, so a third tells nothing new. A file that ran alone in the main pass
// (a solo unit) failed once, under concurrency, and gets the one retry.

export type UnitRunVerdict = {
  file: string
  exitCode: number
  /** Files in the process that produced this verdict (1 = alone). */
  batch: number
  /** The verdict came from the alone rerun of a file that failed in a batch. */
  aloneAfterBatch?: boolean
}

export type RetryPlan = {
  /** Failed files that get the one retry. */
  retry: string[]
  /** Failed files whose failure already reproduced alone: no retry. */
  reproducedAlone: string[]
}

export function planRetries(results: readonly UnitRunVerdict[]): RetryPlan {
  const retry: string[] = []
  const reproducedAlone: string[] = []
  for (const r of results) {
    if (r.exitCode === 0) continue
    if (r.aloneAfterBatch && r.batch === 1) reproducedAlone.push(r.file)
    else retry.push(r.file)
  }
  return { retry, reproducedAlone }
}

export type PhaseTiming = { name: string; ms: number }

/** "total 812.4s (main 790.1s, alone reruns 12.0s, retry 10.3s)"; phases that took 0 ms are left out. */
export function formatPhaseSplit(phases: readonly PhaseTiming[]): string {
  const total = phases.reduce((sum, p) => sum + p.ms, 0)
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  const parts = phases.filter((p) => p.ms > 0).map((p) => `${p.name} ${s(p.ms)}`)
  return `total ${s(total)} (${parts.join(", ")})`
}
