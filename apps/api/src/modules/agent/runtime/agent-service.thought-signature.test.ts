// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gemini signs each function call (`providerMetadata.google.thoughtSignature`) and needs the
// signature back when the call is replayed in a later request. The persisted tool call kept only
// id, name and args, so every replayed call went out unsigned and the AI SDK warned "Replayed N
// functionCall part(s) ... without a thoughtSignature ... injected skip_thought_signature_validator".
// This pins the round trip: streamed call -> persisted metadata -> rebuilt history part.
import { describe, expect, it } from "bun:test"
import { convertToCoreMessages } from "~/modules/agent/context/context"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"

describe("Gemini thoughtSignature survives persist and replay", () => {
  it("a signed tool call is stored with its signature and replayed with it", () => {
    const signed = { google: { thoughtSignature: "sig-abc123" } }
    const persisted = AgentServiceTestAccess.extractToolCalls([
      {
        toolCalls: [
          {
            toolCallId: "call-1",
            toolName: "tickets__search",
            args: { q: "open" },
            ...AgentServiceTestAccess.replayableProviderMetadata(signed),
          },
          // A provider that sent no metadata: nothing is stored for it.
          {
            toolCallId: "call-2",
            toolName: "tickets__get",
            args: { id: "t1" },
            ...AgentServiceTestAccess.replayableProviderMetadata(undefined),
          },
        ],
        toolResults: [
          { toolCallId: "call-1", result: { tickets: [] } },
          { toolCallId: "call-2", result: { id: "t1" } },
        ],
      },
    ])
    expect(persisted[0]?.providerMetadata).toEqual(signed)
    expect(persisted[1]).not.toHaveProperty("providerMetadata")

    // What the row holds after a JSON round trip through kernel.messages.metadata.
    const metadata = JSON.parse(JSON.stringify({ toolCalls: persisted }))
    const history = convertToCoreMessages([
      { authorType: "user", content: "any open tickets?", metadata: null },
      { authorType: "agent", content: "", metadata },
    ])
    const assistant = history.find((m) => (m as { role: string }).role === "assistant") as {
      content: Array<{ type: string; toolName?: string; providerOptions?: unknown }>
    }
    const calls = assistant.content.filter((p) => p.type === "tool-call")
    expect(calls[0]?.providerOptions).toEqual({ google: { thoughtSignature: "sig-abc123" } })
    expect(calls[1]).not.toHaveProperty("providerOptions")
  })

  it("empty or malformed provider metadata is not stored", () => {
    expect(AgentServiceTestAccess.replayableProviderMetadata({})).toEqual({})
    expect(AgentServiceTestAccess.replayableProviderMetadata({ google: {} })).toEqual({})
    expect(AgentServiceTestAccess.replayableProviderMetadata("x")).toEqual({})
  })
})
