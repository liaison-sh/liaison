// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LOCAL DRAFTS OF A PAGE'S TEXT. While a page is edited, its text is kept in this
// browser until the server has it: one draft per user, page and tab (the saver's
// session), so two tabs of one person never write over each other's text. A draft
// is plain text in this browser only, in IndexedDB, with a synchronous
// localStorage shadow written as the page goes away (IndexedDB may not finish
// then). It is erased once the server acknowledged that text, or when the person
// chooses to discard it at sign-out; nothing else erases it, session expiry
// included.
//
// A draft is offered again only when the tab that wrote it is gone: a live tab
// holds a Web Lock named after its key, and where Web Locks do not exist it
// touches the draft every 5 s and counts as gone 20 s after the last touch.
//
// No app imports here: the saver (autosave.ts), the page view and the sign-out
// guard share it, and tests run it on fake-indexeddb.

export interface PageDraft {
  userId: string
  docId: string
  /** The saver (one tab, one page view) that wrote it. */
  sessionId: string
  title: string
  body: string
  /** The revision the text was written against, and a hash of that stored text. */
  baseRevision: number
  baseHash: string
  /** Last edit. */
  at: number
  /** Last time the writing tab was known alive (the no-Web-Locks fallback). */
  beat: number
}

export const DRAFT_DB_NAME = "liaison-page-drafts"
const STORE = "drafts"
/** The shadow keys. They never start with `liaison:`, so clearing that storage keeps them. */
export const SHADOW_PREFIX = "page-draft:"
/** A shadow larger than this is not written (localStorage is small); IndexedDB still holds it. */
export const SHADOW_MAX_CHARS = 200_000
/** Without Web Locks a live saver touches its draft this often ... */
export const HEARTBEAT_MS = 5_000
/** ... and a draft not touched for this long belongs to a tab that is gone. */
export const DEAD_AFTER_MS = 20_000

export function draftKey(d: { userId: string; docId: string; sessionId: string }): string {
  return `${d.userId}:${d.docId}:${d.sessionId}`
}

/** The Web Lock a live saver holds for its draft. */
export function draftLockName(key: string): string {
  return `${SHADOW_PREFIX}${key}`
}

/** A short hash of a stored text (FNV-1a over title and body, plus the length): a name, not a secret. */
export function textHash(title: string, body: string): string {
  const text = `${title}\u0000${body}`
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, "0")}-${text.length}`
}

export interface DraftStore {
  put(draft: PageDraft): Promise<void>
  remove(key: string): Promise<void>
  /** Every draft of this user in this browser, the shadow's included (newest text per key). */
  forUser(userId: string): Promise<PageDraft[]>
  /** Synchronous: the shadow of a draft, written as the page goes away. */
  writeShadow(draft: PageDraft): void
}

type Storageish = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">

function defaultStorage(): Storageish | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function defaultFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB
  } catch {
    return null
  }
}

function isDraft(v: unknown): v is PageDraft {
  if (!v || typeof v !== "object") return false
  const d = v as Record<string, unknown>
  return (
    typeof d.userId === "string" &&
    typeof d.docId === "string" &&
    typeof d.sessionId === "string" &&
    typeof d.title === "string" &&
    typeof d.body === "string" &&
    typeof d.baseRevision === "number" &&
    typeof d.at === "number"
  )
}

function clean(d: PageDraft): PageDraft {
  return {
    userId: d.userId,
    docId: d.docId,
    sessionId: d.sessionId,
    title: d.title,
    body: d.body,
    baseRevision: d.baseRevision,
    baseHash: typeof d.baseHash === "string" ? d.baseHash : "",
    at: d.at,
    beat: typeof d.beat === "number" ? d.beat : d.at,
  }
}

/** IndexedDB (when there is one) plus the localStorage shadow. */
export function createDraftStore(
  opts: { indexedDB?: IDBFactory | null; storage?: Storageish | null } = {},
): DraftStore {
  const factory = opts.indexedDB === undefined ? defaultFactory() : opts.indexedDB
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage
  let dbPromise: Promise<IDBDatabase | null> | null = null

  const open = (): Promise<IDBDatabase | null> => {
    if (!factory) return Promise.resolve(null)
    dbPromise ??= new Promise((resolve) => {
      try {
        const req = factory.open(DRAFT_DB_NAME, 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: "key" })
            store.createIndex("userId", "userId")
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    return dbPromise
  }

  const tx = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T> | null,
  ): Promise<T | null> => {
    const db = await open()
    if (!db) return null
    return new Promise((resolve, reject) => {
      try {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        let value: T | null = null
        if (req) req.onsuccess = () => (value = req.result)
        t.oncomplete = () => resolve(value)
        t.onerror = () => reject(t.error ?? new Error("draft store failed"))
        t.onabort = () => reject(t.error ?? new Error("draft store aborted"))
      } catch (err) {
        reject(err)
      }
    })
  }

  const shadowKey = (key: string) => `${SHADOW_PREFIX}${key}`

  const readShadows = (userId: string): PageDraft[] => {
    if (!storage) return []
    const out: PageDraft[] = []
    try {
      const prefix = shadowKey(`${userId}:`)
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i)
        if (!k?.startsWith(prefix)) continue
        try {
          const v: unknown = JSON.parse(storage.getItem(k) ?? "null")
          if (isDraft(v) && v.userId === userId) out.push(clean(v))
        } catch {
          // A shadow that does not parse is not text anyone can be offered.
        }
      }
    } catch {
      // Storage refused: the shadow is a second copy, IndexedDB is the first.
    }
    return out
  }

  return {
    async put(draft) {
      const value = { ...clean(draft), key: draftKey(draft) }
      const written = await tx("readwrite", (s) => s.put(value))
      // No IndexedDB here: the shadow is the only copy, so it is written now.
      if (written === null && !factory) this.writeShadow(draft)
    },
    async remove(key) {
      try {
        storage?.removeItem(shadowKey(key))
      } catch {
        // Nothing to do: a shadow left behind equals the stored text, and is dropped on open.
      }
      await tx("readwrite", (s) => s.delete(key))
    },
    async forUser(userId) {
      const fromDb =
        (await tx<unknown[]>("readonly", (s) => s.index("userId").getAll(userId)).catch(
          () => null,
        )) ?? []
      const byKey = new Map<string, PageDraft>()
      for (const v of [...fromDb, ...readShadows(userId)]) {
        if (!isDraft(v) || v.userId !== userId) continue
        const d = clean(v)
        const k = draftKey(d)
        const had = byKey.get(k)
        if (!had || d.at > had.at || (d.at === had.at && d.beat > had.beat)) byKey.set(k, d)
      }
      return [...byKey.values()]
    },
    writeShadow(draft) {
      if (!storage) return
      try {
        const json = JSON.stringify(clean(draft))
        if (json.length > SHADOW_MAX_CHARS) return
        storage.setItem(shadowKey(draftKey(draft)), json)
      } catch {
        // Quota or private mode: IndexedDB still has the last put.
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Liveness: is the tab that wrote a draft still open?
// ---------------------------------------------------------------------------

export interface Liveness {
  /** Hold the lock of this key while the saver lives; returns its release. */
  hold(key: string): () => void
  /** The names of the locks held now. */
  held(): Promise<Set<string>>
}

interface LockManagerish {
  request(name: string, callback: () => Promise<void>): Promise<unknown>
  query(): Promise<{ held?: { name?: string }[] }>
}

/** Web Locks, or null where the browser has none (then the heartbeat decides). */
export function webLocks(locks: LockManagerish | null = defaultLocks()): Liveness | null {
  if (!locks) return null
  return {
    hold(key) {
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      locks.request(draftLockName(key), () => held).catch(() => {})
      return release
    },
    async held() {
      try {
        const snapshot = await locks.query()
        return new Set((snapshot.held ?? []).map((l) => l.name ?? "").filter(Boolean))
      } catch {
        return new Set()
      }
    },
  }
}

function defaultLocks(): LockManagerish | null {
  try {
    const locks = (globalThis.navigator as { locks?: LockManagerish } | undefined)?.locks
    return locks && typeof locks.request === "function" && typeof locks.query === "function"
      ? locks
      : null
  } catch {
    return null
  }
}

/** Whether the tab that wrote this draft still lives. */
export function isLive(
  draft: PageDraft,
  held: Set<string> | null,
  now: number = Date.now(),
): boolean {
  if (held) return held.has(draftLockName(draftKey(draft)))
  return now - draft.beat < DEAD_AFTER_MS
}

/** The drafts of this user (of one page, when given) whose tab is gone, newest first. */
export async function deadDrafts(
  store: DraftStore,
  liveness: Liveness | null,
  userId: string,
  docId?: string,
  now: number = Date.now(),
): Promise<PageDraft[]> {
  const all = (await store.forUser(userId)).filter((d) => docId === undefined || d.docId === docId)
  const held = liveness ? await liveness.held() : null
  return all.filter((d) => !isLive(d, held, now)).sort((a, b) => b.at - a.at)
}

let shared: DraftStore | null = null
/** The browser's draft store. */
export function pageDrafts(): DraftStore {
  shared ??= createDraftStore()
  return shared
}

/** @internal tests: a fresh store for the next `pageDrafts()`. */
export function _resetPageDrafts(store: DraftStore | null = null): void {
  shared = store
}
