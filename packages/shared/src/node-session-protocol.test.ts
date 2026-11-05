// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { z } from "zod"
import {
  activityLine,
  batchBytes,
  capEvent,
  commandLine,
  DRIVEN_ELSEWHERE_CODE,
  driverData,
  eventBytes,
  isEndedSessionStatus,
  isKnownSessionStatus,
  isNeedsYouStatus,
  NODE_EVENT_LIMITS,
  NODE_SESSION_COMMAND_TYPES,
  NODE_SESSION_DEFAULT_CAPS,
  NODE_SESSION_ENDED_STATUSES,
  NODE_SESSION_EVENT_TYPES,
  NODE_SESSION_NEEDS_YOU_STATUSES,
  NODE_SESSION_STATUSES,
  NODE_SESSION_SYSTEM_SUBTYPES,
  type NodeSessionEvent,
  type NodeSessionEventIn,
  nodeSessionAtelierStateSchema,
  nodeSessionBatchSchema,
  nodeSessionCommandSchema,
  nodeSessionCompletionSchema,
  nodeSessionEventInSchema,
  openRequests,
  parseCommandLine,
  questionAnswers,
  rowState,
  sessionStatusForJob,
  sessionTitle,
  singleQuestion,
  splitIntoBatches,
  TOOL_USE_ID_RE,
  toProtocol3Completion,
  wireStatus,
} from "./node-session-protocol"

const KIB = 1024
const utf8 = (s: string) => new TextEncoder().encode(s).length
const at = "2026-10-13T10:00:00.000Z"

function ev(payload: Record<string, unknown>, type = "tool_result"): NodeSessionEventIn {
  return { at, type: type as NodeSessionEventIn["type"], payload }
}

describe("event caps (R21)", () => {
  it("a 70 KiB string field is stored at 64 KiB with truncated and fullBytes", () => {
    const e = ev({ id: "t1", isError: false, output: "a".repeat(70 * KIB) })
    const capped = capEvent(e)
    expect(utf8(capped.payload.output as string)).toBe(64 * KIB)
    expect(capped.truncated).toBe(true)
    expect(capped.fullBytes).toBe(eventBytes(e))
    expect(capped.payload.id).toBe("t1")
  })

  it("an event under every cap is returned unchanged, with no truncated flag", () => {
    const e = ev({ id: "t1", isError: false, output: "short" })
    expect(capEvent(e)).toEqual(e)
    expect(capEvent(e).truncated).toBeUndefined()
  })

  it("a 300 KiB event with four 70 KiB fields ends at or under 256 KiB", () => {
    const e = ev({
      id: "t1",
      a: "a".repeat(70 * KIB),
      b: "b".repeat(70 * KIB),
      nested: { c: "c".repeat(70 * KIB), list: ["d".repeat(70 * KIB)] },
    })
    expect(eventBytes(e)).toBeGreaterThan(256 * KIB)
    const capped = capEvent(e)
    expect(eventBytes(capped)).toBeLessThanOrEqual(NODE_EVENT_LIMITS.eventBytes)
    expect(capped.truncated).toBe(true)
    expect(capped.fullBytes).toBe(eventBytes(e))
    expect(capped.payload.id).toBe("t1")
  })

  it("a 400 KiB payload of 20,000 numbers ends in the omitted fallback with fullBytes (K20)", () => {
    const numbers = Array.from({ length: 20_000 }, (_, i) => 1_000_000_000 + i * 7.123456)
    const e = ev({ id: "t9", requestId: "r9", toolUseId: "u9", values: numbers, other: 1 })
    expect(eventBytes(e)).toBeGreaterThan(256 * KIB)
    const capped = capEvent(e)
    expect(capped.payload).toEqual({ omitted: true, id: "t9", requestId: "r9", toolUseId: "u9" })
    expect(capped.truncated).toBe(true)
    expect(capped.fullBytes).toBe(eventBytes(e))
    expect(eventBytes(capped)).toBeLessThanOrEqual(NODE_EVENT_LIMITS.eventBytes)
  })

  it("capping twice equals capping once", () => {
    for (const e of [
      ev({ output: "x".repeat(70 * KIB) }),
      ev({
        a: "a".repeat(70 * KIB),
        b: "b".repeat(70 * KIB),
        c: "c".repeat(70 * KIB),
        d: "d".repeat(70 * KIB),
      }),
      ev({ values: Array.from({ length: 40_000 }, (_, i) => i * 3.3333) }),
    ]) {
      const once = capEvent(e)
      expect(capEvent(once)).toEqual(once)
    }
  })

  it("a code point is never split", () => {
    // "é" is 2 bytes, "😀" is 4: 65537 bytes cannot be cut at exactly 65536 inside a code point.
    const s = `a${"😀".repeat(16 * KIB + 10)}`
    const capped = capEvent(ev({ output: s }))
    const out = capped.payload.output as string
    expect(utf8(out)).toBeLessThanOrEqual(64 * KIB)
    expect(utf8(out)).toBe(1 + 4 * Math.floor((64 * KIB - 1) / 4))
    expect(out.includes("�")).toBe(false)
    expect(s.startsWith(out)).toBe(true)
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false)
  })
})

describe("batches (D33, K4)", () => {
  it("300 events split 256 + 44", () => {
    const events = Array.from({ length: 300 }, (_, i) => ev({ text: `e${i}` }, "assistant_text"))
    const batches = splitIntoBatches(events)
    expect(batches.map((b) => b.length)).toEqual([256, 44])
    expect(batches.flat()).toEqual(events)
  })

  it("1.5 MiB splits on bytes", () => {
    const events = Array.from({ length: 30 }, () =>
      ev({ text: "z".repeat(50 * KIB) }, "assistant_text"),
    )
    expect(batchBytes(events)).toBeGreaterThan(1.4 * KIB * KIB)
    const batches = splitIntoBatches(events)
    expect(batches.length).toBe(2)
    expect(batches.flat()).toEqual(events)
  })

  it("every batch splitIntoBatches makes fits batchBytes ≤ 1 MiB, including one built to land within 10 bytes of the boundary", () => {
    const max = NODE_EVENT_LIMITS.batchBytes - NODE_EVENT_LIMITS.nodeBatchMargin
    // Build events whose first batch lands within 10 bytes under the node bound.
    const base = ev({ text: "" }, "assistant_text")
    const emptyBytes = eventBytes(base)
    const per = 40 * KIB
    const n = Math.floor(max / (per + emptyBytes + 1))
    const events: NodeSessionEventIn[] = Array.from({ length: n }, () =>
      ev({ text: "y".repeat(per) }, "assistant_text"),
    )
    const used = batchBytes(events)
    // One more event filling the gap to within 10 bytes of max.
    const gap = max - used - 1 - emptyBytes - 5
    events.push(ev({ text: "w".repeat(gap) }, "assistant_text"))
    expect(max - batchBytes(events)).toBeGreaterThanOrEqual(0)
    expect(max - batchBytes(events)).toBeLessThanOrEqual(10)
    events.push(ev({ text: "q" }, "assistant_text"))
    const batches = splitIntoBatches(events)
    expect(batches.length).toBe(2)
    expect(batches[0]?.length).toBe(n + 1)
    for (const b of batches) {
      expect(batchBytes(b)).toBeLessThanOrEqual(max)
      expect(batchBytes(b)).toBeLessThanOrEqual(NODE_EVENT_LIMITS.batchBytes)
      expect(b.length).toBeLessThanOrEqual(NODE_EVENT_LIMITS.batchEvents)
    }
  })

  it("measures bytes as UTF-8 of the JSON, brackets and commas included", () => {
    const a = ev({ text: "é" }, "assistant_text")
    const b = ev({ text: "😀" }, "assistant_text")
    expect(eventBytes(a)).toBe(utf8(JSON.stringify(a)))
    expect(batchBytes([a, b])).toBe(eventBytes(a) + eventBytes(b) + 3)
    expect(batchBytes([])).toBe(2)
  })
})

describe("schemas (K3, K11)", () => {
  it("there are the 18 event types of the protocol", () => {
    expect(NODE_SESSION_EVENT_TYPES.length).toBe(18)
  })

  it("the schemas accept truncated and fullBytes and reject an unknown type", () => {
    const e = {
      at,
      type: "tool_result",
      payload: { id: "1", output: "x" },
      truncated: true,
      fullBytes: 70000,
    }
    expect(nodeSessionEventInSchema.safeParse(e).success).toBe(true)
    expect(nodeSessionEventInSchema.safeParse({ ...e, type: "bogus" }).success).toBe(false)
    expect(nodeSessionEventInSchema.safeParse({ ...e, at: "yesterday" }).success).toBe(false)
    expect(nodeSessionEventInSchema.safeParse({ ...e, fullBytes: -1 }).success).toBe(false)
    const batch = {
      jobId: "8f3c2d4e-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
      leaseGeneration: 1,
      batchNo: 1,
      events: [e],
    }
    expect(nodeSessionBatchSchema.safeParse(batch).success).toBe(true)
    expect(nodeSessionBatchSchema.safeParse({ ...batch, batchNo: 0 }).success).toBe(false)
    expect(nodeSessionBatchSchema.safeParse({ ...batch, jobId: "nope" }).success).toBe(false)
    expect(
      nodeSessionBatchSchema.safeParse({ ...batch, events: Array.from({ length: 257 }, () => e) })
        .success,
    ).toBe(false)
  })

  it("an event the node sends carries no seq: the server numbers events (D33)", () => {
    const parsed = nodeSessionEventInSchema.parse({
      seq: 42,
      at,
      type: "assistant_text",
      payload: { text: "x" },
    })
    expect("seq" in parsed).toBe(false)
  })
})

describe("job to session status", () => {
  it("every job status maps per the table; refused maps to null", () => {
    const online = { pendingCount: 0, nodeOnline: true }
    expect(sessionStatusForJob("queued", online)).toBe("queued")
    expect(sessionStatusForJob("offered", online)).toBe("queued")
    expect(sessionStatusForJob("running", online)).toBe("running")
    expect(sessionStatusForJob("running", { pendingCount: 2, nodeOnline: true })).toBe("waiting")
    expect(sessionStatusForJob("running", { pendingCount: 0, nodeOnline: false })).toBe("paused")
    expect(sessionStatusForJob("done", online)).toBe("done")
    expect(sessionStatusForJob("failed", online)).toBe("failed")
    expect(sessionStatusForJob("interrupted", online)).toBe("failed")
    expect(sessionStatusForJob("cancelled", online)).toBe("stopped")
    expect(sessionStatusForJob("refused", online)).toBeNull()
    expect(sessionStatusForJob("fell_back", online)).toBeNull()
  })
})

describe("title and activity line", () => {
  it("title is the first line, 120 chars max", () => {
    expect(sessionTitle("\n  \nFix the login bug\nmore detail")).toBe("Fix the login bug")
    expect(sessionTitle("x".repeat(300)).length).toBe(120)
    expect(sessionTitle("")).toBe("")
  })

  it("the activity line is at most 200 chars and says what is happening", () => {
    const stored: NodeSessionEvent = {
      ...ev({ text: "\nHello there\nsecond" }, "assistant_text"),
      seq: 1,
      receivedAt: at,
    }
    expect(activityLine(stored)).toBe("Hello there")
    expect(
      activityLine(ev({ id: "1", name: "Bash", input: { command: "ls -la" } }, "tool_call")),
    ).toBe("Bash: ls -la")
    expect(
      activityLine(
        ev({ requestId: "r", tool: "Write", input: {}, reason: "outside" }, "permission_request"),
      ),
    ).toBe("Waiting: permission for Write")
    expect(activityLine(ev({ text: "z".repeat(500) }, "assistant_text"))?.length).toBe(200)
  })
})

// ---- P3 steering protocol ----

const CMD_ID = "0b9f8c3e-2a1d-4e5f-9a8b-7c6d5e4f3a2b"

function sev(seq: number, type: string, payload: Record<string, unknown>): NodeSessionEvent {
  return { at, receivedAt: at, seq, type: type as NodeSessionEvent["type"], payload }
}

describe("steering commands (T01)", () => {
  it("each command type validates its payload and refuses an unknown type", () => {
    const valid: Record<string, unknown> = {
      message: { text: "hello" },
      stop: {},
      set_model: { model: "claude-haiku-4-5" },
      set_level: { level: "standard", confirmationId: CMD_ID },
      permission_decision: { requestId: "r1", allow: true, scope: "once" },
      answer: { requestId: "r1", answers: { "Pick one?": "A" } },
      mark_done: { summary: "shipped" },
      set_effort: { effort: "high" },
      set_autonomy: { autonomy: "autonomous" },
      stop_task: { taskId: "task_1" },
      take_over: {},
    }
    for (const type of NODE_SESSION_COMMAND_TYPES) {
      expect(nodeSessionCommandSchema.safeParse({ type, payload: valid[type] }).success).toBe(true)
    }
    const invalid: Array<[string, unknown]> = [
      ["message", { text: "" }],
      ["message", { text: "x".repeat(100_001) }],
      ["set_model", { model: "" }],
      ["set_level", { level: "root" }],
      ["set_level", { level: "open", confirmationId: "not-a-uuid" }],
      ["permission_decision", { requestId: "r1", allow: true, scope: "forever" }],
      ["permission_decision", { requestId: "", allow: false, scope: "once" }],
      ["answer", { requestId: "r1", answers: { q: "x".repeat(10_001) } }],
      [
        "answer",
        {
          requestId: "r1",
          answers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, "a"])),
        },
      ],
    ]
    for (const [type, payload] of invalid) {
      expect(nodeSessionCommandSchema.safeParse({ type, payload }).success).toBe(false)
    }
    expect(nodeSessionCommandSchema.safeParse({ type: "rm_rf", payload: {} }).success).toBe(false)
  })

  it("a command line round-trips and a payload with a newline stays one line", () => {
    const cmd = {
      type: "command" as const,
      commandId: CMD_ID,
      seq: 3,
      command: { type: "message" as const, payload: { text: "line one\nline two\r\nthree" } },
    }
    const line = commandLine(cmd)
    expect(line.includes("\n")).toBe(false)
    expect(line.includes("\r")).toBe(false)
    expect(parseCommandLine(line)).toEqual(cmd)
    expect(parseCommandLine("not json")).toBeNull()
    expect(parseCommandLine(JSON.stringify({ ...cmd, seq: 0 }))).toBeNull()
    expect(parseCommandLine(JSON.stringify({ ...cmd, type: "abort" }))).toBeNull()
    expect(
      parseCommandLine(JSON.stringify({ ...cmd, command: { type: "nope", payload: {} } })),
    ).toBeNull()
  })

  it("answers map each question to its label, multi-select comma-joined, Other as free text", () => {
    const questions = [
      {
        question: "Pick one?",
        header: "One",
        multiSelect: false,
        options: [{ label: "A" }, { label: "B" }],
      },
      {
        question: "Pick some?",
        header: "Some",
        multiSelect: true,
        options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
      },
      { question: "Name?", header: "Name", multiSelect: false, options: [{ label: "Bob" }] },
    ]
    expect(
      questionAnswers(questions, {
        "Pick one?": ["B"],
        "Pick some?": ["X", "Z"],
        "Name?": { other: "Alice" },
      }),
    ).toEqual({ "Pick one?": "B", "Pick some?": "X, Z", "Name?": "Alice" })
    // A question without a pick is left out.
    expect(questionAnswers(questions, { "Pick one?": ["A"] })).toEqual({ "Pick one?": "A" })
  })

  it("singleQuestion is null with two open questions or one question holding two entries", () => {
    const q1 = sev(1, "question", { requestId: "q1", questions: [{ question: "A or B?" }] })
    expect(singleQuestion([q1])).toEqual({ requestId: "q1", question: "A or B?" })
    const q2 = sev(2, "question", { requestId: "q2", questions: [{ question: "C or D?" }] })
    expect(singleQuestion([q1, q2])).toBeNull()
    const two = sev(1, "question", {
      requestId: "q3",
      questions: [{ question: "one?" }, { question: "two?" }],
    })
    expect(singleQuestion([two])).toBeNull()
    // Closing q2 leaves q1 the only open question.
    const closed = sev(3, "decision", { requestId: "q2", outcome: "answered", by: "owner" })
    expect(singleQuestion([q1, q2, closed])).toEqual({ requestId: "q1", question: "A or B?" })
    expect(singleQuestion([])).toBeNull()
  })

  it("a decision closes its request in openRequests", () => {
    const events = [
      sev(1, "permission_request", { requestId: "p1", tool: "Write", input: {}, reason: "" }),
      sev(2, "assistant_text", { text: "hi" }),
      sev(3, "plan_request", { requestId: "p2", plan: "do it" }),
      sev(4, "question", { requestId: "p3", questions: [] }),
      sev(5, "decision", { requestId: "p1", outcome: "allow", by: "owner" }),
    ]
    expect(openRequests(events).map((e) => e.payload.requestId)).toEqual(["p2", "p3"])
  })

  it("TOOL_USE_ID_RE refuses ../x", () => {
    expect(TOOL_USE_ID_RE.test("toolu_01AbC-d_9")).toBe(true)
    expect(TOOL_USE_ID_RE.test("../x")).toBe(false)
    expect(TOOL_USE_ID_RE.test("toolu_../x")).toBe(false)
    expect(TOOL_USE_ID_RE.test("toolu_")).toBe(false)
  })

  it("default caps are 4 live and 2 background (D35)", () => {
    expect(NODE_SESSION_DEFAULT_CAPS).toEqual({ maxLive: 4, maxBackground: 2 })
  })
})

describe("T01 shared vocabulary", () => {
  it("S1: needs_you is a status and an ended status", () => {
    expect((NODE_SESSION_STATUSES as readonly string[]).includes("needs_you")).toBe(true)
    expect([...NODE_SESSION_ENDED_STATUSES]).toEqual(["done", "needs_you", "stopped", "failed"])
    expect([...NODE_SESSION_NEEDS_YOU_STATUSES]).toEqual(["waiting", "needs_you"])
    expect(isEndedSessionStatus("needs_you")).toBe(true)
    expect(isEndedSessionStatus("running")).toBe(false)
    expect(isNeedsYouStatus("waiting")).toBe(true)
    expect(isNeedsYouStatus("done")).toBe(false)
  })

  it("S7: the mark_done command parses, a 301-char summary is refused", () => {
    expect(nodeSessionCommandSchema.safeParse({ type: "mark_done", payload: {} }).success).toBe(
      true,
    )
    expect(
      nodeSessionCommandSchema.safeParse({
        type: "mark_done",
        payload: { summary: "x".repeat(300) },
      }).success,
    ).toBe(true)
    expect(
      nodeSessionCommandSchema.safeParse({
        type: "mark_done",
        payload: { summary: "x".repeat(301) },
      }).success,
    ).toBe(false)
    expect((NODE_SESSION_COMMAND_TYPES as readonly string[]).includes("mark_done")).toBe(true)
  })

  it("S54: stop_task names one subagent's task id; an empty or missing id is refused", () => {
    expect(
      nodeSessionCommandSchema.safeParse({ type: "stop_task", payload: { taskId: "t1" } }).success,
    ).toBe(true)
    for (const payload of [{}, { taskId: "" }, { taskId: "x".repeat(201) }]) {
      expect(nodeSessionCommandSchema.safeParse({ type: "stop_task", payload }).success).toBe(false)
    }
  })

  it("S24: set_effort accepts null and each level, refuses 'extreme'", () => {
    for (const effort of [null, "low", "medium", "high", "xhigh", "max"]) {
      expect(
        nodeSessionCommandSchema.safeParse({ type: "set_effort", payload: { effort } }).success,
      ).toBe(true)
    }
    expect(
      nodeSessionCommandSchema.safeParse({ type: "set_effort", payload: { effort: "extreme" } })
        .success,
    ).toBe(false)
  })

  it("S1: sessionStatusForJob(done, completed:false) is needs_you, completed:true is done", () => {
    const base = { pendingCount: 0, nodeOnline: true }
    expect(sessionStatusForJob("done", { ...base, completed: false })).toBe("needs_you")
    expect(sessionStatusForJob("done", { ...base, completed: true })).toBe("done")
  })

  it("S2: completion schema refuses an unknown `by`", () => {
    expect(nodeSessionCompletionSchema.safeParse({ by: "session", summary: "ok" }).success).toBe(
      true,
    )
    expect(
      nodeSessionCompletionSchema.safeParse({ by: "needs_you", reason: "stuck" }).success,
    ).toBe(true)
    expect(nodeSessionCompletionSchema.safeParse({ by: "robot" }).success).toBe(false)
    expect(nodeSessionCompletionSchema.safeParse({ by: "owner", extra: 1 }).success).toBe(false)
    expect(
      nodeSessionCompletionSchema.safeParse({ by: "session", summary: "x".repeat(301) }).success,
    ).toBe(false)
  })

  it("S9: wireStatus maps needs_you to waiting and leaves the others; rowState prefers state", () => {
    expect(wireStatus("needs_you")).toBe("waiting")
    for (const s of NODE_SESSION_STATUSES) if (s !== "needs_you") expect(wireStatus(s)).toBe(s)
    expect(rowState({ status: "waiting", state: "needs_you" })).toBe("needs_you")
    expect(rowState({ status: "running" })).toBe("running")
    expect(isKnownSessionStatus("needs_you")).toBe(true)
    expect(isKnownSessionStatus("brand_new")).toBe(false)
  })

  it("S51: message accepts confirmDrivenElsewhere; the driver subtype and its data are one shape", () => {
    const confirmed = nodeSessionCommandSchema.safeParse({
      type: "message",
      payload: { text: "go on", confirmDrivenElsewhere: true },
    })
    expect(confirmed.success).toBe(true)
    expect(
      confirmed.success && confirmed.data.type === "message" && confirmed.data.payload,
    ).toEqual({ text: "go on", confirmDrivenElsewhere: true })
    // An old web never sends it: the message is still valid, unconfirmed.
    const plain = nodeSessionCommandSchema.safeParse({ type: "message", payload: { text: "hi" } })
    expect(plain.success && plain.data.type === "message" && plain.data.payload).toEqual({
      text: "hi",
    })
    expect(
      nodeSessionCommandSchema.safeParse({
        type: "message",
        payload: { text: "hi", confirmDrivenElsewhere: "yes" },
      }).success,
    ).toBe(false)
    expect(NODE_SESSION_SYSTEM_SUBTYPES).toContain("driver")
    expect(DRIVEN_ELSEWHERE_CODE).toBe("driven_elsewhere")
    expect(driverData({ elsewhere: true, via: "vscode" })).toEqual({
      elsewhere: true,
      via: "vscode",
      orphan: null,
    })
    expect(driverData({ elsewhere: false })).toEqual({ elsewhere: false, via: null, orphan: null })
    expect(driverData({ elsewhere: true, via: "emacs" })).toEqual({
      elsewhere: true,
      via: null,
      orphan: null,
    })
    expect(driverData({ via: "cli" })).toBeNull()
    expect(driverData(null)).toBeNull()
  })

  it("D33: an orphaned Claude process is read with its pid and the CLI's session id; a pid of 1 or below is none", () => {
    expect(
      driverData({ elsewhere: true, via: null, orphanPid: 5093, cliSessionId: "41173e76" }),
    ).toEqual({ elsewhere: true, via: null, orphan: { pid: 5093, cliSessionId: "41173e76" } })
    expect(driverData({ elsewhere: true, via: null, orphanPid: 1 })?.orphan).toBeNull()
    expect(driverData({ elsewhere: true, via: null, orphanPid: "5093" })?.orphan).toBeNull()
    expect(driverData({ elsewhere: false, via: null, orphanPid: 5093 })?.orphan).toBeNull()
  })
})

describe("wave 2 shared vocabulary", () => {
  it("S30: set_autonomy parses guided/autonomous and refuses 'yolo'", () => {
    for (const autonomy of ["guided", "autonomous"]) {
      expect(
        nodeSessionCommandSchema.safeParse({ type: "set_autonomy", payload: { autonomy } }).success,
      ).toBe(true)
    }
    expect(
      nodeSessionCommandSchema.safeParse({ type: "set_autonomy", payload: { autonomy: "yolo" } })
        .success,
    ).toBe(false)
  })

  const atelier = {
    id: "p1",
    rung: "R2",
    phase: "execute",
    plan: ["frame", "execute"],
    done: ["frame"],
    status: "running",
    awaiting: null,
    boards: [{ title: "Proof", url: "https://example.com/b" }],
  }

  it("S35: the atelier schema refuses status 'paused', a javascript: board URL, a 13th plan item, and over-long strings", () => {
    expect(nodeSessionAtelierStateSchema.safeParse(atelier).success).toBe(true)
    const bad = (patch: Record<string, unknown>) =>
      nodeSessionAtelierStateSchema.safeParse({ ...atelier, ...patch }).success
    expect(bad({ status: "paused" })).toBe(false)
    expect(bad({ awaiting: "someone" })).toBe(false)
    expect(bad({ boards: [{ title: "x", url: "javascript:alert(1)" }] })).toBe(false)
    expect(bad({ boards: [{ title: "x", url: "http://example.com" }] })).toBe(false)
    expect(bad({ plan: Array.from({ length: 13 }, (_, i) => `p${i}`) })).toBe(false)
    expect(bad({ plan: Array.from({ length: 12 }, (_, i) => `p${i}`) })).toBe(true)
    expect(bad({ phase: "x".repeat(41) })).toBe(false)
    expect(bad({ failureReason: "x".repeat(301) })).toBe(false)
    expect(bad({ extra: 1 })).toBe(false)
  })

  it("S57: completion.prUrl accepts https and refuses http and javascript:", () => {
    const parse = (prUrl: string) =>
      nodeSessionCompletionSchema.safeParse({ by: "atelier", prUrl }).success
    expect(parse("https://example.com/o/r/pull/3")).toBe(true)
    expect(parse("http://example.com/o/r/pull/3")).toBe(false)
    expect(parse("javascript:alert(1)")).toBe(false)
  })

  it("S32: completion.reasonCode accepts stuck_after_5_continues and refuses an unknown code", () => {
    expect(
      nodeSessionCompletionSchema.safeParse({
        by: "needs_you",
        reasonCode: "stuck_after_5_continues",
      }).success,
    ).toBe(true)
    expect(
      nodeSessionCompletionSchema.safeParse({ by: "needs_you", reasonCode: "bored" }).success,
    ).toBe(false)
  })

  it("S57: toProtocol3Completion of an atelier completion parses under the protocol-3 schema and carries no new key", () => {
    // A copy of the W1 (protocol 3) schema.
    const w1 = z
      .object({
        by: z.enum(["session", "needs_you", "owner"]),
        summary: z.string().max(300).optional(),
        reason: z.string().max(300).optional(),
      })
      .strict()
    const out = toProtocol3Completion({
      by: "atelier",
      summary: "done",
      prUrl: "https://example.com/o/r/pull/3",
      reasonCode: "pr_missing",
    })
    expect(w1.safeParse(out).success).toBe(true)
    expect(out).toEqual({ by: "session", summary: "done", reason: "pr_missing" })
    const kept = toProtocol3Completion({
      by: "needs_you",
      reason: "mine",
      reasonCode: "push_failed",
    })
    expect(kept).toEqual({ by: "needs_you", reason: "mine" })
  })
})

describe("wave 3 import vocabulary", () => {
  it("S40: import is a session source and take_over a server-applied command", async () => {
    const m = await import("./node-session-protocol")
    expect(m.NODE_SESSION_SOURCES).toContain("import")
    expect(m.NODE_IMPORT_MODES).toEqual(["follow", "take_over"])
    expect(m.NODE_IMPORT_FROM).toEqual(["vscode", "cli", "other"])
    expect(m.NODE_PROTOCOL_IMPORT).toBe(5)
    expect(m.NODE_SESSION_REASON_CODES).toContain("imported")
    expect(m.NODE_SESSION_REASON_CODES).toContain("follow_ended")
    expect(m.NODE_SESSION_SYSTEM_SUBTYPES).toContain("imported")
    expect(m.NODE_SESSION_SYSTEM_SUBTYPES).toContain("follow")
    expect(m.NODE_SESSION_COMMAND_TYPES).toContain("take_over")
    expect(m.nodeSessionCommandSchema.safeParse({ type: "take_over", payload: {} }).success).toBe(
      true,
    )
  })
})
