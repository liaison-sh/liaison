// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION'S HOST TOOLS (S5, S6): mark_done and needs_you set the run's
// completion latch and say so in the transcript; the later call wins.
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { HOST_MCP_SERVER } from "../../../packages/shared/src/node-session-protocol"
import {
  CompletionLatch,
  HOST_TOOL_INPUTS,
  HOST_TOOL_REPLIES,
  type HostToolEvent,
  hostToolHandlers,
  hostTools,
} from "./session-host-tools"

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("")

describe("session host tools (S5, S6)", () => {
  it("S5: the server is the in-process liaison_session server with exactly the two tools", () => {
    const server = hostTools(new CompletionLatch(), () => {})
    expect(server.type).toBe("sdk")
    expect(server.name).toBe(HOST_MCP_SERVER)
    const registered = (server.instance as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    expect(Object.keys(registered).sort()).toEqual(["mark_done", "needs_you"])
  })

  it("S6: mark_done sets the latch by session, emits marked_done and returns the fixed text", async () => {
    const latch = new CompletionLatch()
    const events: HostToolEvent[] = []
    const h = hostToolHandlers(latch, (e) => events.push(e))
    const reply = await h.mark_done({ summary: "Fixed the sum" })
    expect(textOf(reply)).toBe(HOST_TOOL_REPLIES.mark_done)
    expect(latch.completion()).toEqual({ by: "session", summary: "Fixed the sum" })
    expect(events).toEqual([{ subtype: "marked_done", text: "Fixed the sum" }])
  })

  it("S6: needs_you after mark_done wins", async () => {
    const latch = new CompletionLatch()
    const events: HostToolEvent[] = []
    const h = hostToolHandlers(latch, (e) => events.push(e))
    await h.mark_done({ summary: "all good" })
    const reply = await h.needs_you({ reason: "Which branch should I push to?" })
    expect(textOf(reply)).toBe(HOST_TOOL_REPLIES.needs_you)
    expect(latch.completion()).toEqual({
      by: "needs_you",
      reason: "Which branch should I push to?",
    })
    expect(events.map((e) => e.subtype)).toEqual(["marked_done", "marked_needs_you"])
  })

  it("S6: mark_done after needs_you wins, and clear() leaves no completion", async () => {
    const latch = new CompletionLatch()
    const h = hostToolHandlers(latch, () => {})
    await h.needs_you({ reason: "stuck" })
    await h.mark_done({ summary: "" })
    expect(latch.completion()).toEqual({ by: "session" })
    latch.clear()
    expect(latch.completion()).toBeUndefined()
  })

  it("S6: a summary longer than 300 characters is capped in the latch and the event", async () => {
    const latch = new CompletionLatch()
    const events: HostToolEvent[] = []
    const h = hostToolHandlers(latch, (e) => events.push(e))
    await h.mark_done({ summary: "x".repeat(500) })
    expect(latch.completion()?.summary).toHaveLength(300)
    expect(events[0]?.text).toHaveLength(300)
  })

  it("S57: mark_done with prUrl latches it; an http prUrl is refused by the tool schema", async () => {
    const latch = new CompletionLatch()
    const h = hostToolHandlers(latch, () => {})
    const url = "https://github.com/example/repo/pull/7"
    await h.mark_done({ summary: "Fixed the sum", prUrl: url })
    expect(latch.completion()).toEqual({ by: "session", summary: "Fixed the sum", prUrl: url })
    const schema = z.object(HOST_TOOL_INPUTS.mark_done)
    expect(schema.safeParse({ summary: "s", prUrl: url }).success).toBe(true)
    expect(schema.safeParse({ summary: "s" }).success).toBe(true)
    expect(
      schema.safeParse({ summary: "s", prUrl: "http://github.com/example/repo/pull/7" }).success,
    ).toBe(false)
    expect(schema.safeParse({ summary: "s", prUrl: "javascript:alert(1)" }).success).toBe(false)
    expect(
      schema.safeParse({ summary: "s", prUrl: `https://x.example/${"a".repeat(500)}` }).success,
    ).toBe(false)
    // A later mark_done without a link drops the earlier one.
    await h.mark_done({ summary: "again" })
    expect(latch.completion()).toEqual({ by: "session", summary: "again" })
  })

  it("S57: needs_you with code push_failed latches reasonCode; an unknown code is refused by the tool schema", async () => {
    const latch = new CompletionLatch()
    const events: HostToolEvent[] = []
    const h = hostToolHandlers(latch, (e) => events.push(e))
    await h.needs_you({ reason: "remote rejected the push", code: "push_failed" })
    expect(latch.completion()).toEqual({
      by: "needs_you",
      reason: "remote rejected the push",
      reasonCode: "push_failed",
    })
    expect(events).toEqual([{ subtype: "marked_needs_you", text: "remote rejected the push" }])
    const schema = z.object(HOST_TOOL_INPUTS.needs_you)
    expect(schema.safeParse({ reason: "r", code: "push_failed" }).success).toBe(true)
    expect(schema.safeParse({ reason: "r" }).success).toBe(true)
    expect(schema.safeParse({ reason: "r", code: "pr_missing" }).success).toBe(false)
    expect(schema.safeParse({ reason: "r", code: "anything" }).success).toBe(false)
  })

  it("S57: the server's tools take the exported input shapes", () => {
    const server = hostTools(new CompletionLatch(), () => {})
    const registered = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          { inputSchema?: { safeParse: (v: unknown) => { success: boolean } } }
        >
      }
    )._registeredTools
    const mark = registered.mark_done?.inputSchema
    expect(mark?.safeParse({ summary: "s", prUrl: "http://x.example/1" }).success).toBe(false)
    expect(mark?.safeParse({ summary: "s", prUrl: "https://x.example/1" }).success).toBe(true)
    const needs = registered.needs_you?.inputSchema
    expect(needs?.safeParse({ reason: "r", code: "nope" }).success).toBe(false)
    expect(needs?.safeParse({ reason: "r", code: "push_failed" }).success).toBe(true)
  })
})
