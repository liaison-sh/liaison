// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getWsEntityHandlers, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import AgentStateLabel, { AGENT_STUCK_THRESHOLD_MS } from "~/modules/threads/AgentStateLabel"
import { handleWsAgentStreamEvent, resetMessageStore } from "~/modules/threads/message-store"
import { resetPresenceStore } from "~/modules/threads/presence-store"
import { handleTypingEvent } from "~/modules/threads/thread-store"

const threadId = "t-state"

function startTurn() {
  handleTypingEvent({
    type: "typing:start",
    threadId,
    userId: "actor",
    agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    authorType: "agent",
  })
}

describe("agent turn state labels (P4b-T24)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    resetMessageStore()
    resetPresenceStore()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("an announced turn that has not started streaming renders Queued", () => {
    startTurn()
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.getByText("Queued")).toBeInTheDocument()
  })

  it("a streaming turn renders Working", () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId })
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.getByText("Working")).toBeInTheDocument()
  })

  it("a running turn with no stream activity past the stuck threshold renders Stuck, not Working", () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId })
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.getByText("Working")).toBeInTheDocument()
    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS + 1000)
    expect(screen.getByText("Stuck")).toBeInTheDocument()
    expect(screen.queryByText("Working")).not.toBeInTheDocument()
  })

  it("a Stuck turn the server no longer runs ends (its end never reached this client)", async () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId, turnId: "ask-1" })
    handleWsAgentStreamEvent("delta", { threadId, turnId: "ask-1", delta: "Shall I continue" })
    const client = { get: vi.fn(async () => ({ data: { active: false } })) }
    render(() => (
      <ApiContext.Provider value={client as never}>
        <AgentStateLabel threadId={threadId} />
      </ApiContext.Provider>
    ))
    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS + 1000)
    await vi.waitFor(() =>
      expect(client.get).toHaveBeenCalledWith(`/agent/stream-state/${threadId}`),
    )
    await vi.waitFor(() => expect(screen.queryByText("Stuck")).not.toBeInTheDocument())
  })

  it("a stream chunk inside the threshold keeps the turn Working", () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId })
    render(() => <AgentStateLabel threadId={threadId} />)
    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS - 1000)
    handleWsAgentStreamEvent("delta", { threadId, delta: "hi" })
    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS - 1000)
    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.queryByText("Stuck")).not.toBeInTheDocument()
  })

  it("a failed turn renders Failed", () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("error", { threadId, message: "boom" })
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })

  // Surface 8: a turn that cannot START never streams, so the only frame the
  // thread gets is the failure. "Failed" on its own leaves the reader with
  // nothing to act on, and the api used to send nothing at all.
  it("a turn that fails before it ever streams renders Failed with the reason", () => {
    handleWsAgentStreamEvent("error", {
      threadId,
      message: "No API key available for provider anthropic",
    })
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.getByTestId("agent-state")).toHaveAttribute("data-state", "failed")
    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.getByTestId("agent-state-reason").textContent).toBe(
      "No API key available for provider anthropic",
    )
  })

  it("a turn that completes renders none of the four labels", () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("done", { threadId })
    render(() => <AgentStateLabel threadId={threadId} />)
    for (const label of ["Queued", "Working", "Stuck", "Failed"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it("an idle thread with no turn renders none of the four labels", () => {
    render(() => <AgentStateLabel threadId={threadId} />)
    for (const label of ["Queued", "Working", "Stuck", "Failed"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })
})

describe("agent turn state while a tool is running (FX1-C)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    resetMessageStore()
    resetPresenceStore()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("a tool call still running past the stuck threshold renders Working, not Stuck", () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("tool_call", {
      threadId,
      toolCallId: "tc-1",
      toolName: "boxtal__quote_batch",
      args: {},
    })
    render(() => <AgentStateLabel threadId={threadId} />)
    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS + 5000)
    expect(screen.queryByText("Stuck")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-state")).toHaveAttribute("data-state", "working")
  })

  it("names the tool it is waiting on", () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("tool_call", {
      threadId,
      toolCallId: "tc-1",
      toolName: "boxtal__quote_batch",
      args: {},
    })
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.getByTestId("agent-state").textContent).toContain("Working: Quote Batch")
  })

  it("goes Stuck once the tool returns and the stream stays idle past the threshold", () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("tool_call", {
      threadId,
      toolCallId: "tc-1",
      toolName: "boxtal__quote_batch",
      args: {},
    })
    render(() => <AgentStateLabel threadId={threadId} />)
    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS + 5000)
    handleWsAgentStreamEvent("tool_result", { threadId, toolCallId: "tc-1", result: { ok: true } })
    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS + 1000)
    expect(screen.getByText("Stuck")).toBeInTheDocument()
  })

  it("a failed tool call does not hold the turn at Working forever", () => {
    startTurn()
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("tool_call", {
      threadId,
      toolCallId: "tc-1",
      toolName: "kernel__web_fetch",
      args: {},
    })
    handleWsAgentStreamEvent("tool_result", {
      threadId,
      toolCallId: "tc-1",
      result: { error: "boom" },
    })
    render(() => <AgentStateLabel threadId={threadId} />)
    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS + 1000)
    expect(screen.getByText("Stuck")).toBeInTheDocument()
  })
})

describe("agent turn state labels come from the kernel dictionary (P4b-E1)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    resetMessageStore()
    resetPresenceStore()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("renders the French labels when the provider is French", () => {
    startTurn()
    render(() => (
      <I18nProvider initialLocale="fr">
        <AgentStateLabel threadId={threadId} />
      </I18nProvider>
    ))
    expect(screen.getByText("En attente")).toBeInTheDocument()
    handleWsAgentStreamEvent("start", { threadId })
    expect(screen.getByText("En cours")).toBeInTheDocument()
    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS + 1000)
    expect(screen.getByText("Bloqué")).toBeInTheDocument()
  })
})

// THE LIFECYCLE AS THE SOCKET DELIVERS IT (not as a store call fakes it).
// Queued never appeared in a live run: the turn is announced on the typing
// channel with the REQUESTER's actorId, because the run is dispatched in their
// name, and the kernel's typing handler dropped every frame whose actor was
// the viewer. The person who sent the message, the one person waiting for the
// answer, was the only one the announcement never reached.
describe("the turn lifecycle as the websocket delivers it", () => {
  const REQUESTER = "u-requester"
  const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

  function typingHandler() {
    const handler = getWsEntityHandlers("kernel:typing")[0]
    if (!handler) throw new Error("the kernel registers no typing handler")
    return handler
  }

  /** The frame the api broadcasts when a turn starts, exactly as it stamps it. */
  function announceTurn(own: boolean) {
    typingHandler()(
      "start",
      { threadId, authorType: "agent", userId: REQUESTER, agentId: AGENT },
      {
        currentUserId: REQUESTER,
        activeTabId: null,
        isDocumentVisible: true,
        isOwnAction: own,
      },
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    resetRegistry()
    resetBootstrap()
    resetMessageStore()
    resetPresenceStore()
    bootstrapKernelApps()
  })
  afterEach(() => {
    cleanup()
    resetRegistry()
    resetBootstrap()
    vi.useRealTimers()
  })

  it("renders Queued to the SENDER between the send and the first token", () => {
    announceTurn(true)
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.getByText("Queued")).toBeInTheDocument()
  })

  it("walks Queued, Working, Stuck and Failed across one delivered lifecycle", () => {
    announceTurn(true)
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.getByTestId("agent-state").getAttribute("data-state")).toBe("queued")

    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("delta", { threadId, delta: "hi" })
    expect(screen.getByText("Working")).toBeInTheDocument()

    vi.advanceTimersByTime(AGENT_STUCK_THRESHOLD_MS + 1000)
    expect(screen.getByText("Stuck")).toBeInTheDocument()

    handleWsAgentStreamEvent("error", { threadId, message: "boom" })
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })

  it("still drops a HUMAN's own typing echo", () => {
    typingHandler()(
      "start",
      { threadId, userId: REQUESTER, userName: "Me" },
      {
        currentUserId: REQUESTER,
        activeTabId: null,
        isDocumentVisible: true,
        isOwnAction: true,
      },
    )
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.queryByTestId("agent-state")).not.toBeInTheDocument()
  })
})

// A7 / QA THR-10: a turn started from a hidden reply answers in that reply's
// panel. Its state (announced, working, failed) belongs there too: the
// channel's state line showed "Failed No API key …" under the channel list for
// a reply turn that failed.
describe("a reply thread turn stays out of the channel's state line", () => {
  const ROOT = "root-1"
  const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

  function typingHandler() {
    const handler = getWsEntityHandlers("kernel:typing")[0]
    if (!handler) throw new Error("the kernel registers no typing handler")
    return handler
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    resetRegistry()
    resetBootstrap()
    resetMessageStore()
    resetPresenceStore()
    bootstrapKernelApps()
  })
  afterEach(() => {
    cleanup()
    resetRegistry()
    resetBootstrap()
    vi.useRealTimers()
  })

  it("a reply turn that fails before it streams shows no Failed line in the channel", () => {
    handleWsAgentStreamEvent("error", {
      threadId,
      agentId: AGENT,
      replyRootId: ROOT,
      message: "No API key available for provider anthropic",
    })
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.queryByTestId("agent-state")).not.toBeInTheDocument()
  })

  it("a streaming reply turn shows no Working line in the channel", () => {
    handleWsAgentStreamEvent("start", { threadId, agentId: AGENT, replyRootId: ROOT })
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.queryByTestId("agent-state")).not.toBeInTheDocument()
  })

  it("a reply turn's announcement shows no Queued line in the channel", () => {
    typingHandler()(
      "start",
      { threadId, authorType: "agent", userId: "u-1", agentId: AGENT, replyRootId: ROOT },
      { currentUserId: "u-1", activeTabId: null, isDocumentVisible: true, isOwnAction: true },
    )
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.queryByTestId("agent-state")).not.toBeInTheDocument()
  })

  it("a channel turn still shows while a reply turn of another agent has failed", () => {
    handleWsAgentStreamEvent("error", {
      threadId,
      agentId: AGENT,
      replyRootId: ROOT,
      message: "boom",
    })
    handleWsAgentStreamEvent("start", { threadId, agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })
    render(() => <AgentStateLabel threadId={threadId} />)
    expect(screen.getByTestId("agent-state")).toHaveAttribute("data-state", "working")
  })
})
