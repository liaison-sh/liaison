// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { applyRow, resetSessionStore } from "~/modules/sessions/session-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import MessageRow from "~/modules/threads/MessageRow"
import type { Message } from "~/modules/threads/message-store"

interface RenderRowOptions {
  currentUserId?: string
  isAdmin?: boolean
  locale?: "en" | "fr"
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    threadId: "t1",
    authorId: "u1",
    authorName: "Bob Martinez",
    authorAvatarUrl: null,
    authorType: "user",
    authorAgentId: null,
    content: "Hello",
    mentions: null,
    metadata: null,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-05-21T10:00:00Z").toISOString(),
    ...overrides,
  }
}

const noop = () => {}
const renderContent = (content: string): JSX.Element => content

function renderRow(message: Message, options: RenderRowOptions = {}) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <I18nProvider initialLocale={options.locale ?? "en"}>
            <ApiProvider>
              <MessageRow
                message={message}
                grouped={false}
                currentUserId={options.currentUserId ?? "viewer"}
                isAdmin={options.isAdmin}
                onEdit={noop}
                onDelete={noop}
                onReaction={noop}
                onRemoveReaction={noop}
                renderContent={renderContent}
              />
            </ApiProvider>
          </I18nProvider>
        )}
      />
    </Router>
  ))
}

describe("MessageRow — agent attribution", () => {
  it("renders an agent message with its attributed label and an agent marker", () => {
    const { getByTestId, container } = renderRow(
      makeMessage({
        id: "ag1",
        authorType: "agent",
        authorAgentId: null,
        authorName: "Taylor's agent",
        content: "Posted the summary.",
        metadata: { agentAuthorLabel: "Taylor's agent" },
      }),
    )
    expect(container.textContent).toContain("Taylor's agent")
    expect(getByTestId("message-agent-badge-ag1")).toBeTruthy()
  })

  it("renders a routine-authored message labelled with the routine", () => {
    const { getByTestId, container } = renderRow(
      makeMessage({
        id: "ag2",
        authorType: "agent",
        authorAgentId: null,
        authorName: "Routine daily-digest",
        content: "Daily digest.",
        metadata: { agentAuthorLabel: "Routine daily-digest" },
      }),
    )
    expect(container.textContent).toContain("Routine daily-digest")
    expect(getByTestId("message-agent-badge-ag2")).toBeTruthy()
  })

  it("renders a human message with no agent marker", () => {
    const { queryByTestId, container } = renderRow(
      makeMessage({ id: "hu1", authorType: "user", authorName: "Bob Martinez", content: "Thanks" }),
    )
    expect(container.textContent).toContain("Bob Martinez")
    expect(queryByTestId("message-agent-badge-hu1")).toBeNull()
  })
})

describe("MessageRow — a routine's report", () => {
  const report = (outputThreadId = "out-1") =>
    makeMessage({
      id: "rep1",
      threadId: "t1",
      authorType: "agent",
      authorId: "owner",
      authorName: "Routine market-scan",
      content: "Three competitors changed their prices.",
      metadata: {
        agentAuthorLabel: "Routine market-scan",
        routineReport: {
          routineId: "r1",
          routineName: "market-scan",
          outputThreadId,
          ownerUserId: "owner",
        },
      },
    })

  it("links the routine's owner to the full run in its output thread", () => {
    const { getByTestId, container } = renderRow(report(), { currentUserId: "owner" })
    expect(container.textContent).toContain("Routine market-scan")
    expect(getByTestId("message-row-routine-run-link").textContent).toBe(
      "[See the full run](thread:out-1)",
    )
  })

  it("marks the whole summary row with the conversation it was posted to", () => {
    const { getByTestId } = renderRow(report(), { currentUserId: "someone-else" })
    expect(getByTestId("message-row").getAttribute("data-routine-report-thread")).toBe(
      report().threadId,
    )
  })

  it("shows no link to a reader the output thread may not seat", () => {
    const { queryByTestId } = renderRow(report(), { currentUserId: "someone-else" })
    expect(queryByTestId("message-row-routine-run-link")).toBeNull()
  })
})

describe("MessageRow — agent message edit/delete authorization", () => {
  it("shows the message-actions menu (with Edit/Delete) for an admin on an agent message", async () => {
    renderRow(
      makeMessage({
        id: "ag-admin",
        authorType: "agent",
        authorAgentId: null,
        authorId: "someone-else",
        authorName: "Someone else's agent",
        content: "Agent reply an admin should be able to moderate.",
        metadata: { agentAuthorLabel: "Someone else's agent" },
      }),
      { currentUserId: "viewer", isAdmin: true },
    )
    const trigger = screen.getByLabelText("Message actions")
    expect(trigger).toBeTruthy()
    await fireEvent.pointerDown(trigger)
    expect(await screen.findByText("Edit")).toBeInTheDocument()
    expect(await screen.findByText("Delete")).toBeInTheDocument()
  })

  it("shows the message-actions menu for the human whose turn triggered the agent message (authorId match)", async () => {
    renderRow(
      makeMessage({
        id: "ag-self",
        authorType: "agent",
        authorAgentId: null,
        authorId: "viewer",
        authorName: "Viewer's agent",
        content: "Agent reply triggered by the viewer.",
        metadata: { agentAuthorLabel: "Viewer's agent" },
      }),
      { currentUserId: "viewer", isAdmin: false },
    )
    const trigger = screen.getByLabelText("Message actions")
    await fireEvent.pointerDown(trigger)
    expect(await screen.findByText("Edit")).toBeInTheDocument()
    expect(await screen.findByText("Delete")).toBeInTheDocument()
  })

  it("hides the message-actions menu for a non-admin viewer who did not trigger the agent turn", () => {
    const { queryByLabelText } = renderRow(
      makeMessage({
        id: "ag-other",
        authorType: "agent",
        authorAgentId: null,
        authorId: "someone-else",
        authorName: "Someone else's agent",
        content: "Agent reply not owned by this viewer.",
        metadata: { agentAuthorLabel: "Someone else's agent" },
      }),
      { currentUserId: "viewer", isAdmin: false },
    )
    expect(queryByLabelText("Message actions")).toBeNull()
  })
})

describe("MessageRow — a node routing line is a system line, not the asker's message", () => {
  // Walk 2026-10-12 (N8): "This went to Matrix Recipient's computer." was drawn
  // with the asking person's avatar and byline, as if they had said it.
  const routed = (metadata: Record<string, unknown>) =>
    makeMessage({
      id: "sys-node",
      authorType: "system",
      authorName: "Matrix Recipient",
      content:
        "This went to Matrix Recipient's computer. The answer will be linked here when it is done.",
      metadata,
    })

  it("renders a queued line muted and centered, with no avatar or byline", () => {
    const { getByTestId, queryByTestId, container } = renderRow(
      routed({ nodeJobId: "j1", nodeQueued: true }),
    )
    const line = getByTestId("message-row-system-line")
    expect(line.getAttribute("data-system-line")).toBe("node-routing")
    expect(line.textContent).toBe(
      "This went to Matrix Recipient's computer. The answer will be linked here when it is done.",
    )
    expect(line.className).toContain("justify-center")
    expect(queryByTestId("message-row")).toBeNull()
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  it("a turn refused at zero credits says so and offers Billing", () => {
    const { getByTestId } = renderRow(
      makeMessage({
        authorType: "system",
        content: "Out of agent usage",
        metadata: { turnRefusal: true, billingRefusal: "out_of_credits" },
      }),
    )
    expect(getByTestId("message-row-system-line").getAttribute("data-system-line")).toBe(
      "turn-refusal",
    )
    expect(getByTestId("payment-required-billing-link").getAttribute("href")).toBe(
      "/settings/billing",
    )
    expect(getByTestId("payment-required-notice").textContent).not.toContain("Out of agent usage")
  })

  it("renders a refusal line the same way", () => {
    const { getByTestId } = renderRow(routed({ nodeRefusal: "node_daily_cap" }))
    expect(getByTestId("message-row-system-line").getAttribute("data-system-line")).toBe(
      "node-routing",
    )
  })
})

describe("MessageRow — a refused agent turn is said once, by the system", () => {
  // Walk D29: the demo's refusal ("Confirm your email to run the agents") is a
  // system row stamped with the asker's id, so it drew as the visitor's own
  // message, under the visitor's name.
  it("renders the refusal as a muted system line, with no byline", () => {
    const { getByTestId, queryByTestId, container } = renderRow(
      makeMessage({
        id: "sys-refusal",
        authorType: "system",
        authorName: "Walk Tester",
        content: "Confirm your email to run the agents on this demo. The code is in your inbox.",
        metadata: { demoRefusal: "demo_verification_required" },
      }),
    )
    const line = getByTestId("message-row-system-line")
    expect(line.getAttribute("data-system-line")).toBe("turn-refusal")
    expect(line.textContent).toBe(
      "Confirm your email to run the agents on this demo. The code is in your inbox.",
    )
    expect(queryByTestId("message-row")).toBeNull()
    expect(container.textContent).not.toContain("Walk Tester")
  })
})

describe("MessageRow — an approval reminder is the system's line, not the person's", () => {
  // The reminder sweep stamps the person's id on its line in their DM with
  // their agent, so it drew as a post by the person themselves.
  it("renders the reminder line muted, with no byline", () => {
    const { getByTestId, queryByTestId, container } = renderRow(
      makeMessage({
        id: "sys-reminder",
        authorType: "system",
        authorName: "Walk Tester",
        content: "Reminder: 1 of your requests has waited more than a day for a decision.",
        metadata: { type: "approval-reminder" },
      }),
    )
    const line = getByTestId("message-row-system-line")
    expect(line.getAttribute("data-system-line")).toBe("approval-reminder")
    expect(line.textContent).toBe(
      "Reminder: 1 of your requests has waited more than a day for a decision.",
    )
    expect(queryByTestId("message-row")).toBeNull()
    expect(container.textContent).not.toContain("Walk Tester")
  })
})

describe("MessageRow — a node answer posted back to the asking thread (D22)", () => {
  // Walk 2026-10-12 (N8): the asker got a link into the node owner's own
  // thread with the agent, which only the owner can open. The answer itself is
  // posted now; the link to the job thread is drawn for the owner alone.
  const answer = (metadata: Record<string, unknown>) =>
    makeMessage({
      id: "node-answer",
      authorType: "agent",
      authorAgentId: "agent-analyst",
      authorName: "Analyst",
      content: "Quorrel makes audio interfaces.",
      metadata: {
        nodeJobId: "j1",
        nodeResultThreadId: "job-thread",
        nodeOwnerUserId: "owner-1",
        ...metadata,
      },
    })

  it("shows the owner the answer and a link to the job thread", () => {
    const { container } = renderRow(answer({}), { currentUserId: "owner-1" })
    expect(container.textContent).toContain("Quorrel makes audio interfaces.")
    expect(container.textContent).toContain("(thread:job-thread)")
  })

  it("shows anyone else the answer with no link they could not open", () => {
    const { container } = renderRow(answer({}), { currentUserId: "asker-2" })
    expect(container.textContent).toContain("Quorrel makes audio interfaces.")
    expect(container.textContent).not.toContain("thread:job-thread")
  })
})

describe("MessageRow — a node session dispatch is one card, never the transcript (S11)", () => {
  afterEach(() => resetSessionStore())

  it("a node_session message renders one card and no transcript", () => {
    applyRow({
      id: "sess-1",
      ownerUserId: "viewer",
      nodeId: "n1",
      jobId: "j1",
      agentId: "a1",
      source: "dispatch",
      configKind: "owner",
      sourceThreadId: "t1",
      sourceMessageId: "card-1",
      title: "Summarise the README",
      prompt: "Summarise the README",
      folderName: "liaison-walk-sample",
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
      lastSeq: 2,
      latestActivity: "Bash: ls",
      tokensIn: 0,
      tokensOut: 0,
      resultSummary: null,
      error: null,
      createdAt: "2026-10-13T10:00:00.000Z",
      startedAt: "2026-10-13T10:00:00.000Z",
      endedAt: null,
      updatedAt: "2026-10-13T10:00:00.000Z",
    })
    const { container } = renderRow(
      makeMessage({
        id: "card-1",
        authorType: "agent",
        authorAgentId: "a1",
        authorName: "Personal agent",
        authorId: "viewer",
        content: "Started on Minimac: Summarise the README",
        metadata: { kind: "node_session", sessionId: "sess-1", nodeName: "Minimac" } as never,
      }),
      { currentUserId: "viewer" },
    )
    const cards = container.querySelectorAll('[data-testid="node-session-card"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].getAttribute("data-session-id")).toBe("sess-1")
    expect(cards[0].textContent).toContain("Summarise the README")
    expect(cards[0].textContent).toContain("Minimac")
    // The card stands in for the message's text: it is not drawn beside it.
    expect(container.textContent).not.toContain("Started on Minimac")
  })

  // The developer scenario's report step points at the finished session's
  // report by the session it started ({dispatch}).
  it("a finished session's report names its session on the row; other agent rows do not", () => {
    const { container } = renderRow(
      makeMessage({
        id: "report-1",
        authorType: "agent",
        authorAgentId: "a1",
        authorName: "Personal agent",
        content: "Done on Demo laptop (recorded): Fix the battery percentage stuck at 99%",
        metadata: { kind: "node_session_result", sessionId: "sess-9" } as never,
      }),
      { currentUserId: "viewer" },
    )
    const row = container.querySelector('[data-testid="message-row"]')
    expect(row?.getAttribute("data-session-result")).toBe("sess-9")
    const plain = renderRow(
      makeMessage({
        id: "plain-1",
        authorType: "agent",
        authorAgentId: "a1",
        authorName: "Personal agent",
        content: "Here are the bugs.",
      }),
      { currentUserId: "viewer" },
    )
    const other = plain.container.querySelector('[data-testid="message-row"]')
    expect(other?.hasAttribute("data-session-result")).toBe(false)
  })

  it("a dispatch blocked by a folder not shared renders its card, with Fix it for its owner", () => {
    const blocked = makeMessage({
      id: "blocked-1",
      authorType: "agent",
      authorAgentId: "a1",
      authorName: "Personal agent",
      content: 'Not started on Minimac: "liaison-monorepo" is not shared with Liaison yet.',
      metadata: {
        kind: "node_dispatch_blocked",
        ownerUserId: "viewer",
        nodeId: "n1",
        nodeName: "Minimac",
        name: "liaison-monorepo",
        field: "folder",
        task: "Fix the flaky test",
        agentId: "a1",
      } as never,
    })
    const { container } = renderRow(blocked, { currentUserId: "viewer" })
    const cards = container.querySelectorAll('[data-testid="node-dispatch-blocked"]')
    expect(cards).toHaveLength(1)
    expect(container.querySelector('[data-testid="node-dispatch-blocked-fix"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Not started on Minimac: "liaison-monorepo"')
  })
})

describe("MessageRow — an auto-added agent is a system line, not a message", () => {
  const joinLine = () =>
    makeMessage({
      id: "sys1",
      authorType: "system",
      authorName: "Taylor",
      content: "Taylor added Support Agent",
      metadata: {
        type: "participant-added",
        participantKind: "agent",
        actorName: "Taylor",
        participantName: "Support Agent",
      },
    })

  it("renders the muted join line with the agent's display name", () => {
    const { getByTestId, container } = renderRow(joinLine())
    const line = getByTestId("message-row-system-line")
    expect(line.getAttribute("data-system-line")).toBe("participant-added")
    expect(line.textContent).toBe("Taylor added Support Agent")
    // Centered and muted, the way a room reads an event rather than a post.
    expect(line.className).toContain("justify-center")
    expect(container.querySelector(".text-text-tertiary")).not.toBeNull()
  })

  it("is not a message from the person who mentioned: no avatar, no message row", () => {
    const { queryByTestId, container } = renderRow(joinLine())
    expect(queryByTestId("message-row")).toBeNull()
    // The avatar bubble a user row draws (initial in a round accent chip).
    expect(container.querySelector(".rounded-full")).toBeNull()
    // No timestamp header either: an event has no author byline.
    expect(container.textContent).not.toContain(":")
  })

  it("reads the line in the viewer's language, not the stored English row", () => {
    const { container } = render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <I18nProvider initialLocale="fr">
              <ApiProvider>
                <MessageRow
                  message={joinLine()}
                  grouped={false}
                  currentUserId="viewer"
                  onEdit={noop}
                  onDelete={noop}
                  onReaction={noop}
                  onRemoveReaction={noop}
                  renderContent={renderContent}
                />
              </ApiProvider>
            </I18nProvider>
          )}
        />
      </Router>
    ))
    expect(container.textContent).toContain("Taylor a ajouté Support Agent")
  })
})

// An approval-expiry notice is posted by the expiry job with authorType
// "system" but carries the REQUESTER's user id, so the thread rendered it as
// a message by that person: avatar, byline, the lot. Six approvals expiring in
// one thread read as six identical posts by Alice Chen.
describe("MessageRow - an approval notice is a system line, not a person's message", () => {
  const expiredLine = (handle?: string) =>
    makeMessage({
      id: "exp1",
      authorType: "system",
      authorName: "Alice Chen",
      content: "Expired without decision.",
      metadata: {
        type: "approval-decision",
        decision: "expired",
        ...(handle ? { requestHandle: handle } : {}),
      },
    })

  it("renders the muted centered line, never a post by the requester", () => {
    const { getByTestId, queryByTestId, container } = renderRow(expiredLine("request-42"))
    const line = getByTestId("message-row-system-line")
    expect(line.getAttribute("data-system-line")).toBe("approval-decision")
    expect(line.className).toContain("justify-center")
    expect(queryByTestId("message-row")).toBeNull()
    expect(container.textContent).not.toContain("Alice Chen")
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  it("names the approval that expired, so two notices are two facts", () => {
    const { container } = renderRow(expiredLine("request-42"))
    expect(container.textContent).toContain("request-42")
    expect(container.textContent).toContain("expired without decision")
  })

  it("falls back to the stored sentence for a notice with no handle", () => {
    const { container } = renderRow(expiredLine())
    expect(container.textContent).toContain("Expired without decision.")
  })

  // A failed approved execution: the server stamps the requester's id on the
  // notice, so a tour visitor's thread read "Handler failed ..." in their name.
  it("a failed-execution notice is the platform's line, never a post by the person", () => {
    const { getByTestId, queryByTestId, container } = renderRow(
      makeMessage({
        id: "err1",
        authorType: "system",
        authorName: "Alice Chen",
        content:
          "Handler failed: handler mail:send failed with no side effect. Request reverted to pending.",
        metadata: { type: "approval-error" },
      }),
    )
    const line = getByTestId("message-row-system-line")
    expect(line.getAttribute("data-system-line")).toBe("approval-error")
    expect(queryByTestId("message-row")).toBeNull()
    expect(container.textContent).not.toContain("Alice Chen")
    expect(container.textContent).toContain("Request reverted to pending.")
  })
})

// An approved call's output is handed back to the agent as a system row
// stamped with the requester's id. The output is for the agent's transcript:
// the room sees one muted line, never a post by the requester, never the raw output.
describe("MessageRow - an approved call's result is a muted line, not the raw output", () => {
  it("names the request and keeps the output off the page", () => {
    const { getByTestId, queryByTestId, container } = renderRow(
      makeMessage({
        id: "res1",
        authorType: "system",
        authorName: "Alice Chen",
        content: "request-273 ran; its result was passed to the agent.",
        metadata: {
          type: "approval-result",
          requestHandle: "request-273",
          result: '{"secret":"raw output"}',
        },
      }),
    )
    const line = getByTestId("message-row-system-line")
    expect(line.getAttribute("data-system-line")).toBe("approval-result")
    expect(queryByTestId("message-row")).toBeNull()
    expect(container.textContent).toContain("request-273")
    expect(container.textContent).not.toContain("raw output")
    expect(container.textContent).not.toContain("Alice Chen")
  })
})

// The "Approval request x opened." greeting is a system row stamped with the
// requester's user id, so it read as a post BY that person, avatar and byline,
// even when their agent had asked.
describe("MessageRow - an approval opening is a system event, not the requester's post", () => {
  const opened = (meta: Record<string, unknown> = {}) =>
    makeMessage({
      id: "open1",
      authorType: "system",
      authorName: "Avery Shaw",
      content: "Approval request req-7 opened.",
      metadata: { type: "approval-created", requestId: "r7", requestHandle: "req-7", ...meta },
    })

  it("names the agent that asked, never the person's byline", () => {
    const { getByTestId, queryByTestId, container } = renderRow(
      opened({ requesterKind: "agent", requesterName: "Support Desk" }),
    )
    const line = getByTestId("message-row-system-line")
    expect(line.getAttribute("data-system-line")).toBe("approval-created")
    expect(line.textContent).toBe("Approval request req-7 opened, requested by Support Desk")
    expect(queryByTestId("message-row")).toBeNull()
    expect(container.textContent).not.toContain("Avery Shaw")
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  it("names nobody on an older greeting that carries no requester", () => {
    const { getByTestId, container } = renderRow(opened())
    expect(getByTestId("message-row-system-line").textContent).toBe("Approval request req-7 opened")
    expect(container.textContent).not.toContain("Avery Shaw")
  })

  it("is said in the reader's language", () => {
    const { getByTestId } = renderRow(opened({ requesterKind: "user", requesterName: "Avery" }), {
      locale: "fr",
    })
    expect(getByTestId("message-row-system-line").textContent).toBe(
      "Demande d'approbation req-7 ouverte par Avery",
    )
  })
})

describe("MessageRow - an agent turn's words are drawn where they were written", () => {
  const calls = [
    { toolCallId: "tu1", toolName: "kpi__kpi_list_hubs", args: {}, status: "completed" as const },
    { toolCallId: "tu2", toolName: "Bash", args: {}, status: "completed" as const },
  ]
  const narrated = (overrides: Partial<Message> = {}) =>
    makeMessage({
      id: "ag2",
      authorType: "agent",
      authorName: "Data",
      content: "Je cherche le hub.\n\nJe lance le pipeline.\n\nRapport prêt.",
      metadata: {
        toolCalls: calls,
        timeline: [
          { kind: "text", text: "Je cherche le hub." },
          { kind: "tool", toolCallId: "tu1" },
          { kind: "text", text: "Je lance le pipeline." },
          { kind: "tool", toolCallId: "tu2" },
          { kind: "text", text: "Rapport prêt." },
        ],
      },
      ...overrides,
    })

  /** Every text segment and tool row, in document order. */
  function order(container: HTMLElement): string[] {
    return [
      ...container.querySelectorAll(
        '[data-testid="agent-activity-text"], [data-testid="tool-call-row"]',
      ),
    ].map((el) =>
      el.getAttribute("data-testid") === "tool-call-row" ? "tool" : (el.textContent ?? "").trim(),
    )
  }

  it("interleaves the text with the tools instead of every tool first", () => {
    const { container } = renderRow(narrated())
    expect(order(container)).toEqual([
      "Je cherche le hub.",
      "tool",
      "Je lance le pipeline.",
      "tool",
      "Rapport prêt.",
    ])
    // Drawn once: not repeated as a block below the activity.
    expect(container.textContent?.split("Rapport prêt.").length).toBe(2)
  })

  it("falls back to the reply below the activity when it was edited", () => {
    const { container } = renderRow(
      narrated({ content: "Rapport corrigé.", editedAt: new Date().toISOString() }),
    )
    expect(container.querySelectorAll('[data-testid="agent-activity-text"]')).toHaveLength(0)
    expect(container.textContent).toContain("Rapport corrigé.")
    expect(container.textContent).not.toContain("Je cherche le hub.")
  })
})

describe("MessageRow - hovering a reaction chip says who reacted (S15)", () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const people = (...names: string[]) =>
    names.map((name) => ({ id: name === "Me" ? "viewer" : `u-${name}`, name }))

  function hoverChip(emoji: string, users: { id: string; name: string }[], locale: "en" | "fr") {
    vi.useFakeTimers()
    renderRow(
      makeMessage({
        reactions: [
          { emoji, count: users.length, users, reacted: users.some((u) => u.id === "viewer") },
        ],
      }),
      { locale },
    )
    const chip = screen.getByTestId(`reaction-chip-${emoji}`)
    fireEvent.pointerEnter(chip.parentElement as HTMLElement, { pointerType: "mouse" })
    vi.advanceTimersByTime(400)
    return screen.getByTestId("tooltip-content").textContent
  }

  it("names up to five people, the viewer first as You, then counts the rest", () => {
    const users = people("Alice", "Bob", "Me", "Carol", "Dan", "Eve", "Frank")
    expect(hoverChip("👍", users, "en")).toBe("You, Alice, Bob, Carol, Dan and 2 others")
  })

  it("says it in French with Vous", () => {
    const users = people("Alice", "Me", "Bob", "Carol", "Dan", "Eve", "Frank", "Gus")
    expect(hoverChip("🎉", users, "fr")).toBe("Vous, Alice, Bob, Carol, Dan et 3 autres")
  })

  it("joins a short list with and / et, and one extra person is singular", () => {
    expect(hoverChip("🔥", people("Alice", "Bob"), "en")).toBe("Alice and Bob")
    cleanup()
    expect(hoverChip("🔥", people("Me"), "fr")).toBe("Vous")
    cleanup()
    const six = people("A1", "A2", "A3", "A4", "A5", "A6")
    expect(hoverChip("🚀", six, "fr")).toBe("A1, A2, A3, A4, A5 et 1 autre")
  })
})

describe("MessageRow — sub_run card", () => {
  it("follows the status on the message's CURRENT metadata, after a refetch replaced it", async () => {
    const subRun = (status: string) => ({
      runId: "run-1",
      hiddenThreadId: "h1",
      agentType: "investigator",
      label: "S3 live-status",
      status,
      summary: null,
      usage: { promptTokens: 0, completionTokens: 0, creditCost: "0" },
    })
    const [store, setStore] = createStore({
      message: makeMessage({
        id: "card1",
        authorType: "agent",
        content: "",
        metadata: { kind: "sub_run", subRun: subRun("queued") } as Message["metadata"],
      }),
    })
    renderRow(store.message)
    expect(screen.getByTestId("sub-run-card").getAttribute("data-status")).toBe("queued")
    // A thread refetch merges a fresh metadata object into the stored row...
    setStore("message", "metadata", { kind: "sub_run", subRun: subRun("running") } as never)
    expect(screen.getByTestId("sub-run-card").getAttribute("data-status")).toBe("running")
    // ...and the live status patch lands on that new object.
    setStore("message", "metadata", "subRun" as never, "status" as never, "done" as never)
    expect(screen.getByTestId("sub-run-card").getAttribute("data-status")).toBe("done")
  })
})
