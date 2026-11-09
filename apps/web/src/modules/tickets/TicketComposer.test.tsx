// SPDX-License-Identifier: FSL-1.1-ALv2

import { findTour } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  loadMessages: vi.fn(),
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  getDraft: vi.fn().mockReturnValue(""),
  scopes: ["tickets:tickets:reply", "tickets:tickets:write"] as string[],
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
// Picks run through the real uploadFile and land (or fail) when a test says.
vi.mock("~/modules/files/file-service", async (orig) =>
  (await import("~/tests/helpers/held-uploads")).withHeldUploads(orig),
)
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "u1" }),
  hasScope: (scope: string) => state.scopes.includes(scope),
}))
vi.mock("~/modules/tickets/ticket-message-store", () => ({
  loadMessages: state.loadMessages,
  TICKET_REPLY_APPROVAL_EVENT: "tickets:reply-approval-status",
}))
vi.mock("~/modules/tickets/ticket-draft-store", () => ({
  saveDraft: state.saveDraft,
  clearDraft: state.clearDraft,
  getDraft: state.getDraft,
}))

// Flatten PopupMenu for unit tests: render the trigger and content inline (no
// portal, no Kobalte focus traps) so fireEvent.click reaches the menu items in
// JSDOM. Mirrors TicketDetail.test.tsx:72-92.
vi.mock("~/ui/PopupMenu", () => {
  const Root = (props: any) => <>{props.children}</>
  const Trigger = (props: any) => <>{props.children}</>
  const Content = (props: any) => <div role="menu">{props.children}</div>
  const Group = (props: any) => <>{props.children}</>
  const Item = (props: any) => (
    <div
      role="menuitem"
      tabindex="0"
      onClick={() => props.onSelect?.()}
      onKeyDown={(e: any) => {
        if (e.key === "Enter" || e.key === " ") props.onSelect?.()
      }}
    >
      {props.children}
    </div>
  )
  const Label = (props: any) => <div>{props.children}</div>
  const Separator = () => <hr />
  const PopupMenu = Object.assign(Root, { Trigger, Content, Group, Item, Label, Separator })
  return { PopupMenu }
})

import { createSignal } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { installAudioContext, installMic, removeMic } from "~/modules/assist/dictation-fakes"
import { editorOf, setMarkdown, typeInto } from "~/modules/editor/test-helpers"
import { runAutoplay } from "~/modules/tours/autoplay"
import { heldUploads, landedRow, nextTask } from "~/tests/helpers/held-uploads"
import { TicketComposer } from "./TicketComposer"

/** The reply box: the shared editor, once its chunk has loaded. */
const replyBox = () => screen.findByTestId("tickets-composer-body")
async function typeReply(markdown: string) {
  setMarkdown(await replyBox(), markdown)
}

describe("TicketComposer", () => {
  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({})
    state.loadMessages.mockReset()
    state.saveDraft.mockReset()
    state.clearDraft.mockReset()
    state.getDraft.mockReturnValue("")
    state.scopes = ["tickets:tickets:reply", "tickets:tickets:write"]
  })

  it("a person without the reply scope gets no reply tab, only the note", async () => {
    state.scopes = ["tickets:tickets:write"]
    render(() => <TicketComposer ticketId="t1" />)
    expect(screen.queryByTestId("tickets-composer-mode-reply")).toBeNull()
    expect(screen.getByTestId("tickets-composer-mode-note").getAttribute("data-active")).toBe(
      "true",
    )
  })

  it("the footer keeps the wand with the tools and the mic immediately left of Send", async () => {
    installMic()
    installAudioContext()
    state.api.get = vi.fn().mockResolvedValue({ dictation: true, autoClean: true })
    try {
      render(() => <TicketComposer ticketId="t1" />)
      const mic = await screen.findByTestId("voice-dictation-button")
      const send = screen.getByTestId("tickets-composer-submit")
      expect(mic.nextElementSibling).toBe(send)
      const wand = screen.getByTestId("magic-wand")
      expect(send.parentElement?.contains(wand)).toBe(false)
    } finally {
      removeMic()
    }
  })

  it("a take turns the footer into the recorder line, Send out of it until the text is in", async () => {
    installMic()
    installAudioContext()
    state.api.get = vi.fn().mockResolvedValue({ dictation: true, autoClean: true })
    try {
      render(() => <TicketComposer ticketId="t1" />)
      fireEvent.click(await screen.findByTestId("voice-dictation-button"))
      const recorder = await screen.findByTestId("voice-dictation-recorder")
      expect(recorder.closest("[data-composer-footer]")).not.toBeNull()
      expect(screen.getByTestId("tickets-composer-submit").closest("[hidden]")).not.toBeNull()
      fireEvent.click(screen.getByTestId("voice-dictation-discard"))
      await waitFor(() => expect(screen.queryByTestId("voice-dictation-recorder")).toBeNull())
      expect(screen.getByTestId("tickets-composer-submit").closest("[hidden]")).toBeNull()
    } finally {
      removeMic()
    }
  })

  it("its root is a footer DockedComposer", () => {
    render(() => <TicketComposer ticketId="t1" />)
    expect(screen.getByTestId("tickets-composer").getAttribute("data-composer-dock")).toBe("footer")
  })

  it("a person with neither scope reads the ticket with no composer at all", () => {
    state.scopes = ["tickets:tickets:read"]
    render(() => <TicketComposer ticketId="t1" />)
    expect(screen.queryByTestId("tickets-composer")).toBeNull()
  })

  it("a reply parked under a two-approver policy says it waits for a second approver, then reloads once approved", async () => {
    state.api.post = vi
      .fn()
      .mockResolvedValue({ blocked: { reason: "gated", approvalRequestId: "ar-2" } })
    render(() => <TicketComposer ticketId="t1" />)
    await typeReply("Two approvals please")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-composer-awaiting-second-approver").textContent).toContain(
        "Waiting for a second approver",
      ),
    )
    state.loadMessages.mockClear()
    // Another approval's decision is not this reply's.
    window.dispatchEvent(
      new CustomEvent("tickets:reply-approval-status", {
        detail: { ticketId: "t1", approvalId: "other", status: "approved" },
      }),
    )
    expect(screen.getByTestId("tickets-composer-awaiting-second-approver")).toBeTruthy()
    window.dispatchEvent(
      new CustomEvent("tickets:reply-approval-status", {
        detail: { ticketId: "t1", approvalId: "ar-2", status: "approved" },
      }),
    )
    await waitFor(() =>
      expect(screen.queryByTestId("tickets-composer-awaiting-second-approver")).toBeNull(),
    )
    expect(state.loadMessages).toHaveBeenCalledWith(state.api, "t1", { fresh: true })
  })

  it("tells its host once a note is posted or a reply goes out, never for a parked reply", async () => {
    const onSubmitted = vi.fn()
    render(() => <TicketComposer ticketId="t1" onSubmitted={onSubmitted} />)
    await typeReply("On it")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith("reply"))

    onSubmitted.mockClear()
    state.api.post = vi
      .fn()
      .mockResolvedValue({ blocked: { reason: "gated", approvalRequestId: "ar-9" } })
    await typeReply("Two approvals please")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await screen.findByTestId("tickets-composer-awaiting-second-approver")
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it("tells its host once a note is posted", async () => {
    const onSubmitted = vi.fn()
    render(() => <TicketComposer ticketId="t1" initialMode="note" onSubmitted={onSubmitted} />)
    await typeReply("Checked the history")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith("note"))
  })

  it("a parked reply that is rejected says it was not sent", async () => {
    state.api.post = vi
      .fn()
      .mockResolvedValue({ blocked: { reason: "gated", approvalRequestId: "ar-3" } })
    render(() => <TicketComposer ticketId="t1" />)
    await typeReply("Two approvals please")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await screen.findByTestId("tickets-composer-awaiting-second-approver")
    window.dispatchEvent(
      new CustomEvent("tickets:reply-approval-status", {
        detail: { ticketId: "t1", approvalId: "ar-3", status: "denied" },
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("tickets-composer-reply-outcome").textContent).toBe(
        "Your reply was rejected and not sent.",
      ),
    )
    expect(screen.queryByTestId("tickets-composer-awaiting-second-approver")).toBeNull()
  })

  it("shows an uploading tile while a picked file is still on its way", async () => {
    // The upload session opens, the presign never answers: the file stays in
    // flight, and the strip must say so rather than show nothing until it lands.
    state.api.post = vi.fn((url: string) =>
      url === "/files/upload-sessions" ? Promise.resolve({ id: "s1" }) : new Promise(() => {}),
    )
    render(() => <TicketComposer ticketId="t1" />)
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "photo.png", { type: "image/png" })],
    })
    fireEvent.change(input)
    await waitFor(() => expect(screen.getByTestId("composer-attachment-uploading")).toBeTruthy())
  })

  // Posting while a picked file was still uploading sent the note WITHOUT it
  // (the file was not on the session yet) and left the file staged after. A
  // press meanwhile used to do nothing; it now queues the post, which goes
  // out with the file once it is up.
  const addNoteCalls = () =>
    state.api.post.mock.calls.filter(
      (c: unknown[]) => c[0] === "/apps/run-tool" && (c[1] as any)?.toolName === "tickets:addNote",
    )
  // A session of its own per test: other tests leave uploads into "s1" in
  // flight for good, and those would hold this composer too.
  let sessionSeq = 0
  async function queueNoteBehindUpload(sessionGate?: Promise<void>) {
    heldUploads.reset()
    const sessionId = `queued-${++sessionSeq}`
    state.api.post = vi.fn(async (url: string) => {
      if (url === "/files/upload-sessions") {
        if (sessionGate) await sessionGate
        return { id: sessionId }
      }
      return {}
    })
    render(() => <TicketComposer ticketId="t1" initialMode="note" />)
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "context.pdf", { type: "application/pdf" })],
    })
    fireEvent.change(input)
    await waitFor(() =>
      expect(state.api.post).toHaveBeenCalledWith("/files/upload-sessions", expect.anything()),
    )
    setMarkdown(await screen.findByTestId("tickets-composer-body"), "Context for the team.")
    const submit = screen.getByTestId("tickets-composer-submit") as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    expect(submit.getAttribute("aria-label")).toBe("Send when files finish uploading")
    fireEvent.click(submit)
    await nextTask()
    expect(addNoteCalls()).toHaveLength(0)
    expect(submit.dataset.queued).toBe("true")
    expect(submit.textContent).toContain("Queued")
    return { submit, sessionId }
  }

  it("a note posted while a file uploads is queued and goes out with the file", async () => {
    const { submit, sessionId } = await queueNoteBehindUpload()
    await waitFor(() => expect(heldUploads.finish).toHaveLength(1))
    heldUploads.finish[0](landedRow("file-1", "context.pdf"))
    await waitFor(() => expect(addNoteCalls()).toHaveLength(1))
    expect(addNoteCalls()[0][1]).toMatchObject({
      params: { ticketId: "t1", text: "Context for the team.", attachmentSessionId: sessionId },
    })
    expect(submit.dataset.queued).toBeUndefined()
  })

  it("editing the note cancels a queued post", async () => {
    const { submit } = await queueNoteBehindUpload()
    await waitFor(() => expect(heldUploads.finish).toHaveLength(1))
    setMarkdown(screen.getByTestId("tickets-composer-body"), "Context for the team, and more.")
    expect(submit.dataset.queued).toBeUndefined()
    heldUploads.finish[0](landedRow("file-1", "context.pdf"))
    await waitFor(() => expect(screen.queryByTestId("composer-attachment-uploading")).toBeNull())
    await nextTask()
    expect(addNoteCalls()).toHaveLength(0)
  })

  it("a failed upload cancels the queued post and shows the upload error", async () => {
    const { submit } = await queueNoteBehindUpload()
    await waitFor(() => expect(heldUploads.fail).toHaveLength(1))
    heldUploads.fail[0](new Error("storage down"))
    await waitFor(() => expect(screen.getByTestId("composer-attachment-error")).toBeTruthy())
    await nextTask()
    expect(addNoteCalls()).toHaveLength(0)
    expect(submit.dataset.queued).toBeUndefined()
  })

  // Walk 3: a tile still uploading had no remove control, so a slow upload
  // could not be dropped. Removing it aborts the upload, the tile goes at
  // once, the file is never staged (a row the server created anyway is
  // deleted) and the queued post, waiting on nothing now, goes out.
  it("removing a file while it uploads drops it and releases the queued post", async () => {
    const { submit } = await queueNoteBehindUpload()
    await waitFor(() => expect(heldUploads.finish).toHaveLength(1))
    const tile = screen.getByTestId("composer-attachment-uploading")
    fireEvent.click(tile.querySelector("button[data-testid^=composer-attachment-cancel-]")!)
    expect(screen.queryByTestId("composer-attachment-uploading")).toBeNull()

    await waitFor(() => expect(addNoteCalls()).toHaveLength(1))
    expect(addNoteCalls()[0][1]).toMatchObject({
      params: { ticketId: "t1", text: "Context for the team." },
    })
    expect(submit.dataset.queued).toBeUndefined()

    // The confirm was already on its way: its row lands, is never staged,
    // and is deleted.
    heldUploads.finish[0](landedRow("late-1", "context.pdf"))
    await waitFor(() => expect(heldUploads.deleted).toEqual(["/files/late-1"]))
    await nextTask()
    expect(screen.queryByTestId("composer-attachment-late-1")).toBeNull()
    expect(screen.queryByTestId("composer-attachment-error")).toBeNull()
  })

  // The upload session is created on the first pick, one request before the
  // upload itself registers: a post in that gap went out without the file. A
  // press there queues too, and waits for the upload that follows.
  it("a press while the upload session is being created queues until the file is up", async () => {
    let openGate: () => void = () => {}
    const gate = new Promise<void>((r) => (openGate = r))
    await queueNoteBehindUpload(gate)
    openGate()
    await waitFor(() => expect(heldUploads.finish).toHaveLength(1))
    await nextTask()
    expect(addNoteCalls()).toHaveLength(0)
    heldUploads.finish[0](landedRow("file-1", "context.pdf"))
    await waitFor(() => expect(addNoteCalls()).toHaveLength(1))
  })

  // The strip sat right-aligned UNDER the text, beside send; chat has it on
  // top, at the text's left edge. One layout for every composer.
  it("stages files above the text, like chat", async () => {
    state.api.post = vi.fn((url: string) =>
      url === "/files/upload-sessions" ? Promise.resolve({ id: "s1" }) : new Promise(() => {}),
    )
    render(() => <TicketComposer ticketId="t1" />)
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "photo.png", { type: "image/png" })],
    })
    fireEvent.change(input)
    const strip = await waitFor(() => screen.getByTestId("composer-attachment-strip"))
    const body = await replyBox()
    expect(strip.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(strip.className).not.toContain("justify-end")
  })

  // Send sits in the panel's bottom right corner, where the dock's floating
  // bar is: the composer pads its bottom by the shell's clearance for it.
  it("keeps its send row clear of the dock's bar", () => {
    render(() => <TicketComposer ticketId="t1" />)
    expect(screen.getByTestId("tickets-composer").className).toContain("pb-dock-clearance")
  })

  it("renders reply mode by default with submit disabled when empty", () => {
    render(() => <TicketComposer ticketId="t1" />)
    expect(screen.getByTestId("tickets-composer")).toBeTruthy()
    expect(screen.getByTestId("tickets-composer-mode-reply").getAttribute("data-active")).toBe(
      "true",
    )
    expect((screen.getByTestId("tickets-composer-submit") as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows the magic wand button", () => {
    render(() => <TicketComposer ticketId="t1" />)
    expect(screen.getByTestId("magic-wand")).toBeInTheDocument()
  })

  // A person's reply runs on their own scopes: one tickets:reply call, no
  // approval thread, then the conversation reloads with the sent message.
  it("[SC8] send-reply calls tickets:reply once and reloads the conversation", async () => {
    render(() => <TicketComposer ticketId="t1" />)
    await typeReply("Hello customer")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(state.clearDraft).toHaveBeenCalledWith("u1", "t1", "reply"))
    expect(state.api.post).toHaveBeenCalledTimes(1)
    expect(state.api.post.mock.calls[0][0]).toBe("/apps/run-tool")
    expect(state.api.post.mock.calls[0][1]).toEqual({
      toolName: "tickets:reply",
      params: {
        ticketId: "t1",
        htmlBody: "<p>Hello customer</p>",
        textBody: "Hello customer",
      },
    })
    await waitFor(() =>
      expect(state.loadMessages).toHaveBeenCalledWith(state.api, "t1", { fresh: true }),
    )
    expect(screen.queryByTestId("tickets-composer-error")).toBeNull()
  })

  it("a reply refused for a missing scope shows a localized error and keeps the text", async () => {
    state.api.post = vi
      .fn()
      .mockRejectedValue(new ApiError("Missing scope tickets:reply", 403, "forbidden"))
    render(() => <TicketComposer ticketId="t1" />)
    await typeReply("Hello customer")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(screen.getByTestId("tickets-composer-error")).toBeTruthy())
    expect(screen.getByTestId("tickets-composer-error").textContent).toBe(
      "You are not allowed to send replies to customers. Ask an admin for access.",
    )
    expect(state.clearDraft).not.toHaveBeenCalled()
    expect(state.loadMessages).not.toHaveBeenCalled()
    expect((await replyBox()).textContent).toContain("Hello customer")
  })

  it("a note refused for a missing scope shows the note's localized error", async () => {
    state.api.post = vi.fn().mockRejectedValue(new ApiError("Missing scope", 403, "forbidden"))
    render(() => <TicketComposer ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-composer-mode-note"))
    setMarkdown(await screen.findByTestId("tickets-composer-body"), "An internal note")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(screen.getByTestId("tickets-composer-error")).toBeTruthy())
    expect(screen.getByTestId("tickets-composer-error").textContent).toBe(
      "You are not allowed to add notes to tickets. Ask an admin for access.",
    )
  })

  it("a reply that fails for another reason shows the server's message", async () => {
    state.api.post = vi.fn().mockRejectedValue(new ApiError("Mailbox disconnected", 409))
    render(() => <TicketComposer ticketId="t1" />)
    await typeReply("Hello customer")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-composer-error").textContent).toBe("Mailbox disconnected"),
    )
  })

  it("a reply from a mailbox with no stored credentials says to reconnect it", async () => {
    state.api.post = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          "connection_credentials_missing: No credentials are stored for this connection.",
          422,
          "connection_credentials_missing",
        ),
      )
    render(() => <TicketComposer ticketId="t1" />)
    await typeReply("Hello customer")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-composer-error").textContent).toContain(
        "Reconnect this mailbox in Settings → Connections.",
      ),
    )
  })

  it("reply Cc starts with the customer's copied people, removable, and is sent", async () => {
    render(() => <TicketComposer ticketId="t1" defaultCc={["boss@cust.test", "ops@cust.test"]} />)
    const chips = screen.getAllByTestId("tickets-composer-cc-chip")
    expect(chips.map((c) => c.textContent?.replace("×", "").trim())).toEqual([
      "boss@cust.test",
      "ops@cust.test",
    ])
    fireEvent.click(screen.getAllByTestId("tickets-composer-cc-remove")[1]!)
    const input = screen.getByTestId("tickets-composer-cc-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "jordan@fabrikam.test" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await typeReply("Looping in Jordan")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1].params.cc).toEqual([
      "boss@cust.test",
      "jordan@fabrikam.test",
    ])
  })

  it("a customer email copying more than 10 people seeds 10 and says how many were left out", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `p${i}@cust.test`)
    render(() => <TicketComposer ticketId="t1" defaultCc={many} />)
    expect(screen.getAllByTestId("tickets-composer-cc-chip")).toHaveLength(10)
    expect(screen.getByTestId("tickets-composer-cc-left-out").textContent).toContain("2")
    await typeReply("Hello all")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    // FALSIFIABLE: all 12 were seeded and sent, and the server refused the reply.
    expect(state.api.post.mock.calls[0][1].params.cc).toEqual(many.slice(0, 10))
  })

  it("stages files on a session bound to this ticket", async () => {
    state.api.post = vi.fn((url: string) =>
      url === "/files/upload-sessions" ? Promise.resolve({ id: "s-bound" }) : new Promise(() => {}),
    )
    render(() => <TicketComposer ticketId="t1" />)
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "proforma.pdf", { type: "application/pdf" })],
    })
    fireEvent.change(input)
    await waitFor(() =>
      expect(state.api.post).toHaveBeenCalledWith("/files/upload-sessions", {
        targetApp: "tickets",
        targetEntityType: "ticket",
        targetEntityId: "t1",
      }),
    )
  })

  it("an invalid Cc address blocks the send and says which one", async () => {
    render(() => <TicketComposer ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-composer-cc-toggle"))
    const input = screen.getByTestId("tickets-composer-cc-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "jordan-at-fabrikam" } })
    await typeReply("Hi")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(screen.getByTestId("tickets-composer-cc-error")).toBeTruthy())
    expect(screen.getByTestId("tickets-composer-cc-error").textContent).toContain(
      "jordan-at-fabrikam",
    )
    expect(state.api.post).not.toHaveBeenCalled()
  })

  it("a reply without Cc sends no cc", async () => {
    render(() => <TicketComposer ticketId="t1" />)
    await typeReply("Hello")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1].params.cc).toBeUndefined()
  })

  // A formatted reply reaches the customer as formatted email, never as the
  // asterisks it is stored with; the approver still edits the markdown.
  it("sends a formatted reply as email HTML, keeping the markdown as the text", async () => {
    render(() => <TicketComposer ticketId="t1" />)
    await typeReply("Merci **beaucoup** pour ++votre++ retour.")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    const params = state.api.post.mock.calls[0][1].params
    expect(params.textBody).toBe("Merci **beaucoup** pour ++votre++ retour.")
    expect(params.htmlBody).toBe(
      '<p style="margin:0 0 1em">Merci <strong>beaucoup</strong> pour <u>votre</u> retour.</p>',
    )
  })

  it("send-reply includes the follow-up payload and creates no approval thread", async () => {
    render(() => <TicketComposer ticketId="t1" />)
    await typeReply("Hello customer")
    fireEvent.click(screen.getByLabelText("Set follow-up"))
    fireEvent.input(screen.getByTestId("tickets-followup-at"), {
      target: { value: "2026-05-06T10:00" },
    })
    fireEvent.input(screen.getByTestId("tickets-followup-reason"), {
      target: { value: "Check back" },
    })
    fireEvent.input(screen.getByTestId("tickets-followup-trigger"), {
      target: { value: "ticket:t1" },
    })

    fireEvent.click(screen.getByTestId("tickets-composer-submit"))

    await waitFor(() =>
      expect(
        state.api.post.mock.calls.some((call: unknown[]) => call[0] === "/apps/run-tool"),
      ).toBe(true),
    )
    const runToolCall = state.api.post.mock.calls.find(
      (call: unknown[]) => call[0] === "/apps/run-tool",
    )
    expect(state.api.post.mock.calls.some((call: unknown[]) => call[0] === "/threads")).toBe(false)
    expect(runToolCall?.[1].threadId).toBeUndefined()
    expect(runToolCall?.[1]).toMatchObject({
      toolName: "tickets:reply",
      params: {
        ticketId: "t1",
        followup: {
          at: "2026-05-06T10:00",
          reason: "Check back",
          trigger: "ticket:t1",
        },
      },
    })
  })

  it("note mode calls tickets:addNote", async () => {
    render(() => <TicketComposer ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-composer-mode-note"))
    setMarkdown(await screen.findByTestId("tickets-composer-body"), "An internal note")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:addNote",
      params: { ticketId: "t1", text: "An internal note" },
    })
  })

  // BL-192 — reply-macro one-click composer-INSERT affordance. Macro rows come
  // off the wire snake_case (`body_text`); the composer maps them to camelCase.
  const MACRO_ROWS = [
    {
      id: "tpl-1",
      name: "USB driver setup",
      category: "firmware",
      body_text: "Try reinstalling the USB driver.",
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "tpl-2",
      name: "RMA instructions",
      category: "rma",
      body_text: "Here is how to start an RMA.",
      created_at: "2026-01-02T00:00:00Z",
    },
  ]

  function mockTemplatesList() {
    state.api.post = vi.fn().mockImplementation((path: string, body?: any) => {
      if (path === "/apps/run-tool" && body?.toolName === "tickets:templates.list") {
        return Promise.resolve(MACRO_ROWS)
      }
      return Promise.resolve({})
    })
  }

  it("macro picker fetches templates.list on open (reply mode)", async () => {
    mockTemplatesList()
    render(() => <TicketComposer ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-composer-macro-picker"))
    await waitFor(() =>
      expect(
        state.api.post.mock.calls.some(
          (call: any[]) =>
            call[0] === "/apps/run-tool" && call[1]?.toolName === "tickets:templates.list",
        ),
      ).toBe(true),
    )
  })

  it("selecting a macro inserts its body into the composer and enables submit", async () => {
    mockTemplatesList()
    render(() => <TicketComposer ticketId="t1" />)
    // Submit starts disabled (empty body).
    expect((screen.getByTestId("tickets-composer-submit") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId("tickets-composer-macro-picker"))
    await waitFor(() => expect(screen.getByTestId("tickets-macro-tpl-1")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-macro-tpl-1"))
    const box = await replyBox()
    await waitFor(() =>
      expect(editorOf(box).getMarkdown()).toContain("Try reinstalling the USB driver."),
    )
    expect((screen.getByTestId("tickets-composer-submit") as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it("macro picker is hidden in note mode", () => {
    mockTemplatesList()
    render(() => <TicketComposer ticketId="t1" />)
    expect(screen.queryByTestId("tickets-composer-macro-picker")).toBeTruthy()
    fireEvent.click(screen.getByTestId("tickets-composer-mode-note"))
    expect(screen.queryByTestId("tickets-composer-macro-picker")).toBeNull()
  })

  it("clicking the active internal-note tab toggles back to reply mode", () => {
    render(() => <TicketComposer ticketId="t1" />)
    const noteTab = screen.getByTestId("tickets-composer-mode-note")
    const replyTab = screen.getByTestId("tickets-composer-mode-reply")
    // Enter note mode.
    fireEvent.click(noteTab)
    expect(noteTab.getAttribute("data-active")).toBe("true")
    expect(replyTab.getAttribute("data-active")).toBe("false")
    // Clicking the already-active note tab returns to reply mode (previously
    // a no-op — the note tab set mode unconditionally, so it never toggled off).
    fireEvent.click(noteTab)
    expect(noteTab.getAttribute("data-active")).toBe("false")
    expect(replyTab.getAttribute("data-active")).toBe("true")
  })
})

// One header row: the Reply / Internal note toggle on the left, the
// formatting tools on the right, and Cc folded into a button that says how
// many addresses it holds and opens its field in the row.
describe("TicketComposer header row", () => {
  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({})
    state.getDraft.mockReturnValue("")
    state.scopes = ["tickets:tickets:reply", "tickets:tickets:write"]
  })

  it("puts the mode toggle, the Cc button and the formatting tools on one row", async () => {
    render(() => <TicketComposer ticketId="t1" />)
    const header = screen.getByTestId("tickets-composer-header")
    expect(header.contains(screen.getByTestId("tickets-composer-mode-reply"))).toBe(true)
    expect(header.contains(screen.getByTestId("tickets-composer-cc-toggle"))).toBe(true)
    await replyBox()
    await waitFor(() =>
      expect(header.querySelector('[data-testid="rich-editor.toolbar"]')).not.toBeNull(),
    )
    // The tools are the row's last item, after the toggle and Cc.
    const toolbar = header.querySelector('[data-testid="rich-editor.toolbar"]')!
    expect(
      screen.getByTestId("tickets-composer-cc-toggle").compareDocumentPosition(toolbar) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("Cc starts as a closed button with no count when the email copied nobody", () => {
    render(() => <TicketComposer ticketId="t1" />)
    const toggle = screen.getByTestId("tickets-composer-cc-toggle")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("tickets-composer-cc-count")).toBeNull()
    expect(screen.queryByTestId("tickets-composer-cc-field")).toBeNull()
  })

  it("the Cc button opens the field in the row and focuses its input", () => {
    render(() => <TicketComposer ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-composer-cc-toggle"))
    const field = screen.getByTestId("tickets-composer-cc-field")
    expect(screen.getByTestId("tickets-composer-header").contains(field)).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId("tickets-composer-cc-input"))
    expect(screen.queryByTestId("tickets-composer-cc-toggle")).toBeNull()
  })

  it("Cc starts open when the ticket already has Cc addresses", () => {
    render(() => <TicketComposer ticketId="t1" defaultCc={["boss@cust.test"]} />)
    expect(screen.getByTestId("tickets-composer-cc-field")).toBeTruthy()
    expect(screen.getAllByTestId("tickets-composer-cc-chip")).toHaveLength(1)
  })

  it("closing the field folds Cc back into a button that shows the address count", () => {
    render(() => <TicketComposer ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-composer-cc-toggle"))
    const input = screen.getByTestId("tickets-composer-cc-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "a@cust.test, b@cust.test" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByTestId("tickets-composer-cc-field")).toBeNull()
    expect(screen.getByTestId("tickets-composer-cc-count").textContent).toBe("2")
    expect(screen.getByTestId("tickets-composer-cc-toggle").getAttribute("aria-label")).toContain(
      "a@cust.test",
    )
  })

  it("leaving an empty Cc field closes it, an address still typed keeps it open", () => {
    render(() => <TicketComposer ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-composer-cc-toggle"))
    const input = screen.getByTestId("tickets-composer-cc-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "not-an-address" } })
    fireEvent.focusOut(screen.getByTestId("tickets-composer-cc-field"))
    expect(screen.getByTestId("tickets-composer-cc-field")).toBeTruthy()
    fireEvent.input(input, { target: { value: "" } })
    fireEvent.focusOut(screen.getByTestId("tickets-composer-cc-field"))
    expect(screen.queryByTestId("tickets-composer-cc-field")).toBeNull()
  })

  it("note mode hides Cc, button and field alike", () => {
    render(() => <TicketComposer ticketId="t1" defaultCc={["boss@cust.test"]} />)
    fireEvent.click(screen.getByTestId("tickets-composer-mode-note"))
    expect(screen.queryByTestId("tickets-composer-cc-toggle")).toBeNull()
    expect(screen.queryByTestId("tickets-composer-cc-field")).toBeNull()
    fireEvent.click(screen.getByTestId("tickets-composer-mode-reply"))
    expect(screen.getByTestId("tickets-composer-cc-field")).toBeTruthy()
  })

  it("the footer names who the reply goes to, Cc included", () => {
    render(() => (
      <TicketComposer ticketId="t1" recipientName="Lena Hart" defaultCc={["joel@cust.test"]} />
    ))
    expect(screen.getByTestId("tickets-composer-recipients").textContent).toBe(
      "To Lena Hart + 1 Cc",
    )
    fireEvent.click(screen.getByTestId("tickets-composer-cc-remove"))
    expect(screen.getByTestId("tickets-composer-recipients").textContent).toBe("To Lena Hart")
    fireEvent.click(screen.getByTestId("tickets-composer-mode-note"))
    expect(screen.queryByTestId("tickets-composer-recipients")).toBeNull()
  })
})

describe("TicketComposer signature prefill", () => {
  beforeEach(() => {
    state.getDraft.mockReturnValue("")
    state.saveDraft.mockClear()
  })

  /** The reply box's paragraphs, as the person sees them. */
  const paragraphs = (box: HTMLElement) =>
    Array.from(box.querySelectorAll("p")).map((p) => p.innerText ?? p.textContent)

  it("prefills the reply box with the effective signature under a line to type on", async () => {
    render(() => <TicketComposer ticketId="t1" signatureText={"Best,\nFabrikam Support"} />)
    const box = await replyBox()
    await waitFor(() => expect(box.textContent).toContain("Fabrikam Support"))
    expect(editorOf(box).getJSON().content?.[0]).toEqual({ type: "paragraph" })
    expect(paragraphs(box)).toHaveLength(2)
  })

  it("a signature that arrives after the first keys goes after them, once, caret kept", async () => {
    const [sig, setSig] = createSignal<string | null>(null)
    render(() => <TicketComposer ticketId="t1" signatureText={sig()} />)
    const box = await replyBox()
    const ed = editorOf(box)
    ed.commands.focus("start")
    typeInto(ed, "Typed while loading.")
    const caret = ed.state.selection.from
    setSig("Best,\nFabrikam Support")
    await waitFor(() => expect(box.textContent).toContain("Fabrikam Support"))
    // Typed text first, then the signature in its own paragraph, as on an empty box.
    expect(ed.getMarkdown().trim()).toMatch(
      /^Typed while loading\.\n\nBest,\s*\n\s*Fabrikam Support$/,
    )
    expect(paragraphs(box)[0]).toBe("Typed while loading.")
    expect(paragraphs(box)).toHaveLength(2)
    expect(ed.state.selection.from).toBe(caret)
    // Keys typed after it land at the caret, before the signature; never a second copy.
    typeInto(ed, " More")
    setSig("Best,\nFabrikam Support ")
    await nextTask()
    expect(paragraphs(box)[0]).toBe("Typed while loading. More")
    expect(box.textContent?.split("Fabrikam Support")).toHaveLength(2)
  })

  it("does not clobber a saved draft with the signature prefill", async () => {
    state.getDraft.mockReturnValue("my in-progress draft")
    render(() => <TicketComposer ticketId="t1" signatureText="Sig" />)
    const box = await replyBox()
    expect(editorOf(box).getMarkdown()).toBe("my in-progress draft")
  })

  it("keeps submit disabled while the body is only the pristine signature", async () => {
    render(() => <TicketComposer ticketId="t1" signatureText="Sig" />)
    const box = await replyBox()
    await waitFor(() => expect(box.textContent).toBe("Sig"))
    const submit = screen.getByTestId("tickets-composer-submit") as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    setMarkdown(box, "Hi there\n\nSig")
    expect(submit.disabled).toBe(false)
  })

  it("does not re-insert the signature after the user has typed and cleared the box", async () => {
    render(() => <TicketComposer ticketId="t1" signatureText="Sig" />)
    const box = await replyBox()
    await waitFor(() => expect(box.textContent).toBe("Sig"))
    setMarkdown(box, "typed")
    setMarkdown(box, "")
    await nextTask()
    expect(editorOf(box).getMarkdown()).toBe("")
  })

  it("does not persist the pristine prefill as a draft", async () => {
    render(() => <TicketComposer ticketId="t1" signatureText="Sig" />)
    const box = await replyBox()
    await waitFor(() => expect(box.textContent).toBe("Sig"))
    // Unmount triggers the cleanup draft save path.
    document.body.innerHTML = ""
    expect(state.saveDraft).not.toHaveBeenCalled()
  })

  it("note mode never gets a signature prefill", async () => {
    render(() => <TicketComposer ticketId="t1" signatureText="Sig" />)
    const box = await replyBox()
    await waitFor(() => expect(box.textContent).toBe("Sig"))
    fireEvent.click(screen.getByTestId("tickets-composer-mode-note"))
    expect(editorOf(await screen.findByTestId("tickets-composer-body")).getText()).toBe("")
  })

  it("a note is written formatted and posted as markdown", async () => {
    render(() => <TicketComposer ticketId="t1" initialMode="note" />)
    const field = await screen.findByTestId("tickets-composer-body")
    typeInto(editorOf(field), "Client **prioritaire** ")
    expect(field.querySelector("strong")?.textContent).toBe("prioritaire")
    fireEvent.click(screen.getByTestId("tickets-composer-submit"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:addNote",
      params: { ticketId: "t1", text: "Client **prioritaire**" },
    })
  })
})

// The Tickets tour's note beat at phone width, played by "Do it for me" on the
// real composer (its shipped phone autoplay, from the composer sheet on). On
// desktop the agent writes the note; on a phone the script writes it by hand,
// and must never send the note's text to the customer as a reply.
describe("TicketComposer under the Tickets tour's note beat", () => {
  const noteSteps = () => {
    const beat = findTour("tickets.basics")?.beats.find((b) => b.id === "note")
    const steps = beat?.autoplayPhone
    if (!steps) throw new Error("tickets.basics has no phone note autoplay")
    // The composer part: what follows the sheet opening (the action bar is not rendered here).
    const sheet = steps.findIndex((s) => "waitFor" in s && s.waitFor === "ticket-composer-sheet")
    return steps.slice(sheet + 1)
  }
  const play = (steps: Parameters<typeof runAutoplay>[0]) =>
    runAutoplay(steps, {
      cursor: { moveTo: async () => {} },
      signal: new AbortController().signal,
      typeDelayMs: 0,
      stepPauseMs: 0,
      findTimeoutMs: 1000,
    })
  const toolsCalled = () =>
    (state.api.post as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.stringify(c))
  let rects: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({})
    state.getDraft.mockReturnValue("")
    state.scopes = ["tickets:tickets:reply", "tickets:tickets:write"]
    // jsdom lays nothing out: every element counts as on screen.
    rects = vi
      .spyOn(Element.prototype, "getClientRects")
      .mockReturnValue([{}] as unknown as DOMRectList)
  })
  afterEach(() => rects.mockRestore())

  it("in note mode (the sheet the note action opens), it adds a note and never sends a reply", async () => {
    render(() => <TicketComposer ticketId="t1" initialMode="note" />)
    await replyBox()
    expect(await play(noteSteps())).toEqual({ status: "done" })
    await waitFor(() => expect(toolsCalled().some((c) => c.includes("tickets:addNote"))).toBe(true))
    expect(toolsCalled().some((c) => c.includes('"tickets:reply"'))).toBe(false)
  })

  it("the guard before the submit refuses when the button would send a reply", async () => {
    render(() => <TicketComposer ticketId="t1" initialMode="reply" />)
    await replyBox()
    expect(await play(noteSteps())).toEqual({
      status: "refused",
      target: "tickets-composer-submit",
    })
    expect(toolsCalled().some((c) => c.includes('"tickets:reply"'))).toBe(false)
  })

  it("the submit says what it does: add-note in note mode, send-reply in reply mode", async () => {
    render(() => <TicketComposer ticketId="t1" initialMode="note" />)
    const submit = screen.getByTestId("tickets-composer-submit")
    expect(submit.getAttribute("data-action")).toBe("add-note")
    fireEvent.click(screen.getByTestId("tickets-composer-mode-reply"))
    expect(submit.getAttribute("data-action")).toBe("send-reply")
  })
})
