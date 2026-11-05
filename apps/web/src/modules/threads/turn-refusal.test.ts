// SPDX-License-Identifier: FSL-1.1-ALv2
// Walk D29: a refused agent turn showed its reason three times (as the
// visitor's own message, as a red Failed block, and on the Failed state line).
// The system line is the one that stays; the live blocks stay quiet while the
// conversation already says it.
import { afterEach, describe, expect, it } from "vitest"
import { loadMessagesIntoStore, type Message, resetMessageStore } from "./message-store"
import {
  isTurnRefusalLine,
  refusalCodeInThread,
  refusalShownInThread,
  refusedTurnIsEmpty,
} from "./turn-refusal"

const REFUSAL = "Confirm your email to run the agents on this demo. The code is in your inbox."

function row(over: Partial<Message>): Message {
  return {
    id: crypto.randomUUID(),
    threadId: "t1",
    authorId: "u1",
    authorName: "Visitor",
    authorAvatarUrl: null,
    authorType: "user",
    authorAgentId: null,
    content: "hello",
    mentions: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  }
}

afterEach(() => resetMessageStore())

describe("a refused turn, said once", () => {
  it("knows the system row that records a refusal", () => {
    expect(
      isTurnRefusalLine({
        authorType: "system",
        metadata: { demoRefusal: "demo_verification_required" },
      }),
    ).toBe(true)
    expect(isTurnRefusalLine({ authorType: "user", metadata: null })).toBe(false)
    expect(isTurnRefusalLine({ authorType: "system", metadata: { nodeQueued: true } })).toBe(false)
  })

  it("reports a stream error the conversation already says as its system line", () => {
    loadMessagesIntoStore("t1", [
      row({ content: "ask the agent" }),
      row({
        authorType: "system",
        content: REFUSAL,
        metadata: { demoRefusal: "demo_verification_required" },
      }),
    ])
    expect(refusalShownInThread("t1", REFUSAL)).toBe(true)
    expect(refusalShownInThread("t1", "the provider is down")).toBe(false)
    expect(refusalShownInThread("t1", undefined)).toBe(false)
    expect(refusalShownInThread("t2", REFUSAL)).toBe(false)
  })

  // Auto with no model to run, or no usage left: not a demo refusal, but the
  // same row and the same stream error. Said once, never three times.
  it("knows any refusal row the server marks, not only a demo's", () => {
    const NO_MODEL = "Auto has no model to run: this workspace has no usable model key."
    expect(isTurnRefusalLine({ authorType: "system", metadata: { turnRefusal: true } })).toBe(true)
    expect(isTurnRefusalLine({ authorType: "agent", metadata: { turnRefusal: true } })).toBe(false)
    loadMessagesIntoStore("t5", [
      row({ content: "ask the agent" }),
      row({ authorType: "system", content: NO_MODEL, metadata: { turnRefusal: true } }),
    ])
    expect(refusalShownInThread("t5", NO_MODEL)).toBe(true)
    expect(
      refusedTurnIsEmpty("t5", {
        state: "error",
        content: "",
        toolCalls: [],
        error: { message: NO_MODEL },
      }),
    ).toBe(true)
    expect(refusalCodeInThread("t5", NO_MODEL)).toBeNull()
  })
})

describe("a refused turn draws no empty block (walk D29 residual)", () => {
  const refused = (threadId: string) =>
    loadMessagesIntoStore(threadId, [
      row({ threadId, content: "ask the agent" }),
      row({
        threadId,
        authorType: "system",
        content: REFUSAL,
        metadata: { demoRefusal: "demo_verification_required" },
      }),
    ])

  it("a failed turn with nothing of its own, already said by the refusal line, is not drawn", () => {
    refused("t1")
    const stream = { state: "error", content: "", toolCalls: [], error: { message: REFUSAL } }
    expect(refusedTurnIsEmpty("t1", stream)).toBe(true)
    // Any content of its own keeps the block; so does another error, or a live turn.
    expect(refusedTurnIsEmpty("t1", { ...stream, content: "partial" })).toBe(false)
    expect(refusedTurnIsEmpty("t1", { ...stream, toolCalls: [{}] })).toBe(false)
    expect(refusedTurnIsEmpty("t1", { ...stream, error: { message: "provider down" } })).toBe(false)
    expect(refusedTurnIsEmpty("t1", { ...stream, state: "streaming" })).toBe(false)
  })

  it("names the refusal code the conversation's line carries", () => {
    refused("t3")
    expect(refusalCodeInThread("t3", REFUSAL)).toBe("demo_verification_required")
    expect(refusalCodeInThread("t3", "provider down")).toBeNull()
    expect(refusalCodeInThread("t4", REFUSAL)).toBeNull()
  })
})
