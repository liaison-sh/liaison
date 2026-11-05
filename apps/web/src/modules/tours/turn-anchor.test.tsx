// SPDX-License-Identifier: FSL-1.1-ALv2
// The person has ONE conversation with their agent, so it holds earlier turns
// (another scenario's question, a tour's draft). Owner QA: the team chat
// scenario's "It searches the web" ringed a Contacts Search row of an earlier
// turn. The agent's tool rows, citations and the approval cards a turn raises
// carry that turn's id (`data-turn-id`, the message it answers), and a
// scenario's anchor pinned to its ask resolves to that turn only.
import { findTour, resolveBeatAnchor } from "@liaison/shared"
import { render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/approvals/ApprovalCard", () => ({
  default: (props: { requestId: string; turnId?: string | null; askId?: string | null }) => (
    <div
      data-testid="approval-card"
      data-request-id={props.requestId}
      data-turn-id={props.askId ?? props.turnId ?? undefined}
    />
  ),
}))

import AgentActivity from "~/modules/agent/AgentActivity"
import { MessageCitations } from "~/modules/threads/MessageCitations"
import { resolveVisibleAnchor } from "./visible-anchor"

beforeEach(() => {
  // jsdom lays nothing out: every element has a box here.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

/** Two turns of the same conversation: an earlier one (`m-1`) and this run's (`m-2`). */
function twoTurns() {
  return render(() => (
    <div>
      <AgentActivity
        turnId="m-1"
        toolCalls={[
          { toolCallId: "a", toolName: "contacts__search", status: "completed" },
          {
            toolCallId: "a2",
            toolName: "boxtal__create_shipment",
            status: "completed",
            result: { blocked: true, reason: "approval", approvalRequestId: "req-old" },
          },
        ]}
      />
      <MessageCitations turnId="m-1" content="See https://old.example/page" />
      <AgentActivity
        turnId="m-2"
        toolCalls={[
          { toolCallId: "b", toolName: "web_search", status: "running" },
          {
            toolCallId: "b2",
            toolName: "boxtal__create_shipment",
            status: "completed",
            result: { blocked: true, reason: "approval", approvalRequestId: "req-new" },
          },
        ]}
      />
      <MessageCitations turnId="m-2" content="See https://new.example/rules" />
    </div>
  ))
}

const anchorOf = (tourId: string, beatId: string) =>
  findTour(tourId)?.beats.find((b) => b.id === beatId)?.anchor

describe("anchors inside the person's agent conversation", () => {
  it("a scenario's tool row, citations and approval card resolve to this run's turn only", () => {
    twoTurns()
    const created = { "ask-agent": "m-2" }
    // A tool row pinned to the run's ask: that turn's first row.
    expect(
      resolveVisibleAnchor("tool-call-row[data-turn-id=m-2]")?.getAttribute("data-tool-name"),
    ).toBe("web_search")
    const sources = resolveBeatAnchor(anchorOf("kernel.scenario-chat", "sources"), created)
    expect(resolveVisibleAnchor(sources ?? "")?.textContent).toContain("new.example")
    const prepare = resolveBeatAnchor(anchorOf("kernel.scenario-commerce", "prepare"), created)
    expect(resolveVisibleAnchor(prepare ?? "")?.getAttribute("data-request-id")).toBe("req-new")
    // The bare testid would have rung the earlier turn's first row.
    expect(resolveVisibleAnchor("tool-call-row")?.getAttribute("data-tool-name")).toBe(
      "contacts__search",
    )
  })

  it("an answer given after an approval still resolves to the ask that caused it", () => {
    // The ask's own turn parked a call for approval; the answer with the
    // sources came from the turn the approval's result row started.
    render(() => (
      <div>
        <MessageCitations turnId="m-1" content="See https://old.example/page" />
        <AgentActivity
          turnId="result-row"
          askId="m-2"
          toolCalls={[{ toolCallId: "c", toolName: "web_search", status: "completed" }]}
        />
        <MessageCitations turnId="result-row" askId="m-2" content="See https://new.example/rules" />
      </div>
    ))
    const created = { "ask-agent": "m-2" }
    const sources = resolveBeatAnchor(anchorOf("kernel.scenario-chat", "sources"), created)
    expect(resolveVisibleAnchor(sources ?? "")?.textContent).toContain("new.example")
    expect(
      resolveVisibleAnchor("tool-call-row[data-turn-id=m-2]")?.getAttribute("data-tool-name"),
    ).toBe("web_search")
  })

  it("before the run's ask is recorded, it points at nothing", () => {
    twoTurns()
    expect(resolveBeatAnchor(anchorOf("kernel.scenario-chat", "searching"), {})).toBeNull()
  })
})
