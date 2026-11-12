#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run check:raw-insert [--write]`
//
// New tests seed through the seed engine's factories (apps/api/src/seed), not
// through raw `INSERT INTO` statements that write rows no service validated. A
// ratchet: `scripts/raw-insert-baseline.json` lists, one path per line in name
// order, the test files that still carry a raw insert into a kernel or app
// table, and the list may only shrink:
//
//   - a test file with a raw insert that the list does not name: fails (a new
//     raw insert; use a factory);
//   - a listed file that no longer has one (or is gone): fails too, until its
//     line is removed (`--write` rewrites the list), so a removal is locked in
//     by the change that made it.
//
// A list, not a count: two pull requests that each clean a file remove two
// different lines, so they merge without a conflict and the merged list is
// still exact (two lowered counts collided, or merged to a wrong number).
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
  /** Test files with at least one raw insert, in name order. */
  files: string[]
}

export function readBaseline(raw: string): Baseline {
  const parsed = JSON.parse(raw) as { files?: unknown }
  if (!Array.isArray(parsed.files) || !parsed.files.every((f) => typeof f === "string")) {
    throw new Error("scripts/raw-insert-baseline.json: `files` must be a list of paths")
  }
  return { files: parsed.files as string[] }
}

export function formatBaseline(files: readonly string[]): string {
  return `${JSON.stringify({ files: [...files].sort() }, null, 2)}\n`
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

export function compare(
  found: readonly string[],
  baseline: Baseline,
): { exitCode: 0 | 1; message: string } {
  const listed = new Set(baseline.files)
  const now = new Set(found)
  const added = found.filter((f) => !listed.has(f))
  const cleaned = baseline.files.filter((f) => !now.has(f))
  const lines: string[] = []
  if (added.length > 0) {
    lines.push(
      `check:raw-insert: ${added.length} test file(s) gained a raw INSERT INTO kernel/app tables. ` +
        "Seed the rows through the factories (apps/api/src/seed/factories, the minimal tier in " +
        "apps/api/src/seed/tiers/minimal.ts):",
      ...added.map((f) => `  ${f}`),
    )
  }
  if (cleaned.length > 0) {
    lines.push(
      `check:raw-insert: ${cleaned.length} listed file(s) carry no raw insert any more. Lock the ` +
        "improvement in: remove their lines from scripts/raw-insert-baseline.json " +
        "(bun run check:raw-insert --write):",
      ...cleaned.map((f) => `  ${f}`),
    )
  }
  if (lines.length > 0) return { exitCode: 1, message: lines.join("\n") }
  return {
    exitCode: 0,
    message: `check:raw-insert: ${found.length} test files, all listed in the baseline`,
  }
}

if (import.meta.main) {
  const found = rawInsertFiles(trackedFiles(), (f) => readFileSync(resolve(ROOT, f), "utf8"))
  if (process.argv.includes("--list")) for (const f of found) console.log(f)
  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE_PATH, formatBaseline(found))
    console.log(`check:raw-insert: baseline written (${found.length} files)`)
    process.exit(0)
  }
  const baseline = readBaseline(readFileSync(BASELINE_PATH, "utf8"))
  // On a pull request the list itself may not gain a file either.
  const base = process.env.GITHUB_BASE_REF
  if (base) {
    const prev = Bun.spawnSync(["git", "show", `origin/${base}:scripts/raw-insert-baseline.json`], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "ignore",
    })
    if (prev.success) {
      const raw = JSON.parse(prev.stdout.toString()) as { files?: unknown }
      // The base may still hold the older count form: nothing to compare entries against.
      if (Array.isArray(raw.files)) {
        const before = new Set(raw.files as string[])
        const grown = baseline.files.filter((f) => !before.has(f))
        if (grown.length > 0) {
          console.error(
            `check:raw-insert: the baseline gained ${grown.join(", ")}; it may only shrink`,
          )
          process.exit(1)
        }
      }
    }
  }
  const result = compare(found, baseline)
  console[result.exitCode === 0 ? "log" : "error"](result.message)
  process.exit(result.exitCode)
}
