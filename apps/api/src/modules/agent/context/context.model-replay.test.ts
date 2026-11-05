// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Production 2026-10-14/15: the agent wrote `claude-opus-4-6` once from its own
// knowledge (the person had said "Opus 5.5"), then every later request in that
// conversation copied it from the replayed history: its own earlier
// run_on_my_computer call's `model` argument and the "started" result echoing
// it. The replay no longer carries the model of a computer-session call.
import { describe, expect, it } from "bun:test"
import { convertToCoreMessages, withoutReplayedModelChoice } from "./context"

const LEGACY = "claude-opus-4-6"

function replay(toolName: string, args: unknown, result: unknown) {
  const out = convertToCoreMessages([
    { authorType: "user", content: "ok lets do it", metadata: null },
    {
      authorType: "agent",
      content: "Started on Mac. Follow it in the card above.",
      metadata: { toolCalls: [{ toolCallId: "call_297882", toolName, args, result }] },
    },
  ])
  return JSON.stringify(out)
}

describe("a replayed computer-session call never hands the agent a model id", () => {
  it("run_on_my_computer: neither the args nor the started result carry the model", () => {
    const text = replay(
      "kernel__run_on_my_computer",
      { task: "Run an Atelier pipeline", model: LEGACY, folder: "liaison-monorepo" },
      { status: "started", model: LEGACY, folder: "liaison-monorepo", sessionId: "s1" },
    )
    expect(text).not.toContain(LEGACY)
    // Everything else of the call is replayed as made.
    expect(text).toContain("liaison-monorepo")
    expect(text).toContain("Run an Atelier pipeline")
    expect(text).toContain('"status":"started"')
  })

  it("a result stored as a JSON string is cleaned too", () => {
    const text = replay(
      "kernel__run_on_my_computer",
      { task: "t", model: LEGACY },
      JSON.stringify({ status: "started", model: LEGACY }),
    )
    expect(text).not.toContain(LEGACY)
  })

  it("computer_session_settings: neither the args nor `changed` carry the model", () => {
    const text = replay(
      "kernel__computer_session_settings",
      { sessionId: "s1", model: LEGACY },
      { status: "changed", changed: { model: LEGACY, level: "strict" } },
    )
    expect(text).not.toContain(LEGACY)
    expect(text).toContain('"level":"strict"')
  })

  it("other tools are replayed untouched", () => {
    const tc = { toolCallId: "x", toolName: "kernel__other", args: { model: LEGACY }, result: "ok" }
    expect(withoutReplayedModelChoice(tc)).toBe(tc)
  })
})
