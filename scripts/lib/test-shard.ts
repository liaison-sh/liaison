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
