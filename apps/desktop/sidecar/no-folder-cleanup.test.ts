// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S50.7 (owner D13): an owner session runs in the owner's own folder, so no
// cleanup path of the node may ever delete, clean or reset it. Every removal
// in the sidecar and the desktop's node-jobs code is listed here with what it
// removes; a new one fails this test until someone adds it, having checked it
// never takes a workspace's cwd, repoDir or sourceRepo. And the one cleanup
// that runs at the end of every run (the job's shell home) is proven to never
// equal or contain the session's folder.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { removesWorkspace } from "./unattended"
import { jobShellHome } from "./unattended-profile"

const SIDECAR = import.meta.dir
const NODE_JOBS = path.join(import.meta.dir, "..", "src", "node-jobs")

function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((f) => ({
      file: path.relative(SIDECAR, path.join(dir, f)),
      text: readFileSync(path.join(dir, f), "utf8"),
    }))
}

/** `file: the argument` of every removal call, as the source writes it. */
const KNOWN_REMOVALS = new Set([
  "atelier-bundle.ts: old", // <dataDir>/atelier/.old-<hex>: the replaced bundled Atelier (S38)
  "atelier-bundle.ts: tmp", // <dataDir>/atelier/.tmp-<hex>: the bundle being written
  "claude-auth.ts: sinkDir", // the auth probe's own temp dir
  "job-workspace.ts: file", // writeNoFollow: a node-owned file in the session dir, replaced
  "mcp-token.ts: file", // <mcp config>.turn: the local turn's credential file, rewritten
  "mcp-token.ts: temporary", // the token file's temp twin
  "repo-content.ts: args.pluginDir", // <sessionDir>/repo-plugin
  "session-config.ts: at", // clear(): an entry of the mirror, never followed
  "session-credentials.ts: dir", // the broker's socket dir
  "session-credentials.ts: file", // writeShim: a session bin shim, replaced whole
  "session-credentials.ts: home", // the gh call's own mkdtemp HOME (lia-ghh-)
  "session-credentials.ts: tmp", // the gh call's own mkdtemp scratch (lia-gh-)
  "unattended-profile.ts: dir", // prepareJobShellHome: <dataDir>/node-job-home/<run>
  "unattended.ts: path.join(ctx.sessionDir", // <sessionDir>/bin/nc: an earlier version's SSH shim
  "unattended.ts: shellHomeToRemove", // the run's shell home, set only once removesWorkspace cleared it
])

const REMOVAL = /\b(rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\(\s*([^,)]+)/g
const WORKSPACE_FIELD = /\b(cwd|repoDir|sourceRepo|folderPath|worktreeDir|cloneDir)\b/

describe("S50.7: no cleanup path targets an in-place folder", () => {
  const all = [...sources(SIDECAR), ...sources(NODE_JOBS)]

  it("S50: no cleanup path targets an in-place cwd", () => {
    const found: string[] = []
    for (const { file, text } of all) {
      for (const m of text.matchAll(REMOVAL)) {
        const before = text.slice(Math.max(0, (m.index ?? 0) - 1), m.index)
        // A method of something else (`list.unlink(…)`) or a word ending in rm.
        if (before === "." || /[A-Za-z0-9_$]/.test(before)) continue
        found.push(`${file}: ${(m[2] as string).trim()}`)
      }
    }
    for (const entry of found) {
      expect(entry).not.toMatch(WORKSPACE_FIELD)
    }
    expect([...new Set(found)].sort()).toEqual([...KNOWN_REMOVALS].sort())
  })

  it("S50: no git clean, worktree remove, reset or stash is ever spawned", () => {
    const spawned =
      /(spawn|exec|execFile|runStep)(Sync)?\([^)]*"(clean|reset|stash)"|"worktree",\s*"(remove|prune)"|\brm\s+-[a-z]*r/
    for (const { file, text } of all) {
      const lines = text.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l))
      for (const line of lines) {
        if (spawned.test(line)) throw new Error(`${file}: ${line.trim()}`)
      }
    }
  })

  it("S50: the run's shell home never equals or contains the session's folder", () => {
    const dataDir = "/Users/ada/Library/Application Support/liaison-desktop"
    const home = jobShellHome(dataDir, "job-1")
    // The owner's real folders, including their whole home shared as a folder.
    for (const cwd of [
      "/Users/ada/Documents/liaison-monorepo",
      "/Users/ada",
      "/Users/ada/Library/Application Support",
    ]) {
      expect(removesWorkspace(home, { cwd })).toBe(false)
    }
    // The guard itself: a target equal to, or above, a workspace path is refused.
    expect(removesWorkspace("/Users/ada/code", { cwd: "/Users/ada/code" })).toBe(true)
    expect(removesWorkspace("/Users/ada", { cwd: "/Users/ada/code/app" })).toBe(true)
    expect(
      removesWorkspace("/x/home", { cwd: "/y", repoDir: "/x/home/repo", sourceRepo: "/z" }),
    ).toBe(true)
  })
})
