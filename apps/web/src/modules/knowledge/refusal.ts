// SPDX-License-Identifier: FSL-1.1-ALv2

import { ApiError } from "~/lib/api-error"

/** The refusals the server names (`details.reason`), as this client says them. */
const REASON_KEYS: Record<string, string> = {
  folder_scope: "knowledge.refusalFolderScope",
  synced_folder: "knowledge.refusalSyncedFolder",
  holds_synced_folder: "knowledge.refusalHoldsSyncedFolder",
  synced_marker: "knowledge.refusalSyncedMarker",
  not_your_folder: "knowledge.refusalNotYourFolder",
  subfolder_section: "knowledge.refusalSubfolderSection",
  holds_others: "knowledge.refusalHoldsOthers",
  folder_cycle: "knowledge.refusalFolderCycle",
  name_required: "knowledge.refusalNameRequired",
  page_not_in_folder: "knowledge.refusalPageNotInFolder",
}

/**
 * What to tell the person a call was refused, in their language: a refusal
 * the server names, in this client's words; a page or folder that is missing
 * or not theirs to change (404, 403), or a failure that never reached the
 * server, as `fallback` says it for the action; only a refusal this client
 * does not know keeps the server's words, the only ones there are.
 */
export function refusalMessage(err: unknown, fallback: string, t: (key: string) => string): string {
  if (!(err instanceof ApiError)) return fallback
  const reason = err.details?.reason
  if (typeof reason === "string" && REASON_KEYS[reason]) return t(REASON_KEYS[reason])
  if (err.status === 404 || err.status === 403 || err.status === 0) return fallback
  if (err.code === "NOT_FOUND" || err.code === "FORBIDDEN") return fallback
  return err.message || fallback
}
