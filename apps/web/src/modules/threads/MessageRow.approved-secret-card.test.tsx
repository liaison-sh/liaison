// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An approved request_secret draws its card under the approval's result line
// (walk 2026-10-27, N40): in an org with members the call parked for approval,
// and once approved the request existed but no card ever appeared, live or
// after a reload. The line's `secretRequestId` (approvals/result-notice.ts) is
// what the card keys on, so a reload draws it exactly as the live frame does.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import MessageRow, { approvedSecretCardId } from "~/modules/threads/MessageRow"
import type { Message } from "~/modules/threads/message-store"

vi.mock("~/modules/secret-request/SecretRequestToolCard", () => ({
  default: (props: { requestId: string }) => (
    <div data-testid="secret-request-card-stub" data-request-id={props.requestId} />
  ),
}))

const apiMocks = {
  get: vi.fn().mockResolvedValue(undefined),
  post: vi.fn(),
  getEnvelope: vi.fn().mockResolvedValue({ data: [] }),
}

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
  ApiProvider: (p: { children: JSX.Element }) => p.children,
}))

vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: () => true,
  userFromToken: () => ({ userId: "owner", name: "Owner", scopes: ["*"] }),
  onAuthCleared: () => () => {},
}))

const noop = () => {}

function resultLine(metadata: Message["metadata"]): Message {
  return {
    id: "m-result",
    threadId: "dm-1",
    authorId: "owner",
    authorName: "System",
    authorAvatarUrl: null,
    authorType: "system",
    authorAgentId: null,
    content: "request-2 ran; its result was passed to the agent.",
    mentions: null,
    metadata,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-10-27T13:56:30Z").toISOString(),
  }
}

function renderRow(msg: Message) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <I18nProvider initialLocale="en">
            <MessageRow
              message={msg}
              grouped={false}
              currentUserId="owner"
              onEdit={noop}
              onDelete={noop}
              onReaction={noop}
              onRemoveReaction={noop}
              renderContent={(c: string): JSX.Element => c}
            />
          </I18nProvider>
        )}
      />
    </Router>
  ))
}

afterEach(cleanup)

describe("an approved request_secret's card", () => {
  it("is drawn under the approval's result line, keyed by the request it filed", () => {
    renderRow(
      resultLine({
        type: "approval-result",
        requestHandle: "request-2",
        secretRequestId: "sec-42",
        secretCard: "posted",
      }),
    )
    expect(screen.getByText("request-2 ran; its result was passed to the agent")).toBeTruthy()
    expect(screen.getByTestId("secret-request-card-stub").getAttribute("data-request-id")).toBe(
      "sec-42",
    )
  })

  it("is not drawn twice when the same card was already in the conversation", () => {
    renderRow(
      resultLine({
        type: "approval-result",
        requestHandle: "request-5",
        secretRequestId: "sec-42",
        secretCard: "already_posted",
      }),
    )
    expect(screen.queryByTestId("secret-request-card-stub")).toBeNull()
  })

  it("draws nothing under another approved call's result", () => {
    renderRow(resultLine({ type: "approval-result", requestHandle: "request-3" }))
    expect(screen.queryByTestId("secret-request-card-stub")).toBeNull()
    expect(approvedSecretCardId({ type: "approval-decision", secretRequestId: "sec-1" })).toBeNull()
  })
})
