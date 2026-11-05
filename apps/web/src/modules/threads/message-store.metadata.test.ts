// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import type { Message } from "./message-store"

describe("Message type", () => {
  it("accepts metadata field", () => {
    const msg: Message = {
      id: "1",
      threadId: "t1",
      authorId: "u1",
      authorName: "Test",
      authorAvatarUrl: null,
      authorType: "agent",
      authorAgentId: null,
      content: "Hello",
      mentions: null,
      reactions: [],
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      metadata: {
        toolCalls: [{ toolCallId: "tc1", toolName: "search", status: "completed" }],
        finishReason: "stop",
      },
    }
    expect(msg.metadata?.toolCalls).toHaveLength(1)
  })
})
