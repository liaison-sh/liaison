#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run check:raw-insert [--write]`
//
// New tests seed through the seed engine's factories (apps/api/src/seed), not
// through raw `INSERT INTO` statements that write rows no service validated. A
// ratchet: `scripts/raw-insert-baseline.json` records how many test files still
// carry a raw insert into a kernel or app table, and the count may only go
// down.
//
//   - more files than the baseline: fails (a new raw insert; use a factory);
//   - fewer files than the baseline: fails too, until the baseline is lowered
//     with `--write`, so a removal is locked in by the change that made it.
//
// A test file is a tracked `.ts`/`.tsx` file named `*.test.*` / `*.spec.*` or
// under a `tests/`, `test-support/` or `e2e/` directory. A raw insert is
// `INSERT INTO` followed by `kernel.`, `app_` or a `${...}` schema reference
// (an optional quote in between).

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = process.env.LIAISON_ROOT
  ? resolve(process.env.LIAISON_ROOT)
  : resolve(new URL("..", import.meta.url).pathname)
const BASELINE_PATH = resolve(ROOT, "scripts/raw-insert-baseline.json")

export const TEST_FILE = /\.(test|spec)\.tsx?$|(^|\/)(tests|test-support|e2e)\//
export const RAW_INSERT = /INSERT\s+INTO\s+["`]?(kernel\.|app_|\$\{)/i

interface Baseline {
  /** Test files with at least one raw insert. */
  files: number
}

function trackedFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.ts", "*.tsx"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!out.success) throw new Error(`git ls-files failed: ${out.stderr.toString()}`)
  return out.stdout.toString().split("\0").filter(Boolean)
}

/** The test files that carry a raw insert, sorted. */
export function rawInsertFiles(files: readonly string[], read: (f: string) => string): string[] {
  return files
    .filter((f) => TEST_FILE.test(f) && !f.includes("node_modules/"))
    .filter((f) => {
      try {
        return RAW_INSERT.test(read(f))
      } catch {
        return false
      }
    })
    .sort()
}

export function compare(count: number, baseline: Baseline): { exitCode: 0 | 1; message: string } {
  if (count > baseline.files) {
    return {
      exitCode: 1,
      message:
        `check:raw-insert: ${count} test files carry a raw INSERT INTO kernel/app tables, ` +
        `above the baseline of ${baseline.files}. Seed the rows through the factories ` +
        `(apps/api/src/seed/factories, the minimal tier in apps/api/src/seed/tiers/minimal.ts).`,
    }
  }
  if (count < baseline.files) {
    return {
      exitCode: 1,
      message:
        `check:raw-insert: ${count} test files carry a raw insert, below the baseline of ` +
        `${baseline.files}. Lock the improvement in: bun run check:raw-insert --write.`,
    }
  }
  return {
    exitCode: 0,
    message: `check:raw-insert: ${count} test files (baseline ${baseline.files})`,
  }
}

if (import.meta.main) {
  const found = rawInsertFiles(trackedFiles(), (f) => readFileSync(resolve(ROOT, f), "utf8"))
  if (process.argv.includes("--list")) for (const f of found) console.log(f)
  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ files: found.length }, null, 2)}\n`)
    console.log(`check:raw-insert: baseline written (${found.length} files)`)
    process.exit(0)
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline
  // On a pull request the baseline itself may not go up either.
  const base = process.env.GITHUB_BASE_REF
  if (base) {
    const prev = Bun.spawnSync(["git", "show", `origin/${base}:scripts/raw-insert-baseline.json`], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "ignore",
    })
    if (prev.success) {
      const before = JSON.parse(prev.stdout.toString()) as Baseline
      if (baseline.files > before.files) {
        console.error(
          `check:raw-insert: the baseline went up (${before.files} -> ${baseline.files}); it may only go down`,
        )
        process.exit(1)
      }
    }
  }
  const result = compare(found.length, baseline)
  console[result.exitCode === 0 ? "log" : "error"](result.message)
  process.exit(result.exitCode)
}
