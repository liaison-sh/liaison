// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A gated send from an end-to-end encrypted mailbox stores its subject and body
// as ciphertext. The card showed that ciphertext (contentKeyEpk, bodyCiphertext,
// subjectHash...) under Exact payload and no message at all, so the mailbox
// owner could not read the email they were asked to approve and withdrew the
// drafts instead. The owner's browser holds the key: the card must decrypt and
// show the draft, and never print the key material.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DecisionQueueTestAccess } from "~/modules/approvals/decision-queue"
import { setMarkdown } from "~/modules/editor/test-helpers"
import { MAILBOX_UNLOCK_EVENT } from "~/modules/mailbox/mailbox-unlock-bus"
import ApprovalCard from "./ApprovalCard"
import { handleWsCreate, handleWsUpdate, resetApprovalsStore } from "./approvals-store"

// These tests pin each surface's decide wiring; the 5 s Undo window itself is
// decision-queue.test.ts's.
beforeEach(() => {
  DecisionQueueTestAccess.reset()
  DecisionQueueTestAccess.setUndoWindow(0)
})

const apiMocks = {
  get: vi.fn().mockResolvedValue(undefined),
  post: vi.fn(),
}

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))

vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: (s: string) => ["mail:approve"].includes(s),
  userFromToken: () => ({ userId: "u-owner", name: "Owner", scopes: ["mail:approve"] }),
}))

vi.mock("~/modules/shell/toast-store", () => ({ addToast: vi.fn() }))
vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))

const { openApprovalDraft, openMessage } = vi.hoisted(() => ({
  openApprovalDraft: vi.fn(),
  openMessage: vi.fn(),
}))

// The mail message store as the card reads it: a forward's source message, its
// stored attachments known only once the conversation is loaded.
const mailStore = vi.hoisted(() => ({
  loaded: new Map<string, string[]>(),
  onLoad: new Map<string, Map<string, string[]>>(),
  openedFileIds: [] as string[][],
}))
vi.mock("~/modules/mail/mail-message-store", () => ({
  attachmentIdsOfLoadedMessage: (id: string) => mailStore.loaded.get(id),
  loadMessages: vi.fn(async (_api: unknown, conversationId: string) => {
    for (const [id, files] of mailStore.onLoad.get(conversationId) ?? []) {
      mailStore.loaded.set(id, files)
    }
  }),
  sealedMessageById: (id: string) => (mailStore.loaded.has(id) ? { id } : undefined),
}))
vi.mock("~/modules/mailbox/attachment-opener", () => ({
  createAttachmentOpener: () => async (fileIds: string[]) => {
    mailStore.openedFileIds.push(fileIds)
    return fileIds.map((fileId) => ({ fileId, bytesBase64: `PLAIN-${fileId}` }))
  },
}))

vi.mock("~/modules/mailbox/mailbox-store", async () => {
  const { createStore } = await import("solid-js/store")
  const [mailboxStore, setMailboxStatusForTest] = createStore({ status: "locked" as string })
  return {
    mailboxStore,
    setMailboxStatusForTest,
    mailboxCryptoClient: () => ({ isUnlocked: () => true, openApprovalDraft, openMessage }),
  }
})

const setMailboxState = async (_key: "status", value: string) => {
  const mod = (await import("~/modules/mailbox/mailbox-store")) as unknown as {
    setMailboxStatusForTest: (k: "status", v: string) => void
  }
  mod.setMailboxStatusForTest("status", value)
}

const sealedRow = (): any => ({
  id: "ar-sealed",
  handle: "request-1727",
  status: "pending",
  createdAt: "2026-09-25T09:53:09.000Z",
  expiresAt: "2026-10-02T09:53:09.000Z",
  toolName: "mail:compose",
  summary: {
    kind: "mail.compose",
    title: "Compose to igens1@gmail.com via jordan@fabrikam.example",
    lines: ["To: igens1@gmail.com"],
  },
  editableFields: [],
  currentPayload: {
    to: [{ name: "Sebastian Igens", email: "igens1@gmail.com" }],
    accountId: "acc-1",
    mailboxSealed: true,
    encVersion: 1,
    encKeyId: 1,
    contentKeyWrapped: "WRAPPED-KEY-BLOB",
    contentKeyEpk: "MFkwEwYHKoZIzj0CAQ-EPK",
    subjectCiphertext: "SUBJECT-CIPHERTEXT",
    bodyCiphertext: "BODY-CIPHERTEXT",
    subjectHash: "m1Hd5v_T3DYaMDsc",
    byteLength: 1612,
  },
  threadId: "t-1",
  originatingThreadId: "t-1",
  requestedBy: { id: "u-owner" },
  requester: { kind: "user", id: "u-owner", name: "Owner" },
  notifyUserIds: ["u-owner"],
  lastEdit: null,
  lastFailure: null,
})

const KEY_MATERIAL = [
  "WRAPPED-KEY-BLOB",
  "MFkwEwYHKoZIzj0CAQ-EPK",
  "SUBJECT-CIPHERTEXT",
  "BODY-CIPHERTEXT",
  "m1Hd5v_T3DYaMDsc",
]

beforeEach(async () => {
  resetApprovalsStore()
  apiMocks.get.mockReset().mockResolvedValue(undefined)
  openApprovalDraft.mockReset().mockResolvedValue({
    approvalRequestId: "ar-sealed",
    subject: "Your return label",
    textBody: "Hi Sebastian, here is your prepaid return label.",
    htmlBody: null,
    note: null,
  })
  await setMailboxState("status", "locked")
})

/** What the message block shows. */
function shownText(body: HTMLElement): string {
  return (body.textContent ?? "").replace(/\s+/g, " ")
}

describe("ApprovalCard: sealed mail draft", () => {
  it("an unlocked owner sees the decrypted subject and body, never the key material", async () => {
    await setMailboxState("status", "unlocked")
    handleWsCreate(sealedRow(), "u-owner")
    const { container } = render(() => <ApprovalCard requestId="ar-sealed" />)

    const body = await screen.findByTestId("approval-card-message-body")
    await waitFor(() => expect(shownText(body)).toContain("here is your prepaid return label"))
    expect(screen.getByTestId("approval-card-payload")).toHaveTextContent("Your return label")
    for (const blob of KEY_MATERIAL) expect(container.textContent).not.toContain(blob)
    expect(openApprovalDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalRequestId: "ar-sealed",
        bodyCiphertext: "BODY-CIPHERTEXT",
      }),
    )
  })

  it("a locked mailbox says to unlock it, and still prints no key material", async () => {
    handleWsCreate(sealedRow(), "u-owner")
    const { container } = render(() => <ApprovalCard requestId="ar-sealed" />)

    const notice = await screen.findByTestId("approval-card-sealed-draft-notice")
    // The sentence, not its i18n key: prod printed "kernel.approvalsUi..." once.
    expect(notice).toHaveTextContent(/Unlock your mailbox to read it here/)
    expect(openApprovalDraft).not.toHaveBeenCalled()
    for (const blob of KEY_MATERIAL) expect(container.textContent).not.toContain(blob)
  })

  it("a locked mailbox shows the big unlock panel on the card, not a text link", async () => {
    handleWsCreate(sealedRow(), "u-owner")
    render(() => <ApprovalCard requestId="ar-sealed" />)
    const notice = await screen.findByTestId("approval-card-sealed-draft-notice")
    const panel = notice.querySelector('[data-testid="mailbox-locked-notice"]')
    expect(panel).not.toBeNull()
    expect(panel).toHaveAttribute("data-variant", "card")
    expect(panel).toHaveTextContent("Unlock your mail")
    const button = screen.getByTestId("approval-card-sealed-draft-unlock")
    expect(panel!.contains(button)).toBe(true)
    expect(button).toHaveTextContent(/^Unlock$/)
    expect(notice.textContent).not.toMatch(/encrypt/i)
  })

  it("unlocking the mailbox while the card is open reveals the draft", async () => {
    handleWsCreate(sealedRow(), "u-owner")
    render(() => <ApprovalCard requestId="ar-sealed" />)
    await screen.findByTestId("approval-card-sealed-draft-notice")

    await setMailboxState("status", "unlocked")
    const body = await screen.findByTestId("approval-card-message-body")
    await waitFor(() => expect(shownText(body)).toContain("here is your prepaid return label"))
    expect(screen.queryByTestId("approval-card-sealed-draft-notice")).toBeNull()
  })

  it("the locked notice opens the unlock modal from the card itself", async () => {
    const unlockRequests = vi.fn()
    window.addEventListener(MAILBOX_UNLOCK_EVENT, unlockRequests)
    try {
      handleWsCreate(sealedRow(), "u-owner")
      render(() => <ApprovalCard requestId="ar-sealed" />)
      fireEvent.click(await screen.findByTestId("approval-card-sealed-draft-unlock"))
      expect(unlockRequests).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(MAILBOX_UNLOCK_EVENT, unlockRequests)
    }
  })

  it("approving while locked opens the unlock modal and does not approve", async () => {
    const mod = (await import("~/modules/mailbox/mailbox-store")) as unknown as {
      mailboxCryptoClient: () => unknown
    }
    const unlockRequests = vi.fn()
    window.addEventListener(MAILBOX_UNLOCK_EVENT, unlockRequests)
    const spy = vi.spyOn(mod, "mailboxCryptoClient").mockReturnValue(null)
    try {
      handleWsCreate(sealedRow(), "u-owner")
      render(() => <ApprovalCard requestId="ar-sealed" />)
      fireEvent.click(await screen.findByTestId("approval-card-action-approve"))
      await waitFor(() => expect(unlockRequests).toHaveBeenCalledTimes(1))
      expect(apiMocks.post).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      window.removeEventListener(MAILBOX_UNLOCK_EVENT, unlockRequests)
    }
  })
  it("approving while locked carries out the approve by itself once the mailbox unlocks", async () => {
    const mod = (await import("~/modules/mailbox/mailbox-store")) as unknown as {
      mailboxCryptoClient: () => unknown
    }
    const liveClient = mod.mailboxCryptoClient()
    const unlockRequests = vi.fn()
    window.addEventListener(MAILBOX_UNLOCK_EVENT, unlockRequests)
    // Locked: no crypto session yet.
    const spy = vi.spyOn(mod, "mailboxCryptoClient").mockReturnValue(null)
    apiMocks.post.mockReset().mockResolvedValue({ status: "approved" })
    try {
      handleWsCreate(sealedRow(), "u-owner")
      render(() => <ApprovalCard requestId="ar-sealed" />)
      fireEvent.click(await screen.findByTestId("approval-card-action-approve"))
      await waitFor(() => expect(unlockRequests).toHaveBeenCalledTimes(1))
      expect(apiMocks.post).not.toHaveBeenCalled()
      // The user unlocks in the modal: the session exists and the store flips.
      spy.mockReturnValue(liveClient)
      await setMailboxState("status", "unlocked")
      await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1))
      const [path, body] = apiMocks.post.mock.calls[0] as [string, Record<string, unknown>]
      expect(path).toContain("ar-sealed")
      expect(JSON.stringify(body)).toContain("approve")
      // Once, not again on the next status change.
      await setMailboxState("status", "locked")
      await setMailboxState("status", "unlocked")
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(apiMocks.post).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      window.removeEventListener(MAILBOX_UNLOCK_EVENT, unlockRequests)
    }
  })
  // Fabrikam, 2026-10-01: Approve on the Home row posted a bare decision, which
  // the server refuses for a sealed send. The row now opens this card with the
  // press carried over, and the card approves WITH the decrypted draft.
  it("approveOnOpen approves once, carrying the decrypted draft", async () => {
    apiMocks.post.mockReset().mockResolvedValue({ status: "approved" })
    await setMailboxState("status", "unlocked")
    handleWsCreate(sealedRow(), "u-owner")
    render(() => <ApprovalCard requestId="ar-sealed" approveOnOpen />)
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1))
    const [path, body] = apiMocks.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toContain("ar-sealed")
    expect(body).toMatchObject({
      decision: "approve",
      mailboxFulfilment: { draft: { subject: "Your return label" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
  })
  // A forward carries the original's attachments without naming them: its
  // payload has no `attachments`, and the handler adds the source message's own
  // files at execution. The card must supply their readable bytes anyway, or
  // the send refuses with nothing sent.
  it("approving a sealed forward supplies the forwarded message's own attachments", async () => {
    apiMocks.post.mockReset().mockResolvedValue({ status: "approved" })
    mailStore.loaded.clear()
    mailStore.openedFileIds.length = 0
    mailStore.onLoad.set("c-1", new Map([["m-1", ["file-1"]]]))
    openApprovalDraft.mockResolvedValue({
      approvalRequestId: "ar-sealed",
      subject: null,
      textBody: null,
      htmlBody: null,
      note: "FYI",
    })
    openMessage.mockReset().mockResolvedValue({
      id: "m-1",
      subject: "Your label",
      textBody: "label attached",
    })
    await setMailboxState("status", "unlocked")
    handleWsCreate(
      {
        ...sealedRow(),
        toolName: "mail:forward",
        currentPayload: {
          conversationId: "c-1",
          messageId: "m-1",
          to: ["someone@example.com"],
          mailboxSealed: true,
          mailboxQuoteMessageIds: ["m-1"],
          encVersion: 1,
          encKeyId: 1,
          contentKeyWrapped: "WRAPPED-KEY-BLOB",
          contentKeyEpk: "MFkwEwYHKoZIzj0CAQ-EPK",
          noteCiphertext: "NOTE-CIPHERTEXT",
        },
      },
      "u-owner",
    )
    render(() => <ApprovalCard requestId="ar-sealed" approveOnOpen />)
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1))
    const [, body] = apiMocks.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(mailStore.openedFileIds).toEqual([["file-1"]])
    expect(body).toMatchObject({
      decision: "approve",
      mailboxFulfilment: {
        quote: { "m-1": { quotedBody: "label attached", resolvedSubject: "Your label" } },
        attachments: { "file-1": "PLAIN-file-1" },
      },
    })
  })
  // Prod, 2026-11-04: Edit on a sealed reply opened an EMPTY editor. The payload
  // holds only ciphertext, and the editor prefilled from its (absent) textBody
  // instead of the body the card had just decrypted to show.
  const sealedReplyRow = (): any => ({
    ...sealedRow(),
    toolName: "mail:reply",
    editableFields: [
      { field: "textBody", label: "Body", widget: "richtext", invalidates: ["htmlBody"] },
      { field: "to", label: "To", widget: "email-list" },
    ],
    currentPayload: {
      conversationId: "c-1",
      mailboxSealed: true,
      encVersion: 1,
      encKeyId: 1,
      contentKeyWrapped: "WRAPPED-KEY-BLOB",
      contentKeyEpk: "MFkwEwYHKoZIzj0CAQ-EPK",
      bodyCiphertext: "BODY-CIPHERTEXT",
      byteLength: 48,
    },
  })

  it("Edit on a sealed draft opens on the decrypted body, and saves through the payload route", async () => {
    apiMocks.post
      .mockReset()
      .mockResolvedValue({ id: "ar-sealed", currentPayload: {}, lastEdit: null })
    await setMailboxState("status", "unlocked")
    handleWsCreate(sealedReplyRow(), "u-owner")
    render(() => <ApprovalCard requestId="ar-sealed" />)
    const body = await screen.findByTestId("approval-card-message-body")
    await waitFor(() => expect(shownText(body)).toContain("here is your prepaid return label"))

    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    const field = await screen.findByTestId("approval-card-field-textBody")
    await waitFor(() => expect(field.textContent).toContain("here is your prepaid return label"))

    setMarkdown(field, "Hi Sebastian, the label is attached.")
    fireEvent.click(screen.getByTestId("approval-card-action-save"))
    // The edited text goes to the payload route, whose edit seals it again to the
    // mailbox; only the edited field is sent, never the key material.
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("/approvals/ar-sealed/payload", {
        fields: { textBody: "Hi Sebastian, the label is attached." },
      }),
    )
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
  })

  it("a locked sealed draft offers Unlock instead of an empty editor", async () => {
    handleWsCreate(sealedReplyRow(), "u-owner")
    render(() => <ApprovalCard requestId="ar-sealed" />)
    await screen.findByTestId("approval-card-sealed-draft-unlock")
    expect(screen.queryByTestId("approval-card-action-edit")).toBeNull()

    // Unlocked and decrypted, Edit is back and opens on the body.
    await setMailboxState("status", "unlocked")
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    const field = await screen.findByTestId("approval-card-field-textBody")
    await waitFor(() => expect(field.textContent).toContain("here is your prepaid return label"))
  })

  it("after an edit lands, the card opens and shows the new sealed body", async () => {
    await setMailboxState("status", "unlocked")
    handleWsCreate(sealedReplyRow(), "u-owner")
    render(() => <ApprovalCard requestId="ar-sealed" />)
    const body = await screen.findByTestId("approval-card-message-body")
    await waitFor(() => expect(shownText(body)).toContain("here is your prepaid return label"))

    openApprovalDraft.mockResolvedValue({
      approvalRequestId: "ar-sealed",
      subject: null,
      textBody: "Hi Sebastian, the label is attached.",
      htmlBody: null,
      note: null,
    })
    const edited = sealedReplyRow()
    edited.currentPayload = { ...edited.currentPayload, bodyCiphertext: "NEW-BODY-CIPHERTEXT" }
    handleWsUpdate(edited)
    // The message block re-renders around the newly opened draft: read it fresh.
    await waitFor(() =>
      expect(shownText(screen.getByTestId("approval-card-message-body"))).toContain(
        "the label is attached",
      ),
    )
    expect(openApprovalDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ bodyCiphertext: "NEW-BODY-CIPHERTEXT" }),
    )
  })
  // Review of the fix: a compose is sealed with its subject and body under ONE
  // key, so an edit of the body alone could not be re-sealed and always failed.
  // The card sends every sealed part it decrypted, edited or not.
  it("editing only the body of a sealed compose sends the subject along, as decrypted", async () => {
    apiMocks.post
      .mockReset()
      .mockResolvedValue({ id: "ar-sealed", currentPayload: {}, lastEdit: null })
    await setMailboxState("status", "unlocked")
    handleWsCreate(
      {
        ...sealedRow(),
        editableFields: [
          { field: "subject", label: "Subject", widget: "text" },
          { field: "textBody", label: "Body", widget: "richtext", invalidates: ["htmlBody"] },
          { field: "to", label: "To", widget: "email-list" },
        ],
      },
      "u-owner",
    )
    render(() => <ApprovalCard requestId="ar-sealed" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    const field = await screen.findByTestId("approval-card-field-textBody")
    await waitFor(() => expect(field.textContent).toContain("here is your prepaid return label"))
    setMarkdown(field, "Hi Sebastian, the label is attached.")
    fireEvent.click(screen.getByTestId("approval-card-action-save"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("/approvals/ar-sealed/payload", {
        fields: { textBody: "Hi Sebastian, the label is attached.", subject: "Your return label" },
      }),
    )
  })

  it("a sealed part the card cannot edit refuses the save in plain words, sending nothing", async () => {
    const { addToast } = (await import("~/modules/shell/toast-store")) as unknown as {
      addToast: ReturnType<typeof vi.fn>
    }
    addToast.mockClear()
    apiMocks.post.mockReset()
    await setMailboxState("status", "unlocked")
    // A reply whose sealed subject is not an editable field.
    handleWsCreate(
      {
        ...sealedReplyRow(),
        currentPayload: {
          ...sealedReplyRow().currentPayload,
          subjectCiphertext: "SUBJECT-CIPHERTEXT",
        },
      },
      "u-owner",
    )
    render(() => <ApprovalCard requestId="ar-sealed" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    const field = await screen.findByTestId("approval-card-field-textBody")
    await waitFor(() => expect(field.textContent).toContain("here is your prepaid return label"))
    setMarkdown(field, "Hi Sebastian, the label is attached.")
    fireEvent.click(screen.getByTestId("approval-card-action-save"))
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Reject it"), type: "error" }),
      ),
    )
    expect(apiMocks.post).not.toHaveBeenCalled()
  })
})
