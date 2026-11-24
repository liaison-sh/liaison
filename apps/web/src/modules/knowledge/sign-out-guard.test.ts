// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { clearAuth } from "~/modules/auth/auth-store"
import { createPageSaver, liveSavers, type PageSaver } from "./autosave"
import { type DraftStore, draftKey, type Liveness, type PageDraft } from "./drafts"
import {
  createDraftMessageHandler,
  createKnowledgeSignOutGuard,
  type DraftMessage,
  type GuardDeps,
  type UnsavedPage,
} from "./sign-out-guard"

interface Page {
  title: string
  body: string
  revision: number
}

function makeServer() {
  const pages = new Map<string, Page>([
    ["p1", { title: "Returns", body: "start", revision: 1 }],
    ["p2", { title: "Warranty", body: "w", revision: 1 }],
  ])
  const state = { offline: false, gone: new Set<string>() }
  const posts: { path: string; body: Record<string, unknown> }[] = []
  const patches: string[] = []
  const net = () => new ApiError("Network error", 0)
  const idOf = (path: string) => path.split("/")[3]!.split("?")[0]!
  const api = {
    get: vi.fn(async <T>(path: string): Promise<T> => {
      if (state.offline) throw net()
      const id = idOf(path)
      if (state.gone.has(id)) throw new ApiError("Not found", 404)
      return { id, ...pages.get(id)! } as T
    }),
    patch: vi.fn(async <T>(path: string, body: unknown): Promise<T> => {
      patches.push(path)
      if (state.offline) throw net()
      const id = idOf(path)
      if (state.gone.has(id)) throw new ApiError("Not found", 404)
      const b = body as Page
      const page = pages.get(id)!
      if (b.revision !== page.revision) throw new ApiError("Revision conflict", 409)
      const next = { title: b.title, body: b.body, revision: page.revision + 1 }
      pages.set(id, next)
      return { id, ...next } as T
    }),
    post: vi.fn(async <T>(path: string, body: unknown): Promise<T> => {
      if (state.offline) throw net()
      if (state.gone.has(idOf(path))) throw new ApiError("Not found", 404)
      posts.push({ path, body: body as Record<string, unknown> })
      return { id: "v" } as T
    }),
  }
  return { pages, state, posts, patches, api }
}

function memoryDrafts(): DraftStore & { map: Map<string, PageDraft> } {
  const map = new Map<string, PageDraft>()
  return {
    map,
    async put(d) {
      map.set(draftKey(d), { ...d })
    },
    async remove(key) {
      map.delete(key)
    },
    async forUser(userId) {
      return [...map.values()].filter((d) => d.userId === userId).map((d) => ({ ...d }))
    },
    writeShadow(d) {
      map.set(draftKey(d), { ...d })
    },
  }
}

const noLocks: Liveness = { hold: () => () => {}, held: async () => new Set() }

let server: ReturnType<typeof makeServer>
let drafts: ReturnType<typeof memoryDrafts>
let signedIn: string | null

function openPage(docId: string, savers: Set<PageSaver>) {
  const page = server.pages.get(docId)!
  const editor = { title: page.title, body: page.body }
  const saver = createPageSaver({
    api: server.api as never,
    userId: "amina",
    docId,
    base: { ...page },
    read: () => ({ ...editor }),
    currentUserId: () => signedIn,
    drafts,
    liveness: noLocks,
    untitled: () => "Untitled",
    target: null,
  })
  savers.add(saver)
  return {
    saver,
    type(body: string) {
      editor.body = body
      saver.edit()
    },
  }
}

function guardWith(savers: Set<PageSaver>, over: Partial<GuardDeps> = {}) {
  const ask = vi.fn(async (_pages: UnsavedPage[]) => "stay" as const)
  const guard = createKnowledgeSignOutGuard({
    api: server.api as never,
    drafts,
    savers: () => [...savers],
    currentUserId: () => signedIn,
    untitled: () => "Untitled",
    ask,
    messenger: null,
    otherTabsMs: 0,
    flushBoundMs: 5_000,
    ...over,
  })
  return { guard, ask: (over.ask as typeof ask | undefined) ?? ask }
}

beforeEach(() => {
  server = makeServer()
  drafts = memoryDrafts()
  signedIn = "amina"
})

afterEach(async () => {
  for (const s of liveSavers()) await s.destroy({ discard: true })
})

describe("the knowledge sign-out guard", () => {
  it("clean: says yes at once, asks nothing and sends nothing", async () => {
    const savers = new Set<PageSaver>()
    openPage("p1", savers)
    const { guard, ask } = guardWith(savers)
    const started = Date.now()
    expect(await guard({ forced: false })).toBe(true)
    expect(Date.now() - started).toBeLessThan(50)
    expect(ask).not.toHaveBeenCalled()
    expect(server.api.patch).not.toHaveBeenCalled()
    expect(server.api.post).not.toHaveBeenCalled()
  })

  it("dirty text that saves: saved, draft gone, no question", async () => {
    const savers = new Set<PageSaver>()
    const t = openPage("p1", savers)
    t.type("finished sentence")
    const { guard, ask } = guardWith(savers)
    expect(await guard({ forced: false })).toBe(true)
    expect(server.pages.get("p1")!.body).toBe("finished sentence")
    expect(ask).not.toHaveBeenCalled()
    expect(drafts.map.size).toBe(0)
  })

  it("offline with dirty text: asked; Stay keeps session and text; Discard erases it", async () => {
    const savers = new Set<PageSaver>()
    const t = openPage("p1", savers)
    t.type("offline words")
    server.state.offline = true
    const stay = guardWith(savers)
    expect(await stay.guard({ forced: false })).toBe(false)
    expect(stay.ask).toHaveBeenCalledTimes(1)
    const listed = stay.ask.mock.calls[0]![0]
    expect(listed).toEqual([
      expect.objectContaining({
        docId: "p1",
        title: "Returns",
        body: "offline words",
        reason: "offline",
      }),
    ])
    expect(drafts.map.get(t.saver.key)?.body).toBe("offline words")
    expect(liveSavers()).toContain(t.saver)

    const discard = guardWith(savers, { ask: vi.fn(async () => "discard" as const) })
    expect(await discard.guard({ forced: false })).toBe(true)
    expect(drafts.map.size).toBe(0)
    expect(liveSavers()).not.toContain(t.saver)
  })

  it("Discard also erases a draft of a page that is not open, which could not be stored", async () => {
    await drafts.put({
      userId: "amina",
      docId: "p2",
      sessionId: "old",
      title: "Warranty",
      body: "left offline",
      baseRevision: 1,
      baseHash: "",
      at: 1,
      beat: 1,
    })
    server.state.offline = true
    const stay = guardWith(new Set())
    expect(await stay.guard({ forced: false })).toBe(false)
    expect(stay.ask.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ docId: "p2", title: "Warranty", body: "left offline" }),
    ])
    expect(drafts.map.size).toBe(1)
    const discard = guardWith(new Set(), { ask: vi.fn(async () => "discard" as const) })
    expect(await discard.guard({ forced: false })).toBe(true)
    expect(drafts.map.size).toBe(0)
  })

  it("conflict: my text posted as an unapplied version, no question, draft gone", async () => {
    const savers = new Set<PageSaver>()
    const t = openPage("p1", savers)
    server.pages.set("p1", { title: "Returns", body: "theirs", revision: 2 })
    t.type("mine")
    await t.saver.flush()
    expect(t.saver.status().state).toBe("conflict")
    const { guard, ask } = guardWith(savers)
    expect(await guard({ forced: false })).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect(server.posts).toEqual([
      {
        path: "/knowledge/documents/p1/versions",
        body: { title: "Returns", body: "mine", baseRevision: 1, session: t.saver.sessionId },
      },
    ])
    expect(drafts.map.size).toBe(0)
  })

  it("this tab's own draft is posted once, by its saver, never again as a stored draft", async () => {
    const savers = new Set<PageSaver>()
    const t = openPage("p1", savers)
    server.pages.set("p1", { title: "Returns", body: "theirs", revision: 2 })
    t.type("mine")
    await t.saver.flush()
    expect(t.saver.status().state).toBe("conflict")
    await t.saver.persistDraft()
    expect(drafts.map.has(t.saver.key)).toBe(true)
    // The saver's post fails once; a second post of the same draft would succeed.
    let attempts = 0
    const post = server.api.post.getMockImplementation()!
    server.api.post.mockImplementation(async (path: string, body: unknown) => {
      attempts += 1
      if (attempts === 1) throw new ApiError("Unavailable", 503)
      return post(path, body)
    })
    const { guard, ask } = guardWith(savers)
    expect(await guard({ forced: false })).toBe(false)
    expect(attempts).toBe(1)
    expect(server.posts).toEqual([])
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0]).toEqual([expect.objectContaining({ docId: "p1", body: "mine" })])
  })

  it("a draft of a page not open is posted to its history", async () => {
    await drafts.put({
      userId: "amina",
      docId: "p2",
      sessionId: "old",
      title: "Warranty",
      body: "left yesterday",
      baseRevision: 1,
      baseHash: "",
      at: 1,
      beat: 1,
    })
    const { guard, ask } = guardWith(new Set())
    expect(await guard({ forced: false })).toBe(true)
    expect(server.posts[0]).toMatchObject({
      path: "/knowledge/documents/p2/versions",
      body: { body: "left yesterday", session: "old" },
    })
    expect(ask).not.toHaveBeenCalled()
    expect(drafts.map.size).toBe(0)
  })

  it("post refused with 404: asked, the list carries the text to copy", async () => {
    const savers = new Set<PageSaver>()
    const t = openPage("p1", savers)
    server.state.gone.add("p1")
    t.type("text of a page that went away")
    const { guard, ask } = guardWith(savers)
    expect(await guard({ forced: false })).toBe(false)
    expect(ask.mock.calls[0]![0][0]).toMatchObject({
      body: "text of a page that went away",
      reason: "no-access",
    })
  })

  it("another tab's dirty text is saved before the sign-out", async () => {
    // Two tabs of one person: each has its savers, they talk through the channel.
    const thisTab = new Set<PageSaver>()
    const otherTab = new Set<PageSaver>()
    const other = openPage("p2", otherTab)
    other.type("typed in the other tab")
    await other.saver.persistDraft()
    const toOther = createDraftMessageHandler({
      savers: () => [...otherTab],
      currentUserId: () => signedIn,
    })
    const sent: DraftMessage[] = []
    let delivered: Promise<void> = Promise.resolve()
    const { guard, ask } = guardWith(thisTab, {
      messenger: {
        post: (m) => {
          sent.push(m)
          delivered = toOther(m)
        },
      },
      otherTabsMs: 0,
    })
    const answer = guard({ forced: false })
    await delivered
    expect(await answer).toBe(true)
    expect(sent).toEqual([{ type: "flush-now", userId: "amina" }])
    expect(server.pages.get("p2")!.body).toBe("typed in the other tab")
    expect(ask).not.toHaveBeenCalled()
  })

  it("a message for another user is ignored by this tab", async () => {
    const tabSavers = new Set<PageSaver>()
    const t = openPage("p1", tabSavers)
    t.type("mine")
    const handler = createDraftMessageHandler({
      savers: () => [...tabSavers],
      currentUserId: () => signedIn,
    })
    await handler({ type: "discard", userId: "lucas" })
    expect(liveSavers()).toContain(t.saver)
  })

  it("expiry and another tab's sign-out never ask and erase nothing", async () => {
    const savers = new Set<PageSaver>()
    const t = openPage("p1", savers)
    server.state.offline = true
    t.type("unsaved at expiry")
    const ask = vi.fn()
    clearAuth()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(ask).not.toHaveBeenCalled()
    expect(liveSavers()).not.toContain(t.saver)
    expect(drafts.map.get(t.saver.key)?.body).toBe("unsaved at expiry")
  })

  it("deleted account (forced): asks nothing, erases every draft of the user, keeps others'", async () => {
    const savers = new Set<PageSaver>()
    const t = openPage("p1", savers)
    server.state.offline = true
    t.type("will be erased")
    await t.saver.persistDraft()
    await drafts.put({
      userId: "lucas",
      docId: "p1",
      sessionId: "s",
      title: "Returns",
      body: "his",
      baseRevision: 1,
      baseHash: "",
      at: 1,
      beat: 1,
    })
    const { guard, ask } = guardWith(savers)
    expect(await guard({ forced: true })).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect([...drafts.map.values()].map((d) => d.userId)).toEqual(["lucas"])
  })
})
