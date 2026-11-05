// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dispatch to the person's computer that waits for their approval is answered in the
// conversation, on one card: what runs, on which computer, where and with which model, Approve
// and Reject. Approved, the same card becomes the session card; rejected, it says so. The card
// sits at the END of the agent's turn, after the words the agent wrote once the tool answered,
// while the turn streams and once it is stored.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, type JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AgentTurnBlock from "~/modules/agent/AgentTurnBlock"
import { handleWsCreate, resetApprovalsStore } from "~/modules/approvals/approvals-store"
import { DecisionQueueTestAccess } from "~/modules/approvals/decision-queue"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { resetSessionStore } from "~/modules/sessions/session-store"
import MessageRow from "~/modules/threads/MessageRow"
import type { Message, ToolCallState } from "~/modules/threads/message-store"
import NodeDispatchApprovalCard from "./NodeDispatchApprovalCard"

// These tests pin each surface's decide wiring; the 5 s Undo window itself is
// decision-queue.test.ts's.
beforeEach(() => {
  DecisionQueueTestAccess.reset()
  DecisionQueueTestAccess.setUndoWindow(0)
})

let currentUserId = "u-owner"
let scopes: string[] = ["kernel:approve"]
const apiMocks = { get: vi.fn(), post: vi.fn(), getEnvelope: vi.fn() }

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
  ApiProvider: (props: { children: JSX.Element }) => props.children,
}))
vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: (s: string) => scopes.includes(s) || scopes.includes("*"),
  userFromToken: () => ({ userId: currentUserId, name: "Owner", scopes }),
  onAuthCleared: () => () => {},
}))
const toastMock = vi.fn()
vi.mock("~/modules/shell/toast-store", () => ({ addToast: (t: unknown) => toastMock(t) }))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))

const REQUEST = "ar-dispatch"

function approvalRow(over: Record<string, unknown> = {}): any {
  return {
    id: REQUEST,
    handle: "request-0042",
    status: "pending",
    createdAt: "2026-10-15T10:00:00.000Z",
    expiresAt: "2026-10-16T10:00:00.000Z",
    toolName: "kernel:run_on_my_computer",
    approveScope: null,
    summary: {
      kind: "node_dispatch",
      title: "Run on Minimac",
      subtitle: "Minimac",
      lines: ["Task: Fix the flaky test", "Folder: liaison", "Model: claude-haiku-4-5"],
    },
    editableFields: [],
    currentPayload: { task: "Fix the flaky test", folder: "liaison", model: "claude-haiku-4-5" },
    payloadHash: "hash-seen",
    threadId: "t1",
    originatingThreadId: "t1",
    requestedBy: { id: "u-owner" },
    requester: { kind: "agent", id: "agent-1", name: "Olive" },
    notifyUserIds: ["u-owner"],
    lastEdit: null,
    lastFailure: null,
    bundleId: null,
    bundlePosition: null,
    dependsOnId: null,
    ...over,
  }
}

function sessionRow(): any {
  return {
    id: "s1",
    ownerUserId: "u-owner",
    nodeId: "n1",
    jobId: "j1",
    agentId: "agent-1",
    source: "dispatch",
    configKind: "owner",
    sourceThreadId: "t1",
    sourceMessageId: null,
    title: "Fix the flaky test",
    prompt: "Fix the flaky test",
    folderName: "liaison",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "strict",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 1,
    latestActivity: "Bash: bun test",
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-15T10:01:00.000Z",
    startedAt: "2026-10-15T10:01:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-15T10:01:00.000Z",
  }
}

/** What the api answers: the approval as it now stands, and the session it started. */
let served: any = approvalRow()
function answerGets() {
  apiMocks.get.mockImplementation(async (path: string) => {
    if (path === `/approvals/${REQUEST}`) return served
    if (path.includes("/events")) return { events: [], lastSeq: 1 }
    if (path.includes("s1")) return sessionRow()
    return undefined
  })
}

const dispatchCall = (status: ToolCallState["status"] = "completed"): ToolCallState => ({
  toolCallId: "c1",
  toolName: "kernel__run_on_my_computer",
  args: { task: "Fix the flaky test", folder: "liaison", model: "claude-haiku-4-5" },
  status,
  result: {
    blocked: {
      reason: "taint_escalation",
      approvalRequestId: REQUEST,
      summary: { kind: "node_dispatch", title: "Run on Minimac", lines: [] },
    },
  },
})

beforeEach(() => {
  resetApprovalsStore()
  resetSessionStore()
  currentUserId = "u-owner"
  scopes = ["kernel:approve"]
  served = approvalRow()
  apiMocks.get.mockReset()
  apiMocks.post.mockReset()
  toastMock.mockReset()
  answerGets()
})
afterEach(cleanup)

describe("the dispatch approval card", () => {
  it("pending: says what runs, on which computer, where and with which model, with Approve and Reject", async () => {
    render(() => <NodeDispatchApprovalCard requestId={REQUEST} />)
    const card = await screen.findByTestId("node-dispatch-approval")
    await waitFor(() => expect(card).toHaveTextContent("Run on Minimac"))
    expect(card.getAttribute("data-state")).toBe("pending")
    expect(screen.getByTestId("node-dispatch-approval-task")).toHaveTextContent(
      "Fix the flaky test",
    )
    expect(card).toHaveTextContent("liaison")
    expect(card).toHaveTextContent("claude-haiku-4-5")
    expect(screen.getByTestId("node-dispatch-approval-line")).toHaveTextContent(
      "Waiting for your approval",
    )
    expect(screen.getByTestId("node-dispatch-approval-approve")).toHaveTextContent("Approve")
    // The request's id on its buttons, which a tour's Play all presses by.
    expect(
      screen.getByTestId("node-dispatch-approval-approve").getAttribute("data-entity-id"),
    ).toBe(card.getAttribute("data-request-id"))
    expect(screen.getByTestId("node-dispatch-approval-reject")).toHaveTextContent("Reject")
  })

  it("approved: the approve is bound to the version shown, and the card becomes the session card", async () => {
    apiMocks.post.mockImplementation(async () => {
      served = approvalRow({
        status: "approved",
        decidedBy: "u-owner",
        metadata: { nodeSessionId: "s1", nodeName: "Minimac" },
      })
      return { id: REQUEST, status: "approved", decidedBy: "u-owner", decidedAt: "now" }
    })
    render(() => <NodeDispatchApprovalCard requestId={REQUEST} />)
    fireEvent.click(await screen.findByTestId("node-dispatch-approval-approve"))

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1))
    const [path, body] = apiMocks.post.mock.calls[0]
    expect(path).toBe(`/approvals/${REQUEST}/decide`)
    expect(body).toMatchObject({ decision: "approve", payloadHash: "hash-seen" })

    const session = await screen.findByTestId("node-session-card")
    expect(session.getAttribute("data-session-id")).toBe("s1")
    expect(screen.getByTestId("node-dispatch-approval").getAttribute("data-state")).toBe("started")
    expect(screen.queryByTestId("node-dispatch-approval-approve")).toBeNull()
    expect(screen.getByText("Open session")).toBeTruthy()
  })

  it("after a reload, an approved request that started a session shows that session's card", async () => {
    served = approvalRow({ status: "approved", metadata: { nodeSessionId: "s1" } })
    render(() => <NodeDispatchApprovalCard requestId={REQUEST} />)
    expect((await screen.findByTestId("node-session-card")).getAttribute("data-session-id")).toBe(
      "s1",
    )
  })

  it("rejected: Reject sends a deny, and the card says it was rejected and nothing ran", async () => {
    apiMocks.post.mockResolvedValue({
      id: REQUEST,
      status: "denied",
      decidedBy: "u-owner",
      decidedAt: "now",
    })
    render(() => <NodeDispatchApprovalCard requestId={REQUEST} />)
    fireEvent.click(await screen.findByTestId("node-dispatch-approval-reject"))
    await waitFor(() =>
      expect(screen.getByTestId("node-dispatch-approval").getAttribute("data-state")).toBe(
        "denied",
      ),
    )
    expect(apiMocks.post.mock.calls[0][1]).toMatchObject({ decision: "deny" })
    expect(screen.getByTestId("node-dispatch-approval-line")).toHaveTextContent(
      "Rejected. Nothing ran.",
    )
    expect(screen.queryByTestId("node-dispatch-approval-approve")).toBeNull()
    expect(screen.queryByTestId("node-session-card")).toBeNull()
  })

  it("someone who cannot decide it reads the request without the buttons", async () => {
    currentUserId = "u-other"
    scopes = []
    render(() => <NodeDispatchApprovalCard requestId={REQUEST} />)
    const line = await screen.findByTestId("node-dispatch-approval-line")
    await waitFor(() => expect(line).toHaveTextContent("Waiting for approval."))
    expect(screen.queryByTestId("node-dispatch-approval-approve")).toBeNull()
  })

  it("reads in French", async () => {
    handleWsCreate(approvalRow(), "u-owner")
    render(() => (
      <I18nProvider initialLocale="fr">
        <NodeDispatchApprovalCard requestId={REQUEST} />
      </I18nProvider>
    ))
    expect(await screen.findByTestId("node-dispatch-approval")).toHaveTextContent(
      "Exécuter sur Minimac",
    )
    expect(screen.getByTestId("node-dispatch-approval-approve")).toHaveTextContent("Approuver")
    expect(screen.getByTestId("node-dispatch-approval-reject")).toHaveTextContent("Refuser")
  })
})

/** `a` comes before `b` in the document. */
function isBefore(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

describe("the card is pinned at the end of the agent's turn", () => {
  it("while the turn streams, below the summary still arriving, and not inside the tool row", async () => {
    const [content, setContent] = createSignal("")
    render(() => (
      <AgentTurnBlock
        mode="expanded"
        toolCalls={[dispatchCall()]}
        content={content()}
        isStreaming={true}
        isLastMessage={true}
        threadId="t1"
      />
    ))
    const card = await screen.findByTestId("node-dispatch-approval")
    const row = screen.getByTestId("tool-call-row")
    expect(row.contains(card)).toBe(false)
    expect(isBefore(row, card)).toBe(true)

    setContent("I asked to run it on Minimac. Approve it below and it starts.")
    const summary = await screen.findByText(/I asked to run it on Minimac/)
    expect(isBefore(summary, screen.getByTestId("node-dispatch-approval"))).toBe(true)
  })

  it("once the turn is stored (after a reload), below the turn's text", async () => {
    const message = {
      id: "a1",
      threadId: "t1",
      authorId: "u-owner",
      authorName: "Olive",
      authorAvatarUrl: null,
      authorType: "agent",
      authorAgentId: "agent-1",
      content: "I asked to run it on Minimac. Approve it below and it starts.",
      mentions: null,
      metadata: { toolCalls: [dispatchCall()] },
      reactions: [],
      attachments: [],
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-10-15T10:00:05.000Z",
    } as unknown as Message
    const noop = () => {}
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <MessageRow
              message={message}
              grouped={false}
              currentUserId="u-owner"
              onEdit={noop}
              onDelete={noop}
              onReaction={noop}
              onRemoveReaction={noop}
              renderContent={(text: string) => <p>{text}</p>}
            />
          )}
        />
      </Router>
    ))
    const card = await screen.findByTestId("node-dispatch-approval")
    const summary = screen.getByText(/I asked to run it on Minimac/)
    expect(isBefore(summary, card)).toBe(true)
    // Visible without opening the turn's tool list.
    expect(await screen.findByTestId("node-dispatch-approval-approve")).toBeTruthy()
  })

  it("a tool call that is not a dispatch keeps its approval inline", () => {
    render(() => (
      <AgentTurnBlock
        mode="expanded"
        toolCalls={[{ ...dispatchCall(), toolName: "mail__reply" }]}
        content="Drafted."
        threadId="t1"
      />
    ))
    expect(screen.queryByTestId("turn-end-approvals")).toBeNull()
  })
})
