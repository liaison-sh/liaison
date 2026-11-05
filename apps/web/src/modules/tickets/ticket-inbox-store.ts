// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket inbox store — list of inboxes + unread counts derived from
// `tickets:inboxCounts`. Inboxes themselves come from `tickets:inboxes.list`.
import { createStore, produce } from "solid-js/store"
import type { EntityChangeEvent } from "~/framework/entity-changes"
import type { ApiClient } from "~/lib/api-client"
import { runTool } from "~/lib/run-tool"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { TicketInbox } from "./ticket-types"

interface InboxState {
  inboxes: TicketInbox[]
  unreadByInboxId: Record<string, number>
  /** Every visible unread ticket, inbox or not (server `totalUnread`). NOT the
   *  sum of `unreadByInboxId`: tickets with no source inbox belong to no row. */
  totalUnread: number | undefined
  loading: boolean
  loaded: boolean
}

const [ticketInboxStore, setTicketInboxStore] = createStore<InboxState>({
  inboxes: [],
  unreadByInboxId: {},
  totalUnread: undefined,
  loading: false,
  loaded: false,
})

export { ticketInboxStore }

const snakeToCamel = (key: string): string =>
  key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * `tickets:inboxes.list` (and the inbox events) carry the admin SQL row as is,
 * in snake_case, while every reader types and reads `TicketInbox` in camelCase
 * (`isDefaultForCreate`, `emailAddress`, `archivedAt`, `defaultTeam`...). Read
 * raw, those were undefined: the settings form then saved the default inbox
 * as not-default (refused, so no setting on it could be saved) and blanked its
 * team and sensitivity. Every row is given its camelCase keys on the way in;
 * the snake_case ones stay for the readers that still fall back to them.
 */
export function normalizeTicketInbox(row: Record<string, unknown>): TicketInbox {
  const out: Record<string, unknown> = { ...row }
  for (const [key, value] of Object.entries(row)) {
    if (!key.includes("_")) continue
    const camel = snakeToCamel(key)
    if (!(camel in row)) out[camel] = value
  }
  return out as unknown as TicketInbox
}

/**
 * The "All" inbox badge: the server's total when it sent one, else (an older
 * server) the per-inbox sum it used to be.
 */
export function totalUnreadAcrossInboxes(): number {
  if (typeof ticketInboxStore.totalUnread === "number") return ticketInboxStore.totalUnread
  return Object.values(ticketInboxStore.unreadByInboxId).reduce((a, b) => a + b, 0)
}

// The unread count is "open, unmerged tickets with a customer message nobody
// read since" per source inbox (apps/api read-state.ts `inboxCounts`).
const UNREAD_TICKET_ACTIONS = new Set(["create", "created", "reopened", "merged", "converted"])
const UNREAD_TICKET_FIELDS = ["status", "unread", "mergedIntoTicketId", "sourceInboxId"]

/**
 * Can this change move an inbox unread count? A new ticket, a customer
 * message, a read, a close/reopen/merge or an inbox move can; a priority,
 * team or category edit, an SLA breach, our own reply or a note cannot.
 */
export function inboxUnreadMayChange(e: EntityChangeEvent): boolean {
  if (e.resync) return true
  const data = (e.data ?? {}) as Record<string, unknown>
  if (e.key === "tickets:ticket") {
    if (UNREAD_TICKET_ACTIONS.has(e.action)) return true
    const changes = data.changes
    if (!changes || typeof changes !== "object") return false
    return UNREAD_TICKET_FIELDS.some((f) => f in changes)
  }
  if (e.key === "tickets:message") {
    // The inbound append path announces `{ ticketId }` without a kind.
    return e.action === "create" && (data.kind === undefined || data.kind === "inbound")
  }
  return false
}

export async function loadInboxes(api: ApiClient): Promise<void> {
  setTicketInboxStore("loading", true)
  try {
    const list = await runTool<TicketInbox[]>(api, "tickets:inboxes.list", {})
    setTicketInboxStore(
      produce((s) => {
        s.inboxes = Array.isArray(list)
          ? list.map((row) => normalizeTicketInbox(row as unknown as Record<string, unknown>))
          : []
        s.loaded = true
      }),
    )
    await refreshInboxCounts(api)
  } finally {
    setTicketInboxStore("loading", false)
  }
}

/**
 * Save an inbox's settings (`tickets:inboxes.update`) and reload the list.
 * A refusal (403) or failure THROWS: the settings form shows it, it is never
 * swallowed. Returns `"pending"` when an org two-approver policy parked the
 * change for a second person, `"saved"` otherwise.
 */
export async function saveInboxSettings(
  api: ApiClient,
  id: string,
  params: Record<string, unknown>,
): Promise<"saved" | "pending"> {
  const out = await runTool<{ blocked?: { approvalRequestId?: string } } | undefined>(
    api,
    "tickets:inboxes.update",
    { id, ...params },
  )
  void loadInboxes(api)
  return out?.blocked ? "pending" : "saved"
}

export async function refreshInboxCounts(api: ApiClient, inboxIds?: string[]): Promise<void> {
  try {
    const out = await runTool<{
      counts: Array<{ inboxId: string; unread: number }>
      totalUnread?: number
    }>(api, "tickets:inboxCounts", inboxIds ? { inboxIds } : {})
    setTicketInboxStore(
      produce((s) => {
        for (const c of out.counts ?? []) {
          s.unreadByInboxId[c.inboxId] = c.unread
        }
        if (typeof out.totalUnread === "number") s.totalUnread = out.totalUnread
      }),
    )
  } catch {
    // non-fatal
  }
}

export function handleInboxEvent(action: string, data: any): void {
  setTicketInboxStore(
    produce((s) => {
      const id = data?.id
      if (!id) return
      if (action === "create") {
        const exists = s.inboxes.some((i) => i.id === id)
        if (!exists) s.inboxes.push(normalizeTicketInbox(data))
      } else if (action === "update") {
        const idx = s.inboxes.findIndex((i) => i.id === id)
        if (idx >= 0) s.inboxes[idx] = { ...s.inboxes[idx], ...normalizeTicketInbox(data) }
      } else if (action === "disconnect") {
        const idx = s.inboxes.findIndex((i) => i.id === id)
        if (idx >= 0) s.inboxes[idx] = { ...s.inboxes[idx], archivedAt: new Date().toISOString() }
      }
    }),
  )
}

export function resetTicketInboxStore(): void {
  setTicketInboxStore({
    inboxes: [],
    unreadByInboxId: {},
    totalUnread: undefined,
    loading: false,
    loaded: false,
  })
}

onSessionTeardown(resetTicketInboxStore)
