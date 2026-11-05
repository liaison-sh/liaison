// SPDX-License-Identifier: FSL-1.1-ALv2
// The task page's discussion shows a message's files the way the full thread
// view does: images as previews, other files as cards, each downloadable, and
// its comment box attaches files the way the thread composer does.
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { installAudioContext, installMic, removeMic } from "~/modules/assist/dictation-fakes"
import { editorOf, setMarkdown, typeInto } from "~/modules/editor/test-helpers"
import { type FileRow, resetPreviewCache } from "~/modules/files/file-service"
import { TaskDiscussion } from "~/modules/projects/TaskDiscussion"
import { ApiContext } from "~/modules/shell/ApiContext"
import { loadMessagesIntoStore, type Message } from "~/modules/threads/message-store"
import {
  channelJumpRequest,
  consumeChannelJump,
  requestChannelJump,
} from "~/modules/threads/reply-panel-store"

const store = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => {}),
  uploaded: [] as string[],
}))

// The upload itself (presign, PUT, confirm) is file-service's and covered
// there: here the session and the staged row come back at once.
vi.mock("~/modules/files/file-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/files/file-service")>()
  return {
    ...actual,
    createUploadSession: async () => ({
      id: "sess-1",
      targetApp: "kernel",
      targetEntityType: "message",
      targetEntityId: null,
    }),
    uploadFile: async (_api: unknown, file: File, parent: { entityId: string }) => {
      store.uploaded.push(`${file.name}@${parent.entityId}`)
      return {
        id: `row-${file.name}`,
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type,
        thumbnailKey: null,
      } satisfies FileRow
    },
  }
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u-me", name: "Me Myself" }),
}))

const messages: Message[] = [
  {
    id: "m-files",
    threadId: "thread-1",
    authorId: "u1",
    authorName: "Ada Fabrikam",
    authorType: "user",
    content: "📎 screen.png, sheet.xlsx",
    editedAt: null,
    deletedAt: null,
    createdAt: "2025-03-04T09:15:00.000Z",
    attachments: [
      {
        id: "f-png",
        filename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        disposition: "attachment",
        contentId: null,
      },
      {
        id: "f-xlsx",
        filename: "sheet.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 3100,
        disposition: "attachment",
        contentId: null,
      },
    ],
  } as Message,
  {
    id: "m-plain",
    threadId: "thread-1",
    authorId: "u2",
    authorName: "Ben Contoso",
    authorType: "user",
    content: "No files here",
    editedAt: null,
    deletedAt: null,
    createdAt: "2025-03-05T09:15:00.000Z",
  } as Message,
]

// The real store renders the comments (the thread view's own stream); only the
// POST is stubbed.
vi.mock("~/modules/threads/message-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/threads/message-store")>()),
  sendMessage: store.sendMessage,
}))

beforeEach(() => {
  loadMessagesIntoStore("thread-1", messages)
})

afterEach(() => {
  // A preview still in flight when the URL stub is lifted fails, and the
  // session cache would hand that failure to the next test's image.
  resetPreviewCache()
  vi.unstubAllGlobals()
  store.sendMessage.mockClear()
  store.uploaded = []
})

function renderDiscussion(api: ApiClient) {
  return render(() => (
    <ApiContext.Provider value={api}>
      <TaskDiscussion threadId="thread-1" />
    </ApiContext.Provider>
  ))
}

// Still a constructor: the module runner builds URLs to load the lazy editor.
function stubObjectUrls() {
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    }),
  )
}

/** The main panel's active tab in a fresh tab store. */
const ON_SCREEN = { tabType: "kernel:home", entityId: "home" }

const pdf = () => new File(["%PDF"], "brief.pdf", { type: "application/pdf" })
const png = () => new File(["png"], "shot.png", { type: "image/png" })

describe("TaskDiscussion", () => {
  it("its composer is an inline DockedComposer, so it docks above the phone keyboard", () => {
    // The composer sits inside the task page's scroll: as a plain form it
    // scrolled away with the page under the keyboard (ui/DockedComposer.tsx).
    const api = { rawGet: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as ApiClient
    renderDiscussion(api)
    const dock = screen.getByTestId("task-discussion.dropzone").closest("[data-composer-dock]")
    expect(dock?.getAttribute("data-composer-dock")).toBe("inline")
    expect(dock?.contains(screen.getByTestId("task-discussion.send"))).toBe(true)
  })

  // V3, then P2-W5: in the ~340 px discussion column of a wide screen the
  // whole row used to wrap, dropping the Comment button onto its own line,
  // and the send hint (shown by the WINDOW's width) took the room. Now the
  // composer is the size query: the tools wrap among themselves, the send
  // button never wraps or shrinks, and the hint shows only where the
  // composer is at least @md wide. jsdom has no layout, so the rules that
  // produce those widths are what is asserted.
  it("at a narrow composer, the tools wrap among themselves and the send button keeps its line", () => {
    const api = { rawGet: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as ApiClient
    renderDiscussion(api)
    const form = screen.getByTestId("task-discussion.dropzone")
    expect(form.classList.contains("@container")).toBe(true)

    const row = screen.getByTestId("task-discussion.actions")
    expect(row.classList.contains("flex-wrap")).toBe(false)
    expect(row.classList.contains("min-w-0")).toBe(true)

    // The row's controls sit in the recorder's `display: contents` wrapper,
    // so they lay out as the row's own children.
    const tools = within(row).getByTestId("task-discussion.tools")
    for (const c of ["flex-wrap", "flex-1", "min-w-0"])
      expect(tools.classList.contains(c)).toBe(true)
    expect(tools.parentElement?.classList.contains("contents")).toBe(true)
    expect(tools.parentElement?.parentElement).toBe(row)

    const send = within(row).getByTestId("task-discussion.send")
    expect(send.parentElement?.parentElement).toBe(row)
    for (const c of ["shrink-0", "whitespace-nowrap"]) expect(send.classList.contains(c)).toBe(true)
    expect(send.className).not.toMatch(/(^|\s)(sm:)?ml-auto/)

    const hint = within(row).getByTestId("task-discussion.send-hint")
    for (const c of ["hidden", "@md:inline", "whitespace-nowrap", "shrink-0"])
      expect(hint.classList.contains(c)).toBe(true)
    // Never the window's breakpoint: a wide screen has a narrow composer here.
    expect(hint.className).not.toMatch(/(^|\s)sm:inline/)
  })

  it("renders a message's attachments with previews and downloads; a text-only message stays as it was", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    })
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet, get: vi.fn(), post: vi.fn() } as unknown as ApiClient
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDiscussion threadId="thread-1" />
      </ApiContext.Provider>
    ))

    const withFiles = screen.getByTestId("task-discussion.message-m-files")
    expect(within(withFiles).getByTestId("attachment-strip")).toBeVisible()
    // The image previews like in the thread view; the spreadsheet is a card.
    expect(within(withFiles).getByTestId("attachment-image-f-png")).toHaveTextContent("screen.png")
    expect(within(withFiles).getByTestId("attachment-card-f-xlsx")).toHaveTextContent("sheet.xlsx")
    expect(within(withFiles).getByTestId("attachment-download-f-png")).toBeVisible()

    fireEvent.click(within(withFiles).getByTestId("attachment-download-f-xlsx"))
    await waitFor(() => expect(rawGet).toHaveBeenCalledWith("/files/f-xlsx/inline?download=1"))

    const plain = screen.getByTestId("task-discussion.message-m-plain")
    expect(within(plain).getByTestId("task-discussion.message-body")).toHaveTextContent(
      "No files here",
    )
    expect(within(plain).queryByTestId("attachment-strip")).toBeNull()
  })
})

describe("TaskDiscussion comment attachments", () => {
  const api = () =>
    ({
      rawGet: vi.fn(async () => new Response(new Blob(["x"]))),
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
    }) as unknown as ApiClient

  it("attaches a picked file, shows it staged, and sends the comment with its upload session", async () => {
    stubObjectUrls()
    renderDiscussion(api())
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    fireEvent.change(input, { target: { files: [pdf()] } })

    // Staged in the composer's strip, uploaded into the message upload session.
    await waitFor(() => expect(screen.getByText("brief.pdf")).toBeVisible())
    expect(store.uploaded).toEqual(["brief.pdf@sess-1"])

    setMarkdown(await screen.findByTestId("task-discussion.composer"), "Spec attached")
    fireEvent.click(screen.getByTestId("task-discussion.send"))
    await waitFor(() => expect(store.sendMessage).toHaveBeenCalledTimes(1))
    expect(store.sendMessage.mock.calls[0]?.slice(1)).toEqual([
      "thread-1",
      "Spec attached",
      { id: "u-me", name: "Me Myself" },
      // The thread view's send: the view on screen travels with the turn.
      { attachmentSessionId: "sess-1", currentView: ON_SCREEN },
    ])
    // Sent: the strip empties with the field.
    await waitFor(() => expect(screen.queryByText("brief.pdf")).toBeNull())
  })

  it("a file alone is a comment: send is enabled with no text", async () => {
    stubObjectUrls()
    renderDiscussion(api())
    const send = screen.getByTestId("task-discussion.send") as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByTestId("attachment-upload-input"), {
      target: { files: [pdf()] },
    })
    await waitFor(() => expect(send.disabled).toBe(false))
    fireEvent.click(send)
    await waitFor(() =>
      expect(store.sendMessage.mock.calls[0]?.slice(2)).toEqual([
        "",
        { id: "u-me", name: "Me Myself" },
        { attachmentSessionId: "sess-1", currentView: ON_SCREEN },
      ]),
    )
  })

  it("stages a pasted screenshot and a dropped file through the same session", async () => {
    stubObjectUrls()
    renderDiscussion(api())
    const pasted = new File(["png"], "image.png", { type: "image/png" })
    fireEvent.paste(await screen.findByTestId("task-discussion.composer"), {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => pasted }],
        getData: () => "",
      },
    })
    fireEvent.drop(screen.getByTestId("task-discussion.dropzone"), {
      dataTransfer: { files: [png()], types: ["Files"] },
    })
    await waitFor(() => expect(store.uploaded).toHaveLength(2))
    // The clipboard's generic name is stamped, as in the thread composer.
    expect(store.uploaded[0]).toMatch(/^pasted-.*\.png@sess-1$/)
    expect(store.uploaded[1]).toBe("shot.png@sess-1")
  })

  it("sends what the editor shows as markdown, then empties the field", async () => {
    renderDiscussion(api())
    const field = await screen.findByTestId("task-discussion.composer")
    const editor = editorOf(field)
    typeInto(editor, "Bien reçu")
    editor.commands.setTextSelection({ from: 1, to: 5 })
    fireEvent.keyDown(field, { key: "b", ctrlKey: true })
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true })
    await waitFor(() => expect(store.sendMessage).toHaveBeenCalledTimes(1))
    expect(store.sendMessage.mock.calls[0]?.[2]).toBe("**Bien** reçu")
    await waitFor(() => expect(field.textContent).toBe(""))
  })

  it("opens a comment's image in the full-screen viewer", async () => {
    stubObjectUrls()
    renderDiscussion(api())
    const thumb = await waitFor(() => screen.getByTestId("attachment-thumbnail-f-png"))
    fireEvent.click(thumb.closest("button") as HTMLButtonElement)
    await waitFor(() => expect(screen.getByTestId("attachment-lightbox-f-png")).toBeVisible())
  })
})

describe("TaskDiscussion: a notification's message", () => {
  it("brings the comment a notification is about into view", async () => {
    const api = { rawGet: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as ApiClient
    const scrolled: string[] = []
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute("data-message-id") ?? "")
    }
    try {
      renderDiscussion(api)
      requestChannelJump("thread-1", "m-files")
      await waitFor(() => expect(scrolled).toContain("m-files"))
      const row = screen
        .getByTestId("task-discussion.scroller")
        .querySelector('[data-message-id="m-files"]') as HTMLElement
      expect(row.dataset.quoteHighlight).toBe("true")
      // The request is taken: it does not fire again in another view.
      expect(channelJumpRequest()).toBeNull()
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it("leaves another thread's request alone", async () => {
    const api = { rawGet: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as ApiClient
    renderDiscussion(api)
    requestChannelJump("thread-other", "m-files")
    await new Promise((r) => setTimeout(r, 50))
    const pending = channelJumpRequest()
    expect(pending).toMatchObject({ threadId: "thread-other", messageId: "m-files" })
    if (pending) consumeChannelJump(pending)
  })
})

describe("TaskDiscussion dictation", () => {
  it("the mic sits immediately left of Send; the wand stays with the tools", async () => {
    installMic()
    installAudioContext()
    try {
      const api = {
        rawGet: vi.fn(),
        get: vi.fn(async (path: string) =>
          path === "/assist/capabilities" ? { dictation: true, autoClean: true } : [],
        ),
        post: vi.fn(),
      } as unknown as ApiClient
      renderDiscussion(api)
      const mic = await screen.findByTestId("voice-dictation-button")
      expect(mic.nextElementSibling).toBe(screen.getByTestId("task-discussion.send"))
      expect(
        screen.getByTestId("task-discussion.tools").contains(screen.getByTestId("magic-wand")),
      ).toBe(true)
    } finally {
      removeMic()
    }
  })
})
