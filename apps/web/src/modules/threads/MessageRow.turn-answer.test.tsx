// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A saved agent answer carries the turn it answers (`agent-answer` +
// `data-turn-id`), as the live block does while the turn streams: a guided
// step showing "Its answer" lost it the moment the turn ended and the answer
// was saved, and waited for ever (walk, 2026-10-26).
//
// After an approval the answering turn is started by the approval's result
// row, so its `turnId` is that row; the answer still names the person's
// question (`askId`), and that is what it carries.

import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import MessageRow from "~/modules/threads/MessageRow"
import type { Message } from "~/modules/threads/message-store"

function agentAnswer(
  turnId: string | undefined,
  extra: { askId?: string; content?: string } = {},
): Message {
  return {
    id: "a1",
    threadId: "t1",
    authorId: null,
    authorName: "Personal agent",
    authorAvatarUrl: null,
    authorType: "agent",
    authorAgentId: "agent-1",
    content: extra.content ?? "She is not a VIP.",
    mentions: null,
    metadata: {
      ...(turnId ? { turnId } : {}),
      ...(extra.askId ? { askId: extra.askId } : {}),
    },
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-10-26T13:51:36Z").toISOString(),
  } as unknown as Message
}

const noop = () => {}
const renderContent = (content: string): JSX.Element => content

function renderRow(message: Message) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <I18nProvider initialLocale="en">
            <ApiProvider>
              <MessageRow
                message={message}
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
}

afterEach(cleanup)

describe("MessageRow: a saved agent answer names its turn", () => {
  it("carries agent-answer with the turn's asking message id", () => {
    renderRow(agentAnswer("ask-1"))
    const answer = screen.getByTestId("agent-answer")
    expect(answer.dataset.turnId).toBe("ask-1")
    expect(answer.textContent).toContain("She is not a VIP.")
  })

  it("an answer an approval's handed-back turn gave carries the person's ask, citations too", () => {
    renderRow(
      agentAnswer("result-row", {
        askId: "ask-1",
        content: "Rules are at https://rules.example/page",
      }),
    )
    expect(screen.getByTestId("agent-answer").dataset.turnId).toBe("ask-1")
    expect(screen.getByTestId("message-citations").dataset.turnId).toBe("ask-1")
  })

  it("an answer saved before the ask was recorded falls back to its turn", () => {
    renderRow(agentAnswer("ask-1", { content: "See https://rules.example/page" }))
    expect(screen.getByTestId("agent-answer").dataset.turnId).toBe("ask-1")
    expect(screen.getByTestId("message-citations").dataset.turnId).toBe("ask-1")
  })

  it("an answer with no recorded turn carries no turn id", () => {
    renderRow(agentAnswer(undefined))
    expect(screen.getByTestId("agent-answer").dataset.turnId).toBeUndefined()
  })
})
