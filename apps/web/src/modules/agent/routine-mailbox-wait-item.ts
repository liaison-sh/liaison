// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The attention row of a routine run waiting for its owner's private mailbox
// (attention kind `routine_mailbox_wait`, the server's routine-mailbox-wait.ts),
// read as data. Pure, so the feed shaping (home-action-count.ts) can read it
// without the row's mailbox runtime; the row is RoutineMailboxWaitRow.

import type { AttentionItem } from "@liaison/shared"

/** What a waiting run's row carries (routine-mailbox-wait.ts `routineMailboxWait`). */
export interface RoutineMailboxWait {
  routineId: string
  routineName: string
  runId: string
  expiresAt: string | null
  /** What started the run: an event's kind (never its data), or null for its schedule. */
  trigger: { app: string; entity: string; action: string } | null
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

/** The waiting run an attention row is, or null for any other row. */
export function routineMailboxWaitOf(item: AttentionItem): RoutineMailboxWait | null {
  if (item.kind !== "routine_mailbox_wait") return null
  const raw = item.metadata?.routineMailboxWait as Record<string, unknown> | undefined
  const routineId = str(raw?.routineId)
  const runId = str(raw?.runId)
  if (!raw || !routineId || !runId) return null
  const t = raw.trigger as Record<string, unknown> | null | undefined
  const app = str(t?.app)
  const entity = str(t?.entity)
  const action = str(t?.action)
  return {
    routineId,
    runId,
    routineName: str(raw.routineName) ?? "",
    expiresAt: str(raw.expiresAt),
    trigger: app && entity && action ? { app, entity, action } : null,
  }
}

/** True for a waiting run whose 24 hours are over: it has left the list. */
export function isExpiredMailboxWait(item: AttentionItem, nowMs: number = Date.now()): boolean {
  const wait = routineMailboxWaitOf(item)
  if (!wait?.expiresAt) return false
  const at = Date.parse(wait.expiresAt)
  return Number.isFinite(at) && at <= nowMs
}
