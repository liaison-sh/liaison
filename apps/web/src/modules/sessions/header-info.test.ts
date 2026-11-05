// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S20, S22, S54 (D21) and S55 (D23): the header's derived figures, from the
// events the node forwards (T08's shapes) and the row's token counters (T04).
import type { NodeSessionEvent } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import {
  cacheState,
  context,
  contextPercent,
  drivenElsewhere,
  driver,
  driverKey,
  formatCountdown,
  markOrphanStopped,
  middleTruncate,
  resetStoppedOrphans,
  STUCK_AFTER_MS,
  subagents,
  tokenSplit,
} from "./header-info"

const T0 = Date.parse("2026-10-15T12:00:00.000Z")
const MIN = 60_000
let seq = 0
function ev(
  atMs: number,
  type: NodeSessionEvent["type"],
  payload: Record<string, unknown>,
  parentToolUseId?: string,
): NodeSessionEvent {
  seq++
  return {
    seq,
    at: new Date(atMs).toISOString(),
    receivedAt: new Date(atMs).toISOString(),
    type,
    payload,
    ...(parentToolUseId ? { parentToolUseId } : {}),
  } as NodeSessionEvent
}
const task = (atMs: number, subtype: string, data: Record<string, unknown>) =>
  ev(atMs, "system", { subtype, text: String(data.description ?? ""), data })
const usage = (atMs: number, extra: Record<string, unknown>, parent?: string) =>
  ev(atMs, "usage", { tokensIn: 10, tokensOut: 1, model: "m", ...extra }, parent)

describe("subagents (S20, S54)", () => {
  it("S20: two local_agent starts and one notification give 1 running, 1 done; a local_bash task is not counted", () => {
    const events = [
      task(T0, "task_started", {
        taskId: "a",
        toolUseId: "tu_a",
        taskType: "local_agent",
        subagentType: "Explore",
        description: "Find the sum bug",
      }),
      task(T0, "task_started", {
        taskId: "b",
        toolUseId: "tu_b",
        taskType: "local_agent",
        description: "Write the test",
      }),
      task(T0, "task_started", { taskId: "sh", taskType: "local_bash", description: "bun dev" }),
      task(T0 + MIN, "task_notification", { taskId: "a", status: "completed" }),
      task(T0 + MIN, "task_notification", { taskId: "sh", status: "completed" }),
    ]
    const s = subagents(events, T0 + 2 * MIN)
    expect([s.running, s.stuck, s.done]).toEqual([1, 0, 1])
    expect(s.list.map((x) => [x.taskId, x.state])).toEqual([
      ["b", "running"],
      ["a", "done"],
    ])
    expect(s.list[1]).toMatchObject({
      toolUseId: "tu_a",
      subagentType: "Explore",
      description: "Find the sum bug",
      endedAt: T0 + MIN,
    })
  })

  it("S20: a notification without a start, a skipTranscript and an ambient task are ignored; a subagentType alone counts", () => {
    const events = [
      task(T0, "task_notification", { taskId: "ghost", status: "completed" }),
      task(T0, "task_started", { taskId: "x", taskType: "local_agent", skipTranscript: true }),
      task(T0, "task_started", { taskId: "y", taskType: "local_agent", ambient: true }),
      task(T0, "task_started", { taskId: "z", subagentType: "general-purpose" }),
    ]
    const s = subagents(events, T0 + MIN)
    expect(s.list.map((x) => x.taskId)).toEqual(["z"])
    expect([s.running, s.done]).toEqual([1, 0])
  })

  it("S54: end from data.endTime; task_progress carries the tool count and the last tool; a failed notification is finished", () => {
    const events = [
      task(T0, "task_started", { taskId: "a", toolUseId: "tu_a", taskType: "local_agent" }),
      task(T0 + MIN, "task_progress", { taskId: "a", toolUses: 7, lastToolName: "Grep" }),
      task(T0 + 2 * MIN, "task_updated", {
        taskId: "a",
        status: "completed",
        endTime: T0 + 90_000,
      }),
      task(T0, "task_started", { taskId: "b", taskType: "local_agent" }),
      task(T0 + MIN, "task_notification", { taskId: "b", status: "failed" }),
    ]
    const s = subagents(events, T0 + 3 * MIN)
    const a = s.list.find((x) => x.taskId === "a")
    expect(a).toMatchObject({
      state: "done",
      endedAt: T0 + 90_000,
      toolUses: 7,
      lastToolName: "Grep",
    })
    expect(s.list.find((x) => x.taskId === "b")?.state).toBe("failed")
    expect([s.running, s.stuck, s.done]).toEqual([0, 0, 2])
  })

  it("S54, D31a: a subagent with no event of its own for 4 min is stuck, even mid tool call, and sorted first", () => {
    const events = [
      task(T0, "task_started", { taskId: "quiet", toolUseId: "tu_q", taskType: "local_agent" }),
      task(T0, "task_started", { taskId: "busy", toolUseId: "tu_b", taskType: "local_agent" }),
      // busy's own tool call never returns: an open call is no exemption.
      ev(T0 + 10_000, "tool_call", { id: "c1", name: "Bash", input: {} }, "tu_b"),
      task(T0 + 30_000, "task_started", {
        taskId: "fresh",
        toolUseId: "tu_f",
        taskType: "local_agent",
      }),
    ]
    const s = subagents(events, T0 + 10_000 + STUCK_AFTER_MS + 1000)
    expect(s.list.map((x) => [x.taskId, x.state])).toEqual([
      ["quiet", "stuck"],
      ["busy", "stuck"],
      ["fresh", "running"],
    ])
    expect([s.running, s.stuck, s.done]).toEqual([1, 2, 0])
    // Its own events move the clock: just under 4 min after its call it runs.
    expect(
      subagents(events, T0 + 10_000 + STUCK_AFTER_MS - 1000).list.find((x) => x.taskId === "busy")
        ?.state,
    ).toBe("running")
    // Just under 4 min is still running.
    expect(subagents(events, T0 + STUCK_AFTER_MS - 1000).stuck).toBe(0)
  })
})

describe("subagents without their own events (S53, S54)", () => {
  it("S54, D31a: with no subagent event held, a task_progress naming a tool does not keep it running past 4 min; the tool is kept for the badge", () => {
    const events = [
      task(T0, "task_started", { taskId: "t", toolUseId: "tu_t", taskType: "local_agent" }),
      task(T0 + 10_000, "task_progress", { taskId: "t", toolUses: 3, lastToolName: "Bash" }),
      task(T0, "task_started", { taskId: "q", toolUseId: "tu_q", taskType: "local_agent" }),
      task(T0 + 20_000, "task_progress", { taskId: "q", toolUses: 2 }),
    ]
    const s = subagents(events, T0 + 20_000 + STUCK_AFTER_MS + 1000)
    expect(s.list.map((x) => [x.taskId, x.state, x.lastToolName])).toEqual([
      ["t", "stuck", "Bash"],
      ["q", "stuck", null],
    ])
    expect(s.list.find((x) => x.taskId === "t")?.lastEventAt).toBe(T0 + 10_000)
    // Under 4 min since its last progress it is running.
    expect(
      subagents(events, T0 + 10_000 + STUCK_AFTER_MS - 1000).list.find((x) => x.taskId === "t")
        ?.state,
    ).toBe("running")
  })

  it("S54: a second start of the same task is a resume: running again and marked resumed; the model comes from its Agent call", () => {
    const events = [
      ev(T0 - 1000, "tool_call", {
        id: "tu_r",
        name: "Agent",
        input: { description: "Fix it", subagent_type: "general-purpose", model: "sonnet" },
      }),
      task(T0, "task_started", { taskId: "r", toolUseId: "tu_r", taskType: "local_agent" }),
      task(T0 + MIN, "task_notification", { taskId: "r", status: "completed" }),
      task(T0 + 2 * MIN, "task_started", {
        taskId: "r",
        toolUseId: "tu_r",
        taskType: "local_agent",
      }),
    ]
    const [r] = subagents(events, T0 + 2 * MIN + 1000).list
    expect(r).toMatchObject({ state: "running", resumed: true, endedAt: null, model: "sonnet" })
    const once = subagents(events.slice(0, 3), T0 + 2 * MIN).list[0]
    expect(once).toMatchObject({ state: "done", resumed: false })
  })
})

describe("cacheState (S22)", () => {
  it("S22: a usage 4 min ago with a 5m write gives 1:00 left; 6 min ago is cold; a 1h write 30 min ago gives 30:00", () => {
    const five = [usage(T0, { cacheRead: 0, cacheWrite5m: 900, cacheWrite1h: 0 })]
    const warm = cacheState(five, T0 + 4 * MIN)
    expect(warm).toEqual({ state: "warm", remainingMs: MIN, ttl: "5m" })
    expect(formatCountdown(warm.state === "warm" ? warm.remainingMs : 0)).toBe("1:00")
    expect(cacheState(five, T0 + 6 * MIN).state).toBe("cold")
    const hour = [usage(T0, { cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 900 })]
    const h = cacheState(hour, T0 + 30 * MIN)
    expect(h.state === "warm" && formatCountdown(h.remainingMs)).toBe("30:00")
  })

  it("S22: a read-only usage after a 1h write keeps the 1h TTL", () => {
    const events = [
      usage(T0, { cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 900 }),
      usage(T0 + 10 * MIN, { cacheRead: 900, cacheWrite5m: 0, cacheWrite1h: 0 }),
    ]
    expect(cacheState(events, T0 + 20 * MIN)).toEqual({
      state: "warm",
      remainingMs: 50 * MIN,
      ttl: "1h",
    })
  })

  it("S22: no call is cold; a subagent's call and a delta chunk do not refresh the main cache", () => {
    expect(cacheState([], T0)).toEqual({ state: "cold" })
    const events = [
      usage(T0, { cacheRead: 0, cacheWrite5m: 900, cacheWrite1h: 0 }),
      usage(T0 + 4 * MIN, { cacheRead: 10, cacheWrite5m: 5, cacheWrite1h: 0 }, "tu_a"),
      // A later chunk of the same message: no split, not a call.
      usage(T0 + 4 * MIN, {}),
    ]
    expect(cacheState(events, T0 + 6 * MIN).state).toBe("cold")
  })

  it("S22: an older node sends no split: its last main-thread usage counts, at 5 min", () => {
    const events = [usage(T0, {}), usage(T0 + MIN, {})]
    expect(cacheState(events, T0 + 3 * MIN)).toEqual({
      state: "warm",
      remainingMs: 3 * MIN,
      ttl: "5m",
    })
  })
})

describe("context (S22, D23)", () => {
  it("S22: context 50% from 100k of 200k", () => {
    const events = [
      usage(T0, { contextTokens: 80_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }),
      ev(T0 + 1, "result", { text: "ok", contextWindow: 200_000 }),
      usage(T0 + 2, { contextTokens: 100_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }),
      // A subagent's usage carries no contextTokens (S21) and never counts.
      usage(T0 + 3, { cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: 0 }, "tu_a"),
    ]
    expect(contextPercent(events)).toBe(50)
    expect(context(events)).toEqual({ tokens: 100_000, window: 200_000, percent: 50 })
  })

  it("S22: hidden until both the context and the window are known", () => {
    expect(contextPercent([usage(T0, { contextTokens: 1000 })])).toBeNull()
    expect(contextPercent([ev(T0, "result", { text: "", contextWindow: 200_000 })])).toBeNull()
  })
})

describe("tokenSplit (S55, D23)", () => {
  it("S55: in = uncached input + cache writes, out, the breakdown and the hit rate", () => {
    const s = tokenSplit({
      tokensIn: 1_000_000,
      tokensOut: 12_000,
      tokensCacheRead: 900_000,
      tokensCacheWrite5m: 40_000,
      tokensCacheWrite1h: 20_000,
    })
    expect(s).toEqual({
      kind: "split",
      in: 100_000,
      out: 12_000,
      uncached: 40_000,
      cacheWrite5m: 40_000,
      cacheWrite1h: 20_000,
      cacheRead: 900_000,
      hitRate: 0.9,
    })
  })

  it("S55: a session with no input has no hit rate (never NaN%)", () => {
    expect(
      tokenSplit({
        tokensIn: 0,
        tokensOut: 0,
        tokensCacheRead: 0,
        tokensCacheWrite5m: 0,
        tokensCacheWrite1h: 0,
      }),
    ).toEqual({
      kind: "split",
      in: 0,
      out: 0,
      uncached: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      hitRate: null,
    })
  })

  it("S55: a split larger than the input (incomplete across a node upgrade) keeps the single total; the hit rate never passes 100%", () => {
    // Cache reads counted while the input of older batches was not: the split cannot be trusted.
    expect(
      tokenSplit({
        tokensIn: 50_000,
        tokensOut: 2_000,
        tokensCacheRead: 80_000,
        tokensCacheWrite5m: 0,
        tokensCacheWrite1h: 0,
      }),
    ).toEqual({ kind: "total", total: 52_000 })
    expect(
      tokenSplit({
        tokensIn: 50_000,
        tokensOut: 2_000,
        tokensCacheRead: 40_000,
        tokensCacheWrite5m: 8_000,
        tokensCacheWrite1h: 4_000,
      }),
    ).toEqual({ kind: "total", total: 52_000 })
    // Every input token read from the cache: exactly 100%.
    const all = tokenSplit({
      tokensIn: 50_000,
      tokensOut: 2_000,
      tokensCacheRead: 50_000,
      tokensCacheWrite5m: 0,
      tokensCacheWrite1h: 0,
    })
    expect(all.kind === "split" ? all.hitRate : undefined).toBe(1)
  })

  it("S55: a row without the split (an older API or node) keeps the single total", () => {
    expect(tokenSplit({ tokensIn: 400_000, tokensOut: 12_000 })).toEqual({
      kind: "total",
      total: 412_000,
    })
    expect(
      tokenSplit({
        tokensIn: 400_000,
        tokensOut: 12_000,
        tokensCacheRead: 0,
        tokensCacheWrite5m: 0,
        tokensCacheWrite1h: 0,
      }),
    ).toEqual({ kind: "total", total: 412_000 })
  })
})

describe("driver (S51, D28)", () => {
  const drv = (atMs: number, data: Record<string, unknown>) =>
    ev(atMs, "system", { subtype: "driver", text: "Driven from VS Code", data })
  const start = (atMs: number) =>
    ev(atMs, "system", { subtype: "start", text: "started", data: {} })
  const refused = (atMs: number) =>
    ev(atMs, "command_applied", {
      commandId: "c1",
      type: "message",
      outcome: "failed",
      error: "driven_elsewhere",
    })

  it("S51: the badge shows after a driver elsewhere event and clears after elsewhere false", () => {
    expect(driver([])).toBeNull()
    const on = [start(T0), drv(T0 + 1, { elsewhere: true, via: "vscode" })]
    expect(driver(on)).toEqual({ via: "vscode", refused: false, orphan: null })
    expect(driver([...on, drv(T0 + 2, { elsewhere: false, via: null })])).toBeNull()
    expect(driver([drv(T0, { elsewhere: true, via: "cli" })])).toEqual({
      via: "cli",
      refused: false,
      orphan: null,
    })
    // An unknown holder reads as another Claude Code.
    expect(driver([drv(T0, { elsewhere: true, via: "emacs" })])).toEqual({
      via: null,
      refused: false,
      orphan: null,
    })
  })

  it("S51: the next run's start clears it, and a driven_elsewhere settle since the last start is a refusal", () => {
    const on = [drv(T0, { elsewhere: true, via: "vscode" }), refused(T0 + 1)]
    expect(driver(on)).toEqual({ via: "vscode", refused: true, orphan: null })
    // The refusal may land before the driver event.
    expect(driver([refused(T0), drv(T0 + 1, { elsewhere: true, via: "vscode" })])).toEqual({
      via: "vscode",
      refused: true,
      orphan: null,
    })
    expect(driver([...on, start(T0 + 2)])).toBeNull()
    // A refusal of an earlier run does not carry over.
    expect(
      driver([refused(T0), start(T0 + 1), drv(T0 + 2, { elsewhere: true, via: "vscode" })]),
    ).toEqual({ via: "vscode", refused: false, orphan: null })
  })

  it("S51: a session back to running shows no driver", () => {
    const events = [drv(T0, { elsewhere: true, via: "vscode" })]
    expect(drivenElsewhere({ status: "waiting", state: "needs_you" }, events)).toEqual({
      via: "vscode",
      refused: false,
      orphan: null,
    })
    expect(drivenElsewhere({ status: "running", state: "running" }, events)).toBeNull()
  })

  it("D33 (batch-4 F3): an orphan driver carries its pid; once the owner stopped it, the session shows no driver", () => {
    const events = [
      drv(T0, { elsewhere: true, via: null, orphanPid: 5093, cliSessionId: "41173e76" }),
    ]
    const session = { id: "s9", status: "waiting", state: "needs_you" } as const
    expect(drivenElsewhere(session, events)).toEqual({
      via: null,
      refused: false,
      orphan: { pid: 5093, cliSessionId: "41173e76" },
    })
    expect(driverKey({ via: null, orphan: { pid: 5093, cliSessionId: null } })).toBe("orphan")
    markOrphanStopped("s9", 4000)
    expect(drivenElsewhere(session, events)).not.toBeNull()
    markOrphanStopped("s9", 5093)
    expect(drivenElsewhere(session, events)).toBeNull()
    resetStoppedOrphans()
    expect(drivenElsewhere(session, events)).not.toBeNull()
  })
})

describe("middleTruncate", () => {
  it("keeps a short name whole and cuts a long one in its middle, to the length asked", () => {
    expect(middleTruncate("node/readme", 28)).toBe("node/readme")
    const long = "liaison/373bdeb2-walk-a3a9-repo-3"
    const cut = middleTruncate(long, 24)
    expect(cut).toHaveLength(24)
    expect(cut.startsWith("liaison/373")).toBe(true)
    expect(cut.endsWith("repo-3")).toBe(true)
    expect(cut).toContain("…")
  })
})
