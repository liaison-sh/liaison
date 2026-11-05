// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T08: the owner's answers to a session's waiting requests (S9, S12, S14,
// D39, G2, G3). No timeout anywhere: a request waits until it is answered.
import { afterAll, afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type DecisionPayload,
  ruleTarget,
  SessionAsks,
  SessionRules,
  sanitizePermissionResult,
} from "./session-asks"

const root = mkdtempSync(path.join(tmpdir(), "liaison-session-asks-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => setSystemTime())

const signal = () => new AbortController().signal

function asks(dir?: string) {
  const decisions: DecisionPayload[] = []
  const a = new SessionAsks()
  a.onDecision = (d) => decisions.push(d)
  a.rules = new SessionRules(dir)
  return { a, decisions }
}

const write = (file_path: string) => ({
  tool: "Write",
  input: { file_path, content: "x" },
  kind: "permission" as const,
})

describe("P3-T08 SessionAsks (S12, D39)", () => {
  it("a permission ask waits 11 simulated minutes with no answer and is still pending", async () => {
    const timers = spyOn(globalThis, "setTimeout")
    const { a, decisions } = asks()
    let settled = false
    void a.ask("toolu_1", write("/w/a.txt"), signal()).then(() => {
      settled = true
    })
    // No timer is armed anywhere on the path.
    expect(timers).not.toHaveBeenCalled()
    timers.mockRestore()
    setSystemTime(new Date(Date.now() + 11 * 60_000))
    await Bun.sleep(10)
    expect(settled).toBe(false)
    expect(a.pending()).toEqual(["toolu_1"])
    expect(decisions).toEqual([])
  })

  it("Allow once resolves allow with the original input and emits decision allow", async () => {
    const { a, decisions } = asks()
    const waiting = a.ask("toolu_1", write("/w/a.txt"), signal())
    expect(
      a.decide({
        type: "permission_decision",
        payload: { requestId: "toolu_1", allow: true, scope: "once" },
      }),
    ).toEqual({ outcome: "applied" })
    expect(await waiting).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/w/a.txt", content: "x" },
    })
    expect(decisions).toEqual([{ requestId: "toolu_1", outcome: "allow", by: "owner" }])
  })

  it("Deny resolves deny without interrupt and emits decision deny", async () => {
    const { a, decisions } = asks()
    const waiting = a.ask("toolu_1", write("/w/a.txt"), signal())
    a.decide({
      type: "permission_decision",
      payload: { requestId: "toolu_1", allow: false, scope: "once" },
    })
    expect(await waiting).toEqual({ behavior: "deny", message: "Denied by the owner." })
    expect(decisions).toEqual([{ requestId: "toolu_1", outcome: "deny", by: "owner" }])
  })

  it("Allow for this session adds a rule for the same tool in the same directory only", async () => {
    const { a, decisions } = asks()
    const waiting = a.ask("toolu_1", write("/w/dir/a.txt"), signal())
    a.decide({
      type: "permission_decision",
      payload: { requestId: "toolu_1", allow: true, scope: "session" },
    })
    expect((await waiting).behavior).toBe("allow")
    expect(decisions[0]).toEqual({ requestId: "toolu_1", outcome: "allow_session", by: "owner" })
    expect(a.rules.match("Write", { file_path: "/w/dir/b.txt" })).toBe(true)
    expect(a.rules.match("Write", { file_path: "/w/other/b.txt" })).toBe(false)
    expect(a.rules.match("Edit", { file_path: "/w/dir/b.txt" })).toBe(false)
  })

  it("the session rule survives a restart through allowed.json", () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    new SessionRules(dir).add("WebFetch", { url: "https://docs.example.com/a" })
    expect(statSync(path.join(dir, "allowed.json")).mode & 0o777).toBe(0o600)
    const again = new SessionRules(dir)
    expect(again.match("WebFetch", { url: "https://docs.example.com/other" })).toBe(true)
    expect(again.match("WebFetch", { url: "https://evil.example.com/a" })).toBe(false)
  })

  it("file rule targets resolve as the guard does: session cwd, ~ and symlinks (m5)", () => {
    const base = realpathSync(mkdtempSync(path.join(root, "m5-")))
    const home = path.join(base, "home")
    const cwd = path.join(base, "repo")
    mkdirSync(path.join(home, "notes"), { recursive: true })
    mkdirSync(path.join(cwd, "src"), { recursive: true })
    symlinkSync(path.join(cwd, "src"), path.join(base, "link"))
    const rules = new SessionRules(undefined, { home, cwd })
    rules.add("Write", { file_path: "~/notes/a.txt" })
    expect(rules.match("Write", { file_path: path.join(home, "notes", "b.txt") })).toBe(true)
    rules.add("Edit", { file_path: "src/a.ts" })
    // Relative to the session's folder, never the sidecar's own cwd.
    expect(rules.match("Edit", { file_path: path.join(cwd, "src", "b.ts") })).toBe(true)
    // Through a symlink: the real folder.
    expect(rules.match("Edit", { file_path: path.join(base, "link", "c.ts") })).toBe(true)
    expect(rules.match("Edit", { file_path: path.join(cwd, "other.ts") })).toBe(false)
    // A `..` spelling the guard refuses matches only itself.
    expect(ruleTarget("Write", { file_path: "../x/a.txt" }, { home, cwd })).toMatch(/^input:/)
  })

  it("rule targets: git push names its remote and branch; any other command is exact", () => {
    expect(ruleTarget("Bash", { command: "git push origin node/fix" })).toBe("push:origin node/fix")
    expect(ruleTarget("Bash", { command: "git push -u origin node/fix" })).toBe(
      "push:origin node/fix",
    )
    expect(ruleTarget("Bash", { command: "rm -rf /" })).toBe("command:rm -rf /")
    expect(ruleTarget("WebSearch", { query: "x" })).toBe("any")
  })

  it("an answer resolves with updatedInput.answers mapped by question text", async () => {
    const { a, decisions } = asks()
    const questions = [{ question: "Pick?", header: "P", options: [], multiSelect: false }]
    const waiting = a.ask(
      "toolu_q",
      { tool: "AskUserQuestion", input: { questions }, kind: "question" },
      signal(),
    )
    expect(
      a.decide({ type: "answer", payload: { requestId: "toolu_q", answers: { "Pick?": "B" } } }),
    ).toEqual({ outcome: "applied" })
    expect(await waiting).toEqual({
      behavior: "allow",
      updatedInput: { questions, answers: { "Pick?": "B" } },
    })
    expect(decisions).toEqual([{ requestId: "toolu_q", outcome: "answered", by: "owner" }])
  })

  it("approving a plan passes setMode default; any other setMode default is still stripped", async () => {
    const { a, decisions } = asks()
    const plan = a.ask(
      "toolu_p",
      { tool: "ExitPlanMode", input: { plan: "1. fix" }, kind: "plan" },
      signal(),
    )
    a.decide({
      type: "permission_decision",
      payload: { requestId: "toolu_p", allow: true, scope: "once" },
    })
    expect(await plan).toEqual({
      behavior: "allow",
      updatedInput: { plan: "1. fix" },
      updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
    })
    expect(decisions).toEqual([{ requestId: "toolu_p", outcome: "allow", by: "owner" }])
    // Anywhere else, a setMode to default, acceptEdits or bypass is dropped.
    const other = a.ask("toolu_2", write("/w/a.txt"), signal())
    a.resolve("toolu_2", {
      behavior: "allow",
      updatedPermissions: [
        { type: "setMode", mode: "default", destination: "session" },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
        { type: "setMode", mode: "bypassPermissions", destination: "session" },
      ],
    })
    expect(await other).toEqual({ behavior: "allow", updatedPermissions: [] })
    expect(
      sanitizePermissionResult(
        {
          behavior: "allow",
          updatedPermissions: [
            { type: "setMode", mode: "bypassPermissions", destination: "session" },
          ],
        },
        { planExit: true },
      ),
    ).toEqual({ behavior: "allow", updatedPermissions: [] })
  })

  it("Keep planning denies the plan without interrupt", async () => {
    const { a, decisions } = asks()
    const plan = a.ask(
      "toolu_p",
      { tool: "ExitPlanMode", input: { plan: "x" }, kind: "plan" },
      signal(),
    )
    a.decide({
      type: "permission_decision",
      payload: { requestId: "toolu_p", allow: false, scope: "once" },
    })
    expect(await plan).toEqual({ behavior: "deny", message: "Keep planning." })
    expect(decisions[0]?.outcome).toBe("deny")
  })

  it("a decision for an unknown or already-decided request is noop", async () => {
    const { a } = asks()
    expect(
      a.decide({
        type: "permission_decision",
        payload: { requestId: "nope", allow: true, scope: "once" },
      }),
    ).toEqual({ outcome: "noop" })
    const w = a.ask("toolu_1", write("/w/a.txt"), signal())
    a.decide({
      type: "permission_decision",
      payload: { requestId: "toolu_1", allow: true, scope: "once" },
    })
    await w
    expect(
      a.decide({
        type: "permission_decision",
        payload: { requestId: "toolu_1", allow: false, scope: "once" },
      }),
    ).toEqual({ outcome: "noop" })
    // An answer to a permission request is not an answer.
    void a.ask("toolu_3", write("/w/a.txt"), signal())
    expect(a.decide({ type: "answer", payload: { requestId: "toolu_3", answers: {} } })).toEqual({
      outcome: "noop",
    })
  })

  it("the process ending emits decision expired for each open request", async () => {
    const { a, decisions } = asks()
    const one = a.ask("toolu_1", write("/w/a.txt"), signal())
    const two = a.ask("toolu_2", write("/w/b.txt"), signal())
    a.denyAll("The session ended.", { outcome: "expired", by: "process_exit" })
    expect(await one).toMatchObject({ behavior: "deny", interrupt: true })
    expect(await two).toMatchObject({ behavior: "deny", interrupt: true })
    expect(decisions).toEqual([
      { requestId: "toolu_1", outcome: "expired", by: "process_exit" },
      { requestId: "toolu_2", outcome: "expired", by: "process_exit" },
    ])
  })
})
