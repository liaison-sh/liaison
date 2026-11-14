// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createSignal, Suspense } from "solid-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => ({
  userId: null as string | null,
  scopes: [] as string[],
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => (auth.userId ? { userId: auth.userId, scopes: auth.scopes } : null),
  hasScope: (scope: string) => auth.scopes.includes(scope),
}))

import { LinkedDocuments, linkedItemsFromDescription } from "~/modules/projects/LinkedDocuments"

const DESCRIPTION = [
  "Statut : CANDIDATE",
  "PRD : @[PRD App Initialisation v0.7](knowledge:source_link:src-1)",
  "Notes : @[Compte-rendu weekly](knowledge:document:doc-1)",
  "Maquette : @[maquette.png](kernel:file:file-1)",
  "Owner : @[Dana](kernel:user:u1)",
].join("\n")

function makeApi(get: (path: string) => Promise<unknown>) {
  return {
    get: vi.fn(get),
    getEnvelope: vi.fn(async () => ({ data: [] })),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as any
}

describe("LinkedDocuments", () => {
  it("lists only document/file mentions (people stay prose)", () => {
    expect(linkedItemsFromDescription(DESCRIPTION).map((i) => [i.kind, i.label])).toEqual([
      ["source_link", "PRD App Initialisation v0.7"],
      ["document", "Compte-rendu weekly"],
      ["file", "maquette.png"],
    ])
    expect(linkedItemsFromDescription("plain text, https://drive.google.com/x")).toEqual([])
  })

  it("renders nothing on a card without linked documents", () => {
    const api = makeApi(async () => ({}))
    const { queryByTestId } = render(() => (
      <LinkedDocuments compact description="nothing linked here" api={api} />
    ))
    expect(queryByTestId("linked-documents")).toBeNull()
  })

  it("compact cards are collapsed chips that expand to the document body on demand", async () => {
    const api = makeApi(async (path: string) => {
      if (path === "/knowledge/documents/doc-1") {
        return { title: "Compte-rendu weekly", body: "## Décisions\n\n- Plaid **retenu**" }
      }
      if (path === "/knowledge/source-links/src-1") {
        return {
          title: "PRD",
          source: "google-drive",
          url: "https://docs.google.com/document/d/abc",
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    const { getAllByTestId, getByTestId, queryByTestId } = render(() => (
      <LinkedDocuments compact description={DESCRIPTION} api={api} />
    ))
    const cards = getAllByTestId("linked-document")
    expect(cards.map((c) => c.getAttribute("data-kind"))).toEqual([
      "source_link",
      "document",
      "file",
    ])
    // Collapsed: no fetch, no body.
    expect(api.get).not.toHaveBeenCalled()
    expect(queryByTestId("linked-document.body")).toBeNull()

    // Expand the Knowledge document → markdown body, lazily fetched.
    fireEvent.click(getAllByTestId("linked-document.toggle")[1]!)
    await waitFor(() => expect(getByTestId("linked-document.markdown")).toBeTruthy())
    expect(api.get).toHaveBeenCalledWith("/knowledge/documents/doc-1")
    const md = getByTestId("linked-document.markdown")
    expect(md.querySelector("h2")?.textContent).toBe("Décisions")
    expect(md.querySelector("strong")?.textContent).toBe("retenu")

    // Expand the Drive spec → outbound link to the live doc.
    fireEvent.click(getAllByTestId("linked-document.toggle")[0]!)
    await waitFor(() => expect(getByTestId("linked-document.external")).toBeTruthy())
    expect(getByTestId("linked-document.external").getAttribute("href")).toBe(
      "https://docs.google.com/document/d/abc",
    )
  })

  it("a toggle click does not bubble to the card (which would open the task)", () => {
    const api = makeApi(async () => ({}))
    const onCardClick = vi.fn()
    const { getAllByTestId } = render(() => (
      // biome-ignore lint/a11y/useKeyWithClickEvents: test harness
      // biome-ignore lint/a11y/noStaticElementInteractions: test harness
      <div onClick={onCardClick}>
        <LinkedDocuments compact description={DESCRIPTION} api={api} />
      </div>
    ))
    fireEvent.click(getAllByTestId("linked-document.toggle")[0]!)
    expect(onCardClick).not.toHaveBeenCalled()
  })

  it("the full section lists the task's own attachments next to the mentioned ones", async () => {
    const api = makeApi(async (path: string) => {
      if (path === "/files/file-2/metadata") {
        return { id: "file-2", filename: "notes.md", mimeType: "text/markdown", sizeBytes: 12 }
      }
      throw new Error(`unexpected ${path}`)
    })
    api.getEnvelope = vi.fn(async (path: string) => {
      expect(path).toContain("app=projects&entityType=task&entityId=t1")
      return {
        data: [
          { id: "file-1", filename: "maquette.png", mimeType: "image/png", sizeBytes: 10 },
          { id: "file-2", filename: "notes.md", mimeType: "text/markdown", sizeBytes: 12 },
        ],
      }
    })
    const { getAllByTestId, getByTestId } = render(() => (
      <LinkedDocuments description={DESCRIPTION} api={api} taskId="t1" />
    ))
    await waitFor(() => expect(getAllByTestId("linked-document")).toHaveLength(4))
    // file-1 is both mentioned and attached → listed once (as the mention).
    expect(getAllByTestId("linked-document").map((c) => c.getAttribute("data-kind"))).toEqual([
      "source_link",
      "document",
      "file",
      "file",
    ])
    expect(getByTestId("linked-documents").textContent).toContain("notes.md")
  })

  it("a host re-reading the same task lists its files once, and a reload keeps the page mounted", async () => {
    const api = makeApi(async (path: string) => {
      throw new Error(`unexpected ${path}`)
    })
    api.getEnvelope = vi.fn(async () => ({
      data: [{ id: "file-2", filename: "notes.md", mimeType: "text/markdown", sizeBytes: 12 }],
    }))
    // The task page passes `taskId={t().id}` from a memo that changes on every
    // store event about the task: same id, a new task object each time.
    const [task, setTask] = createSignal({ id: "t1", rev: 0 })
    const [version, setVersion] = createSignal(0)
    const { getAllByTestId, queryByTestId } = render(() => (
      <Suspense fallback={<div data-testid="suspended" />}>
        <div data-testid="page">
          <LinkedDocuments
            description="nothing linked"
            api={api}
            taskId={task().id}
            attachmentsVersion={version()}
          />
        </div>
      </Suspense>
    ))
    await waitFor(() => expect(getAllByTestId("linked-document")).toHaveLength(1))
    expect(api.getEnvelope).toHaveBeenCalledTimes(1)

    setTask({ id: "t1", rev: 1 })
    setTask({ id: "t1", rev: 2 })
    expect(queryByTestId("suspended")).toBeNull()
    expect(api.getEnvelope).toHaveBeenCalledTimes(1)

    // A new upload reloads the list without suspending the page around it.
    setVersion(1)
    expect(api.getEnvelope).toHaveBeenCalledTimes(2)
    expect(queryByTestId("suspended")).toBeNull()
    expect(queryByTestId("page")).not.toBeNull()
  })

  it("lists the files posted in the task's discussion, labelled as such, read from the thread's messages", async () => {
    // Newest first, as the messages route answers: a page of the discussion.
    const page = [
      {
        id: "m-2",
        threadId: "thread-d",
        authorId: "u2",
        authorName: "Ben Contoso",
        authorType: "user",
        content: "Gone",
        deletedAt: "2025-03-06T09:00:00.000Z",
        createdAt: "2025-03-06T09:00:00.000Z",
        attachments: [
          { id: "f-gone", filename: "gone.pdf", mimeType: "application/pdf", sizeBytes: 5 },
        ],
      },
      {
        id: "m-1",
        threadId: "thread-d",
        authorId: "u1",
        authorName: "Ada Fabrikam",
        authorType: "user",
        content: "Here is the brief",
        createdAt: "2025-03-05T09:00:00.000Z",
        attachments: [
          { id: "f-brief", filename: "brief.pdf", mimeType: "application/pdf", sizeBytes: 9 },
          // Also attached to the task itself: listed once, as the task's.
          { id: "file-2", filename: "notes.md", mimeType: "text/markdown", sizeBytes: 12 },
        ],
      },
    ]
    const api = makeApi(async (path: string) => {
      throw new Error(`unexpected ${path}`)
    })
    api.getEnvelope = vi.fn(async (path: string) => {
      if (path.startsWith("/threads/thread-d/messages")) return { data: page }
      if (path.includes("app=projects&entityType=task&entityId=t1")) {
        return {
          data: [{ id: "file-2", filename: "notes.md", mimeType: "text/markdown", sizeBytes: 12 }],
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    const { getAllByTestId } = render(() => (
      <LinkedDocuments description="" api={api} taskId="t1" discussionThreadId="thread-d" />
    ))
    await waitFor(() => expect(getAllByTestId("linked-document")).toHaveLength(2))
    const [own, posted] = getAllByTestId("linked-document")
    expect(own!.textContent).toContain("notes.md")
    expect(own!.getAttribute("data-source")).toBeNull()
    expect(posted!.textContent).toContain("brief.pdf")
    expect(posted!.getAttribute("data-source")).toBe("discussion")
    expect(posted!.textContent).toContain("From discussion")
    expect(posted!.getAttribute("title")).toContain("Ada Fabrikam")
    // The discussion is read through the thread's own messages route.
    expect(api.getEnvelope).toHaveBeenCalledWith("/threads/thread-d/messages?limit=50", undefined)
  })

  describe("removing a task attachment", () => {
    beforeEach(() => {
      auth.userId = "u-me"
      auth.scopes = []
    })

    function attachmentsApi() {
      const api = makeApi(async (path: string) => {
        throw new Error(`unexpected ${path}`)
      })
      api.getEnvelope = vi.fn(async () => ({
        data: [
          {
            id: "mine",
            filename: "mine.pdf",
            mimeType: "application/pdf",
            sizeBytes: 3,
            uploadedBy: "u-me",
          },
          {
            id: "theirs",
            filename: "theirs.pdf",
            mimeType: "application/pdf",
            sizeBytes: 3,
            uploadedBy: "u-other",
          },
        ],
      }))
      api.delete = vi.fn(async () => undefined)
      return api
    }

    it("offers Remove on the files I added only, and removes after an inline confirm", async () => {
      const api = attachmentsApi()
      const { getAllByTestId, getByTestId, queryByTestId } = render(() => (
        <LinkedDocuments description="" api={api} taskId="t1" />
      ))
      await waitFor(() => expect(getAllByTestId("linked-document")).toHaveLength(2))
      const cards = getAllByTestId("linked-document")
      expect(cards[0]!.querySelector('[data-testid="linked-document.remove"]')).not.toBeNull()
      expect(cards[1]!.querySelector('[data-testid="linked-document.remove"]')).toBeNull()

      fireEvent.click(getByTestId("linked-document.remove"))
      expect(api.delete).not.toHaveBeenCalled()
      fireEvent.click(getByTestId("linked-document.remove-confirm"))
      await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/files/mine"))
      await waitFor(() => expect(queryByTestId("linked-document.remove-confirm-row")).toBeNull())
    })

    it("cancel keeps the file", async () => {
      const api = attachmentsApi()
      const { getAllByTestId, getByTestId, queryByTestId } = render(() => (
        <LinkedDocuments description="" api={api} taskId="t1" />
      ))
      await waitFor(() => expect(getAllByTestId("linked-document")).toHaveLength(2))
      fireEvent.click(getByTestId("linked-document.remove"))
      fireEvent.click(getByTestId("linked-document.remove-cancel"))
      expect(queryByTestId("linked-document.remove-confirm-row")).toBeNull()
      expect(api.delete).not.toHaveBeenCalled()
    })

    it("a projects administrator may remove anyone's file", async () => {
      auth.scopes = ["projects:settings:admin"]
      const api = attachmentsApi()
      const { getAllByTestId } = render(() => (
        <LinkedDocuments description="" api={api} taskId="t1" />
      ))
      await waitFor(() => expect(getAllByTestId("linked-document.remove")).toHaveLength(2))
    })
  })
})
