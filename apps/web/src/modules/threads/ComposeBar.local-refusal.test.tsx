// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A REFUSED LOCAL START IS SAID WHERE THE DRAFT CAME BACK (2026-09-23).
//
// Production: the desktop app was quit and relaunched, the first message in a
// "This machine" conversation was refused (409, the conversation still held by
// the previous instance) and the window showed nothing a person could act on.
// Pinned here, through the real send path a thread view uses: the refusal is
// on screen above the composer and says whose computer holds the conversation,
// the draft is back in a field that still takes typing, and the two ways out
// (take it over, let Liaison answer) do what they say.

import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopClaimHolder } from "~/lib/desktop-shell-contract"
import { resetLocalTurnMessages } from "~/modules/desktop/desktop-store"
import {
  type FakeBridgeOptions,
  installFakeBridge,
  uninstallFakeBridge,
} from "~/modules/desktop/fake-bridge"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import { ApiProvider } from "~/modules/shell/ApiContext"
import ComposeBar from "~/modules/threads/ComposeBar"
import { LocalRuntimeUnavailableError } from "~/modules/threads/local-runtime-send"
import { resetMessageStore, sendMessage } from "~/modules/threads/message-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

const THREAD = "t-dm-data"
const AGENT = "agent-data"
const USER = { id: "u-me", name: "Me" }

const api = {
  post: vi.fn(async () => ({ data: { id: "m-posted", threadId: THREAD, authorType: "user" } })),
}

/** What a thread view hands the composer: false only for a send held back. */
function onSend(content: string): Promise<boolean> {
  return sendMessage(api as never, THREAD, content, USER).then(
    () => true,
    (err) => !(err instanceof LocalRuntimeUnavailableError),
  )
}

async function renderComposer() {
  render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <ComposeBar onSend={onSend} onTyping={vi.fn()} threadId={THREAD} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
  return screen.findByRole("textbox", { name: "Write a message" })
}

function refusedByHolder(holder: DesktopClaimHolder, extra: FakeBridgeOptions = {}) {
  return installFakeBridge(
    { runtimeLocation: "local", folderPath: "/Users/me/reports" },
    { refuseStart: "ConversationClaimed", refuseStartHolder: holder, ...extra },
  )
}

async function send(editor: HTMLElement, text: string) {
  typeInto(editorOf(editor), text)
  fireEvent.keyDown(editor, { key: "Enter" })
}

describe("a local start the server refused, in the composer", () => {
  beforeEach(() => {
    resetMessageStore()
    resetThreadStore()
    resetLocalTurnMessages()
    api.post.mockClear()
    addThread({
      id: THREAD,
      handle: "dm-data",
      title: null,
      type: "agent_chat",
      participants: [
        { id: USER.id, name: USER.name, participantType: "user", agentId: null },
        { id: `seat-${AGENT}`, name: "Data", participantType: "agent", agentId: AGENT },
      ],
      lastMessage: null,
      unreadCount: 0,
      updatedAt: "2026-09-23T20:04:00Z",
    })
  })

  afterEach(() => uninstallFakeBridge())

  it("says the conversation runs on another of your computers, and hands the draft back editable", async () => {
    refusedByHolder({ sameUser: true, holderName: null, canTakeOver: true })
    const editor = await renderComposer()
    await send(editor, "make the report")

    const notice = await screen.findByRole("alert")
    expect(notice.textContent).toContain("running on another computer (one of yours)")
    // Nothing was posted, and the draft is back in a field that takes typing.
    expect(api.post).not.toHaveBeenCalled()
    await waitFor(() => expect(editor.textContent).toBe("make the report"))
    expect(editor.getAttribute("contenteditable")).toBe("true")
    editorOf(editor).commands.setTextSelection(editorOf(editor).state.doc.content.size - 1)
    typeInto(editorOf(editor), " now")
    expect(editor.textContent).toBe("make the report now")
  })

  it("names the colleague whose computer holds it", async () => {
    refusedByHolder({ sameUser: false, holderName: "Stéphanie", canTakeOver: true })
    const editor = await renderComposer()
    await send(editor, "hello")
    const notice = await screen.findByRole("alert")
    expect(notice.textContent).toContain("another computer (Stéphanie's)")
  })

  it("takes the conversation over when asked, and the refusal goes", async () => {
    const shell = refusedByHolder(
      { sameUser: true, holderName: null, canTakeOver: true },
      { takeOverSucceeds: true },
    )
    const editor = await renderComposer()
    await send(editor, "hello")
    fireEvent.click(await screen.findByTestId("local-start-take-over"))
    await waitFor(() => expect(shell.calls.started.at(-1)).toMatchObject({ takeOver: true }))
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    expect(shell.state().sessionStatus).toBe("running")
  })

  it("switches the conversation to Liaison when asked", async () => {
    const shell = refusedByHolder({ sameUser: false, holderName: "Stéphanie", canTakeOver: true })
    const editor = await renderComposer()
    await send(editor, "hello")
    fireEvent.click(await screen.findByTestId("local-start-use-liaison"))
    expect(shell.calls.locations).toContain("liaison")
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })

  it("says any other refusal inline too", async () => {
    installFakeBridge(
      { runtimeLocation: "local", folderPath: "/Users/me/reports" },
      { refuseStart: "AuditRefused" },
    )
    const editor = await renderComposer()
    await send(editor, "hello")
    const notice = await screen.findByRole("alert")
    expect(notice.textContent?.length ?? 0).toBeGreaterThan(10)
    expect(screen.queryByTestId("local-start-take-over")).toBeNull()
  })
})
