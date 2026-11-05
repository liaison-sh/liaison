// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T07 (S8 transcript, plan, D13): the one place that knows the event
// vocabulary. Events in seq order become the items the view renders: tool calls
// pair with their results, a subagent is one item (S53), requests carry
// their decision, the pinned plan is the latest todo, and nothing is ever a
// JSON dump.
import type { NodeSessionEvent } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import {
  buildTranscript,
  latestPlan,
  oldestPending,
  pendingRequests,
  type TranscriptItem,
  toolArgument,
  toolMeta,
} from "./transcript"

const T0 = Date.parse("2026-10-13T10:00:00.000Z")
let seq = 0

function ev(
  type: NodeSessionEvent["type"],
  payload: Record<string, unknown>,
  over: Partial<NodeSessionEvent> & { atMs?: number } = {},
): NodeSessionEvent & { clientReceivedAt: number } {
  seq++
  const { atMs, ...rest } = over
  const at = atMs ?? T0 + seq * 1000
  return {
    seq,
    at: new Date(at).toISOString(),
    receivedAt: new Date(at + 40).toISOString(),
    type,
    payload,
    clientReceivedAt: at + 60,
    ...rest,
  }
}

const SID = "3f2a9c1e-0000-4000-8000-000000000001"
const ctx = { sessionId: SID, folderName: "my-repo" }

function build(events: NodeSessionEvent[], status: "running" | "done" = "running") {
  return buildTranscript(events, { sessionStatus: status, pathContext: ctx })
}

/** Every string an item shows as text (the raw tool input stays structured). */
function shownStrings(items: TranscriptItem[]): string[] {
  const out: string[] = []
  const walk = (v: unknown, key: string) => {
    if (key === "input" || key === "questions") return
    if (typeof v === "string") out.push(v)
    else if (Array.isArray(v)) for (const x of v) walk(x, key)
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k)
  }
  walk(items, "")
  return out
}

describe("buildTranscript", () => {
  it("a tool_call and its tool_result pair by id, with duration", () => {
    seq = 0
    const items = build([
      ev(
        "tool_call",
        { id: "toolu_1", name: "Bash", input: { command: "wc -l README.md" } },
        {
          atMs: T0,
        },
      ),
      ev(
        "tool_result",
        { id: "toolu_1", isError: false, output: "3 README.md" },
        {
          atMs: T0 + 2500,
        },
      ),
    ])
    expect(items).toHaveLength(1)
    const tool = items[0]
    expect(tool.kind).toBe("tool")
    if (tool.kind !== "tool") return
    expect(tool.name).toBe("Bash")
    expect(tool.argument).toBe("wc -l README.md")
    expect(tool.result?.output).toBe("3 README.md")
    expect(tool.durationMs).toBe(2500)
    expect(tool.running).toBe(false)
    expect(tool.seq).toBe(1)
  })

  it("S53: a Task call is one subagent item; its own events never render in the main transcript", () => {
    seq = 0
    const items = build([
      ev("tool_call", {
        id: "toolu_task",
        name: "Task",
        input: { description: "List the files", subagent_type: "Explore", model: "haiku" },
      }),
      ev(
        "tool_call",
        { id: "toolu_ls", name: "Bash", input: { command: "ls" } },
        { parentToolUseId: "toolu_task" },
      ),
      ev("assistant_text", { text: "inner" }, { parentToolUseId: "toolu_task" }),
      ev("tool_result", { id: "toolu_task", isError: false, output: "done" }),
      // An Agent call whose subagent sent nothing yet is a subagent item too.
      ev("tool_call", { id: "toolu_agent", name: "Agent", input: { description: "Deeper" } }),
    ])
    expect(items.map((i) => i.kind)).toEqual(["subagent", "subagent"])
    const [sub, fresh] = items
    if (sub.kind !== "subagent" || fresh.kind !== "subagent") return
    expect([sub.id, sub.title, sub.description, sub.model]).toEqual([
      "toolu_task",
      "Explore",
      "List the files",
      "haiku",
    ])
    expect(sub.result?.output).toBe("done")
    // No type: the reference names it from the catalogue (m9).
    expect([fresh.id, fresh.title, fresh.model]).toEqual(["toolu_agent", "", null])
  })

  it("S54: task events make no transcript line: the panel and the inline reference show them", () => {
    seq = 0
    const items = build([
      ev("system", { subtype: "task_started", text: "Fix it", data: { taskId: "t" } }),
      ev("system", { subtype: "task_progress", text: "Fix it", data: { taskId: "t" } }),
      ev("system", { subtype: "task_updated", text: "", data: { taskId: "t" } }),
      ev("system", { subtype: "task_notification", text: "completed", data: { taskId: "t" } }),
      ev("system", { subtype: "compact_boundary", text: "Context compacted" }),
    ])
    expect(
      items.map((i) => (i.kind === "dim" && i.type === "system" ? i.subtype : i.kind)),
    ).toEqual(["compact_boundary"])
  })

  it("S53: in a subagent's drawer its own events (all carrying its id) render on top", () => {
    seq = 0
    const items = build([
      ev("assistant_text", { text: "looking" }, { parentToolUseId: "toolu_task" }),
      ev(
        "tool_call",
        { id: "toolu_ls", name: "Bash", input: { command: "ls" } },
        { parentToolUseId: "toolu_task" },
      ),
    ])
    expect(items.map((i) => i.kind)).toEqual(["text", "tool"])
  })

  it("a permission_request with a later decision is resolved, without one pending", () => {
    seq = 0
    const events = [
      ev("permission_request", {
        requestId: "r1",
        tool: "Edit",
        input: { file_path: "/x/my-repo/a.ts" },
        reason: "outside",
      }),
      ev("decision", { requestId: "r1", outcome: "allow", by: "owner" }),
      ev("question", { requestId: "r2", questions: [{ question: "Which?", options: [] }] }),
    ]
    const items = build(events)
    expect(items.map((i) => i.kind)).toEqual(["request", "request"])
    const [a, b] = items
    expect(a.kind === "request" && a.pending).toBe(false)
    expect(a.kind === "request" && a.decision?.outcome).toBe("allow")
    expect(a.kind === "request" && a.argument).toBe("a.ts")
    expect(b.kind === "request" && b.pending).toBe(true)
    expect(pendingRequests(events).map((r) => r.requestId)).toEqual(["r2"])
    expect(oldestPending(events)?.requestId).toBe("r2")
  })

  it("an unknown tool name is a generic tool row with a name", () => {
    seq = 0
    const items = build([
      ev("tool_call", { id: "toolu_x", name: "BrandNewTool", input: { q: "hi" } }),
    ])
    expect(items[0].kind === "tool" && items[0].name).toBe("BrandNewTool")
    expect(items[0].kind === "tool" && items[0].argument).toBe("hi")
    const nameless = build([ev("tool_call", { id: "toolu_y", input: {} })])
    // No name: the model carries none; the row names it from the catalogue (m9).
    expect(nameless[0].kind === "tool" && nameless[0].name).toBe("")
  })

  it("usage and command_applied make no item; unknown types make nothing", () => {
    seq = 0
    const items = build([
      ev("usage", { tokensIn: 1, tokensOut: 2, model: "m" }),
      ev("command_applied", { commandId: "c", type: "message", outcome: "applied" }),
      ev("todo", { items: [], from: "TodoWrite" }),
      { ...ev("assistant_text", { text: "x" }), type: "brand_new" as never },
    ])
    expect(items).toEqual([])
  })

  it("a call without result spins only while the session runs", () => {
    seq = 0
    const events = [ev("tool_call", { id: "toolu_1", name: "Bash", input: { command: "sleep 9" } })]
    expect(build(events, "running")[0]).toMatchObject({ kind: "tool", running: true })
    expect(build(events, "done")[0]).toMatchObject({ kind: "tool", running: false })
  })

  it("no item text contains a JSON object literal", () => {
    seq = 0
    const items = build([
      ev("user_message", { text: "Fix it", commandId: "c1" }),
      ev("assistant_text", { text: "On it." }),
      ev("thinking", { text: "hmm" }),
      ev("tool_call", { id: "toolu_1", name: "Odd", input: { nested: { a: 1 }, list: [1] } }),
      ev("tool_result", { id: "toolu_1", isError: true, output: "Error: no" }),
      ev("todo", { items: [{ content: "a", status: "pending" }], from: "TodoWrite" }),
      ev("permission_request", {
        requestId: "r1",
        tool: "Bash",
        input: { x: { y: 1 } },
        reason: "",
      }),
      ev("question", {
        requestId: "r2",
        questions: [{ question: "Q", options: [{ label: "A" }] }],
      }),
      ev("plan_request", { requestId: "r3", plan: "1. do it" }),
      ev("decision", { requestId: "r3", outcome: "deny", by: "owner" }),
      ev("command_applied", { commandId: "c1", type: "message", outcome: "applied" }),
      ev("status", { status: "waiting" }),
      ev("usage", { tokensIn: 1, tokensOut: 1, model: "m" }),
      ev("model_changed", { from: "a", to: "b" }),
      ev("level_changed", { from: "strict", to: "standard" }),
      ev("resumed", { after: "offline" }),
      ev("system", {
        subtype: "start",
        text: "Claude Code started",
        data: { cwd: "/x", mcp: { a: 1 } },
      }),
      ev("result", { text: "All done", isError: false, subtype: "success", branch: "node/x" }),
    ])
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "text",
      "thinking",
      "tool",
      "request",
      "request",
      "request",
      "dim",
      "dim",
      "dim",
      "dim",
      "dim",
      "result",
    ])
    for (const s of shownStrings(items)) {
      expect(s).not.toMatch(/\{\s*"/)
      expect(s.startsWith("/")).toBe(false)
    }
  })
})

describe("latestPlan", () => {
  it("the latest todo wins; current is the in_progress item", () => {
    seq = 0
    const plan = latestPlan(
      [
        ev("todo", { items: [{ content: "old", status: "pending" }], from: "TodoWrite" }),
        ev("todo", {
          items: [
            { content: "Plan", status: "completed" },
            { content: "List files", status: "in_progress", activeForm: "Listing files" },
            { content: "Edit README", status: "pending" },
          ],
          from: "TodoWrite",
        }),
      ],
      ctx,
    )
    expect(plan).toEqual({
      items: expect.any(Array),
      done: 1,
      total: 3,
      current: "Listing files",
    })
    expect(latestPlan([ev("assistant_text", { text: "x" })], ctx)).toBeNull()
  })

  it("Task* lists (from: Task) count the same way", () => {
    seq = 0
    const plan = latestPlan(
      [
        ev("todo", {
          items: [
            { content: "a", status: "completed" },
            { content: "b", status: "completed" },
            { content: "c", status: "in_progress" },
          ],
          from: "Task",
        }),
      ],
      ctx,
    )
    expect(plan).toMatchObject({ done: 2, total: 3, current: "c" })
  })
})

describe("toolArgument and toolMeta", () => {
  it("names one line per tool, paths relative", () => {
    expect(toolArgument("Read", { file_path: "/Users/me/code/my-repo/src/a.ts" }, ctx)).toBe(
      "src/a.ts",
    )
    expect(toolArgument("Grep", { pattern: "TODO", path: "/x" }, ctx)).toBe("TODO")
    expect(toolArgument("Glob", { pattern: "**/*.ts" }, ctx)).toBe("**/*.ts")
    expect(toolArgument("WebFetch", { url: "https://example.com" }, ctx)).toBe(
      "https://example.com",
    )
    expect(toolArgument("WebSearch", { query: "solid js" }, ctx)).toBe("solid js")
    expect(toolArgument("Skill", { skill: "walk-skill" }, ctx)).toBe("walk-skill")
    expect(toolArgument("TodoWrite", { todos: [1, 2, 3] }, ctx)).toBe("3")
    expect(toolArgument("Bash", { command: "echo a\necho b" }, ctx)).toBe("echo a")
    expect(toolArgument("Odd", { a: { b: 1 } }, ctx)).toBe("")
    expect(toolArgument("Bash", { command: "cat /Users/me/code/my-repo/a.txt" }, ctx)).toBe(
      "cat a.txt",
    )
  })

  it("meta: duration, line count, Grep matches", () => {
    seq = 0
    const [grep, bash] = build([
      ev("tool_call", { id: "toolu_g", name: "Grep", input: { pattern: "x" } }, { atMs: T0 }),
      ev(
        "tool_result",
        { id: "toolu_g", isError: false, output: "a:1\nb:2\n" },
        {
          atMs: T0 + 1000,
        },
      ),
      ev("tool_call", { id: "toolu_b", name: "Bash", input: { command: "ls" } }, { atMs: T0 }),
      ev("tool_result", { id: "toolu_b", isError: false, output: "a\nb\nc" }, { atMs: T0 + 500 }),
    ])
    expect(grep.kind === "tool" && toolMeta(grep)).toEqual({ durationMs: 1000, matches: 2 })
    expect(bash.kind === "tool" && toolMeta(bash)).toEqual({ durationMs: 500, lines: 3 })
  })
})
