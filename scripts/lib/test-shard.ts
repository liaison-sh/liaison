// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `scripts/test-run.ts <suite> --shard <i>/<n>`: one machine's share of a suite,
// so a lane can be split across CI runners (the hand-started `gate` workflow).
// Not the runner's own shards, which are databases inside one run.
//
// The files of the suite are dealt round robin over their sorted list, so every
// file lands in exactly one shard and the shards stay within one file of each
// other in size. Each shard keeps the suite's own file order: a suite that lists
// a file first because it needs a fresh database still runs it first.
import { readdirSync, statSync } from "node:fs"
import path from "node:path"

export interface Shard {
  /** 1-based. */
  index: number
  total: number
}

export function parseShard(value: string | undefined): Shard | null {
  const m = /^(\d+)\/(\d+)$/.exec(value ?? "")
  if (!m) return null
  const index = Number(m[1])
  const total = Number(m[2])
  if (total < 1 || index < 1 || index > total) return null
  return { index, total }
}

/** The files of shard `index` of `total`, in the order `files` gives them. */
export function pickShard(files: string[], shard: Shard): string[] {
  const sorted = [...new Set(files)].sort()
  const mine = new Set(sorted.filter((_, i) => i % shard.total === shard.index - 1))
  const seen = new Set<string>()
  return files.filter((f) => {
    if (!mine.has(f) || seen.has(f)) return false
    seen.add(f)
    return true
  })
}

/**
 * The files of shard `index` of `total`, dealt by measured duration rather than
 * by count, for a runner that runs `workers` files at once and each file on
 * one worker (Playwright without fullyParallel). Longest first, each file goes
 * to the shard where it ends soonest: a shard ends at the larger of its time
 * spread over its workers and its longest file, which no worker count shortens
 * (ties: the shard with less time, then the lower one). A file the table does
 * not know counts as the table's median. Deterministic: the same files and
 * table give the same shards on every runner. The shard keeps the order
 * `files` gives.
 */
export function pickShardByTime(
  files: string[],
  shard: Shard,
  seconds: Record<string, number>,
  workers = 1,
): string[] {
  const unique = [...new Set(files)]
  const known = Object.values(seconds)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b)
  const fallback = known.length > 0 ? (known[Math.floor(known.length / 2)] as number) : 1
  const cost = (f: string) => {
    const v = seconds[f]
    return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback
  }
  const byCost = [...unique].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0))
  const per = Math.max(1, Math.floor(workers))
  const sum = Array.from({ length: shard.total }, () => 0)
  const longest = Array.from({ length: shard.total }, () => 0)
  const end = (i: number, add: number) =>
    Math.max((sum[i] as number) / per + add / per, longest[i] as number, add)
  const mine = new Set<string>()
  for (const f of byCost) {
    const c = cost(f)
    let target = 0
    for (let i = 1; i < sum.length; i++) {
      const d = end(i, c) - end(target, c)
      if (d < 0 || (d === 0 && (sum[i] as number) < (sum[target] as number))) target = i
    }
    sum[target] = (sum[target] as number) + c
    longest[target] = Math.max(longest[target] as number, c)
    if (target === shard.index - 1) mine.add(f)
  }
  const seen = new Set<string>()
  return files.filter((f) => {
    if (!mine.has(f) || seen.has(f)) return false
    seen.add(f)
    return true
  })
}

/**
 * The Playwright scenario files a default run picks up (apps/web's chromium and
 * iphone projects), relative to `cwd`, sorted. The desktop-webview scenarios
 * belong to an opt-in project and are left out.
 */
export function playwrightScenarioFiles(e2eDir: string, cwd: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (
        entry.isFile() &&
        entry.name.endsWith(".scenario.test.ts") &&
        !entry.name.endsWith(".desktop-webview.scenario.test.ts")
      )
        out.push(path.relative(cwd, full).split(path.sep).join("/"))
    }
  }
  walk(e2eDir)
  return out.sort()
}

/** What `bun test` treats as a test file. */
const BUN_TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/

/** Flags of a `bun test` command that take the next argument as their value. */
const VALUE_FLAGS = new Set(["--timeout", "-t", "--test-name-pattern", "--env-file"])

function testFilesUnder(dir: string, rel: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const childRel = `${rel}/${entry.name}`
    if (entry.isDirectory()) testFilesUnder(path.join(dir, entry.name), childRel, out)
    else if (entry.isFile() && BUN_TEST_FILE.test(entry.name)) out.push(childRel)
  }
}

/**
 * A `bun test` command with its path arguments replaced by the shard's share.
 * A directory argument counts as the test files under it. A path that does not
 * exist stays a file, so `bun test` still fails loudly on it. `files` is the
 * shard's share: empty when the suite has fewer files than shards.
 */
export function shardBunTestCmd(
  cmd: string[],
  cwd: string,
  shard: Shard,
): { cmd: string[]; files: string[] } {
  const head: string[] = []
  const files: string[] = []
  for (let i = 0; i < cmd.length; i++) {
    const arg = cmd[i] as string
    const isPath = i >= 2 && !arg.startsWith("-") && !VALUE_FLAGS.has(cmd[i - 1] as string)
    if (!isPath) {
      head.push(arg)
      continue
    }
    let isDir = false
    try {
      isDir = statSync(path.resolve(cwd, arg)).isDirectory()
    } catch {}
    if (isDir) {
      const found: string[] = []
      testFilesUnder(path.resolve(cwd, arg), arg.replace(/\/+$/, ""), found)
      files.push(...found.sort())
    } else {
      files.push(arg)
    }
  }
  const mine = pickShard(files, shard)
  return { cmd: [...head, ...mine], files: mine }
}
