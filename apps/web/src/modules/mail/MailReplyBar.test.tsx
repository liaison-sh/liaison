// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { installAudioContext, installMic, removeMic } from "~/modules/assist/dictation-fakes"
import { editableIn, setMarkdown } from "~/modules/editor/test-helpers"

import { heldUploads, landedRow, nextTask } from "~/tests/helpers/held-uploads"
import { MailReplyBar } from "./MailReplyBar"

// Picks run through the real uploadFile and land (or fail) when a test says.
vi.mock("~/modules/files/file-service", async (orig) =>
  (await import("~/tests/helpers/held-uploads")).withHeldUploads(orig),
)

// A presign that never answers keeps a picked file in flight.
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: vi.fn(async (path: string) =>
      path === "/assist/capabilities" ? { dictation: true, autoClean: true } : undefined,
    ),
    post: vi.fn(() => new Promise(() => {})),
  }),
}))
vi.mock("~/modules/mail/mail-account-store", () => ({
  allAccounts: () => [{ id: "acc-1" }],
  personalAccounts: () => [{ id: "acc-1" }],
}))
vi.mock("~/modules/mail/mail-message-store", () => ({
  getMessages: () => [],
}))
vi.mock("~/modules/mail/mail-draft-store", async (orig) => ({
  mailSendErrorKey: (await orig<typeof import("~/modules/mail/mail-draft-store")>())
    .mailSendErrorKey,
  // A fresh draft per render: uploads a presign never answers stay in flight
  // for the whole file, and must not show up in the next test's composer.
  createDraft: vi.fn(async () => ({ id: `draft-${Math.random().toString(36).slice(2)}` })),
  getDraftForConversation: () => null,
  scheduleDraftSave: vi.fn(),
  sendDraft: vi.fn(),
}))

/** Write in the reply's editor, as typed. */
const writeReply = async (markdown: string) =>
  setMarkdown(await editableIn("mail-reply-editor"), markdown)

describe("MailReplyBar — collapse behavior", () => {
  test("its root is a footer DockedComposer", () => {
    render(() => <MailReplyBar conversationId="conv-1" />)
    expect(screen.getByTestId("mail-reply-bar").getAttribute("data-composer-dock")).toBe("footer")
  })

  test("renders collapsed by default showing Reply button", () => {
    render(() => <MailReplyBar conversationId="conv-1" />)
    expect(screen.getByTestId("mail-reply-expand")).toBeDefined()
    expect(screen.queryByTestId("mail-reply-editor")).toBeNull()
  })

  test("expands editor on Reply button click", async () => {
    render(() => <MailReplyBar conversationId="conv-1" />)
    await fireEvent.click(screen.getByTestId("mail-reply-expand"))
    expect(screen.getByTestId("mail-reply-editor")).toBeDefined()
    expect(screen.queryByTestId("mail-reply-expand")).toBeNull()
  })
})

describe("MailReplyBar — attachments", () => {
  test("stages files above the text, like chat", async () => {
    render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "photo.png", { type: "image/png" })],
    })
    fireEvent.change(input)
    const strip = await waitFor(() => screen.getByTestId("composer-attachment-strip"))
    const editor = screen.getByTestId("mail-reply-editor")
    expect(strip.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(strip.className).not.toContain("justify-end")
  })

  // Send sits in the panel's bottom right corner, where the dock's floating
  // bar is: the bar pads its bottom by the shell's clearance for it.
  test("keeps its send row clear of the dock's bar", () => {
    render(() => <MailReplyBar conversationId="conv-1" />)
    expect(screen.getByTestId("mail-reply-bar").className).toContain("pb-dock-clearance")
  })
  test("shows an uploading tile while a picked file is still on its way", async () => {
    render(() => <MailReplyBar conversationId="conv-1" />)
    await fireEvent.click(screen.getByTestId("mail-reply-expand"))
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "photo.png", { type: "image/png" })],
    })
    fireEvent.change(input)
    await waitFor(() => expect(screen.getByTestId("composer-attachment-uploading")).toBeTruthy())
  })

  // Send sends the draft with the files already on it: one still uploading
  // went out missing, then landed on the sent draft. A press meanwhile used to
  // do nothing; it now queues the send, which goes out once the file is up.
  async function queueBehindUpload() {
    const { sendDraft } = await import("~/modules/mail/mail-draft-store")
    vi.mocked(sendDraft).mockClear()
    heldUploads.reset()
    render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    await writeReply("Here is the file.")
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "photo.png", { type: "image/png" })],
    })
    fireEvent.change(input)
    await waitFor(() => expect(heldUploads.finish).toHaveLength(1))
    const send = screen.getByTestId("mail-reply-send") as HTMLButtonElement
    expect(send.disabled).toBe(false)
    expect(send.getAttribute("aria-label")).toBe("Send when files finish uploading")
    fireEvent.click(send)
    await nextTask()
    expect(sendDraft).not.toHaveBeenCalled()
    expect(send.dataset.queued).toBe("true")
    expect(send.textContent).toContain("Queued")
    return { send, sendDraft: vi.mocked(sendDraft) }
  }

  test("Send while a file uploads is queued and goes out once the file is up", async () => {
    const { send, sendDraft } = await queueBehindUpload()
    heldUploads.finish[0](landedRow("file-1", "photo.png"))
    await waitFor(() => expect(sendDraft).toHaveBeenCalledTimes(1))
    expect(sendDraft.mock.calls[0][2]).toMatchObject({
      htmlBody: "<p>Here is the file.</p>",
      textBody: "Here is the file.",
    })
    expect(send.dataset.queued).toBeUndefined()
  })

  // The reply is written in the shared editor and leaves as formatted email
  // with its plain-text part, never as markdown.
  test("a formatted reply is sent as email HTML with a plain-text part", async () => {
    const { sendDraft } = await import("~/modules/mail/mail-draft-store")
    vi.mocked(sendDraft).mockClear()
    render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    await writeReply("**Merci**, voir [la doc](https://x.test/doc)")
    fireEvent.click(screen.getByTestId("mail-reply-send"))
    await waitFor(() => expect(sendDraft).toHaveBeenCalledTimes(1))
    expect(vi.mocked(sendDraft).mock.calls[0][2]).toMatchObject({
      htmlBody:
        '<p style="margin:0 0 1em"><strong>Merci</strong>, voir <a href="https://x.test/doc" style="word-break:break-word">la doc</a></p>',
      textBody: "Merci, voir la doc (https://x.test/doc)",
    })
  })

  test("editing the reply cancels a queued send", async () => {
    const { send, sendDraft } = await queueBehindUpload()
    await writeReply("Here is the file, and a note.")
    expect(send.dataset.queued).toBeUndefined()
    heldUploads.finish[0](landedRow("file-1", "photo.png"))
    await waitFor(() => expect(screen.queryByTestId("composer-attachment-uploading")).toBeNull())
    await nextTask()
    expect(sendDraft).not.toHaveBeenCalled()
  })

  test("a failed upload cancels the queued send and shows the upload error", async () => {
    const { send, sendDraft } = await queueBehindUpload()
    heldUploads.fail[0](new Error("storage down"))
    await waitFor(() => expect(screen.getByTestId("composer-attachment-error")).toBeTruthy())
    await nextTask()
    expect(sendDraft).not.toHaveBeenCalled()
    expect(send.dataset.queued).toBeUndefined()
  })
})

describe("MailReplyBar — dictation", () => {
  test("the mic sits immediately left of Send; the wand stays with the tools", async () => {
    installMic()
    installAudioContext()
    try {
      render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
      const mic = await screen.findByTestId("voice-dictation-button")
      expect(mic.nextElementSibling).toBe(screen.getByTestId("mail-reply-send"))
      expect(screen.getByTestId("magic-wand").nextElementSibling).not.toBe(mic)
    } finally {
      removeMic()
    }
  })
})

describe("MailReplyBar — send errors", () => {
  test("a send the provider never confirmed says it may have left; the next Send confirms a resend", async () => {
    const { sendDraft } = await import("~/modules/mail/mail-draft-store")
    const { ApiError } = await import("~/lib/api-error")
    vi.mocked(sendDraft).mockReset()
    vi.mocked(sendDraft).mockRejectedValueOnce(
      new ApiError(
        "The mail provider did not confirm this message",
        409,
        "mail_send_outcome_unknown",
      ),
    )
    vi.mocked(sendDraft).mockResolvedValueOnce({ conversationId: "conv-1", messageId: "m-1" })
    render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    await writeReply("It ships tomorrow.")
    fireEvent.click(screen.getByTestId("mail-reply-send"))
    await waitFor(() =>
      expect(screen.getByTestId("mail-reply-error").textContent).toContain("Check Sent first."),
    )
    expect(vi.mocked(sendDraft).mock.calls[0]?.[2]).not.toHaveProperty("confirmResend")
    fireEvent.click(screen.getByTestId("mail-reply-send"))
    await waitFor(() => expect(vi.mocked(sendDraft)).toHaveBeenCalledTimes(2))
    expect(vi.mocked(sendDraft).mock.calls[1]?.[2]).toMatchObject({ confirmResend: true })
  })

  test("a mailbox with no stored credentials says to reconnect it", async () => {
    const { sendDraft } = await import("~/modules/mail/mail-draft-store")
    const { ApiError } = await import("~/lib/api-error")
    vi.mocked(sendDraft).mockReset()
    vi.mocked(sendDraft).mockRejectedValue(
      new ApiError(
        "connection_credentials_missing: No credentials are stored for this connection.",
        422,
        "connection_credentials_missing",
      ),
    )
    render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    await writeReply("It ships tomorrow.")
    fireEvent.click(screen.getByTestId("mail-reply-send"))
    await waitFor(() =>
      expect(screen.getByTestId("mail-reply-error").textContent).toContain(
        "Reconnect this mailbox in Settings → Connections.",
      ),
    )
  })

  test("a mailbox whose connection is gone says nothing was sent and to reconnect it", async () => {
    const { sendDraft } = await import("~/modules/mail/mail-draft-store")
    const { ApiError } = await import("~/lib/api-error")
    vi.mocked(sendDraft).mockReset()
    vi.mocked(sendDraft).mockRejectedValue(
      new ApiError(
        'No connected account for connection "imap": The mailbox support@example.com is no longer connected, so nothing was sent.',
        422,
        "connection_not_connected",
      ),
    )
    render(() => <MailReplyBar conversationId="conv-1" startExpanded />)
    await writeReply("It ships tomorrow.")
    fireEvent.click(screen.getByTestId("mail-reply-send"))
    await waitFor(() => {
      const text = screen.getByTestId("mail-reply-error").textContent ?? ""
      expect(text).toContain("This mailbox is no longer connected, so nothing was sent.")
      expect(text).not.toContain("No connected account")
    })
  })
})
