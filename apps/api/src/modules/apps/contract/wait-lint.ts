// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The static half of the "no in-run waiting" rule: app code that runs in the
// sandbox must not wait inside a run for longer than 2 s (a run is woken, does
// its work and ends; a later step is a job, a timer or a resumable step, not a
// sleep). This scan flags every place in an app's sandboxed sources that can
// wait: a timer (`setTimeout`, `setInterval`, `Bun.sleep`), a call to a
// sleep/delay helper, a loop that polls the clock, or a loop bounded by a
// poll attempt count (a provider job awaited inside the run). A literal delay of
// at most 2 s passes; any other delay cannot be proved short and is flagged.
// The runtime half is the sleep counter of every run (harness.ts).
//
// Scanned: the handler entry (`handlers.ts`) and `src/**`, minus tests, test
// helpers and browser UI code (`ui.tsx`, `src/ui/**`, `*.tsx`), which never
// run in the sandbox.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export const MAX_IN_RUN_WAIT_MS = 2_000

export interface WaitSite {
  /** Path relative to the app's directory. */
  file: string
  line: number
  text: string
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "ui",
  "__fixtures__",
  "__test-helpers__",
  "test",
  "tests",
])

function isScanned(rel: string): boolean {
  if (!rel.endsWith(".ts")) return false
  if (/\.(test|spec)\.ts$/.test(rel) || /(^|\/)test-[^/]*\.ts$/.test(rel)) return false
  return true
}

function sourcesOf(appDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p)
      } else if (isScanned(relative(appDir, p))) {
        out.push(p)
      }
    }
  }
  for (const top of ["handlers.ts", "src"]) {
    const p = join(appDir, top)
    try {
      if (statSync(p).isDirectory()) walk(p)
      else if (isScanned(top)) out.push(p)
    } catch {
      /* absent */
    }
  }
  return out.sort()
}

/** A delay argument that is a numeric literal of at most 2 s. */
function shortLiteral(arg: string): boolean {
  const m = /^\s*([0-9][0-9_]*)\s*$/.exec(arg)
  return m !== null && Number(m[1]?.replaceAll("_", "")) <= MAX_IN_RUN_WAIT_MS
}

/** The text of the call's argument list starting at `open` (index of "("), one line only. */
function argsAt(line: string, open: number): string[] {
  let depth = 0
  let cur = ""
  const args: string[] = []
  for (let i = open; i < line.length; i++) {
    const ch = line[i]
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++
      if (depth === 1 && ch === "(") continue
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--
      if (depth === 0) {
        args.push(cur)
        return args
      }
    } else if (ch === "," && depth === 1) {
      args.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  args.push(cur)
  return args
}

const TIMER_CALL = /\b(setTimeout|setInterval)\s*\(/g
const SLEEP_CALL = /(?<![.\w])(sleep|sleepFn|delay)\s*\(/g
const DEFINITION =
  /\b(function\s+\w+|=>|:\s*\(|(const|let|var)\s+\w+\s*=|\w+\s*\([^)]*\)\s*(:\s*[\w<>[\] |]+)?\s*\{)/
const CLOCK_POLL = /\b(while|for)\s*\(.*\bDate\.now\(\)/
/** A loop bounded by a poll attempt count: it waits on a provider job inside the run. */
const POLL_LOOP = /\b(while|for)\s*\(.*\b\w*poll\w*(attempt|max)\w*/i

/** Every place in the app's sandboxed sources that can wait past 2 s in a run. */
export function lintAppWaits(appDir: string): WaitSite[] {
  const sites: WaitSite[] = []
  for (const path of sourcesOf(appDir)) {
    const lines = readFileSync(path, "utf8").split("\n")
    lines.forEach((raw, i) => {
      if (waitsOnLine(raw)) {
        sites.push({ file: relative(appDir, path), line: i + 1, text: raw.trim() })
      }
    })
  }
  return sites
}

/** True when this source line can wait past 2 s. */
function waitsOnLine(raw: string): boolean {
  const code = raw.replace(/\/\/.*$/, "")
  if (/^\s*\*/.test(raw) || code.trim() === "") return false
  if (/\bBun\.sleep\b/.test(code) || CLOCK_POLL.test(code) || POLL_LOOP.test(code)) return true
  for (const m of code.matchAll(TIMER_CALL)) {
    const delay = argsAt(code, (m.index ?? 0) + m[0].length - 1)[1] ?? "0"
    if (!shortLiteral(delay)) return true
  }
  for (const m of code.matchAll(SLEEP_CALL)) {
    const at = m.index ?? 0
    // A definition of the helper itself (`function sleep(ms)`, `sleep(ms: number) {`).
    const before = code.slice(0, at)
    if (
      /\bfunction\s*$/.test(before) ||
      (/^\s*(async\s+)?$/.test(before) && DEFINITION.test(code))
    ) {
      continue
    }
    if (!shortLiteral(argsAt(code, at + m[0].length - 1)[0] ?? "")) return true
  }
  return false
}
