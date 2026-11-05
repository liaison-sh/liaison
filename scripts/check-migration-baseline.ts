#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run check:migration-baseline`
//
// 0. PRE-LAUNCH MODE (I-OPS-1): while there is no installed-customer data, the
//    `0000_initial.sql` baseline is a LIVING file — DB fixes (RLS, FORCE RLS,
//    FKs, new columns) rewrite it in place and dev DBs are reset+reseeded, not
//    migrated forward (remediation-plan D2). In that window the sha256 lock is
//    counter-productive: it goes red on every intentional baseline edit. So if
//    pre-launch mode is active the guard short-circuits to exit 0 with a notice.
//    Pre-launch mode is active when EITHER:
//      • the `LIAISON_PRELAUNCH=1` env var is set (ad-hoc / CI override), OR
//      • the committed `.baseline` manifest carries `"prelaunch": true`.
//    POST-LAUNCH: flip the committed marker to `false` (or delete it) and re-pin
//    the hash — the frozen-baseline lock below re-arms automatically.
// 1. If `.baseline` is absent, exit 0 (pre-baseline no-op).
// 2. For each `protected` entry, sha256 the file; compare to manifest hash.
// 3. If mismatch, exit 1.
// 4. In CI, also reject baseline manifest mutations that *remove* a protected
//    entry (a PR cannot bypass the guard by erasing the entry).

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

interface BaselineEntry {
  path: string
  sha256: string
}

interface Baseline {
  tag: string
  /** I-OPS-1: when true, the sha256 lock is disabled (living-baseline window). */
  prelaunch?: boolean
  protected: BaselineEntry[]
}

/** I-OPS-1: env override — `LIAISON_PRELAUNCH=1` forces pre-launch mode on
 *  regardless of the committed marker (ad-hoc local edits / CI). */
function prelaunchEnvActive(): boolean {
  const v = process.env.LIAISON_PRELAUNCH
  return v === "1" || v === "true"
}

const REPO_ROOT = process.env.LIAISON_ROOT
  ? resolve(process.env.LIAISON_ROOT)
  : resolve(new URL("..", import.meta.url).pathname)
const BASELINE_PATH = resolve(REPO_ROOT, "apps/api/src/db/migrations/.baseline")

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export interface RunResult {
  exitCode: 0 | 1
  errors: string[]
  /** Diagnostic notices printed to stdout (not failures). */
  notices?: string[]
}

export function runCheck(opts: { ci?: boolean } = {}): RunResult {
  if (!existsSync(BASELINE_PATH)) {
    return { exitCode: 0, errors: [] }
  }

  let baseline: Baseline
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline
  } catch (err) {
    return { exitCode: 1, errors: [`failed to parse .baseline: ${err}`] }
  }

  // I-OPS-1 — pre-launch mode: skip the sha256 lock while the baseline is a
  // living file. Re-arm post-launch by clearing the env var AND the committed
  // marker. The env var wins so a developer can opt in without editing the file.
  if (prelaunchEnvActive() || baseline.prelaunch === true) {
    const via = prelaunchEnvActive() ? "LIAISON_PRELAUNCH env" : ".baseline prelaunch:true"
    return {
      exitCode: 0,
      errors: [],
      notices: [
        `migration baseline check SKIPPED — pre-launch mode active (${via}). ` +
          `The 0000 baseline is a living file pre-launch; re-arm the lock post-launch ` +
          `by setting prelaunch:false in .baseline and re-pinning the sha256.`,
      ],
    }
  }

  const errors: string[] = []
  for (const entry of baseline.protected) {
    const abs = resolve(REPO_ROOT, entry.path)
    if (!existsSync(abs)) {
      errors.push(`baseline protected file missing: ${entry.path}`)
      continue
    }
    const actual = sha256File(abs)
    if (actual !== entry.sha256) {
      errors.push(
        `migration baseline is locked at ${baseline.tag} — ${entry.path} hash mismatch (add a new forward migration instead).`,
      )
    }
  }

  if (opts.ci) {
    // In CI, defend against PRs that delete a protected entry from .baseline
    // to mask a change to the protected file. We compare HEAD~ vs HEAD.
    try {
      const prev = Bun.spawnSync(["git", "show", "HEAD~1:apps/api/src/db/migrations/.baseline"], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "ignore",
      })
      if (prev.success) {
        const previous = JSON.parse(prev.stdout.toString()) as Baseline
        const currentPaths = new Set(baseline.protected.map((e) => e.path))
        for (const old of previous.protected) {
          if (!currentPaths.has(old.path)) {
            errors.push(
              `migration baseline: protected entry ${old.path} was removed from .baseline (forbidden — add a forward migration instead).`,
            )
          }
        }
      }
    } catch {
      // Best-effort: a missing HEAD~ baseline is fine.
    }
  }

  return { exitCode: errors.length ? 1 : 0, errors }
}

if (import.meta.main) {
  const result = runCheck({ ci: process.env.CI === "true" })
  for (const n of result.notices ?? []) console.log(n)
  for (const e of result.errors) console.error(e)
  process.exit(result.exitCode)
}
