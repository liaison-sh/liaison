// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Trash on the client (S19, D3, D4): the list the person may restore, "Move to
// trash" with a 10 s Undo, Restore, and Delete for good for administrators. A
// refusal is told from its status and code in the person's language, never with
// the server's English text.

import { createSignal } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { relativeTime } from "~/lib/relative-time"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { hasScope } from "~/modules/auth/auth-store"
import { addToast } from "~/modules/shell/toast-store"
import {
  deleteKnowledgeDocumentForGood,
  type KnowledgeTrashEntry,
  listKnowledgeTrash,
  restoreKnowledgeDocument,
  trashKnowledgeDocument,
} from "./knowledge-api"
import { loadCollectionsTree, loadDocuments, loadKnowledgeHome } from "./knowledge-store"

type T = (key: string, params?: Record<string, string>) => string

/** "29 days left", "1 day left", "Deleted today", or "Kept" for a page archived before Trash. */
export function daysLeftLabel(entry: Pick<KnowledgeTrashEntry, "daysLeft">, t: T): string {
  const d = entry.daysLeft
  if (d === null) return t("knowledge.trash.kept")
  if (d <= 0) return t("knowledge.trash.lastDay")
  if (d === 1) return t("knowledge.trash.oneDayLeft")
  return t("knowledge.trash.daysLeft", { count: String(d) })
}

/** "You, 2 days ago", "Lucas Pereira, 2 days ago", or the date alone. */
export function trashedLine(
  entry: KnowledgeTrashEntry,
  me: string | null,
  locale: string,
  t: T,
): string {
  const when = relativeTime(entry.trashedAt ?? entry.archivedAt, locale, { style: "long" }) || ""
  if (entry.trashedAt === null) return t("knowledge.trash.archivedBefore", { when })
  if (entry.trashedBy && entry.trashedBy === me) return t("knowledge.trash.byYou", { when })
  if (entry.trashedByName) return t("knowledge.trash.byName", { name: entry.trashedByName, when })
  return when
}

/** The Undo window after "Move to trash" (S19). */
export const UNDO_MS = 10_000

const [entries, setEntries] = createSignal<KnowledgeTrashEntry[] | null>(null)

/** The pages in Trash the person may restore (null until loaded). */
export const trashEntries = entries
export const trashCount = () => entries()?.length ?? 0

/** Trash is for whoever may move pages to it and back, or delete them for good. */
export function canSeeTrash(): boolean {
  return hasScope("knowledge:documents:archive") || hasScope("knowledge:documents:admin")
}

/** "Move to trash" on a page: the archive scope (the edit right is the page's own). */
export function canMoveToTrash(): boolean {
  return hasScope("knowledge:documents:archive")
}

/** Delete for good: administrators only (D4). The server also wants the edit right. */
export function canDeleteForGood(): boolean {
  return hasScope("knowledge:documents:admin")
}

export async function loadTrash(api: ApiClient): Promise<KnowledgeTrashEntry[]> {
  if (!canSeeTrash()) {
    setEntries([])
    return []
  }
  const list = await listKnowledgeTrash(api)
  const rows = Array.isArray(list) ? list : []
  setEntries(rows)
  return rows
}

export function resetTrash(): void {
  setEntries(null)
}
onSessionTeardown(resetTrash)

export type TrashAction = "trash" | "restore" | "delete"

/** A refused Trash action, as an i18n key: from its status and code only. */
export function trashRefusalKey(err: unknown, action: TrashAction): string {
  if (!(err instanceof ApiError)) return "knowledge.trash.failed"
  if (err.status === 404) {
    return action === "trash"
      ? "knowledge.trash.cannotTrash"
      : action === "restore"
        ? "knowledge.trash.cannotRestore"
        : "knowledge.trash.cannotDelete"
  }
  if (err.status === 403) {
    return action === "delete" ? "knowledge.trash.onlyAdmins" : "knowledge.trash.cannotTrash"
  }
  if (err.status === 400 && err.code === "VALIDATION") {
    return action === "trash"
      ? "knowledge.trash.syncedRefused"
      : action === "delete"
        ? "knowledge.trash.notInTrash"
        : "knowledge.trash.failed"
  }
  if (err.code === "PURGE_INCOMPLETE") return "knowledge.trash.purgeIncomplete"
  return "knowledge.trash.failed"
}

/** What lists pages, again: the tree, the documents, Home and Trash. */
async function refreshAll(api: ApiClient): Promise<void> {
  await Promise.allSettled([
    loadDocuments(api),
    loadCollectionsTree(api),
    loadKnowledgeHome(api),
    loadTrash(api),
  ])
}

/**
 * Restore a page from Trash. Resolves true when it is back; a refusal is toasted.
 */
export async function restoreFromTrash(
  api: ApiClient,
  page: { id: string; title: string },
  t: T,
): Promise<boolean> {
  try {
    await restoreKnowledgeDocument(api, page.id)
  } catch (err) {
    addToast({ type: "error", message: t(trashRefusalKey(err, "restore")) })
    return false
  }
  void refreshAll(api)
  return true
}

/**
 * Move a page to Trash, then offer Undo for 10 s. Throws the refusal, so the
 * caller says it where the person acted. `onRestored` runs after an Undo.
 */
export async function moveToTrash(
  api: ApiClient,
  page: { id: string; title: string },
  t: T,
  opts: { onRestored?: () => void } = {},
): Promise<void> {
  await trashKnowledgeDocument(api, page.id)
  void refreshAll(api)
  addToast({
    type: "info",
    message: t("knowledge.trash.movedToast", { title: page.title }),
    durationMs: UNDO_MS,
    action: {
      label: t("knowledge.trash.undo"),
      onClick: () => {
        void restoreFromTrash(api, page, t).then((ok) => {
          if (ok) opts.onRestored?.()
        })
      },
    },
  })
}

/** Delete for good a page in Trash. Resolves true when it is gone; a refusal is toasted. */
export async function deleteForGood(
  api: ApiClient,
  page: { id: string; title: string },
  t: T,
): Promise<boolean> {
  try {
    await deleteKnowledgeDocumentForGood(api, page.id)
  } catch (err) {
    addToast({ type: "error", message: t(trashRefusalKey(err, "delete")) })
    void loadTrash(api).catch(() => {})
    return false
  }
  addToast({ type: "success", message: t("knowledge.trash.deletedToast", { title: page.title }) })
  void refreshAll(api)
  return true
}
