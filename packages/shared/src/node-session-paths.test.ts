// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { displayPath } from "./node-session-paths"

const ctx = { sessionId: "abc-123" }

describe("displayPath", () => {
  it("shows a path relative to the session's cwd, whatever slashes end the cwd", () => {
    expect(displayPath("/Users/me/repo/src/a.ts", { ...ctx, cwd: "/Users/me/repo///" })).toBe(
      "src/a.ts",
    )
  })

  it("shows what follows the first worktree segment that has a rest", () => {
    expect(displayPath("/x/worktrees/feat/src/a.ts", ctx)).toBe("src/a.ts")
    expect(displayPath("/x/worktrees//worktrees/feat/a.ts", ctx)).toBe("a.ts")
  })

  it("names the clone folder from a repo URL without its query, fragment, slashes or .git", () => {
    const path = "/data/sessions/abc123/liaison/apps/x.ts"
    expect(displayPath(path, { ...ctx, repo: "https://h/o/liaison.git/?ref=main#top" })).toBe(
      "apps/x.ts",
    )
  })

  it("stays linear on input built to make a backtracking pattern slow", () => {
    const started = performance.now()
    displayPath(`/a${"/".repeat(100_000)}`, { ...ctx, cwd: `/b${"/".repeat(100_000)}x` })
    displayPath(`/${"/worktrees/./".repeat(20_000)}\n`, ctx)
    displayPath("/a/b", { ...ctx, repo: `${"#".repeat(50_000)}\n` })
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
