// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE HOME BADGE. Home and Messages used to show the same number: the Home
// icon drew the unread-message total (A14) that the Messages entry already
// shows, so the two entries said the same thing twice and Home's own content
// never reached a badge. Messages counts unread messages; Home counts what
// Home presents as needing the user's action:
//
//   - the rows its Approvals card lists (pending requests the user can decide,
//     access requests they can grant, their routine runs waiting for their
//     private mailbox; peer requests folded exactly when the card folds them), and
//   - the "need you now" alerts its Messages card pins above the unread
//     threads (`urgentStripItems`: scope requests, node permission prompts,
//     SLA risks, system alerts, overdue work scored urgent, anything the
//     provider scored >= 70).
//
// Unread threads and mentions are Messages things: Home lists them in its
// Messages card, but they belong to the Messages badge, so they are not
// counted here. The count reads the same attention store Home renders from,
// which every live path (WS frames, focus, the safety poll) keeps current.
//
// D21 (Home's own sidebar): this list IS the sidebar's "Needs you" section, so
// its total and the badge are one number by construction. Three refinements,
// all here so the badge and the sidebar can never disagree:
//   - a ticket awaiting a reply is queue volume, not a personal decision: it
//     moves to "Your queues" (and out of the badge) unless it is assigned to
//     the viewer (owner, recommendation 1);
//   - an access request counts only for someone who can grant it;
//   - a routine that failed or paused is filed under Agents, never here.

import type { AttentionItem } from "@liaison/shared"
import { createMemo, createRoot, createSignal } from "solid-js"
import { isExpiredMailboxWait } from "~/modules/agent/routine-mailbox-wait-item"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { isApprovalItem, partitionPeerRequests } from "~/modules/shell/approval-facets"
import { splitFeed, urgentStripItems } from "~/modules/shell/attention-groups"
import { attentionStore } from "~/modules/shell/attention-store"

const SHOW_PEER_REQUESTS_KEY = "liaison.home.showPeerRequests"

/** Default FALSE (peer rows folded). Any storage failure keeps the default. */
function readStoredShowPeerRequests(): boolean {
  try {
    return localStorage.getItem(SHOW_PEER_REQUESTS_KEY) === "1"
  } catch {
    return false
  }
}

const [peerRequestsShown, setPeerRequestsShown] = createSignal(readStoredShowPeerRequests())

/** Whether Home's Approvals card shows peer requests. Shared with the badge. */
export function showPeerRequests(): boolean {
  return peerRequestsShown()
}

export function setShowPeerRequests(next: boolean): void {
  setPeerRequestsShown(next)
  try {
    localStorage.setItem(SHOW_PEER_REQUESTS_KEY, next ? "1" : "0")
  } catch {
    // Per-viewer convenience only: losing it costs the user nothing.
  }
}

/** Re-reads the stored preference (Home mount, tests). */
export function reloadShowPeerRequests(): void {
  setPeerRequestsShown(readStoredShowPeerRequests())
}

/** The rows Home's Approvals card lists, before its action facet: approvals,
 *  access requests (only for someone who can grant them) and routine runs
 *  waiting for a private mailbox. A waiting run whose 24 hours are over has
 *  left the list (its run history says it expired; the server's sweep marks
 *  its row read too). */
export function homeApprovalItems(
  nowItems: AttentionItem[],
  peersShown: boolean,
  viewer: HomeViewer = { userId: "", canGrantAccess: true },
): AttentionItem[] {
  const approvals = nowItems.filter(
    (item) =>
      isApprovalItem(item) &&
      !isExpiredMailboxWait(item) &&
      (item.kind !== "scope_request" || viewer.canGrantAccess),
  )
  return peersShown ? approvals : partitionPeerRequests(approvals).mine
}

/** Who is looking: what decides an item is theirs to act on. */
export interface HomeViewer {
  userId: string
  /** Holds `kernel:scope_requests:admin`: access requests are theirs to grant. */
  canGrantAccess: boolean
}

export const ACCESS_GRANT_SCOPE = "kernel:scope_requests:admin"

/** The signed-in viewer, read from the token (reactive through it). */
export function currentHomeViewer(): HomeViewer {
  return { userId: userFromToken()?.userId ?? "", canGrantAccess: hasScope(ACCESS_GRANT_SCOPE) }
}

/** A ticket awaiting a reply that is not assigned to the viewer: queue volume
 *  ("Your queues"), not a decision (D21, recommendation 1). */
export function isQueueVolumeItem(item: AttentionItem, viewer: HomeViewer): boolean {
  if (item.kind !== "awaiting_agent") return false
  const assignedTo = item.metadata?.assignedTo
  return !(typeof assignedTo === "string" && assignedTo.length > 0 && assignedTo === viewer.userId)
}

/** A routine that failed or paused (routine-alert.ts): Home's Agents section. */
export function isRoutineAlertItem(item: AttentionItem): boolean {
  const alert = item.metadata?.routineAlert
  return typeof alert === "object" && alert !== null
}

/** Every item Home presents as needing the user's action, each once. This is
 *  the sidebar's "Needs you" section and the Home badge (D21). */
export function homeActionItems(
  items: AttentionItem[],
  peersShown: boolean,
  viewer: HomeViewer = { userId: "", canGrantAccess: true },
): AttentionItem[] {
  const { now } = splitFeed(items)
  const seen = new Set<string>()
  const out: AttentionItem[] = []
  for (const item of [...homeApprovalItems(now, peersShown, viewer), ...urgentStripItems(now)]) {
    if (seen.has(item.id)) continue
    if (isQueueVolumeItem(item, viewer)) continue
    if (isRoutineAlertItem(item)) continue
    if (item.kind === "scope_request" && !viewer.canGrantAccess) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/**
 * The shared memo, built on the first read rather than at import: importing
 * this module must not read the token or the stores (a module that merely
 * imports the shell would otherwise read auth state before anything set it).
 */
let count: (() => number) | null = null

/** The number the Home entry shows. */
export function homeActionCount(): number {
  count ??= createRoot(() =>
    createMemo(
      () => homeActionItems(attentionStore.items, peerRequestsShown(), currentHomeViewer()).length,
    ),
  )
  return count()
}

/**
 * The number of approvals Home's Approvals card lists from `items`: the same
 * rows, with peer requests folded exactly when the card folds them. Work's
 * Approvals row shows this, so the one queue never carries two counts (Work 9,
 * Home 8 plus "Show 1 more, from colleagues").
 */
export function homeApprovalCount(items: AttentionItem[]): number {
  return homeApprovalItems(splitFeed(items).now, peerRequestsShown(), currentHomeViewer()).length
}
