// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A synthetic running session for the memory budget (S56, D30): the main
// thread's events of an hour-long session with `subagents` subagents, the
// shapes the node forwards (T08): text, thinking, tool calls and results (one
// result in five a large output of 10-60 KB), usage with the cache split,
// `task_*` system events for the subagents, a plan now and then. Deterministic.

import type { NodeSessionEvent } from "@liaison/shared"

export type FrameEvent = NodeSessionEvent & { sessionId: string }

export interface SyntheticOptions {
  sessionId?: string
  events: number
  subagents?: number
  startMs?: number
  /** Milliseconds between events (an hour over 30,000 events: 120). */
  stepMs?: number
}

function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** A flat string of about `bytes` (as JSON.parse makes it; never a rope), unique per call. */
function output(bytes: number, seq: number): string {
  const lines: string[] = []
  for (let n = 0, size = 0; size < bytes; n++) {
    const line = `src/modules/example/file-${seq}.ts:${n}: const value = compute(input, options) // ok`
    lines.push(line)
    size += line.length + 1
  }
  return lines.join("\n")
}

/** Every event of the session, in seq order (seq 1..n). */
export function* syntheticSession(opts: SyntheticOptions): Generator<FrameEvent> {
  const sessionId = opts.sessionId ?? "s1"
  const subs = opts.subagents ?? 10
  const t0 = opts.startMs ?? Date.parse("2026-10-15T12:00:00.000Z")
  const step = opts.stepMs ?? 120
  const rnd = lcg(7)
  let seq = 0
  let call = 0
  const make = (type: NodeSessionEvent["type"], payload: Record<string, unknown>): FrameEvent => {
    seq++
    const at = new Date(t0 + seq * step).toISOString()
    return { sessionId, seq, at, receivedAt: at, type, payload } as FrameEvent
  }
  yield make("system", {
    subtype: "start",
    text: "",
    data: { cwd: "/home/me/code", level: "strict" },
  })
  yield make("user_message", { text: "Fix the flaky tests" })
  for (let i = 0; i < subs; i++) {
    if (seq >= opts.events) return
    const id = `toolu_agent_${i}`
    yield make("tool_call", {
      id,
      name: "Agent",
      input: { description: `Subagent ${i}`, subagent_type: "general-purpose", prompt: "Look" },
    })
    yield make("system", {
      subtype: "task_started",
      text: `Subagent ${i}`,
      data: {
        taskId: `task_${i}`,
        toolUseId: id,
        description: `Subagent ${i}`,
        taskType: "local_agent",
      },
    })
  }
  let progress = 0
  while (seq < opts.events) {
    const k = seq % 12
    if (k === 0)
      yield make("assistant_text", { text: `Looking at step ${seq}. ${"x".repeat(150)}` })
    else if (k === 1 || k === 5 || k === 10)
      yield make("usage", {
        tokensIn: 1200,
        tokensOut: 300,
        cacheRead: 1000,
        cacheWrite5m: 100,
        cacheWrite1h: 0,
        contextTokens: 40_000 + seq,
      })
    else if (k === 2 || k === 8) {
      call++
      yield make("tool_call", {
        id: `toolu_${call}`,
        name: k === 2 ? "Bash" : "Read",
        input: k === 2 ? { command: `bun test step-${seq}` } : { file_path: "/home/me/code/a.ts" },
      })
    } else if (k === 3 || k === 9) {
      const big = k === 3 && rnd() < 0.2
      const bytes = big ? 10_000 + Math.floor(rnd() * 50_000) : 400 + Math.floor(rnd() * 1600)
      yield make("tool_result", { id: `toolu_${call}`, isError: false, output: output(bytes, seq) })
    } else if (k === 4 || k === 6 || k === 11) {
      const i = progress++ % subs
      yield make("system", {
        subtype: "task_progress",
        text: "",
        data: {
          taskId: `task_${i}`,
          toolUseId: `toolu_agent_${i}`,
          toolUses: Math.floor(progress / subs),
          lastToolName: "Read",
        },
      })
    } else if (k === 7) {
      if (seq % 600 === 7)
        yield make("todo", {
          items: [
            { content: "Read the tests", status: "completed" },
            { content: "Fix the race", status: "in_progress", activeForm: "Fixing the race" },
          ],
        })
      else yield make("thinking", { text: `Considering ${seq}` })
    }
  }
}
