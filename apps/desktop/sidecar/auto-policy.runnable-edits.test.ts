// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Once a session read outside text, an edit that plants code a later,
// innocent-looking command runs (a git hook, a package script, an `.envrc`, a
// CI workflow) asks, even inside the folder. Ordinary source edits keep
// running. acceptEdits never asks `canUseTool` about an edit inside the
// folder, so the sidecar's PreToolUse guard is what asks.
import { describe, expect, it } from "bun:test"
import { autoAllows, editRunsLater } from "./auto-policy"
import { guardRunnableEdits } from "./index"
import { guardHook } from "./sdk-runner"

const CWD = "/work/folder"

describe("editRunsLater", () => {
  it.each([
    ".git/hooks/pre-commit",
    ".git/config",
    ".husky/pre-push",
    "package.json",
    "web/package.json",
    "pyproject.toml",
    "Makefile",
    "justfile",
    ".envrc",
    ".env",
    ".env.local",
    ".github/workflows/ci.yml",
    ".gitlab-ci.yml",
    ".vscode/tasks.json",
    ".claude/settings.json",
    "conftest.py",
    `${CWD}/.git/hooks/post-checkout`,
  ])("an edit of %s runs later", (path) => {
    expect(editRunsLater("Write", { file_path: path }, CWD)).toBe(true)
    expect(editRunsLater("Edit", { file_path: path }, CWD)).toBe(true)
  })

  it.each(["src/index.ts", "README.md", "docs/guide.md", "tests/app.test.ts", "scripts.md"])(
    "an edit of %s does not",
    (path) => {
      expect(editRunsLater("Write", { file_path: path }, CWD)).toBe(false)
    },
  )

  it("fails closed on a write tool with no readable path, and ignores other tools", () => {
    expect(editRunsLater("Write", {}, CWD)).toBe(true)
    expect(editRunsLater("Read", { file_path: "package.json" }, CWD)).toBe(false)
  })

  it("a symlink-spelled edit the CLI asked about asks once marked, and runs before", () => {
    const input = { file_path: `${CWD}/package.json` }
    const context = { blockedPath: `${CWD}/package.json` }
    expect(autoAllows("Edit", input, CWD, context)).toBe(true)
    expect(autoAllows("Edit", input, CWD, context, { readOutsideText: true })).toBe(false)
    const source = { file_path: `${CWD}/src/a.ts` }
    expect(
      autoAllows("Edit", source, CWD, { blockedPath: source.file_path }, { readOutsideText: true }),
    ).toBe(true)
  })
})

describe("the PreToolUse guard", () => {
  function broker(answer: "allow" | "deny") {
    const asked: string[] = []
    return {
      asked,
      ask: async (toolName: string) => {
        asked.push(toolName)
        return answer === "allow"
          ? ({ behavior: "allow", updatedInput: {} } as const)
          : ({ behavior: "deny", message: "no" } as const)
      },
    }
  }

  it("lets every edit go on before outside text, without asking", async () => {
    const b = broker("deny")
    const guard = guardRunnableEdits(() => false, CWD, b)
    expect(await guard("Write", { file_path: ".git/hooks/pre-commit" })).toBeNull()
    expect(b.asked).toEqual([])
  })

  it("asks for a runnable edit after outside text, and refuses on a deny", async () => {
    const b = broker("deny")
    const guard = guardRunnableEdits(() => true, CWD, b)
    expect(await guard("Write", { file_path: ".git/hooks/pre-commit" })).toBe("no")
    expect(await guard("Edit", { file_path: "src/a.ts" })).toBeNull()
    expect(b.asked).toEqual(["Write"])
  })

  it("an allow lets the edit go on", async () => {
    const guard = guardRunnableEdits(() => true, CWD, broker("allow"))
    expect(await guard("Edit", { file_path: "package.json" })).toBeNull()
  })

  it("reaches the SDK as a PreToolUse deny, and as nothing when it lets the call go", async () => {
    const hook = guardHook(async (tool) => (tool === "Write" ? "no" : null)).hooks[0]
    const input = (tool_name: string) =>
      ({
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input: { file_path: "package.json" },
        tool_use_id: "t1",
        session_id: "s",
        transcript_path: "/t",
        cwd: CWD,
      }) as never
    const signal = { signal: new AbortController().signal }
    expect(await hook(input("Write"), "t1", signal)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no",
      },
    })
    expect(await hook(input("Edit"), "t1", signal)).toEqual({})
  })
})
