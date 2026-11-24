// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AUTOSAVE OF A KNOWLEDGE PAGE. One saver per mounted page view (one tab, one
// page), with its own session id: the server makes one version of one session's
// edits within 10 minutes, and never mixes two sessions (two tabs of one person
// included). Framework-free; the page view drives it.
//
// - Saves 1 s after the last edit, at least every 8 s while typing, one request
//   at a time, each against the revision the previous one returned. Title and
//   text go in one PATCH `?autosave=1&session=<id>`.
// - Every edit is also put in the local draft (drafts.ts) until the server has it.
// - Network failures and server faults retry after 1, 2, 4 ... 30 s, and at once
//   when the browser is back online. A text over 1,000,000 characters is not sent.
// - 409: someone saved first. If the stored text is the one this saver sent (the
//   reply was lost after the server applied it) it is saved; else `conflict`, and
//   saving stops while typing goes on. 404/403: `no-access`, the draft is kept.
// - WHOSE SESSION: a saver is bound to the user it was created for. Before each
//   request it checks that the signed-in user is that user, and otherwise sends
//   nothing, ever. When the session ends (expiry, revocation, another tab's
//   sign-out) every saver is destroyed after a last local put; nothing is erased.

import type { ApiClient, RequestInitLike } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { onAuthCleared, onLogoutBroadcast } from "~/modules/auth/auth-store"
import {
  type DraftStore,
  deadDrafts,
  draftKey,
  HEARTBEAT_MS,
  type Liveness,
  type PageDraft,
  textHash,
} from "./drafts"

export type SaveState =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "offline"
  | "conflict"
  | "too-large"
  | "no-access"
  | "error"
  | "title-too-long"
  | "rejected"

/** A page as the server answers it. */
export interface SavedRow {
  id: string
  title: string
  body: string
  revision: number
  updatedAt?: string
  updatedBy?: string | null
  [k: string]: unknown
}

export interface SaverStatus {
  state: SaveState
  /** `too-large`: the text's length; `title-too-long`: the title's. */
  size?: number
  /** `rejected`: why the server refused the text. */
  message?: string
  /** `conflict`: the text someone else saved. */
  theirs?: SavedRow
}

export const DEBOUNCE_MS = 1_000
export const MAX_WAIT_MS = 8_000
export const MAX_BODY_CHARS = 1_000_000
/** The server's limit on a title (`knowledgeDocumentBaseSchema`), after trimming. */
export const MAX_TITLE_CHARS = 240
/** fetch `keepalive` bodies are capped at 64 KB by browsers; this leaves room for the rest. */
export const KEEPALIVE_MAX_BYTES = 60_000
const RETRY_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

type Api = Pick<ApiClient, "get" | "post" | "patch">

export interface PageText {
  title: string
  body: string
}

export interface PageSaverOptions {
  api: Api
  /** The user this saver writes for, for its whole life. */
  userId: string
  docId: string
  /** The stored page the editor was loaded with. */
  base: { title: string; body: string; revision: number }
  /** The text in the editor now (read lazily: serializing a long page costs). */
  read: () => PageText
  /** Who is signed in now; the saver sends nothing for anybody else. */
  currentUserId: () => string | null
  /** Awaited before each request (a token refresh in flight). */
  beforeRequest?: () => Promise<void> | null | undefined
  drafts: DraftStore
  liveness: Liveness | null
  /** "Untitled" in the reader's language: an empty title is saved as that (edge 2). */
  untitled: () => string
  onStatus?: (status: SaverStatus) => void
  /** The server stored a text of this saver (the row it answered). */
  onSaved?: (row: SavedRow) => void
  /**
   * The page was renamed elsewhere while this view changed only its text: the view
   * shows this title, and `read` returns it from now on.
   */
  onTitleAdopted?: (title: string) => void
  sessionId?: string
  /** For tests: the window whose events end the page (pagehide, visibility, online). */
  target?: Window | null
}

export interface PageSaver {
  readonly sessionId: string
  readonly userId: string
  readonly docId: string
  /** The draft's key: user, page and this session. */
  readonly key: string
  status(): SaverStatus
  /** The revision the next save is made against. */
  revision(): number
  /** The text was edited (read later through `read`). */
  edit(): void
  /** Unsaved text: edited since the server last stored this saver's text. */
  hasUnsaved(): boolean
  /** Save now and wait; `keepalive` lets the request outlive the page. */
  flush(opts?: { keepalive?: boolean }): Promise<SaverStatus>
  /** Put the current text in the local draft now, and wait for it. */
  persistDraft(): Promise<void>
  /** Conflict: my text becomes the page, saved over theirs as a new version. */
  keepMine(theirRevision: number): Promise<SaverStatus>
  /**
   * Conflict: my text goes to Page history (an unapplied version) and theirs is
   * what this saver now edits. False when my text could not be stored: then
   * nothing changes and the draft stays.
   */
  takeTheirs(theirs: SavedRow): Promise<boolean>
  /** My unsaved text to Page history as an unapplied version; the draft is erased once stored. */
  postUnapplied(): Promise<boolean>
  /**
   * Someone else's save while this saver has nothing unsaved: it is the new base.
   * With unsaved text it is not taken: the next save meets the conflict.
   */
  adoptRemote(row: SavedRow): boolean
  /**
   * The text in the editor was written against an older text than `theirs` (a
   * draft found on opening): nothing is saved until the person chooses.
   */
  markConflict(theirs: SavedRow): void
  /** Stop for good: timers, listeners and the request in flight. A last local put
   *  first, unless `discard`. */
  destroy(opts?: { discard?: boolean }): Promise<void>
}

const live = new Set<PageSaver>()

/** Every saver alive in this tab. */
export function liveSavers(): PageSaver[] {
  return [...live]
}

/** The session is over in this tab: every saver stops, its text left in the draft. */
export async function destroyAllSavers(opts?: { discard?: boolean }): Promise<void> {
  await Promise.all(liveSavers().map((s) => s.destroy(opts)))
}

// The session is over (expiry, a refused refresh, revocation, a sign-out here or in
// another tab): every saver stops after a last local put. Nothing is erased.
const endAllSavers = () => {
  void destroyAllSavers()
}
onSessionTeardown(endAllSavers)
onAuthCleared(endAllSavers)
onLogoutBroadcast(endAllSavers)

function newSessionId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    // randomUUID needs a secure context; getRandomValues does not. A version 4 uuid.
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

/** A title as the server stores it: trimmed, and `untitled` when nothing is left. */
export function storedTitle(title: string, untitled: string): string {
  return title.trim() || untitled
}

function statusOf(err: unknown): number | null {
  if (err instanceof ApiError) return err.status
  if (err instanceof TypeError) return 0
  return null
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  )
}

export function createPageSaver(opts: PageSaverOptions): PageSaver {
  const sessionId = opts.sessionId ?? newSessionId()
  const key = draftKey({ userId: opts.userId, docId: opts.docId, sessionId })
  const target =
    opts.target === undefined ? (typeof window === "undefined" ? null : window) : opts.target

  let status: SaverStatus = { state: "idle" }
  let revision = opts.base.revision
  /** The text the server holds from this saver's point of view. */
  let acked: PageText = { title: opts.base.title, body: opts.base.body }
  let dirty = false
  let lastEditAt = 0
  let fresh = false
  let destroyed = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let retryStep = 0
  let inFlight: { controller: AbortController; done: Promise<void> } | null = null
  let again = false
  /** A draft exists in the store for this key (so the heartbeat has something to touch). */
  let hasDraft = false

  const setStatus = (next: SaverStatus) => {
    status = next
    opts.onStatus?.(next)
  }

  // The title exactly as the server stores it: trimmed, and "Untitled" when empty.
  const normalized = (t: PageText): PageText => ({
    title: storedTitle(t.title, opts.untitled()),
    body: t.body,
  })
  const sameText = (a: PageText, b: PageText) => a.title === b.title && a.body === b.body

  // ── Local draft: one put at a time, coalesced to the latest text ──────────
  let draftOps: Promise<void> = Promise.resolve()
  let putWanted = false
  let putQueued = false

  const draftNow = (now: number) => {
    const text = opts.read()
    return {
      userId: opts.userId,
      docId: opts.docId,
      sessionId,
      title: text.title,
      body: text.body,
      baseRevision: revision,
      baseHash: textHash(acked.title, acked.body),
      at: lastEditAt || now,
      beat: now,
    }
  }

  const queueDraftPut = (): Promise<void> => {
    putWanted = true
    if (putQueued) return draftOps
    putQueued = true
    draftOps = draftOps.then(async () => {
      putQueued = false
      if (!putWanted) return
      putWanted = false
      if (!dirty) return
      try {
        await opts.drafts.put(draftNow(Date.now()))
        hasDraft = true
      } catch {
        // IndexedDB refused (quota): the shadow on pagehide is the fallback.
      }
    })
    return draftOps
  }

  const queueDraftRemove = (): Promise<void> => {
    putWanted = false
    draftOps = draftOps.then(async () => {
      // Edited again meanwhile: that text is not stored yet, the draft stays.
      if (dirty) return
      try {
        await opts.drafts.remove(key)
        hasDraft = false
      } catch {
        // Left behind, it equals the stored text and is dropped on the next open.
      }
    })
    return draftOps
  }

  // ── Timers ────────────────────────────────────────────────────────────────
  const clearSaveTimers = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (maxTimer) clearTimeout(maxTimer)
    debounceTimer = null
    maxTimer = null
  }
  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }
  const blocked = () => destroyed || status.state === "conflict" || status.state === "no-access"

  const schedule = () => {
    if (blocked()) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void run(), DEBOUNCE_MS)
    maxTimer ??= setTimeout(() => void run(), MAX_WAIT_MS)
  }

  const scheduleRetry = () => {
    clearRetry()
    const delay = RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)]!
    retryStep += 1
    retryTimer = setTimeout(() => void run(), delay)
  }

  const mine = () => opts.currentUserId() === opts.userId

  const markSaved = () => {
    dirty = false
    retryStep = 0
    clearRetry()
    setStatus({ state: "saved" })
    void queueDraftRemove()
  }

  const accept = (row: SavedRow, sent: PageText) => {
    revision = row.revision
    acked = { title: row.title ?? sent.title, body: row.body ?? sent.body }
    fresh = false
    opts.onSaved?.(row)
    if (sameText(normalized(opts.read()), acked)) markSaved()
    else {
      retryStep = 0
      setStatus({ state: "dirty" })
      schedule()
    }
  }

  // ── One save ──────────────────────────────────────────────────────────────
  const send = async (keepalive: boolean): Promise<void> => {
    if (blocked() || !dirty) return
    // Never for anyone else: not after an expiry, not with the next person's token.
    if (!mine()) return
    await opts.beforeRequest?.()
    if (blocked() || !mine()) return
    const text = normalized(opts.read())
    if (text.body.length > MAX_BODY_CHARS) {
      setStatus({ state: "too-large", size: text.body.length })
      return
    }
    if (text.title.length > MAX_TITLE_CHARS) {
      // The server would refuse it: nothing is sent until the title is shortened.
      setStatus({ state: "title-too-long", size: text.title.length })
      return
    }
    if (sameText(text, acked)) {
      markSaved()
      return
    }
    const payload = { title: text.title, body: text.body, revision }
    if (
      keepalive &&
      new TextEncoder().encode(JSON.stringify(payload)).length > KEEPALIVE_MAX_BYTES
    ) {
      // Too big to outlive the page: the draft holds it, saved at the next open (edge 5).
      return
    }
    const path = `/knowledge/documents/${opts.docId}?autosave=1&session=${sessionId}${fresh ? "&fresh=1" : ""}`
    const controller = new AbortController()
    const init: RequestInitLike = {
      signal: controller.signal,
      suppressGlobalError: true,
      ...(keepalive ? { keepalive: true } : {}),
    }
    setStatus({ state: "saving" })
    let resolveDone: () => void = () => {}
    inFlight = { controller, done: new Promise((r) => (resolveDone = r)) }
    try {
      const row = await opts.api.patch<SavedRow>(path, payload, init)
      if (destroyed) return
      accept(row, text)
    } catch (err) {
      if (destroyed || isAbort(err)) return
      await failed(err, text)
    } finally {
      inFlight = null
      resolveDone()
    }
  }

  const failed = async (err: unknown, sent: PageText) => {
    const code = statusOf(err)
    if (code === 409) {
      // Someone saved first, or this saver's own reply was lost after it applied.
      let stored: SavedRow | null = null
      try {
        if (mine())
          stored = await opts.api.get<SavedRow>(`/knowledge/documents/${opts.docId}`, {
            suppressGlobalError: true,
          })
      } catch (e) {
        const c = statusOf(e)
        if (c === 404 || c === 403) {
          setStatus({ state: "no-access" })
          return
        }
        setStatus({ state: c === 0 ? "offline" : "error" })
        scheduleRetry()
        return
      }
      if (destroyed || !stored) return
      if (stored.title === sent.title && stored.body === sent.body) {
        accept(stored, sent)
        return
      }
      // The revision moved without the text (verified, shared, moved): nobody wrote
      // over mine, so it is saved against the new revision.
      if (stored.title === acked.title && stored.body === acked.body) {
        revision = stored.revision
        again = true
        return
      }
      // Only the title moved (a rename in the sidebar, or another tab), and this view
      // did not touch the title: the new title is taken and my text saved over it.
      if (stored.body === acked.body && sent.title === acked.title) {
        revision = stored.revision
        acked = { title: stored.title, body: acked.body }
        opts.onTitleAdopted?.(stored.title)
        again = true
        return
      }
      clearSaveTimers()
      setStatus({ state: "conflict", theirs: stored })
      return
    }
    if (code === 404 || code === 403) {
      clearSaveTimers()
      setStatus({ state: "no-access" })
      return
    }
    if (code === 413) {
      setStatus({ state: "too-large", size: sent.body.length })
      return
    }
    if (code === 0 || code === 429 || (code !== null && code >= 500)) {
      setStatus({ state: code === 0 ? "offline" : "error" })
      scheduleRetry()
      return
    }
    if (code !== null && code >= 400) {
      // Refused for what the text is: sending it again changes nothing. The next edit tries.
      setStatus({ state: "rejected", message: err instanceof Error ? err.message : "" })
      return
    }
    setStatus({ state: "error" })
  }

  const run = async (keepalive = false): Promise<void> => {
    if (destroyed) return
    if (inFlight) {
      again = true
      return inFlight.done
    }
    clearSaveTimers()
    clearRetry()
    await send(keepalive)
    while (again && !destroyed) {
      again = false
      if (dirty && !blocked()) await send(false)
    }
  }

  // ── The page going away ───────────────────────────────────────────────────
  const onPageHide = () => {
    if (destroyed || !dirty) return
    try {
      opts.drafts.writeShadow(draftNow(Date.now()))
    } catch {
      // The IndexedDB draft of the last edit is still there.
    }
    void run(true)
  }
  /**
   * The page goes away with a conflict open (D7): my text goes to Page history as it
   * leaves (keepalive, so under 64 KB). The draft stays until a later open: the
   * server keeps one unapplied version per session and base, so sending it again
   * adds nothing.
   */
  const onPageGone = () => {
    onPageHide()
    if (destroyed || !dirty || status.state !== "conflict" || !mine()) return
    const text = opts.read()
    const payload = {
      title: normalized(text).title,
      body: text.body,
      baseRevision: revision,
      session: sessionId,
    }
    if (new TextEncoder().encode(JSON.stringify(payload)).length > KEEPALIVE_MAX_BYTES) return
    opts.api
      .post(`/knowledge/documents/${opts.docId}/versions`, payload, {
        keepalive: true,
        suppressGlobalError: true,
      })
      .catch(() => {})
  }
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") onPageHide()
  }
  const onOnline = () => {
    if (destroyed || !dirty) return
    if (status.state === "offline" || status.state === "error") {
      retryStep = 0
      void run()
    }
  }
  target?.addEventListener("pagehide", onPageGone)
  target?.addEventListener("online", onOnline)
  target?.document?.addEventListener("visibilitychange", onVisibility)

  // ── Liveness of this tab's draft ──────────────────────────────────────────
  const releaseLock = opts.liveness?.hold(key) ?? null
  if (!opts.liveness) {
    heartbeat = setInterval(() => {
      if (hasDraft && dirty) void queueDraftPut()
    }, HEARTBEAT_MS)
  }

  const saver: PageSaver = {
    sessionId,
    userId: opts.userId,
    docId: opts.docId,
    key,
    status: () => status,
    revision: () => revision,
    edit() {
      if (destroyed) return
      dirty = true
      lastEditAt = Date.now()
      void queueDraftPut()
      if (blocked()) return
      if (
        status.state === "saved" ||
        status.state === "idle" ||
        status.state === "too-large" ||
        status.state === "title-too-long" ||
        status.state === "rejected"
      )
        setStatus({ state: "dirty" })
      schedule()
    },
    hasUnsaved: () => dirty,
    async flush(flushOpts) {
      if (flushOpts?.keepalive) {
        onPageHide()
        return status
      }
      await run()
      await draftOps
      return status
    },
    async persistDraft() {
      await queueDraftPut()
    },
    async keepMine(theirRevision) {
      if (destroyed) return status
      revision = theirRevision
      fresh = true
      dirty = true
      setStatus({ state: "dirty" })
      await run()
      return status
    },
    async takeTheirs(theirs) {
      if (destroyed) return false
      if (!(await saver.postUnapplied())) return false
      revision = theirs.revision
      acked = { title: theirs.title, body: theirs.body }
      dirty = false
      setStatus({ state: "saved" })
      return true
    },
    async postUnapplied() {
      if (!dirty) return true
      if (!mine()) return false
      const text = opts.read()
      try {
        await opts.beforeRequest?.()
        if (!mine()) return false
        await opts.api.post(
          `/knowledge/documents/${opts.docId}/versions`,
          {
            title: normalized(text).title,
            body: text.body,
            baseRevision: revision,
            session: sessionId,
          },
          { suppressGlobalError: true },
        )
      } catch {
        return false
      }
      dirty = false
      await queueDraftRemove()
      return true
    },
    adoptRemote(row) {
      if (destroyed) return false
      if (row.revision <= revision) return false
      if (dirty || inFlight) {
        // Not taken over unsaved text: saving now meets the conflict at once.
        if (!blocked()) void run()
        return false
      }
      revision = row.revision
      acked = { title: row.title, body: row.body }
      return true
    },
    markConflict(theirs) {
      if (destroyed) return
      dirty = true
      lastEditAt ||= Date.now()
      clearSaveTimers()
      setStatus({ state: "conflict", theirs })
      void queueDraftPut()
    },
    async destroy(destroyOpts) {
      if (destroyed) return
      clearSaveTimers()
      clearRetry()
      if (heartbeat) clearInterval(heartbeat)
      target?.removeEventListener("pagehide", onPageGone)
      target?.removeEventListener("online", onOnline)
      target?.document?.removeEventListener("visibilitychange", onVisibility)
      if (destroyOpts?.discard) {
        dirty = false
        destroyed = true
        inFlight?.controller.abort()
        await queueDraftRemove()
      } else {
        // The last local put, then nothing more from this saver.
        if (dirty) await queueDraftPut()
        destroyed = true
        inFlight?.controller.abort()
        await draftOps
      }
      releaseLock?.()
      live.delete(saver)
    },
  }
  live.add(saver)
  return saver
}

// ── Drafts found when a page opens ──────────────────────────────────────────

export interface OpenedDrafts {
  /** Written against the text the page has now: put back in the editor and saved. */
  restore: PageDraft | null
  /** Written against an older text: offered next to the stored one (a conflict). */
  conflict: PageDraft | null
  /** Further dead drafts of this page: to Page history, one unapplied version each. */
  extra: PageDraft[]
}

/**
 * The drafts of a tab that is gone, for this user and page (never another user's,
 * never a live tab's). Those equal to the stored text are erased; of the others the
 * newest goes to the editor, every further one to Page history.
 */
export async function openDrafts(args: {
  drafts: DraftStore
  liveness: Liveness | null
  userId: string
  docId: string
  current: { title: string; body: string; revision: number }
  now?: number
  /** Whether this draft's text is already in the page's history (see {@link draftInHistory}). */
  inHistory?: (d: PageDraft) => Promise<boolean>
}): Promise<OpenedDrafts> {
  const dead = await deadDrafts(args.drafts, args.liveness, args.userId, args.docId, args.now)
  const out: OpenedDrafts = { restore: null, conflict: null, extra: [] }
  const currentHash = textHash(args.current.title, args.current.body)
  for (const d of dead) {
    if (d.body === args.current.body && d.title.trim() === args.current.title) {
      await args.drafts.remove(draftKey(d)).catch(() => {})
      continue
    }
    const onCurrent = d.baseRevision === args.current.revision || d.baseHash === currentHash
    // Written against an older text, but saved after all (the save as the tab closed
    // went through, after the copy was written): erased, never offered against newer text.
    if (!onCurrent && args.inHistory && (await args.inHistory(d).catch(() => false))) {
      await args.drafts.remove(draftKey(d)).catch(() => {})
      continue
    }
    if (!out.restore && !out.conflict) {
      if (onCurrent) out.restore = d
      else out.conflict = d
    } else out.extra.push(d)
  }
  return out
}

/** How many of a person's newest versions after a draft's base are compared with it. */
const HISTORY_MATCH_LOOKUPS = 3

/**
 * Whether a draft's text is in the page's history as a save of this person made after
 * the draft's base: the shadow copy of a save that went through as the tab closed.
 * Any failure answers false, and the draft is offered as before.
 */
export function draftInHistory(api: Api, userId: string): (d: PageDraft) => Promise<boolean> {
  return async (d) => {
    const versions = await api.get<
      {
        id: string
        kind: string
        authorType: string
        authorId: string | null
        revision: number | null
        title: string
      }[]
    >(`/knowledge/documents/${d.docId}/versions`, { suppressGlobalError: true })
    const title = d.title.trim()
    const candidates = versions
      .filter(
        (v) =>
          v.kind !== "unapplied" &&
          v.authorType === "user" &&
          v.authorId === userId &&
          (v.revision ?? 0) > d.baseRevision &&
          (v.title === title || !title),
      )
      .slice(0, HISTORY_MATCH_LOOKUPS)
    for (const v of candidates) {
      const full = await api.get<{ body: string }>(
        `/knowledge/documents/${d.docId}/versions/${v.id}`,
        { suppressGlobalError: true },
      )
      if (full.body === d.body) return true
    }
    return false
  }
}

/** A dead draft to Page history; erased once stored, kept if it cannot be. */
export async function postDraftToHistory(
  api: Api,
  drafts: DraftStore,
  d: PageDraft,
  untitled: string,
): Promise<boolean> {
  try {
    await api.post(
      `/knowledge/documents/${d.docId}/versions`,
      {
        title: storedTitle(d.title, untitled),
        body: d.body,
        baseRevision: d.baseRevision,
        session: d.sessionId,
      },
      { suppressGlobalError: true },
    )
  } catch {
    return false
  }
  await drafts.remove(draftKey(d)).catch(() => {})
  return true
}
