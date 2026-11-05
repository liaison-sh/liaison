// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An agent turn that tried to read personal mail while the mailbox was locked
// gets an Unlock button right under it. Before, the assistant could only say
// "unlock it in the mail view", which sent the user somewhere else to fix a
// problem they could fix here.

import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { MAILBOX_UNLOCK_EVENT } from "~/modules/mailbox/mailbox-unlock-bus"
import { ApiProvider } from "~/modules/shell/ApiContext"
import MessageRow from "~/modules/threads/MessageRow"
import type { Message } from "~/modules/threads/message-store"

vi.mock("~/modules/mailbox/mailbox-store", async () => {
  const { createStore } = await import("solid-js/store")
  const [mailboxStore, setMailboxStoreForTest] = createStore({
    status: "locked" as string,
    lastErrorCode: null as string | null,
  })
  return { mailboxStore, setMailboxStoreForTest, mailboxCryptoClient: () => null }
})

async function setStatus(status: string): Promise<void> {
  const mod = (await import("~/modules/mailbox/mailbox-store")) as unknown as {
    setMailboxStoreForTest: (key: "status", value: string) => void
  }
  mod.setMailboxStoreForTest("status", status)
}

function agentMessage(result: unknown): Message {
  return {
    id: "a1",
    threadId: "t1",
    authorId: null,
    authorName: "Personal agent",
    authorAvatarUrl: null,
    authorType: "agent",
    authorAgentId: "agent-1",
    content: "I could not read that mail.",
    mentions: null,
    metadata: {
      toolCalls: [{ toolCallId: "c1", toolName: "mail__read", status: "completed", result }],
    },
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-09-29T10:00:00Z").toISOString(),
  } as unknown as Message
}

const LOCKED_RESULT = {
  messageIds: ["m1"],
  byteLength: 0,
  redacted: true,
  mailbox: { status: "MAILBOX_LOCKED" },
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

beforeEach(async () => {
  await setStatus("locked")
})
afterEach(cleanup)

describe("MessageRow: an agent turn that met a locked mailbox", () => {
  it("shows an Unlock button under the turn that opens the unlock modal", () => {
    const requests = vi.fn()
    window.addEventListener(MAILBOX_UNLOCK_EVENT, requests)
    try {
      renderRow(agentMessage(LOCKED_RESULT))
      expect(screen.getByTestId("message-row-mailbox-locked")).toBeTruthy()
      fireEvent.click(screen.getByTestId("message-row-mailbox-unlock"))
      expect(requests).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(MAILBOX_UNLOCK_EVENT, requests)
    }
  })

  it("goes away once the mailbox is unlocked", async () => {
    renderRow(agentMessage(LOCKED_RESULT))
    expect(screen.getByTestId("message-row-mailbox-locked")).toBeTruthy()
    await setStatus("unlocked")
    expect(screen.queryByTestId("message-row-mailbox-locked")).toBeNull()
  })

  it("shows nothing for a turn whose tools did not meet a locked mailbox", () => {
    renderRow(agentMessage({ messageIds: ["m1"], byteLength: 10, redacted: true }))
    expect(screen.queryByTestId("message-row-mailbox-locked")).toBeNull()
  })
})
