// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { findAiAttribution } from "./check-no-ai-coauthor"

const SCRIPT = path.join(import.meta.dir, "check-no-ai-coauthor.ts")
const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("findAiAttribution", () => {
  it("flags an AI co-author trailer, any case", () => {
    expect(
      findAiAttribution("Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"),
    ).toHaveLength(1)
    expect(findAiAttribution("Fix\n\nco-authored-by: Copilot <x@y.z>")).toHaveLength(1)
  })
  it("flags a Generated with footer", () => {
    expect(
      findAiAttribution("Body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"),
    ).toHaveLength(1)
  })
  it("keeps a human co-author and prose that names a tool", () => {
    expect(findAiAttribution("Fix\n\nCo-authored-by: Jane Doe <jane@example.com>")).toEqual([])
    expect(findAiAttribution("Support Claude models in the picker")).toEqual([])
  })
})

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}

describe("check-no-ai-coauthor script", () => {
  function repo(messages: string[]) {
    const root = mkdtempSync(path.join(tmpdir(), "no-ai-coauthor-"))
    roots.push(root)
    git(root, "init", "-q")
    git(
      root,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    )
    const base = git(root, "rev-parse", "HEAD")
    for (const m of messages) {
      git(
        root,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        m,
      )
    }
    return { root, base, head: git(root, "rev-parse", "HEAD") }
  }
  function run(cwd: string, env: Record<string, string>) {
    return spawnSync("bun", [SCRIPT], { cwd, encoding: "utf8", env: { ...process.env, ...env } })
  }

  it("fails on a trailer in the range and names the commit", () => {
    const { root, base, head } = repo([
      "ok",
      "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
    ])
    const r = run(root, { BASE_SHA: base, HEAD_SHA: head })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("Co-Authored-By: Claude")
  })
  it("fails on the pull request body", () => {
    const { root, base, head } = repo(["ok"])
    const r = run(root, {
      BASE_SHA: base,
      HEAD_SHA: head,
      PR_BODY: "x\n\nGenerated with Claude Code",
    })
    expect(r.status).toBe(1)
  })
  it("passes a clean range", () => {
    const { root, base, head } = repo(["ok", "fix\n\nCo-authored-by: Jane <jane@example.com>"])
    expect(run(root, { BASE_SHA: base, HEAD_SHA: head }).status).toBe(0)
  })
})
