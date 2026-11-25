// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SIGN-OUT WITH UNSAVED TEXT. An explicit sign-out first stores every text of this
// person that is not in its page yet: the person's other tabs are asked to save
// now; every open saver here saves (a conflict left open goes to Page history as an
// unapplied version); every other draft of this person is posted to its page's
// history. Whatever is left (offline, over 1 MB, a page gone or no longer
// editable, a full browser) is listed, with Copy for each, and the person chooses:
// stay signed in (the default) or sign out and discard. Only that second choice
// erases unsaved drafts. With nothing unsaved there is no question and no wait.
//
// A forced sign-out (deleted account, ended demo workspace) asks nothing and
// erases this person's drafts.

import type { ApiClient } from "~/lib/api-client"
import { onSignOutGuard, type SignOutContext } from "~/lib/session-lifecycle"
import { type PageSaver, postDraftToHistory, type SaveState } from "./autosave"
import { type DraftStore, draftKey, type PageDraft } from "./drafts"

export interface UnsavedPage {
  key: string
  docId: string
  title: string
  body: string
  /** Why it could not be stored, when this tab knows (its open saver's state). */
  reason: SaveState | null
}

export type SignOutChoice = "stay" | "discard"

type Api = Pick<ApiClient, "get" | "post" | "patch">

export interface Messenger {
  post(message: DraftMessage): void
}

export type DraftMessage =
  | { type: "flush-now"; userId: string }
  | { type: "discard"; userId: string }

export interface GuardDeps {
  api: Api
  drafts: DraftStore
  savers: () => PageSaver[]
  currentUserId: () => string | null
  untitled: () => string
  /** Show the list and wait for the person's choice. */
  ask: (pages: UnsavedPage[]) => Promise<SignOutChoice>
  /** The person's other tabs (null without BroadcastChannel). */
  messenger: Messenger | null
  /** How long the other tabs get to save. */
  otherTabsMs?: number
  /** How long this tab's savers get. */
  flushBoundMs?: number
}

export const OTHER_TABS_MS = 1_000
export const FLUSH_BOUND_MS = 5_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    work.catch(() => {}),
    new Promise<void>((r) => {
      timer = setTimeout(r, ms)
    }),
  ])
  clearTimeout(timer)
}

/** The guard itself (registered by `installKnowledgeSignOutGuard`). */
export function createKnowledgeSignOutGuard(deps: GuardDeps) {
  return async (ctx: SignOutContext): Promise<boolean> => {
    const userId = deps.currentUserId()
    if (!userId) return true
    const mine = deps.savers().filter((s) => s.userId === userId)

    if (ctx.forced) {
      await Promise.all(mine.map((s) => s.destroy({ discard: true }).catch(() => {})))
      deps.messenger?.post({ type: "discard", userId })
      for (const d of await deps.drafts.forUser(userId).catch(() => []))
        await deps.drafts.remove(draftKey(d)).catch(() => {})
      return true
    }

    const localKeys = new Set(mine.map((s) => s.key))
    const dirty = mine.filter((s) => s.hasUnsaved())
    let stored = await deps.drafts.forUser(userId).catch(() => [] as PageDraft[])
    const elsewhere = stored.some((d) => !localKeys.has(draftKey(d)))
    // Nothing unsaved anywhere: the sign-out goes on at once, as it always did.
    if (!dirty.length && !elsewhere) return true

    // (1) The person's other tabs save what they can.
    if (elsewhere && deps.messenger) {
      deps.messenger.post({ type: "flush-now", userId })
      await sleep(deps.otherTabsMs ?? OTHER_TABS_MS)
    }

    // (2) This tab's savers save; what they cannot goes to Page history.
    await bounded(Promise.all(dirty.map((s) => s.flush())), deps.flushBoundMs ?? FLUSH_BOUND_MS)
    const reasons = new Map<string, SaveState>()
    for (const s of dirty) {
      if (!s.hasUnsaved()) continue
      reasons.set(s.key, s.status().state)
      await s.postUnapplied().catch(() => false)
      // Still unsaved: its text must be in the draft for the list and for later.
      if (s.hasUnsaved()) await s.persistDraft().catch(() => {})
    }

    // (3) Every other draft of this person, of a page open or not, live or not.
    stored = await deps.drafts.forUser(userId).catch(() => [] as PageDraft[])
    for (const d of stored) {
      if (localKeys.has(draftKey(d))) continue
      await postDraftToHistory(deps.api, deps.drafts, d, deps.untitled())
    }

    // (4) What could not be stored anywhere: the person decides.
    const left = await deps.drafts.forUser(userId).catch(() => [] as PageDraft[])
    const pages: UnsavedPage[] = left
      .filter((d) => {
        const saver = mine.find((s) => s.key === draftKey(d))
        return !saver || saver.hasUnsaved()
      })
      .sort((a, b) => b.at - a.at)
      .map((d) => ({
        key: draftKey(d),
        docId: d.docId,
        title: d.title.trim() ? d.title : deps.untitled(),
        body: d.body,
        reason: reasons.get(draftKey(d)) ?? null,
      }))
    if (!pages.length) return true
    const choice = await deps.ask(pages)
    if (choice !== "discard") return false
    await Promise.all(mine.map((s) => s.destroy({ discard: true }).catch(() => {})))
    deps.messenger?.post({ type: "discard", userId })
    for (const p of pages) await deps.drafts.remove(p.key).catch(() => {})
    return true
  }
}

/**
 * What another tab's sign-out asks of this one: save now (`flush-now`), or drop
 * the unsaved text the person chose to discard (`discard`).
 */
export function createDraftMessageHandler(deps: {
  savers: () => PageSaver[]
  currentUserId: () => string | null
  flushBoundMs?: number
}) {
  return async (message: unknown): Promise<void> => {
    if (!message || typeof message !== "object") return
    const m = message as Partial<DraftMessage>
    if (typeof m.userId !== "string" || m.userId !== deps.currentUserId()) return
    const mine = deps.savers().filter((s) => s.userId === m.userId)
    if (m.type === "flush-now") {
      await bounded(
        Promise.all(mine.filter((s) => s.hasUnsaved()).map((s) => s.flush())),
        deps.flushBoundMs ?? FLUSH_BOUND_MS,
      )
    } else if (m.type === "discard") {
      await Promise.all(mine.map((s) => s.destroy({ discard: true }).catch(() => {})))
    }
  }
}

export const DRAFT_CHANNEL = "liaison-page-drafts"

let installed = false

/** Register the guard and listen to the other tabs, once per page. */
export function installKnowledgeSignOutGuard(deps: Omit<GuardDeps, "messenger">): () => void {
  if (installed) return () => {}
  installed = true
  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(DRAFT_CHANNEL)
  } catch {
    channel = null
  }
  const onMessage = createDraftMessageHandler(deps)
  if (channel) channel.onmessage = (e) => void onMessage(e.data)
  const messenger: Messenger | null = channel
    ? { post: (message) => channel?.postMessage(message) }
    : null
  const dispose = onSignOutGuard(createKnowledgeSignOutGuard({ ...deps, messenger }))
  return () => {
    dispose()
    channel?.close()
    installed = false
  }
}
