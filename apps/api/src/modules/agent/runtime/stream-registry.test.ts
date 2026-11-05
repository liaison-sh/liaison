// SPDX-License-Identifier: FSL-1.1-ALv2
// stream-registry — snapshots of in-flight agent runs (Redis, folded), used by
// GET /api/agent/stream-state/:threadId so a view opened mid-run (an agent
// chat promoted to a thread) can seed the live thinking/tool-call block.
import { beforeEach, describe, expect, it } from "bun:test"
import {
  AgentStreamRegistryTestAccess,
  getLiveAgentStream,
  listLiveAgentStreams,
  recordAgentStreamEvent,
} from "./stream-registry"

const THREAD = "11111111-1111-1111-1111-111111111111"
const ORG = "22222222-2222-2222-2222-222222222222"

describe("agent stream registry", () => {
  beforeEach(async () => {
    await AgentStreamRegistryTestAccess.reset()
  })

  it("accumulates reasoning, text and tool calls from start", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start")
    await recordAgentStreamEvent(THREAD, ORG, "reasoning", { delta: "thinking " })
    await recordAgentStreamEvent(THREAD, ORG, "reasoning", { delta: "hard" })
    await recordAgentStreamEvent(THREAD, ORG, "tool_call", {
      toolCallId: "t1",
      toolName: "shopify__orders_search",
      args: { limit: 5 },
    })
    await recordAgentStreamEvent(THREAD, ORG, "tool_result", {
      toolCallId: "t1",
      result: { ok: true },
    })
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "The answer" })

    const snap = await getLiveAgentStream(THREAD)
    expect(snap).not.toBeNull()
    expect(snap!.orgId).toBe(ORG)
    expect(snap!.reasoning).toBe("thinking hard")
    expect(snap!.content).toBe("The answer")
    expect(snap!.reasoningStreaming).toBe(false)
    expect(snap!.toolCalls).toEqual([
      {
        toolCallId: "t1",
        toolName: "shopify__orders_search",
        args: { limit: 5 },
        result: { ok: true },
        status: "completed",
      },
    ])
  })

  it("records reasoning and tool calls as an ordered timeline for late joiners", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start")
    await recordAgentStreamEvent(THREAD, ORG, "reasoning", { delta: "look " })
    await recordAgentStreamEvent(THREAD, ORG, "reasoning", { delta: "first" })
    await recordAgentStreamEvent(THREAD, ORG, "tool_call", { toolCallId: "t1", toolName: "search" })
    await recordAgentStreamEvent(THREAD, ORG, "reasoning", { delta: "now open" })
    await recordAgentStreamEvent(THREAD, ORG, "tool_call", { toolCallId: "t2", toolName: "open" })

    // Reasoning deltas coalesce into their run; each tool call is anchored where
    // it was invoked, so a mid-thinking call is not dumped after all thinking.
    expect((await getLiveAgentStream(THREAD))!.timeline).toEqual([
      { kind: "reasoning", text: "look first", itemId: "r0" },
      { kind: "tool", toolCallId: "t1", itemId: "t1" },
      { kind: "reasoning", text: "now open", itemId: "r2" },
      { kind: "tool", toolCallId: "t2", itemId: "t2" },
    ])
  })

  it("records answer text between tools where it was written", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start")
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "Je cherche " })
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "le hub." })
    await recordAgentStreamEvent(THREAD, ORG, "tool_call", { toolCallId: "t1", toolName: "search" })
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "Trouvé." })
    expect((await getLiveAgentStream(THREAD))!.timeline).toEqual([
      { kind: "text", text: "Je cherche le hub.", itemId: "t0" },
      { kind: "tool", toolCallId: "t1", itemId: "t1" },
      { kind: "text", text: "Trouvé.", itemId: "t2" },
    ])
  })

  it("marks a tool result carrying an error envelope as status error", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start")
    await recordAgentStreamEvent(THREAD, ORG, "tool_call", {
      toolCallId: "t1",
      toolName: "x",
      args: {},
    })
    await recordAgentStreamEvent(THREAD, ORG, "tool_result", {
      toolCallId: "t1",
      result: { error: "boom" },
    })
    expect((await getLiveAgentStream(THREAD))!.toolCalls[0]!.status).toBe("error")
  })

  it("is removed on each terminal action", async () => {
    for (const terminal of ["done", "error", "clear"]) {
      await recordAgentStreamEvent(THREAD, ORG, "start")
      expect(await getLiveAgentStream(THREAD)).not.toBeNull()
      await recordAgentStreamEvent(THREAD, ORG, terminal)
      expect(await getLiveAgentStream(THREAD)).toBeNull()
    }
  })

  it("unions each content-bearing tag, so a later narrower tag cannot re-gate earlier content", async () => {
    // The snapshot is served as ONE blob, so its tag has to cover every chunk
    // already folded into it. Overwriting with the latest tag hands the payout
    // text to a reader who cannot read finance, because the trailing untagged
    // chunk re-gated content recorded under the wider set.
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, { accumulatedScopes: [] })
    await recordAgentStreamEvent(
      THREAD,
      ORG,
      "delta",
      { delta: "PAYOUT 42000 EUR" },
      { accumulatedScopes: ["finance:read"] },
    )
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: " ok" }, { accumulatedScopes: [] })

    const snap = (await getLiveAgentStream(THREAD))!
    expect(snap.content).toBe("PAYOUT 42000 EUR ok")
    expect(snap.accumulatedScopes).toEqual(["finance:read"])
  })

  it("keeps every earlier scope when a later tag names a different one", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, { accumulatedScopes: ["a:read"] })
    await recordAgentStreamEvent(
      THREAD,
      ORG,
      "reasoning",
      { delta: "x" },
      { accumulatedScopes: ["b:read"] },
    )
    await recordAgentStreamEvent(
      THREAD,
      ORG,
      "tool_call",
      { toolCallId: "t1", toolName: "z" },
      { accumulatedScopes: ["a:read"] },
    )

    const snap = (await getLiveAgentStream(THREAD))!
    expect([...(snap.accumulatedScopes ?? [])].sort()).toEqual(["a:read", "b:read"])
  })

  it("pins requesterId at start, so a later producer cannot claim the replay exemption", async () => {
    // The requester is exempt from the replay gate, so whoever holds this field
    // reads the in-flight blob whatever its scopes. It is a property of the
    // TURN, fixed when the run starts; letting a later chunk name it lets any
    // producer hand the exemption to a caller of its choosing.
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, {})
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "hi" }, { requesterId: "attacker" })
    expect((await getLiveAgentStream(THREAD))!.requesterId).toBe("")
  })

  it("keeps the requester named at start when a later chunk names a different one", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, { requesterId: "owner" })
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "hi" }, { requesterId: "attacker" })
    expect((await getLiveAgentStream(THREAD))!.requesterId).toBe("owner")
  })

  it("ignores non-start events for a thread with no live run", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "orphan" })
    expect(await getLiveAgentStream(THREAD)).toBeNull()
  })
})

// spec-agents.md A29/A30: a message that names two agents gives BOTH a turn,
// and the two runs overlap. Keyed on the thread alone the second `start` wiped
// the first's snapshot, the two sets of deltas folded into one blob, and the
// first `done` deleted the entry out from under the run still going: the room
// showed one live turn and the other agent showed no state at all.
describe("two agents answering in one room", () => {
  const ALPHA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  const BETA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

  beforeEach(async () => {
    await AgentStreamRegistryTestAccess.reset()
  })

  it("keeps a live run each, with its own content", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, { agentId: ALPHA })
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "alpha says" }, { agentId: ALPHA })
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, { agentId: BETA })
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "beta says" }, { agentId: BETA })

    expect((await listLiveAgentStreams(THREAD)).length).toBe(2)
    expect((await getLiveAgentStream(THREAD, ALPHA))?.content).toBe("alpha says")
    expect((await getLiveAgentStream(THREAD, BETA))?.content).toBe("beta says")
  })

  it("one agent finishing leaves the other still running", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, { agentId: ALPHA })
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, { agentId: BETA })
    await recordAgentStreamEvent(THREAD, ORG, "done", { finishReason: "stop" }, { agentId: ALPHA })

    expect(await getLiveAgentStream(THREAD, ALPHA)).toBeNull()
    expect(await getLiveAgentStream(THREAD, BETA)).not.toBeNull()
    expect((await listLiveAgentStreams(THREAD)).length).toBe(1)
  })

  it("a tool result lands on the run that made the call", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, { agentId: ALPHA })
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, { agentId: BETA })
    await recordAgentStreamEvent(
      THREAD,
      ORG,
      "tool_call",
      { toolCallId: "t1", toolName: "search" },
      { agentId: ALPHA },
    )
    await recordAgentStreamEvent(
      THREAD,
      ORG,
      "tool_result",
      { toolCallId: "t1", result: { ok: true } },
      { agentId: ALPHA },
    )
    expect((await getLiveAgentStream(THREAD, ALPHA))?.toolCalls.length).toBe(1)
    expect((await getLiveAgentStream(THREAD, BETA))?.toolCalls.length).toBe(0)
  })
})

describe("a newer turn of the same agent", () => {
  beforeEach(async () => {
    await AgentStreamRegistryTestAccess.reset()
  })
  const AGENT = "agent-a"
  const first = { agentId: AGENT, turnId: "ask-1", requesterId: "u1" }
  const second = { agentId: AGENT, turnId: "ask-2", requesterId: "u1" }

  it("the replaced turn's end leaves the newer turn live, with its own content", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, first)
    await recordAgentStreamEvent(THREAD, ORG, "start", {}, second)
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "newer" }, second)
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "older" }, first)
    await recordAgentStreamEvent(THREAD, ORG, "done", {}, first)
    // The newer turn keeps streaming after the replaced one ended.
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: " answer" }, second)

    const live = await listLiveAgentStreams(THREAD)
    expect(live.map((s) => s.turnId)).toEqual(["ask-2"])
    expect(live[0]?.content).toBe("newer answer")
    expect((await getLiveAgentStream(THREAD, AGENT))?.turnId).toBe("ask-2")
  })
})
