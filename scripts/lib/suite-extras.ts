// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test files a `bun test` suite of scripts/test-run.ts runs beyond the list in
// its SUITES entry: `scripts/test-suites.d/<suite>/<feature>.txt`, one path per
// line relative to the suite's cwd (`#` starts a comment). A pull request that
// adds a test file to a suite adds a file of its own here instead of a line at
// the end of the suite's list, so two such PRs never edit the same lines. The
// suite-routing guards (test-run.suites.test.ts, test-run.bundled.test.ts) read
// these entries as listings of their suite, so every rule they hold (each test
// file in exactly one suite, no phantom file) holds for them too.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export const SUITE_EXTRAS_DIR = join(import.meta.dir, "..", "test-suites.d")

/** Suite name → the extra test files its `*.txt` files list, in file then line order. */
export function readSuiteExtras(dir: string = SUITE_EXTRAS_DIR): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!existsSync(dir)) return out
  for (const suite of readdirSync(dir).sort()) {
    const suiteDir = join(dir, suite)
    if (!statSync(suiteDir).isDirectory()) continue
    const files: string[] = []
    for (const file of readdirSync(suiteDir)
      .filter((f) => f.endsWith(".txt"))
      .sort()) {
      for (const raw of readFileSync(join(suiteDir, file), "utf8").split("\n")) {
        const line = raw.replace(/#.*$/, "").trim()
        if (!line) continue
        if (!/\.test\.tsx?$/.test(line) || line.startsWith("/") || line.includes("..")) {
          throw new Error(
            `scripts/test-suites.d/${suite}/${file}: "${line}" is not a test file path relative to the suite's cwd`,
          )
        }
        files.push(line)
      }
    }
    if (files.length > 0) out.set(suite, files)
  }
  return out
}

/**
 * Append each suite's extra files to its command, unless the run names its own files. Only a
 * plain `bun test <files>` suite takes extras: one that does not throws, so a misplaced file
 * fails the run instead of running nowhere.
 */
export function applySuiteExtras(
  suites: Record<string, { cmd: string[] }>,
  extras: Map<string, string[]>,
  runNamesFiles: boolean,
): void {
  for (const [name, files] of extras) {
    const suite = suites[name]
    if (!suite) throw new Error(`scripts/test-suites.d/${name}: no suite of that name`)
    if (suite.cmd[0] !== "bun" || suite.cmd[1] !== "test") {
      throw new Error(`scripts/test-suites.d/${name}: only a \`bun test\` suite takes extra files`)
    }
    if (!runNamesFiles) suite.cmd.push(...files)
  }
}

/**
 * A suite block of test-run.ts's source with its extra files appended as quoted listings, for
 * the guards that read the source: they then see an extra file exactly as a listed one.
 */
export function withExtraListings(name: string, block: string, extras: Map<string, string[]>) {
  const files = extras.get(name)
  if (!files) return block
  return `${block}\n    // scripts/test-suites.d/${name}\n${files.map((f) => `    "${f}",`).join("\n")}\n`
}
