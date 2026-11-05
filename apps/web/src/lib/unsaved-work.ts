// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WORK THE PAGE WOULD LOSE: a draft in a composer, a file staged or still
// uploading, a form with edits nobody saved. A surface that holds such work
// registers it here with a function that describes it (null while there is
// nothing to lose), and the actions that throw the page or a tab away (the
// desktop Reload, closing other tabs) ask first, naming what goes.
//
// The confirmation itself is one small question at a time, drawn by the shell
// (`UnsavedWorkConfirm`), never a flow of its own.
import { createSignal } from "solid-js"
import { PAGE_RELOAD_GUARD_KEY, type PageReloadGuard } from "~/lib/desktop-shell-contract"

export interface UnsavedWorkEntry {
  /** The tab the work lives in, when it lives in one (the dock's composer does not). */
  tabId?: string
  /** What would be lost, in the reader's words, or null when nothing would be. */
  describe: () => string | null
}

export type DiscardAction = "reload" | "close-tabs"

export interface PendingDiscard {
  action: DiscardAction
  /** What would be lost, one line each. */
  items: string[]
  proceed: () => void
}

const entries = new Map<string, UnsavedWorkEntry>()
const [pending, setPending] = createSignal<PendingDiscard | null>(null)

/** Registers (or replaces) the work under `id`. Returns its remover. */
export function registerUnsavedWork(id: string, entry: UnsavedWorkEntry): () => void {
  entries.set(id, entry)
  return () => unregisterUnsavedWork(id, entry)
}

/** Removes `id`; with `entry`, only while that same entry is the registered one. */
export function unregisterUnsavedWork(id: string, entry?: UnsavedWorkEntry): void {
  if (entry && entries.get(id) !== entry) return
  entries.delete(id)
}

/** What would be lost, optionally only the work of the tabs `inTabs` accepts. */
export function listUnsavedWork(inTabs?: (tabId: string | undefined) => boolean): string[] {
  const out: string[] = []
  for (const entry of entries.values()) {
    if (inTabs && !inTabs(entry.tabId)) continue
    const description = entry.describe()
    if (description !== null && description.trim() !== "") out.push(description)
  }
  return out
}

/**
 * Runs `proceed` at once when `items` is empty; otherwise opens the question
 * and runs it only on a confirm. Returns true when it asked.
 */
export function confirmDiscard(
  action: DiscardAction,
  items: string[],
  proceed: () => void,
): boolean {
  if (items.length === 0) {
    proceed()
    return false
  }
  setPending({ action, items, proceed })
  return true
}

/** The open question, for the shell to draw. */
export const pendingDiscard = pending

/** The answer: true discards and runs the action, false keeps everything. */
export function resolveDiscard(confirmed: boolean): void {
  const open = pending()
  setPending(null)
  if (confirmed) open?.proceed()
}

/** The guard the desktop shell's Reload calls (`PAGE_RELOAD_GUARD_KEY`). */
export const reloadGuard: PageReloadGuard = (proceed) => {
  const items = listUnsavedWork()
  if (items.length === 0) return false
  confirmDiscard("reload", items, proceed)
  return true
}

/** Publishes the reload guard on the window. Returns its remover. */
export function installReloadGuard(target: object = globalThis): () => void {
  Reflect.set(target, PAGE_RELOAD_GUARD_KEY, reloadGuard)
  return () => {
    if (Reflect.get(target, PAGE_RELOAD_GUARD_KEY) === reloadGuard) {
      Reflect.deleteProperty(target, PAGE_RELOAD_GUARD_KEY)
    }
  }
}

/** Test hook: forget every entry and any open question. */
export function resetUnsavedWork(): void {
  entries.clear()
  setPending(null)
}
