// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  NODE_EVENT_LIMITS,
  NODE_SESSION_SYSTEM_SUBTYPES,
  type NodeSessionEventIn,
  nodeSessionEventInSchema,
} from "../../../packages/shared/src/node-session-protocol"
import {
  type BatchClock,
  createNormalizeState,
  EventBatcher,
  type NormalizeState,
  normalize,
  type SessionEventsLine,
  SPILL_CUT_LINE,
  SPILL_MAX_BYTES,
  spillWriter,
} from "./session-events"

const AT = "2026-10-13T10:00:00.000Z"

function state(): NormalizeState {
  return createNormalizeState(() => AT)
}

function assistant(id: string, content: unknown[], usage?: Record<string, number>) {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, model: "claude-opus-5", content, ...(usage ? { usage } : {}) },
  }
}

function userToolResult(
  toolUseId: string,
  content: unknown,
  isError = false,
  toolUseResult?: unknown,
) {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content }],
    },
    ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}),
  }
}

describe("normalize: assistant blocks", () => {
  it("an assistant message with text, thinking and two tool_use blocks yields four events in order", () => {
    const m = assistant("m1", [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "pondering" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x" } },
    ])
    const events = normalize(m, state())
    expect(events.map((e) => e.type)).toEqual([
      "assistant_text",
      "thinking",
      "tool_call",
      "tool_call",
    ])
    expect(events[0].payload).toEqual({ text: "hello" })
    expect(events[1].payload).toEqual({ text: "pondering" })
    expect(events[2].payload).toEqual({ id: "t1", name: "Bash", input: { command: "ls" } })
    expect(events[3].payload).toEqual({ id: "t2", name: "Read", input: { file_path: "/x" } })
  })

  it("a subagent's tool_call carries parentToolUseId", () => {
    const m = {
      ...assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      parent_tool_use_id: "parent-1",
    }
    const [event] = normalize(m, state())
    expect(event.parentToolUseId).toBe("parent-1")
  })

  it("a top-level (non-subagent) message carries no parentToolUseId", () => {
    const m = assistant("m1", [{ type: "text", text: "hi" }])
    const [event] = normalize(m, state())
    expect(event.parentToolUseId).toBeUndefined()
  })
})

describe("normalize: user tool_result", () => {
  it("a string tool_result becomes a tool_result event", () => {
    const m = userToolResult("t1", "ls output")
    const [event] = normalize(m, state())
    expect(event.type).toBe("tool_result")
    expect(event.payload).toEqual({ id: "t1", isError: false, output: "ls output" })
  })

  it("an errored tool_result carries isError true", () => {
    const m = userToolResult("t1", "boom", true)
    const [event] = normalize(m, state())
    expect(event.payload.isError).toBe(true)
  })

  it("a block-array tool_result's text blocks join into the output string", () => {
    const m = userToolResult("t1", [{ type: "text", text: "line one" }])
    const [event] = normalize(m, state())
    expect(event.payload.output).toBe("line one")
  })

  it("a plain user message with no tool_result block yields no events", () => {
    const m = { type: "user", parent_tool_use_id: null, message: { content: "just text" } }
    expect(normalize(m, state())).toEqual([])
  })
})

describe("normalize: TodoWrite", () => {
  it("a TodoWrite tool_use yields its tool_call plus a todo event from TodoWrite", () => {
    const m = assistant("m1", [
      {
        type: "tool_use",
        id: "t1",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
            { content: "Write a test", status: "pending" },
          ],
        },
      },
    ])
    const events = normalize(m, state())
    expect(events.map((e) => e.type)).toEqual(["tool_call", "todo"])
    expect(events[1].payload).toEqual({
      items: [
        { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
        { content: "Write a test", status: "pending" },
      ],
      from: "TodoWrite",
    })
  })
})

describe("normalize: TaskCreate then TaskUpdate", () => {
  it("TaskCreate then TaskUpdate yields the rebuilt todo", () => {
    const s = state()

    // TaskCreate: no todo event yet (TaskCreateInput names no id).
    const create = assistant("m1", [
      { type: "tool_use", id: "tu1", name: "TaskCreate", input: { subject: "Fix tests" } },
    ])
    expect(normalize(create, s).map((e) => e.type)).toEqual(["tool_call"])

    // The matching tool_result mints the real id and now the list has a row.
    const createResult = userToolResult(
      "tu1",
      JSON.stringify({ task: { id: "task-1", subject: "Fix tests" } }),
      false,
      {
        task: { id: "task-1", subject: "Fix tests" },
      },
    )
    const afterCreate = normalize(createResult, s)
    expect(afterCreate.map((e) => e.type)).toEqual(["tool_result", "todo"])
    expect(afterCreate[1].payload).toEqual({
      items: [{ content: "Fix tests", status: "pending" }],
      from: "Task",
    })

    // TaskUpdate addresses the real id directly and rebuilds again.
    const update = assistant("m2", [
      {
        type: "tool_use",
        id: "tu2",
        name: "TaskUpdate",
        input: { taskId: "task-1", status: "in_progress" },
      },
    ])
    const afterUpdate = normalize(update, s)
    expect(afterUpdate.map((e) => e.type)).toEqual(["tool_call", "todo"])
    expect(afterUpdate[1].payload).toEqual({
      items: [{ content: "Fix tests", status: "in_progress" }],
      from: "Task",
    })
  })
})

describe("normalize: usage", () => {
  it("walk D19: a streamed message's usage adds up to its latest figures, even after its first event was sent", () => {
    const s = state()
    const chunk1 = assistant("m1", [{ type: "text", text: "part one" }], {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 0,
    })
    const chunk2 = assistant("m1", [{ type: "text", text: "part two" }], {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
    })
    const chunk3 = assistant("m1", [{ type: "text", text: "part three" }], {
      input_tokens: 10,
      output_tokens: 40,
      cache_read_input_tokens: 2,
    })
    const usage = (events: ReturnType<typeof normalize>) =>
      events.filter((e) => e.type === "usage").map((e) => ({ ...e.payload }))
    // Each event is read as it is produced (the batcher sends it at once).
    const sent = [chunk1, chunk2, chunk3].flatMap((c) => usage(normalize(c, s)))
    // S21: the first chunk also carries the cache split and the context size.
    expect(sent[0]).toEqual({
      tokensIn: 10,
      tokensOut: 1,
      model: "claude-opus-5",
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      contextTokens: 10,
    })
    expect(sent[1]).toEqual({ tokensIn: 2, tokensOut: 4, model: "claude-opus-5" })
    const total = sent.reduce<{ tokensIn: number; tokensOut: number }>(
      (t, p) => ({
        tokensIn: t.tokensIn + (p.tokensIn as number),
        tokensOut: t.tokensOut + (p.tokensOut as number),
      }),
      { tokensIn: 0, tokensOut: 0 },
    )
    expect(total).toEqual({ tokensIn: 12, tokensOut: 40 })
    // The same figures again add nothing.
    expect(usage(normalize(chunk3, s))).toEqual([])
  })
})

describe("walk D19: the result's figures reconcile the session's usage", () => {
  it("a result adds what modelUsage holds beyond the streamed chunks' counts, once per process", () => {
    const s = state()
    normalize({ type: "system", subtype: "init", session_id: "x" }, s)
    const sum = (events: ReturnType<typeof normalize>[]) =>
      events
        .flat()
        .filter((e) => e.type === "usage")
        .reduce(
          (t, e) => ({
            tokensIn: t.tokensIn + (e.payload.tokensIn as number),
            tokensOut: t.tokensOut + (e.payload.tokensOut as number),
          }),
          { tokensIn: 0, tokensOut: 0 },
        )
    const got = [
      normalize(
        assistant("m1", [{ type: "tool_use", id: "t", name: "Bash", input: {} }], {
          input_tokens: 10,
          output_tokens: 3,
        }),
        s,
      ),
      normalize(
        assistant("m2", [{ type: "text", text: "done" }], {
          input_tokens: 8,
          output_tokens: 3,
        }),
        s,
      ),
    ]
    const result = (out: number, inp: number) => ({
      type: "result",
      subtype: "success",
      result: "done",
      is_error: false,
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: inp,
          outputTokens: out,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 0,
        },
        "claude-haiku-5-5": { inputTokens: 5, outputTokens: 2 },
      },
    })
    const first = normalize(result(469, 18), s)
    expect(first.map((e) => e.type)).toEqual(["usage", "result"])
    expect(sum([...got, first])).toEqual({ tokensIn: 18 + 100 + 5, tokensOut: 469 + 2 })
    // modelUsage is cumulative: the next turn's result adds only what grew.
    const second = normalize(result(600, 30), s)
    expect(sum([...got, first, second])).toEqual({ tokensIn: 30 + 100 + 5, tokensOut: 600 + 2 })
    // A restarted process counts from zero again.
    normalize({ type: "system", subtype: "init", session_id: "x" }, s)
    const third = normalize(result(50, 10), s)
    expect(sum([third])).toEqual({ tokensIn: 10 + 100 + 5, tokensOut: 52 })
  })
})

describe("final walk F6b: the result's usage names the model in use", () => {
  it("after a switch, the closing usage names the main thread's latest model, not the one with most tokens", () => {
    const s = state()
    normalize({ type: "system", subtype: "init", session_id: "x" }, s)
    const switched = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m9",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "on it" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }
    normalize(switched, s)
    const out = normalize(
      {
        type: "result",
        subtype: "success",
        result: "done",
        is_error: false,
        modelUsage: {
          "claude-haiku-4-5": { inputTokens: 500, outputTokens: 900 },
          "claude-sonnet-5": { inputTokens: 20, outputTokens: 30 },
        },
      },
      s,
    )
    const usage = out.find((e) => e.type === "usage")
    expect(usage?.payload.model).toBe("claude-sonnet-5")
  })
})

describe("normalize: result", () => {
  it("a result message becomes a result event", () => {
    const m = { type: "result", subtype: "success", result: "done", is_error: false }
    const [event] = normalize(m, state())
    expect(event.type).toBe("result")
    expect(event.payload).toEqual({ text: "done", isError: false, subtype: "success" })
  })
})

describe("normalize: system (compact boundary, api retry, rate limit)", () => {
  it("a compact boundary message becomes a system event", () => {
    const m = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }
    const [event] = normalize(m, state())
    expect(event.type).toBe("system")
    expect(event.payload.subtype).toBe("compact_boundary")
  })

  it("an api retry message becomes a system event", () => {
    const m = { type: "system", subtype: "api_retry", attempt: 1, max_retries: 3 }
    const [event] = normalize(m, state())
    expect(event.type).toBe("system")
    expect(event.payload.subtype).toBe("api_retry")
  })

  it("a rate limit event becomes a system event", () => {
    const m = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }
    const [event] = normalize(m, state())
    expect(event.type).toBe("system")
    expect(event.payload.subtype).toBe("rate_limit")
  })
})

describe("normalize: dropped", () => {
  it("every other SDK message type is dropped and counted, with no events", () => {
    const s = state()
    expect(normalize({ type: "system", subtype: "init" }, s)).toEqual([])
    expect(normalize({ type: "stream_event" }, s)).toEqual([])
    expect(s.dropped).toBe(2)
  })

  it("never emits a raw SDK message: every returned event matches the protocol event shape", () => {
    const m = assistant("m1", [{ type: "text", text: "hi" }])
    const [event] = normalize(m, state())
    expect(Object.keys(event).sort()).toEqual(["at", "payload", "type"].sort())
  })
})

describe("normalize: capping (K11)", () => {
  it("a 70 KiB tool output is truncated with fullBytes", () => {
    const big = "a".repeat(70 * 1024)
    const m = userToolResult("t1", big)
    const [event] = normalize(m, state())
    expect(event.truncated).toBe(true)
    expect(event.fullBytes).toBeGreaterThan(0)
    expect((event.payload.output as string).length).toBeLessThan(big.length)
  })

  it("every event normalised from every fixture passes the shared schema", () => {
    const s = state()
    const fixtures = [
      assistant("m1", [
        { type: "text", text: "hi" },
        { type: "thinking", thinking: "..." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ]),
      userToolResult("t1", "ok"),
      { type: "result", subtype: "success", result: "done", is_error: false },
      { type: "system", subtype: "compact_boundary", compact_metadata: {} },
      { type: "system", subtype: "api_retry", attempt: 1, max_retries: 3 },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    ]
    for (const fixture of fixtures) {
      for (const event of normalize(fixture, s)) {
        expect(() => nodeSessionEventInSchema.parse(event)).not.toThrow()
      }
    }
  })
})

// ---- EventBatcher ----

function fakeClock() {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextId = 1
  const clock: BatchClock = {
    setTimeout: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number)
    },
  }
  return {
    clock,
    /** Fires every scheduled timer whose delay is at most `ms`, once. */
    advance(ms: number) {
      for (const [id, t] of [...timers.entries()]) {
        if (t.ms <= ms) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    pendingTimers() {
      return timers.size
    },
  }
}

function fakeEvent(bytes = 10): NodeSessionEventIn {
  return { at: AT, type: "assistant_text", payload: { text: "x".repeat(bytes) } }
}

describe("EventBatcher", () => {
  it("flushes at 250 ms when the timer fires", () => {
    const { clock, advance } = fakeClock()
    const flushed: SessionEventsLine[] = []
    const batcher = new EventBatcher({ sessionId: "s1", flush: (l) => flushed.push(l), clock })
    batcher.push(fakeEvent())
    expect(flushed).toEqual([])
    advance(249)
    expect(flushed).toEqual([])
    advance(250)
    expect(flushed.length).toBe(1)
    expect(flushed[0]).toEqual({ type: "session_events", sessionId: "s1", events: [fakeEvent()] })
  })

  it("flushes at 64 events without waiting for the timer", () => {
    const { clock } = fakeClock()
    const flushed: SessionEventsLine[] = []
    const batcher = new EventBatcher({ sessionId: "s1", flush: (l) => flushed.push(l), clock })
    for (let i = 0; i < 64; i++) batcher.push(fakeEvent())
    expect(flushed.length).toBe(1)
    expect(flushed[0].events.length).toBe(64)
    expect(batcher.pendingCount).toBe(0)
  })

  it("flushes before the byte limit, never crossing it itself", () => {
    const { clock } = fakeClock()
    const flushed: SessionEventsLine[] = []
    const maxBytes = 1000
    const batcher = new EventBatcher({
      sessionId: "s1",
      flush: (l) => flushed.push(l),
      clock,
      maxBytes,
    })
    // Each event is far smaller than maxBytes; push enough to cross it.
    for (let i = 0; i < 40; i++) batcher.push(fakeEvent(30))
    expect(flushed.length).toBeGreaterThan(0)
    for (const line of flushed) {
      expect(new TextEncoder().encode(JSON.stringify(line.events)).length).toBeLessThanOrEqual(
        maxBytes,
      )
    }
  })

  it("a single event over the byte limit still goes out, alone", () => {
    const { clock } = fakeClock()
    const flushed: SessionEventsLine[] = []
    const batcher = new EventBatcher({
      sessionId: "s1",
      flush: (l) => flushed.push(l),
      clock,
      maxBytes: 100,
    })
    batcher.push(fakeEvent(500))
    expect(flushed.length).toBe(1)
    expect(flushed[0].events.length).toBe(1)
  })

  it("stop() flushes whatever is pending and cancels the timer", () => {
    const { clock, pendingTimers } = fakeClock()
    const flushed: SessionEventsLine[] = []
    const batcher = new EventBatcher({ sessionId: "s1", flush: (l) => flushed.push(l), clock })
    batcher.push(fakeEvent())
    expect(pendingTimers()).toBe(1)
    batcher.stop()
    expect(flushed.length).toBe(1)
    expect(pendingTimers()).toBe(0)
  })

  it("flushNow on an empty batcher is a no-op", () => {
    const { clock } = fakeClock()
    const flushed: SessionEventsLine[] = []
    const batcher = new EventBatcher({ sessionId: "s1", flush: (l) => flushed.push(l), clock })
    batcher.flushNow()
    expect(flushed).toEqual([])
  })

  it("every flushed batch's events pass the shared schema and byte check (K11)", () => {
    const { clock } = fakeClock()
    const flushed: SessionEventsLine[] = []
    const batcher = new EventBatcher({ sessionId: "s1", flush: (l) => flushed.push(l), clock })
    const s = state()
    const messages = [
      assistant("m1", [{ type: "text", text: "hi" }]),
      userToolResult("t1", "ok"),
      { type: "result", subtype: "success", result: "done", is_error: false },
    ]
    for (const m of messages) batcher.pushAll(normalize(m, s))
    batcher.stop()
    expect(flushed.length).toBeGreaterThan(0)
    for (const line of flushed) {
      expect(line.events.length).toBeLessThanOrEqual(NODE_EVENT_LIMITS.batchEvents)
      expect(new TextEncoder().encode(JSON.stringify(line.events)).length).toBeLessThanOrEqual(
        NODE_EVENT_LIMITS.batchBytes,
      )
      for (const event of line.events) {
        expect(() => nodeSessionEventInSchema.parse(event)).not.toThrow()
      }
    }
  })
})

describe("P3-T19 spill files for cut outputs (S7, D3)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "liaison-spill-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("a 100 KiB tool output is spilled whole and the event is cut", () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const st = state()
    st.spill = spillWriter(dir)
    const output = "x".repeat(100 * 1024)
    const [event] = normalize(userToolResult("toolu_big1", output), st)
    if (!event) throw new Error("no event")
    expect(event.truncated).toBe(true)
    expect((event.payload.output as string).length).toBeLessThan(output.length)
    const file = path.join(dir, "spill", "toolu_big1.txt")
    expect(readFileSync(file, "utf8")).toBe(output)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  })

  it("walk D8: Claude Code's own <persisted-output> shows its preview, cut, with the saved file as the full output", () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const config = mkdtempSync(path.join(root, "cfg-"))
    const results = path.join(config, "projects", "-x", "abc", "tool-results")
    mkdirSync(results, { recursive: true })
    const whole = Array.from({ length: 200000 }, (_, i) => String(i + 1)).join("\n")
    const saved = path.join(results, "bzd9dbqp0.txt")
    writeFileSync(saved, whole)
    const preview = "1\n2\n3"
    const cli = `<persisted-output>\nOutput too large (1.2MB). Full output saved to: ${saved}\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`
    const st = state()
    st.spill = spillWriter(dir)
    st.persistedRoot = config
    const [event] = normalize(userToolResult("toolu_seq1", cli), st)
    if (!event) throw new Error("no event")
    expect(event.payload.output).toBe(`${preview}\n...`)
    expect(String(event.payload.output)).not.toContain("persisted-output")
    expect(event.truncated).toBe(true)
    expect(event.fullBytes).toBe(Buffer.byteLength(whole, "utf8"))
    expect(readFileSync(path.join(dir, "spill", "toolu_seq1.txt"), "utf8")).toBe(whole)
    // A file outside the session's config dir is never read: the preview, not cut.
    const outside = path.join(root, "tool-results")
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, "x.txt"), "secret")
    const forged = cli.replace(saved, path.join(outside, "x.txt"))
    const [other] = normalize(userToolResult("toolu_seq2", forged), st)
    expect(other?.payload.output).toBe(`${preview}\n...`)
    expect(other?.truncated).toBeUndefined()
    expect(existsSync(path.join(dir, "spill", "toolu_seq2.txt"))).toBe(false)
    // The unsaved form: its notice, without the markup.
    const dropped = normalize(
      userToolResult(
        "toolu_seq3",
        "<truncated-output>\nOutput too large (3MB). It could not be saved, so only the first 1KB are shown.\n</truncated-output>",
      ),
      st,
    )[0]
    expect(dropped?.payload.output).toBe(
      "Output too large (3MB). It could not be saved, so only the first 1KB are shown.",
    )
  })

  it("a short output spills nothing", () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const st = state()
    st.spill = spillWriter(dir)
    normalize(userToolResult("toolu_small", "ls output"), st)
    expect(existsSync(path.join(dir, "spill"))).toBe(false)
  })

  it("a bad tool id spills nothing", () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    const st = state()
    st.spill = spillWriter(dir)
    normalize(userToolResult("../escape", "y".repeat(NODE_EVENT_LIMITS.fieldBytes + 1)), st)
    normalize(userToolResult("toolu_a/../../b", "y".repeat(NODE_EVENT_LIMITS.fieldBytes + 1)), st)
    expect(existsSync(path.join(dir, "spill"))).toBe(false)
    expect(existsSync(path.join(root, "escape.txt"))).toBe(false)
  })

  it("an output over 20 MiB keeps 20 MiB and says it was cut", () => {
    const dir = mkdtempSync(path.join(root, "s-"))
    spillWriter(dir)("toolu_huge", "é".repeat(SPILL_MAX_BYTES / 2 + 10))
    const kept = readFileSync(path.join(dir, "spill", "toolu_huge.txt"), "utf8")
    expect(kept.endsWith(SPILL_CUT_LINE)).toBe(true)
    expect(kept.includes("\uFFFD")).toBe(false)
    expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(
      SPILL_MAX_BYTES + Buffer.byteLength(SPILL_CUT_LINE, "utf8"),
    )
  })
})

describe("S19: task events are forwarded as system events", () => {
  const started = {
    type: "system",
    subtype: "task_started",
    task_id: "task-1",
    run_id: "run-1",
    tool_use_id: "toolu_agent1",
    description: "Audit the sidecar",
    subagent_type: "Explore",
    task_type: "local_agent",
    is_backgrounded: false,
    spawn_depth: 1,
    prompt: "SECRET PROMPT TEXT",
    uuid: "u1",
    session_id: "s1",
  }

  it("S19: task_started becomes a system event with taskId and taskType, without prompt", () => {
    const s = state()
    const events = normalize(started, s)
    expect(events).toHaveLength(1)
    const [event] = events
    expect(event.type).toBe("system")
    // Top level: the panel builds its rows without loading subagent events.
    expect(event.parentToolUseId).toBeUndefined()
    expect(event.payload).toEqual({
      subtype: "task_started",
      text: "Audit the sidecar",
      data: {
        taskId: "task-1",
        runId: "run-1",
        toolUseId: "toolu_agent1",
        taskType: "local_agent",
        subagentType: "Explore",
        description: "Audit the sidecar",
        isBackgrounded: false,
        spawnDepth: 1,
      },
    })
    expect(JSON.stringify(event)).not.toContain("SECRET PROMPT TEXT")
    expect(s.dropped).toBe(0)
    expect(nodeSessionEventInSchema.safeParse(event).success).toBe(true)
  })

  it("S19: a background shell's task_started is forwarded with its own task type and no subagent type", () => {
    const [event] = normalize(
      {
        type: "system",
        subtype: "task_started",
        task_id: "bash-1",
        tool_use_id: "toolu_bash1",
        description: "bun run dev",
        task_type: "local_bash",
        is_backgrounded: true,
        uuid: "u2",
        session_id: "s1",
      },
      state(),
    )
    expect(event.payload.subtype).toBe("task_started")
    expect(event.payload.data).toEqual({
      taskId: "bash-1",
      toolUseId: "toolu_bash1",
      taskType: "local_bash",
      description: "bun run dev",
      isBackgrounded: true,
    })
  })

  it("S19: the text is the description cut to 200 characters", () => {
    const [event] = normalize({ ...started, description: "x".repeat(500) }, state())
    expect(event.payload.text).toBe("x".repeat(200))
  })

  it("S19: task_notification keeps status", () => {
    const [event] = normalize(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        tool_use_id: "toolu_agent1",
        status: "completed",
        output_file: "/private/out/task-1.txt",
        summary: "Agent finished",
        usage: { total_tokens: 1234, tool_uses: 7, duration_ms: 42000 },
        resource_links: [{ uri: "file:///secret" }],
        skip_transcript: false,
        ambient: false,
        uuid: "u3",
        session_id: "s1",
      },
      state(),
    )
    expect(event.type).toBe("system")
    expect(event.parentToolUseId).toBeUndefined()
    expect(event.payload).toEqual({
      subtype: "task_notification",
      text: "completed",
      data: {
        taskId: "task-1",
        toolUseId: "toolu_agent1",
        status: "completed",
        summary: "Agent finished",
        totalTokens: 1234,
        toolUses: 7,
        durationMs: 42000,
        skipTranscript: false,
        ambient: false,
      },
    })
    const raw = JSON.stringify(event)
    expect(raw).not.toContain("/private/out")
    expect(raw).not.toContain("file:///secret")
  })

  it("S19: task_updated carries the patched status and end time", () => {
    const [event] = normalize(
      {
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: { status: "failed", end_time: 1760500000000, error: "boom", is_backgrounded: true },
        uuid: "u4",
        session_id: "s1",
      },
      state(),
    )
    expect(event.payload).toEqual({
      subtype: "task_updated",
      text: "failed",
      data: {
        taskId: "task-1",
        status: "failed",
        endTime: 1760500000000,
        error: "boom",
        isBackgrounded: true,
      },
    })
  })

  it("S20: every task subtype the node forwards is a named system subtype (task_progress included)", () => {
    for (const subtype of ["task_started", "task_progress", "task_updated", "task_notification"]) {
      const events = normalize({ ...started, subtype, uuid: `u-${subtype}` }, state())
      expect(events.map((e) => e.payload.subtype)).toEqual([subtype])
      expect(NODE_SESSION_SYSTEM_SUBTYPES as readonly string[]).toContain(subtype)
    }
  })

  it("S19: task_progress carries the live tool count and last tool", () => {
    const [event] = normalize(
      {
        type: "system",
        subtype: "task_progress",
        task_id: "task-1",
        tool_use_id: "toolu_agent1",
        description: "Audit the sidecar",
        subagent_type: "Explore",
        usage: { total_tokens: 900, tool_uses: 3, duration_ms: 12000 },
        last_tool_name: "Grep",
        uuid: "u5",
        session_id: "s1",
      },
      state(),
    )
    expect(event.payload).toEqual({
      subtype: "task_progress",
      text: "Audit the sidecar",
      data: {
        taskId: "task-1",
        toolUseId: "toolu_agent1",
        subagentType: "Explore",
        description: "Audit the sidecar",
        totalTokens: 900,
        toolUses: 3,
        durationMs: 12000,
        lastToolName: "Grep",
      },
    })
  })
})

describe("S21: usage carries the cache split and the context size", () => {
  const big = {
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
  }

  it("S21: the first usage chunk carries cacheRead/cacheWrite1h and contextTokens; a repeat chunk adds only output", () => {
    const s = state()
    const first = normalize(assistant("m1", [{ type: "text", text: "a" }], big as never), s)
    const u1 = first.find((e) => e.type === "usage")
    expect(u1?.payload).toEqual({
      tokensIn: 5310,
      tokensOut: 2,
      model: "claude-opus-5",
      cacheRead: 5000,
      cacheWrite5m: 100,
      cacheWrite1h: 200,
      contextTokens: 5310,
    })
    const second = normalize(
      assistant("m1", [{ type: "text", text: "b" }], { ...big, output_tokens: 50 } as never),
      s,
    )
    const u2 = second.find((e) => e.type === "usage")
    expect(u2?.payload).toEqual({ tokensIn: 0, tokensOut: 48, model: "claude-opus-5" })
  })

  it("S21: a chunk without cache_creation has zero 5m/1h writes", () => {
    const [, u] = normalize(
      assistant("m1", [{ type: "text", text: "a" }], {
        input_tokens: 4,
        output_tokens: 1,
        cache_read_input_tokens: 6,
      }),
      state(),
    )
    expect(u.payload).toMatchObject({
      cacheRead: 6,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      contextTokens: 10,
    })
  })

  it("S21: a subagent's usage has no contextTokens", () => {
    const m = {
      ...assistant("m2", [{ type: "text", text: "sub" }], big as never),
      parent_tool_use_id: "toolu_agent1",
    }
    const u = normalize(m, state()).find((e) => e.type === "usage")
    expect(u?.parentToolUseId).toBe("toolu_agent1")
    expect(u?.payload.cacheRead).toBe(5000)
    expect(u?.payload).not.toHaveProperty("contextTokens")
  })

  it("S21: tokensIn sum is unchanged", () => {
    const s = state()
    const chunks = [
      assistant("m1", [{ type: "text", text: "a" }], big as never),
      assistant("m1", [{ type: "text", text: "b" }], { ...big, output_tokens: 9 } as never),
      assistant("m2", [{ type: "text", text: "c" }], {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 5310,
      }),
    ]
    const sum = chunks
      .flatMap((c) => normalize(c, s))
      .filter((e) => e.type === "usage")
      .reduce(
        (t, e) => ({
          tokensIn: t.tokensIn + (e.payload.tokensIn as number),
          tokensOut: t.tokensOut + (e.payload.tokensOut as number),
        }),
        { tokensIn: 0, tokensOut: 0 },
      )
    // A34: input + cache read + cache write per message, outputs at their latest.
    expect(sum).toEqual({ tokensIn: 5310 + 5317, tokensOut: 9 + 3 })
  })

  it("S21: result carries contextWindow from modelUsage", () => {
    const s = state()
    normalize(
      assistant("m1", [{ type: "text", text: "a" }], { input_tokens: 1, output_tokens: 1 }),
      s,
    )
    const out = normalize(
      {
        type: "result",
        subtype: "success",
        result: "done",
        is_error: false,
        modelUsage: {
          "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, contextWindow: 200000 },
          "claude-opus-5": { inputTokens: 1, outputTokens: 1, contextWindow: 1000000 },
        },
      },
      s,
    )
    const result = out.find((e) => e.type === "result")
    expect(result?.payload.contextWindow).toBe(1000000)
  })

  it("S21: a result without the main model's contextWindow has none", () => {
    const out = normalize(
      { type: "result", subtype: "success", result: "done", is_error: false, modelUsage: {} },
      state(),
    )
    expect(out.find((e) => e.type === "result")?.payload).not.toHaveProperty("contextWindow")
  })
})
