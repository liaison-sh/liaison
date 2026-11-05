// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two literals the message stream still printed in English whatever the
// reader's language: the "Generating..." line under a turn that has started but
// produced no text yet, and the read-only notice on a gated tool call whose
// approval card cannot be loaded. Both come from the catalog now.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/approvals/ApprovalCard", () => ({
  default: (props: { requestId: string; compact?: boolean }) => (
    <div data-testid="approval-card-stub" data-request-id={props.requestId} />
  ),
}))

import AgentTurnBlock from "~/modules/agent/AgentTurnBlock"
import ToolCallRow from "~/modules/agent/ToolCallRow"
import { I18nProvider } from "~/modules/i18n/i18n-context"

function renderIn(locale: "en" | "fr", node: () => unknown) {
  return render(() => <I18nProvider initialLocale={locale}>{node() as never}</I18nProvider>)
}

/** A gated tool call with no approval request id: the read-only fallback. */
const legacyBlockedToolCall = {
  toolCallId: "t1",
  toolName: "mail__reply",
  args: {},
  result: {
    data: null,
    blocked: { reason: "gated", summary: { kind: "mail.reply", title: "Re: y", lines: [] } },
  },
  status: "completed",
}

describe("the message stream speaks the reader's language", () => {
  afterEach(() => cleanup())

  it("names the waiting turn in French", () => {
    renderIn("fr", () => (
      <AgentTurnBlock
        mode="expanded"
        toolCalls={[]}
        content=""
        isStreaming={true}
        isLastMessage={true}
      />
    ))

    expect(screen.getByText("Génération…")).toBeInTheDocument()
    expect(screen.queryByText("Generating...")).toBeNull()
  })

  it("keeps the English wording for an English reader", () => {
    renderIn("en", () => (
      <AgentTurnBlock
        mode="expanded"
        toolCalls={[]}
        content=""
        isStreaming={true}
        isLastMessage={true}
      />
    ))

    expect(screen.getByText("Generating...")).toBeInTheDocument()
  })

  it("puts the gated tool call's read-only notice in French", () => {
    renderIn("fr", () => <ToolCallRow toolCall={legacyBlockedToolCall as never} />)

    const summary = screen.getByTestId("approval-legacy-summary")
    expect(summary.textContent).toContain(
      "En attente d'approbation. Actualisez pour voir les mises à jour en direct.",
    )
    expect(summary.textContent).not.toContain("Pending approval")
  })

  it("keeps the English notice for an English reader", () => {
    renderIn("en", () => <ToolCallRow toolCall={legacyBlockedToolCall as never} />)

    expect(screen.getByTestId("approval-legacy-summary").textContent).toContain(
      "Pending approval. Refresh to see live updates.",
    )
  })
})
