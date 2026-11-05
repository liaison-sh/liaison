// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reply, attach a file, remove it, type nothing: a "(No recipients) / (No
// subject)" draft stayed in Drafts, and its view could not discard it. The
// draft was created bare (recipients and subject were only saved with the
// body), and nothing threw it away once it was empty again.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { editableIn, setMarkdown } from "~/modules/editor/test-helpers"

import { MailReplyBar } from "./MailReplyBar"

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(async () => ({ deleted: true })),
}))
const store = vi.hoisted(() => ({
  createDraft: vi.fn(async () => ({ id: "draft-1", htmlBody: "", textBody: "" })),
  discardDraft: vi.fn(async () => {}),
  scheduleDraftSave: vi.fn(),
  sendDraft: vi.fn(async () => ({})),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => api }))
vi.mock("~/modules/mail/mail-account-store", () => ({
  allAccounts: () => [{ id: "acc-1" }],
  personalAccounts: () => [{ id: "acc-1" }],
}))
vi.mock("~/modules/mail/mail-conversation-store", () => ({
  conversationStore: { byId: { "conv-1": { accountId: "acc-1", subject: "Invoice for October" } } },
}))
const INBOUND = {
  id: "msg-1",
  direction: "inbound",
  fromAddress: { email: "billing@print.example" },
  ccAddresses: [{ email: "accounts@print.example" }],
}
// The conversation's messages, as a signal: they can load after the bar mounts.
const messages = vi.hoisted(() => ({ set: (_: unknown[]) => {} }))
vi.mock("~/modules/mail/mail-message-store", async () => {
  const { createSignal } = await import("solid-js")
  const [list, setList] = createSignal<unknown[]>([])
  messages.set = setList
  return { getMessages: () => list() }
})
const setMessages = (list: unknown[]) => messages.set(list)
vi.mock("~/modules/mail/mail-draft-store", () => ({
  ...store,
  getDraftForConversation: () => undefined,
}))
// The real button presigns and uploads; what matters here is that it asks
// the composer for its draft, then hands back the staged row.
vi.mock("~/modules/files/AttachmentUploadButton", () => ({
  AttachmentUploadButton: (props: {
    parent: () => Promise<unknown>
    onUploaded: (row: unknown) => void
  }) => (
    <button
      data-testid="mock-attach"
      onClick={async () => {
        await props.parent()
        props.onUploaded({
          id: "file-1",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          thumbnailUrl: null,
        })
      }}
    />
  ),
}))

async function attach(): Promise<void> {
  fireEvent.click(screen.getByTestId("mock-attach"))
  await waitFor(() => expect(screen.getByTestId("composer-attachment-file-1")).toBeTruthy())
}

describe("MailReplyBar reply drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMessages([INBOUND])
  })

  test("creates the draft with the reply's recipients and subject", async () => {
    render(() => <MailReplyBar conversationId="conv-1" startExpanded initialMode="reply-all" />)
    await attach()
    expect(store.createDraft).toHaveBeenCalledTimes(1)
    expect(store.createDraft).toHaveBeenCalledWith(
      api,
      expect.objectContaining({
        accountId: "acc-1",
        conversationId: "conv-1",
        replyToMessageId: "msg-1",
        to: [{ email: "billing@print.example" }],
        cc: [{ email: "accounts@print.example" }],
        subject: "Re: Invoice for October",
      }),
    )
  })

  // The bar mounts with the conversation, often before its messages have
  // loaded: the recipients were read once, at mount, and stayed empty.
  test("finds the recipients when the messages load after the bar mounted", async () => {
    setMessages([])
    render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    setMessages([INBOUND])
    await attach()
    expect(store.createDraft).toHaveBeenCalledWith(
      api,
      expect.objectContaining({ to: [{ email: "billing@print.example" }] }),
    )
  })

  test("attaching then removing the only file throws the empty draft away", async () => {
    render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    await attach()
    fireEvent.click(screen.getByTestId("composer-attachment-remove-file-1"))
    expect(screen.queryByTestId("composer-attachment-file-1")).toBeNull()
    await waitFor(() => expect(store.discardDraft).toHaveBeenCalledWith(api, "draft-1"))
    expect(api.delete).toHaveBeenCalledWith("/files/file-1")
  })

  test("closing the reply on a draft emptied again throws it away", async () => {
    const { unmount } = render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    setMarkdown(await editableIn("mail-reply-editor"), "Thanks")
    await waitFor(() => expect(store.createDraft).toHaveBeenCalledTimes(1))
    setMarkdown(await editableIn("mail-reply-editor"), "")
    await waitFor(() => expect(store.scheduleDraftSave).toHaveBeenCalledTimes(2))
    expect(store.discardDraft).not.toHaveBeenCalled()
    unmount()
    expect(store.discardDraft).toHaveBeenCalledWith(api, "draft-1")
  })

  test("a draft with text in it is kept when the reply closes", async () => {
    const { unmount } = render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    setMarkdown(await editableIn("mail-reply-editor"), "Thanks")
    await waitFor(() => expect(store.createDraft).toHaveBeenCalledTimes(1))
    unmount()
    expect(store.discardDraft).not.toHaveBeenCalled()
  })

  test("a draft still holding a file is kept when the reply closes", async () => {
    const { unmount } = render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    await attach()
    unmount()
    expect(store.discardDraft).not.toHaveBeenCalled()
  })
})
