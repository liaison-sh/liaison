// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D56 F3: what the D55 permission card says about a browser test. A
// Playwright runner leaves the sandbox, and with it the repository's own code
// it loads (its Playwright config, the tests, package scripts, global setup,
// node_modules/.bin) runs with the owner's full rights. The card says so and
// lists the files of that kind changed in the session's folder, so the owner
// sees what the session may have planted. Bounded and cheap: one git status,
// one git diff since the session's start commit, one directory listing.
import { spawnSync } from "node:child_process"
import { lstatSync, readdirSync } from "node:fs"
import path from "node:path"
import { OWNER_REPO_GUARD } from "./job-workspace"

/** The card's line (the English fallback a client without the card's text shows). */
export const BROWSER_TEST_RIGHTS =
  "A browser test runs outside the sandbox: the repository's own code it loads (its Playwright config, the tests, package scripts) runs with your full rights."

/** At most this many files are listed; the rest are counted. */
export const BROWSER_TEST_FILES_MAX = 20
/** node_modules/.bin entries looked at, at most. */
const BIN_ENTRIES_MAX = 500
const GIT_MS = 3000

/** The files a Playwright run loads and executes, by repository-relative path. */
export function isBrowserTestFile(rel: string): boolean {
  const p = rel.replace(/\\/g, "/")
  const base = p.slice(p.lastIndexOf("/") + 1)
  if (base === "package.json") return true
  if (/^playwright(-ct)?\.config\.[^/]+$/i.test(base)) return true
  if (/\.(spec|test|e2e|setup|teardown)\.[cm]?[jt]sx?$/i.test(base)) return true
  if (/^global[-._]?(setup|teardown)\b[^/]*\.[cm]?[jt]sx?$/i.test(base)) return true
  return p.startsWith("node_modules/.bin/") || p.includes("/node_modules/.bin/")
}

export interface BrowserTestFiles {
  files: string[]
  /** How many more matched than are listed. */
  more: number
}

function git(
  bin: string,
  cwd: string,
  args: string[],
  env: Record<string, string>,
  ms: number,
): string | null {
  const out = spawnSync(bin, ["-C", cwd, ...OWNER_REPO_GUARD, ...args], {
    env,
    encoding: "utf8",
    timeout: ms,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  })
  return out.status === 0 ? (out.stdout ?? "") : null
}

/**
 * The browser-test files changed in `cwd`: uncommitted (tracked or not), in
 * the commits since `sinceHead` (the session's start commit), and the
 * node_modules/.bin entries modified since `sinceMs`. Never throws: an
 * unreadable source adds nothing.
 */
export function browserTestFilesChanged(args: {
  cwd: string
  sinceHead?: string | null
  sinceMs?: number
  git?: string
  env?: Record<string, string>
  timeoutMs?: number
}): BrowserTestFiles {
  const bin = args.git ?? "git"
  const env = args.env ?? (process.env as Record<string, string>)
  const ms = args.timeoutMs ?? GIT_MS
  const found = new Set<string>()
  const status = git(
    bin,
    args.cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    env,
    ms,
  )
  for (const entry of (status ?? "").split("\0")) {
    if (entry.length > 3) found.add(entry.slice(3))
  }
  if (args.sinceHead) {
    const diff = git(
      bin,
      args.cwd,
      ["diff", "--name-only", "-z", "--no-renames", args.sinceHead, "HEAD"],
      env,
      ms,
    )
    for (const name of (diff ?? "").split("\0")) if (name) found.add(name)
  }
  if (args.sinceMs !== undefined) {
    const binDir = path.join(args.cwd, "node_modules", ".bin")
    try {
      for (const name of readdirSync(binDir).slice(0, BIN_ENTRIES_MAX)) {
        try {
          if (lstatSync(path.join(binDir, name)).mtimeMs >= args.sinceMs) {
            found.add(`node_modules/.bin/${name}`)
          }
        } catch {}
      }
    } catch {}
  }
  const all = [...found].filter(isBrowserTestFile).sort()
  return {
    files: all.slice(0, BROWSER_TEST_FILES_MAX),
    more: Math.max(0, all.length - BROWSER_TEST_FILES_MAX),
  }
}

/** The card's reason in English: the rights line and the list (an older client shows only this). */
export function browserTestReason(changed: BrowserTestFiles): string {
  if (changed.files.length === 0) {
    return `${BROWSER_TEST_RIGHTS} No such file changed in this folder.`
  }
  const more = changed.more > 0 ? ` and ${changed.more} more` : ""
  return `${BROWSER_TEST_RIGHTS} Changed in this folder: ${changed.files.join(", ")}${more}.`
}
