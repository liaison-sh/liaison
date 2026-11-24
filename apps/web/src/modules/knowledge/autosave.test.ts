// SPDX-License-Identifier: FSL-1.1-ALv2
import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { clearAuth } from "~/modules/auth/auth-store"
import {
  createPageSaver,
  liveSavers,
  MAX_BODY_CHARS,
  openDrafts,
  type PageSaver,
  postDraftToHistory,
  type SavedRow,
} from "./autosave"
import {
  createDraftStore,
  DEAD_AFTER_MS,
  type DraftStore,
  draftKey,
  draftLockName,
  type Liveness,
  type PageDraft,
} from "./drafts"

// ── A fake server: one page, revisions, a log of every request ──────────────
interface Server {
  page: { id: string; title: string; body: string; revision: number }
  patches: {
    path: string
    body: { title: string; body: string; revision: number }
    keepalive?: boolean
  }[]
  posts: { path: string; body: Record<string, unknown> }[]
  /** Next PATCH fails this way (then the server works again). */
  failNext: (() => Error) | null
  /** Every request fails as the network does. */
  offline: boolean
  /** The PATCH is applied but its answer is lost. */
  loseReply: boolean
  gone: boolean
}

function makeServer(): Server {
  return {
    page: { id: "p1", title: "Returns", body: "start", revision: 1 },
    patches: [],
    posts: [],
    failNext: null,
    offline: false,
    loseReply: false,
    gone: false,
  }
}

function apiOf(server: Server) {
  const net = () => new ApiError("Network error", 0)
  return {
    get: vi.fn(async <T>(_path: string): Promise<T> => {
      if (server.offline) throw net()
      if (server.gone) throw new ApiError("Not found", 404)
      return { ...server.page } as T
    }),
    patch: vi.fn(
      async <T>(path: string, body: unknown, init?: { keepalive?: boolean }): Promise<T> => {
        const b = body as { title: string; body: string; revision: number }
        server.patches.push({ path, body: b, keepalive: init?.keepalive })
        if (server.offline) throw net()
        if (server.failNext) {
          const make = server.failNext
          server.failNext = null
          throw make()
        }
        if (server.gone) throw new ApiError("Not found", 404)
        if (b.revision !== server.page.revision) throw new ApiError("Revision conflict", 409)
        server.page = {
          ...server.page,
          title: b.title,
          body: b.body,
          revision: server.page.revision + 1,
        }
        if (server.loseReply) {
          server.loseReply = false
          throw net()
        }
        return { ...server.page } as T
      },
    ),
    post: vi.fn(async <T>(path: string, body: unknown): Promise<T> => {
      if (server.offline) throw net()
      if (server.gone) throw new ApiError("Not found", 404)
      server.posts.push({ path, body: body as Record<string, unknown> })
      return { id: `v${server.posts.length}` } as T
    }),
  }
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

/** Web Locks as a set of held names. */
function fakeLocks(): Liveness & { names: Set<string> } {
  const names = new Set<string>()
  return {
    names,
    hold(key) {
      names.add(draftLockName(key))
      return () => names.delete(draftLockName(key))
    },
    async held() {
      return new Set(names)
    },
  }
}

/** One mounted page view: an editor (its text) and its saver. */
function tab(args: {
  server: Server
  api: ReturnType<typeof apiOf>
  drafts: DraftStore
  liveness: Liveness | null
  user?: () => string | null
  userId?: string
  text?: { title: string; body: string }
}) {
  const text = args.text ?? { title: args.server.page.title, body: args.server.page.body }
  const editor = { ...text }
  const saver = createPageSaver({
    api: args.api as never,
    userId: args.userId ?? "amina",
    docId: "p1",
    base: { ...args.server.page },
    read: () => ({ ...editor }),
    currentUserId: args.user ?? (() => args.userId ?? "amina"),
    drafts: args.drafts,
    liveness: args.liveness,
    untitled: () => "Untitled",
  })
  return {
    saver,
    type(body: string, title?: string) {
      editor.body = body
      if (title !== undefined) editor.title = title
      saver.edit()
    },
    editor,
  }
}

const flushPromises = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

let server: Server
let api: ReturnType<typeof apiOf>
let drafts: ReturnType<typeof memoryDrafts>
let locks: ReturnType<typeof fakeLocks>

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  })
  server = makeServer()
  api = apiOf(server)
  drafts = memoryDrafts()
  locks = fakeLocks()
})

afterEach(async () => {
  for (const s of liveSavers()) await s.destroy({ discard: true })
  vi.useRealTimers()
})

describe("createPageSaver", () => {
  it("saves within 2 s of the last key, and at most every 10 s while typing", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    // A key every 500 ms for 30 s.
    const saveTimes: number[] = []
    api.patch.mockImplementation(async (_p: string, body: unknown) => {
      saveTimes.push(Date.now())
      const b = body as { title: string; body: string; revision: number }
      server.page = { ...server.page, ...b, revision: server.page.revision + 1 }
      return { ...server.page } as never
    })
    const start = Date.now()
    for (let i = 0; i < 60; i++) {
      t.type(`start ${i}`)
      await vi.advanceTimersByTimeAsync(500)
    }
    const lastKey = Date.now() - 500
    await vi.advanceTimersByTimeAsync(2_000)
    expect(saveTimes.length).toBeGreaterThanOrEqual(3)
    const gaps = saveTimes.map((at, i) => at - (i ? saveTimes[i - 1]! : start))
    for (const gap of gaps.slice(0, -1)) expect(gap).toBeLessThanOrEqual(10_000)
    expect(saveTimes.at(-1)! - lastKey).toBeLessThanOrEqual(2_000)
    expect(server.page.body).toBe("start 59")
    expect(t.saver.status().state).toBe("saved")
    // Saved text leaves no draft.
    await flushPromises()
    expect(drafts.map.size).toBe(0)
  })

  it("sends title and text in one PATCH with ?autosave=1 and its session", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    t.type("new text", "New title")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.patches).toHaveLength(1)
    expect(server.patches[0]!.path).toBe(
      `/knowledge/documents/p1?autosave=1&session=${t.saver.sessionId}`,
    )
    expect(server.patches[0]!.body).toEqual({ title: "New title", body: "new text", revision: 1 })
  })

  it("an empty title is saved as Untitled (edge 2), and that counts as saved", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    t.type("start", "  ")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.page.title).toBe("Untitled")
    expect(t.saver.status().state).toBe("saved")
    expect(t.saver.hasUnsaved()).toBe(false)
  })

  it("reply lost after the server applied: the retry's 409 finds my text stored -> saved, no conflict", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    server.loseReply = true
    t.type("mine")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.saver.status().state).toBe("offline")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.saver.status().state).toBe("saved")
    expect(t.saver.revision()).toBe(2)
    expect(server.page.body).toBe("mine")
  })

  it("network failures retry after 1, 2, 4 ... s up to 30 s, and at once when back online", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    server.offline = true
    t.type("offline text")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.patches).toHaveLength(1)
    for (const step of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(step - 1)
      const before = server.patches.length
      await vi.advanceTimersByTimeAsync(1)
      expect(server.patches.length).toBe(before + 1)
    }
    expect(t.saver.status().state).toBe("offline")
    server.offline = false
    window.dispatchEvent(new Event("online"))
    await vi.advanceTimersByTimeAsync(0)
    expect(server.page.body).toBe("offline text")
    expect(t.saver.status().state).toBe("saved")
  })

  it("10 minutes offline then reload: the text is offered", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    server.offline = true
    for (let i = 0; i < 120; i++) {
      t.type(`offline ${i}`)
      await vi.advanceTimersByTimeAsync(5_000)
    }
    // Reload: the page is gone with its saver (no clean flush), then opens again.
    window.dispatchEvent(new Event("pagehide"))
    await t.saver.destroy()
    server.offline = false
    const opened = await openDrafts({
      drafts,
      liveness: locks,
      userId: "amina",
      docId: "p1",
      current: server.page,
    })
    expect(opened.restore?.body).toBe("offline 119")
    expect(opened.conflict).toBeNull()
  })

  it("over 1,000,000 characters: not sent, says the size, the draft is kept (edge 4)", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    const big = "x".repeat(MAX_BODY_CHARS + 1)
    t.type(big)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(server.patches).toHaveLength(0)
    expect(t.saver.status()).toEqual({ state: "too-large", size: MAX_BODY_CHARS + 1 })
    expect(drafts.map.get(t.saver.key)?.body).toBe(big)
  })

  it("page trashed or access removed while typing: no-access, saving stops, the draft is kept (edge 3)", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    server.gone = true
    t.type("still mine")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.saver.status().state).toBe("no-access")
    t.type("still mine, more")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.patches).toHaveLength(1)
    expect(drafts.map.get(t.saver.key)?.body).toBe("still mine, more")
  })

  it("64 KB+ at unload is not sent with keepalive and stays as draft (edge 5); a small one is", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    const big = "y".repeat(70_000)
    t.type(big)
    window.dispatchEvent(new Event("pagehide"))
    await flushPromises()
    expect(server.patches).toHaveLength(0)
    expect(drafts.map.get(t.saver.key)?.body).toBe(big)

    const t2 = tab({ server, api, drafts, liveness: locks })
    t2.type("small")
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
    await flushPromises()
    expect(server.patches.at(-1)).toMatchObject({ keepalive: true, body: { body: "small" } })
  })

  it("two savers on one page: the second gets the conflict and keeps its text", async () => {
    const a = tab({ server, api, drafts, liveness: locks })
    const b = tab({ server, api, drafts, liveness: locks, userId: "lucas" })
    a.type("Amina's text")
    await vi.advanceTimersByTimeAsync(1_000)
    b.type("Lucas's text")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(b.saver.status().state).toBe("conflict")
    expect(b.saver.status().theirs?.body).toBe("Amina's text")
    b.type("Lucas's text, longer")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(server.page.body).toBe("Amina's text")
    expect(drafts.map.get(b.saver.key)?.body).toBe("Lucas's text, longer")
  })

  it("Keep mine saves over theirs with fresh=1 at their revision", async () => {
    const a = tab({ server, api, drafts, liveness: locks })
    const b = tab({ server, api, drafts, liveness: locks })
    a.type("A")
    await vi.advanceTimersByTimeAsync(1_000)
    b.type("B")
    await vi.advanceTimersByTimeAsync(1_000)
    const theirs = b.saver.status().theirs!
    await b.saver.keepMine(theirs.revision)
    expect(server.patches.at(-1)!.path).toContain("&fresh=1")
    expect(server.page.body).toBe("B")
    expect(b.saver.status().state).toBe("saved")
  })

  it("Take theirs posts my text as an unapplied version, then edits theirs", async () => {
    const a = tab({ server, api, drafts, liveness: locks })
    const b = tab({ server, api, drafts, liveness: locks })
    a.type("A")
    await vi.advanceTimersByTimeAsync(1_000)
    b.type("B")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await b.saver.takeTheirs(b.saver.status().theirs as SavedRow)).toBe(true)
    expect(server.posts).toEqual([
      {
        path: "/knowledge/documents/p1/versions",
        body: { title: "Returns", body: "B", baseRevision: 1, session: b.saver.sessionId },
      },
    ])
    expect(b.saver.revision()).toBe(2)
    await flushPromises()
    expect(drafts.map.has(b.saver.key)).toBe(false)
  })

  it("Take theirs that cannot store my text changes nothing and keeps the draft", async () => {
    const a = tab({ server, api, drafts, liveness: locks })
    const b = tab({ server, api, drafts, liveness: locks })
    a.type("A")
    await vi.advanceTimersByTimeAsync(1_000)
    b.type("B")
    await vi.advanceTimersByTimeAsync(1_000)
    server.offline = true
    expect(await b.saver.takeTheirs(b.saver.status().theirs as SavedRow)).toBe(false)
    expect(b.saver.status().state).toBe("conflict")
    expect(drafts.map.get(b.saver.key)?.body).toBe("B")
  })

  it("session expiry keeps the draft; user B signs in: the old saver sends nothing on its 1 s, 30 s and online triggers; B is never offered A's text; A is, again", async () => {
    let signedIn: string | null = "amina"
    const t = tab({ server, api, drafts, liveness: locks, user: () => signedIn })
    server.offline = true
    t.type("Amina's unsaved")
    await vi.advanceTimersByTimeAsync(1_000)
    const sent = server.patches.length
    // Expiry: the refresh is refused and the auth store is cleared.
    clearAuth()
    await flushPromises()
    expect(liveSavers()).not.toContain(t.saver)
    signedIn = "lucas"
    server.offline = false
    t.type("typed after the end")
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(30_000)
    window.dispatchEvent(new Event("online"))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.patches.length).toBe(sent)
    expect(api.get).not.toHaveBeenCalled()
    const forLucas = await openDrafts({
      drafts,
      liveness: locks,
      userId: "lucas",
      docId: "p1",
      current: server.page,
    })
    expect(forLucas).toEqual({ restore: null, conflict: null, extra: [] })
    const forAmina = await openDrafts({
      drafts,
      liveness: locks,
      userId: "amina",
      docId: "p1",
      current: server.page,
    })
    expect(forAmina.restore?.body).toBe("Amina's unsaved")
  })

  it("a saver whose user is no longer signed in never sends, even before any teardown", async () => {
    let signedIn: string | null = "amina"
    const t = tab({ server, api, drafts, liveness: locks, user: () => signedIn })
    signedIn = "lucas"
    t.type("text")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(server.patches).toHaveLength(0)
    expect(await t.saver.postUnapplied()).toBe(false)
    expect(server.posts).toHaveLength(0)
    expect(drafts.map.get(t.saver.key)?.body).toBe("text")
  })

  it("ONE user, two tabs: tab B opening finds A's live draft and leaves it; both drafts coexist", async () => {
    const a = tab({ server, api, drafts, liveness: locks })
    server.offline = true
    a.type("tab A text")
    await vi.advanceTimersByTimeAsync(1_000)
    const opened = await openDrafts({
      drafts,
      liveness: locks,
      userId: "amina",
      docId: "p1",
      current: server.page,
    })
    expect(opened).toEqual({ restore: null, conflict: null, extra: [] })
    const b = tab({ server, api, drafts, liveness: locks })
    b.type("tab B text")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(a.saver.key).not.toBe(b.saver.key)
    expect(drafts.map.get(a.saver.key)?.body).toBe("tab A text")
    expect(drafts.map.get(b.saver.key)?.body).toBe("tab B text")
  })

  it("ONE user, two tabs saving: no text is ever overwritten silently", async () => {
    const a = tab({ server, api, drafts, liveness: locks })
    const b = tab({ server, api, drafts, liveness: locks })
    a.type("A1")
    await vi.advanceTimersByTimeAsync(1_000)
    b.type("B1")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(b.saver.status().state).toBe("conflict")
    expect(server.page.body).toBe("A1")
    expect(drafts.map.get(b.saver.key)?.body).toBe("B1")
  })

  it("two dead drafts on one page: the newest offered, the other to Page history, none lost", async () => {
    const d = (sessionId: string, body: string, at: number): PageDraft => ({
      userId: "amina",
      docId: "p1",
      sessionId,
      title: "Returns",
      body,
      baseRevision: 1,
      baseHash: "",
      at,
      beat: at,
    })
    await drafts.put(d("s1", "older", 1_000))
    await drafts.put(d("s2", "newer", 2_000))
    await drafts.put(d("s3", "start", 3_000)) // equals the stored text: dropped
    const opened = await openDrafts({
      drafts,
      liveness: locks,
      userId: "amina",
      docId: "p1",
      current: server.page,
    })
    expect(opened.restore?.body).toBe("newer")
    expect(opened.extra.map((x) => x.body)).toEqual(["older"])
    expect(drafts.map.has("amina:p1:s3")).toBe(false)
    expect(await postDraftToHistory(api as never, drafts, opened.extra[0]!, "Untitled")).toBe(true)
    expect(server.posts[0]!.body).toMatchObject({ body: "older", baseRevision: 1, session: "s1" })
    expect(drafts.map.has("amina:p1:s1")).toBe(false)
    // Kept when it cannot be stored.
    server.offline = true
    expect(await postDraftToHistory(api as never, drafts, opened.restore!, "Untitled")).toBe(false)
    expect(drafts.map.has("amina:p1:s2")).toBe(true)
  })

  it("a draft written against an older text is offered as a conflict", async () => {
    await drafts.put({
      userId: "amina",
      docId: "p1",
      sessionId: "s1",
      title: "Returns",
      body: "mine",
      baseRevision: 0,
      baseHash: "nope",
      at: 1,
      beat: 1,
    })
    const opened = await openDrafts({
      drafts,
      liveness: locks,
      userId: "amina",
      docId: "p1",
      current: server.page,
    })
    expect(opened.conflict?.body).toBe("mine")
    expect(opened.restore).toBeNull()
  })

  it("no Web Locks: a draft touched 5 s ago is live, 21 s ago is offered", async () => {
    const now = Date.now()
    const base = {
      userId: "amina",
      docId: "p1",
      title: "Returns",
      baseRevision: 1,
      baseHash: "",
      at: now,
    }
    await drafts.put({ ...base, sessionId: "live", body: "live", beat: now - 5_000 })
    await drafts.put({
      ...base,
      sessionId: "dead",
      body: "dead",
      beat: now - (DEAD_AFTER_MS + 1_000),
    })
    const opened = await openDrafts({
      drafts,
      liveness: null,
      userId: "amina",
      docId: "p1",
      current: server.page,
      now,
    })
    expect(opened.restore?.body).toBe("dead")
    expect(opened.extra).toEqual([])
  })

  it("no Web Locks: a live saver with unsaved text touches its draft every 5 s", async () => {
    const t = tab({ server, api, drafts, liveness: null })
    server.offline = true
    t.type("unsaved")
    await vi.advanceTimersByTimeAsync(1_000)
    const first = drafts.map.get(t.saver.key)!.beat
    await vi.advanceTimersByTimeAsync(5_000)
    expect(drafts.map.get(t.saver.key)!.beat).toBeGreaterThan(first)
  })

  it("destroy with discard erases the draft; without, it keeps the last text", async () => {
    const t = tab({ server, api, drafts, liveness: locks })
    server.offline = true
    t.type("keep me")
    await t.saver.destroy()
    expect(drafts.map.get(t.saver.key)?.body).toBe("keep me")
    expect(locks.names.size).toBe(0)
    const u = tab({ server, api, drafts, liveness: locks })
    u.type("drop me")
    await u.saver.destroy({ discard: true })
    expect(drafts.map.has(u.saver.key)).toBe(false)
  })

  it("a remote save is adopted while clean, and refused over unsaved text", async () => {
    const t: { saver: PageSaver; type: (b: string) => void } = tab({
      server,
      api,
      drafts,
      liveness: locks,
    })
    expect(t.saver.adoptRemote({ id: "p1", title: "Returns", body: "theirs", revision: 2 })).toBe(
      true,
    )
    expect(t.saver.revision()).toBe(2)
    expect(t.saver.adoptRemote({ id: "p1", title: "Returns", body: "theirs", revision: 2 })).toBe(
      false,
    )
    t.type("mine")
    expect(t.saver.adoptRemote({ id: "p1", title: "Returns", body: "again", revision: 3 })).toBe(
      false,
    )
    expect(t.saver.revision()).toBe(2)
  })
})

describe("createDraftStore (IndexedDB + shadow)", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  const draft = (over: Partial<PageDraft> = {}): PageDraft => ({
    userId: "amina",
    docId: "p1",
    sessionId: "s1",
    title: "T",
    body: "B",
    baseRevision: 1,
    baseHash: "h",
    at: 1,
    beat: 1,
    ...over,
  })

  it("puts, lists per user and removes", async () => {
    const store = createDraftStore({ indexedDB: new IDBFactory(), storage: null })
    await store.put(draft())
    await store.put(draft({ userId: "lucas", body: "his" }))
    await store.put(draft({ sessionId: "s2", body: "B2" }))
    expect((await store.forUser("amina")).map((d) => d.body).sort()).toEqual(["B", "B2"])
    expect((await store.forUser("lucas")).map((d) => d.body)).toEqual(["his"])
    await store.remove("amina:p1:s1")
    expect((await store.forUser("amina")).map((d) => d.body)).toEqual(["B2"])
  })

  it("the shadow is read with the database, the newest text per key wins, and remove clears both", async () => {
    const storage = window.localStorage
    storage.clear()
    const store = createDraftStore({ indexedDB: new IDBFactory(), storage })
    await store.put(draft({ body: "older", at: 1 }))
    store.writeShadow(draft({ body: "newer", at: 2 }))
    expect(Object.keys(storage).every((k) => !k.startsWith("liaison:"))).toBe(true)
    expect((await store.forUser("amina")).map((d) => d.body)).toEqual(["newer"])
    expect(await store.forUser("lucas")).toEqual([])
    await store.remove("amina:p1:s1")
    expect(await store.forUser("amina")).toEqual([])
  })

  it("a shadow over 200 KB is not written", async () => {
    const storage = window.localStorage
    storage.clear()
    const store = createDraftStore({ indexedDB: null, storage })
    store.writeShadow(draft({ body: "z".repeat(210_000) }))
    expect(storage.length).toBe(0)
  })

  it("without IndexedDB a put lands in the shadow", async () => {
    const storage = window.localStorage
    storage.clear()
    const store = createDraftStore({ indexedDB: null, storage })
    await store.put(draft({ body: "only copy" }))
    expect((await store.forUser("amina"))[0]?.body).toBe("only copy")
  })
})
