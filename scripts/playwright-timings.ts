// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Refreshes scripts/lib/playwright-timings.json, the per-file seconds the
// Playwright lane's shards are dealt by (scripts/lib/test-shard.ts,
// pickShardByTime), from the JUnit reports of a run: the `<testsuite>` lines
// of a JUnit XML file, or of a run's output.log, which carries the JUnit
// reporter's output (logs/<run>/output.log, or a gate run's
// gate-logs-playwright-<n> artifacts). A file is the sum of its projects'
// times. Files the reports do not cover keep their seconds; files that no
// longer exist are dropped.
//
//   bun run scripts/playwright-timings.ts <report> [<report>...]
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { playwrightScenarioFiles } from "./lib/test-shard"

const ROOT = path.resolve(import.meta.dir, "..")
const TABLE = path.join(ROOT, "scripts/lib/playwright-timings.json")
const WEB = path.join(ROOT, "apps/web")
const E2E = path.join(WEB, "src/tests/e2e")

/** Per-file seconds from JUnit `<testsuite name=... time=...>` elements. */
export function secondsFromJunit(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of text.matchAll(/<testsuite\s[^>]*>/g)) {
    const name = /\bname="([^"]+)"/.exec(m[0])?.[1]
    const time = Number(/\btime="([\d.]+)"/.exec(m[0])?.[1])
    if (!name || !Number.isFinite(time)) continue
    out[name] = (out[name] ?? 0) + time
  }
  return out
}

if (import.meta.main) {
  const reports = process.argv.slice(2)
  if (reports.length === 0) {
    console.error("usage: bun run scripts/playwright-timings.ts <junit.xml|output.log> [...]")
    process.exit(2)
  }
  const run: Record<string, number> = {}
  for (const r of reports) {
    if (!existsSync(r)) throw new Error(`no such report: ${r}`)
    for (const [k, v] of Object.entries(secondsFromJunit(readFileSync(r, "utf8"))))
      run[k] = (run[k] ?? 0) + v
  }
  const table = JSON.parse(readFileSync(TABLE, "utf8")) as Record<string, number>
  const files = playwrightScenarioFiles(E2E, E2E)
  const next: Record<string, number> = {}
  for (const f of files) {
    const v = run[f] ?? table[f]
    if (v !== undefined) next[f] = Math.max(1, Math.round(v))
  }
  writeFileSync(TABLE, `${JSON.stringify(next, null, 2)}\n`)
  const total = Object.values(next).reduce((a, b) => a + b, 0)
  console.log(
    `${TABLE}: ${Object.keys(next).length} files (${Object.keys(run).length} from these reports), ${(total / 60).toFixed(1)} worker-min`,
  )
}
