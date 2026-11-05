// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket message store — per-ticket message thread, with pagination and
// optimistic-placeholder reconciliation for outbound replies.
import { runWithOwner } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { onEntityChange } from "~/framework/entity-changes"
import type { ApiClient } from "~/lib/api-client"
import { runTool } from "~/lib/run-tool"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { sanitizeMailHtml } from "~/modules/mail/mail-sanitize"
import type { TicketMessage, TicketMessageAttachment } from "./ticket-types"

interface ThreadState {
  byId: Record<string, TicketMessage>
  /** Oldest-first display order (chat/email convention: newest at the bottom). */
  ids: string[]
  nextCursor: string | null
  loading: boolean
  loaded: boolean
  /** Last load attempt failed (network/tool error). Cleared on a successful
   *  load — the conversation pane renders a retry affordance off this instead
   *  of a silent empty thread. */
  error: boolean
}

interface MessageState {
  threadsByTicketId: Record<string, ThreadState>
}

const [ticketMessageStore, setTicketMessageStore] = createStore<MessageState>({
  threadsByTicketId: {},
})

export { ticketMessageStore }

export function ticketReplyPayloadHash(payload: {
  ticketId: string
  textBody?: string
  htmlBody?: string
}): string {
  const input = JSON.stringify({
    toolName: "tickets:reply",
    ticketId: payload.ticketId,
    textBody: payload.textBody ?? "",
    htmlBody: payload.htmlBody ?? "",
  })
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`
}

export function getThread(ticketId: string): ThreadState | undefined {
  return ticketMessageStore.threadsByTicketId[ticketId]
}

/**
 * The people the customer's latest email copied (its Cc), as plain addresses.
 * A reply starts with them so they stay on the thread; empty when the latest
 * customer email copied nobody or the thread is not loaded yet.
 */
export function latestInboundCc(ticketId: string): string[] {
  const thread = ticketMessageStore.threadsByTicketId[ticketId]
  if (!thread) return []
  for (let i = thread.ids.length - 1; i >= 0; i--) {
    const m = thread.byId[thread.ids[i]!]
    if (!m || m.kind !== "inbound") continue
    const from = m.fromEmail?.toLowerCase() ?? ""
    return (m.ccEmails ?? [])
      .map((c) =>
        typeof c === "string"
          ? c
          : ((c as { email?: unknown } | null)?.email as string | undefined),
      )
      .filter((c): c is string => typeof c === "string" && c.includes("@"))
      .filter((c) => c.toLowerCase() !== from)
  }
  return []
}

function sanitizeTicketMessage(message: TicketMessage): TicketMessage {
  if (!message.htmlBody) return message
  return { ...message, htmlBody: sanitizeMailHtml(message.htmlBody) }
}

// First-paint page: tiny (newest 3, stripped, HTML) so a big prod ticket shows
// readable content within a few hundred ms; the standard page follows.
const FIRST_PAINT_LIMIT = 3
// Standard bounded page size (see the loadTwoStage comment).
const PAGE_LIMIT = 15

// In-flight full (non-append) loads, keyed by ticketId. TicketDetail's mount
// kicks loadMessages off in PARALLEL with loadTicket, whose success path also
// chains a loadMessages — this dedupe makes the pair cost exactly one
// two-stage load instead of a double fetch.
const _inFlightLoads: Record<string, Promise<void>> = {}
// The abort handle of each in-flight load, so a restart can end it (S26).
const _inFlightAborts: Record<string, AbortController> = {}

// --- Live appends the WS patch cannot apply ---
// A message appended by the inbound mail path (a customer reply, a synced
// outbound) is announced as `create { ticketId }` without the message itself,
// which `handleTicketMessageEvent` cannot insert. An OPEN thread reloads in
// place instead (the reload merges, nothing blinks); once per burst per ticket.
// Resync is owned by the detail store, which chains loadMessages.
let _messagesApi: ApiClient | null = null
let _disposeLive: (() => void) | null = null

function isFullMessageEvent(data: Record<string, unknown>): boolean {
  return (
    typeof data.id === "string" &&
    (typeof data.textBody === "string" || typeof data.htmlBody === "string")
  )
}

function subscribeTicketMessagesLive(): void {
  if (_disposeLive) return
  // Owner-less on purpose: the first caller is TicketDetail's onMount, and a
  // subscription owned by that component would die with it while every later
  // thread still counted on it. Session teardown disposes it instead.
  _disposeLive =
    runWithOwner(null, () =>
      onEntityChange("tickets:message", (events) => {
        const api = _messagesApi
        if (!api) return
        const ticketIds = new Set<string>()
        for (const e of events) {
          if (e.resync || e.action !== "create") continue
          const data = (e.data ?? {}) as Record<string, unknown>
          const ticketId = data.ticketId
          if (typeof ticketId !== "string" || isFullMessageEvent(data)) continue
          if (ticketMessageStore.threadsByTicketId[ticketId]?.loaded) ticketIds.add(ticketId)
        }
        for (const ticketId of ticketIds) void loadMessages(api, ticketId, { fresh: true })
      }),
    ) ?? null
}

/** A follow-up load queued behind an in-flight one, per ticket (see `fresh`). */
const _queuedLoads: Record<string, Promise<void>> = {}

/**
 * `fresh`: the caller just changed the thread (a note it added, a live append)
 * and needs a load that STARTS after that change. A load already in flight may
 * have read before it, so a fresh call queues one more load behind it (shared
 * by every fresh call meanwhile) instead of joining it. Plain calls (a mount)
 * share the in-flight load.
 *
 * `restart`: a resync after a network blip (S26). A load in flight may have
 * been swallowed by the blip and never settle, so neither joining nor queuing
 * behind it would ever show what happened in the gap: it is aborted (it ends
 * quietly, its write-back dropped) and a new load starts now.
 */
export function loadMessages(
  api: ApiClient,
  ticketId: string,
  opts: { fresh?: boolean; restart?: boolean } = {},
): Promise<void> {
  _messagesApi = api
  subscribeTicketMessagesLive()
  if (opts.restart && ticketId in _inFlightLoads) {
    _inFlightAborts[ticketId]?.abort()
    delete _inFlightAborts[ticketId]
    delete _inFlightLoads[ticketId]
  }
  const existing = _inFlightLoads[ticketId]
  if (existing && opts.fresh) {
    const queued = _queuedLoads[ticketId]
    if (queued) return queued
    const next = existing
      .catch(() => {})
      .then(() => {
        delete _queuedLoads[ticketId]
        return loadMessages(api, ticketId)
      })
    _queuedLoads[ticketId] = next
    return next
  }
  if (existing) return existing
  const controller = new AbortController()
  const p = loadTwoStage(api, ticketId, controller.signal).finally(() => {
    if (_inFlightLoads[ticketId] === p) {
      delete _inFlightLoads[ticketId]
      delete _inFlightAborts[ticketId]
    }
  })
  _inFlightLoads[ticketId] = p
  _inFlightAborts[ticketId] = controller
  return p
}

export async function loadMoreMessages(api: ApiClient, ticketId: string): Promise<void> {
  await loadOlderInternal(api, ticketId)
}

/**
 * Progressive two-stage initial load. Rich view, but BOUNDED: HTML bodies for
 * the pane's rendering, small pages (newest first; older pages stream in via
 * loadMoreMessages + cursor), and quoted tails trimmed server-side. A
 * 68-message thread whose quoted tails run 100-350KB each used to produce a
 * multi-megabyte response that failed outright and left the thread empty.
 * Trimmed messages carry the QUOTE_TRIMMED_MARKER; expanding one lazily
 * re-fetches that single message in full (fetchFullTicketMessage below).
 *
 * Both stages are fired immediately, in parallel:
 *  - stage 1 (`messagesLimit: 3`) commits as soon as it lands so the newest
 *    exchange is readable ASAP;
 *  - stage 2 (`messagesLimit: 15`) is authoritative — it re-commits the full
 *    page (deduped by id, oldest-first preserved) and owns `nextCursor`.
 * Races handled: stage 2 landing first skips stage 1's commit entirely
 * (`fullCommitted`); a RELOAD of an already-loaded thread skips stage 1 too
 * (never shrink a full thread to 3 rows); locally-present messages not in the
 * committed page (placeholders, WS arrivals, older pages from load-more) are
 * preserved in position. The error state is set only when BOTH stages failed
 * and nothing is on screen.
 */
async function loadTwoStage(api: ApiClient, ticketId: string, signal: AbortSignal): Promise<void> {
  setTicketMessageStore(
    produce((s) => {
      if (!s.threadsByTicketId[ticketId]) {
        s.threadsByTicketId[ticketId] = {
          byId: {},
          ids: [],
          nextCursor: null,
          loading: true,
          loaded: false,
          error: false,
        }
      } else {
        s.threadsByTicketId[ticketId].loading = true
        s.threadsByTicketId[ticketId].error = false
      }
    }),
  )

  let fullCommitted = false

  const fetchPage = (limit: number) =>
    runTool<{
      ticket: unknown
      messages: { items: TicketMessage[]; nextCursor: string | null }
    }>(
      api,
      "tickets:get",
      {
        ticketId,
        messagesLimit: limit,
        includeHtml: true,
        stripQuoted: true,
      },
      { signal },
    )

  const applyPage = (
    out: { messages?: { items?: TicketMessage[]; nextCursor?: string | null } },
    stage: "first" | "full",
  ): void => {
    // Restarted: the load that replaced this one owns the thread now.
    if (signal.aborted) return
    if (stage === "first" && fullCommitted) return
    // Server returns each page newest-first (`ORDER BY sent_at DESC, id DESC`,
    // keyset-paginated via messagesCursor). Display is oldest-first (newest at
    // the bottom, email/chat convention) — reverse each page before merging so
    // `ids` is always oldest-first both within a page and across pages.
    const items = [...(out.messages?.items ?? [])].reverse()
    setTicketMessageStore(
      produce((s) => {
        const t = s.threadsByTicketId[ticketId]
        if (!t) return // reset/teardown mid-flight — drop the write-back
        // Reload of an already-populated thread: only the authoritative page
        // may re-commit — the 3-row first-paint page would visibly shrink it.
        if (stage === "first" && t.loaded) return
        const pageIds = new Set(items.map((m) => m.id))
        // Preserve local rows the page doesn't cover: rows ordered BEFORE the
        // page's span are older history (load-more pages); rows after are
        // newer (placeholders, WS arrivals racing the fetch).
        const firstPageIdx = t.ids.findIndex((id) => pageIds.has(id))
        const olderExtras: string[] = []
        const newerExtras: string[] = []
        t.ids.forEach((id, idx) => {
          if (pageIds.has(id)) return
          if (firstPageIdx !== -1 && idx < firstPageIdx) olderExtras.push(id)
          else newerExtras.push(id)
        })
        const keptById: Record<string, TicketMessage> = {}
        for (const id of [...olderExtras, ...newerExtras]) {
          const m = t.byId[id]
          if (m) keptById[id] = m
        }
        t.byId = keptById
        for (const m of items) t.byId[m.id] = sanitizeTicketMessage(m)
        t.ids = [...olderExtras, ...items.map((m) => m.id), ...newerExtras]
        // The cursor follows the LARGER page once it lands; the first-paint
        // page's cursor is a correct interim value (load-more from it fetches
        // the next-older span, deduped on insert).
        if (stage === "full" || !fullCommitted) t.nextCursor = out.messages?.nextCursor ?? null
        t.loaded = true
        t.error = false
      }),
    )
  }

  const firstOk = fetchPage(FIRST_PAINT_LIMIT)
    .then((out) => {
      applyPage(out, "first")
      return true
    })
    .catch(() => false)
  const fullOk = fetchPage(PAGE_LIMIT)
    .then((out) => {
      fullCommitted = true
      applyPage(out, "full")
      return true
    })
    .catch(() => false)

  const [a, b] = await Promise.all([firstOk, fullOk])
  if (signal.aborted) return
  setTicketMessageStore(
    produce((s) => {
      const t = s.threadsByTicketId[ticketId]
      if (!t) return
      t.loading = false
      // Surface the failure ONLY when both stages produced nothing: the
      // conversation pane shows an error + retry state off `error` instead of
      // silently rendering an empty thread.
      if (!a && !b && t.ids.length === 0) t.error = true
    }),
  )
}

async function loadOlderInternal(api: ApiClient, ticketId: string): Promise<void> {
  const params: Record<string, unknown> = {
    ticketId,
    messagesLimit: PAGE_LIMIT,
    includeHtml: true,
    stripQuoted: true,
  }
  const cursor = ticketMessageStore.threadsByTicketId[ticketId]?.nextCursor
  if (cursor) params.messagesCursor = cursor
  setTicketMessageStore(
    produce((s) => {
      const t = s.threadsByTicketId[ticketId]
      if (!t) return
      t.loading = true
      t.error = false
    }),
  )
  try {
    const out = await runTool<{
      ticket: unknown
      messages: { items: TicketMessage[]; nextCursor: string | null }
    }>(api, "tickets:get", params)
    const items = [...(out.messages?.items ?? [])].reverse()
    setTicketMessageStore(
      produce((s) => {
        const t = s.threadsByTicketId[ticketId]
        if (!t) return
        // Load-more fetches the NEXT (older) page — insert it at the TOP,
        // ahead of whatever's already loaded, preserving oldest-first order.
        const newIds: string[] = []
        for (const m of items) {
          t.byId[m.id] = sanitizeTicketMessage(m)
          if (!t.ids.includes(m.id)) newIds.push(m.id)
        }
        t.ids = [...newIds, ...t.ids]
        t.nextCursor = out.messages?.nextCursor ?? null
        t.loaded = true
        t.loading = false
        t.error = false
      }),
    )
  } catch {
    setTicketMessageStore(
      produce((s) => {
        const t = s.threadsByTicketId[ticketId]
        if (t) {
          t.loading = false
          t.error = true
        }
      }),
    )
  }
}

/**
 * Re-fetch ONE message in full (untrimmed quoted history, HTML body) and patch
 * it into the thread in place. Used when the reader expands the quoted history
 * of a message whose page-load body was trimmed server-side
 * (QUOTE_TRIMMED_MARKER). Throws on failure so the caller can show it.
 */
export async function fetchFullTicketMessage(
  api: ApiClient,
  ticketId: string,
  messageId: string,
): Promise<void> {
  const out = await runTool<{
    messages: { items: TicketMessage[]; nextCursor: string | null }
  }>(api, "tickets:get", {
    ticketId,
    messageId,
    includeHtml: true,
    stripQuoted: false,
  })
  const full = out.messages?.items?.find((m) => m.id === messageId) ?? out.messages?.items?.[0]
  if (!full) throw new Error("Message not found")
  setTicketMessageStore(
    produce((s) => {
      const t = s.threadsByTicketId[ticketId]
      if (!t || !t.byId[messageId]) return
      // Merge onto the existing row (keeps position in `ids` and any locally
      // derived fields); sanitize the fresh htmlBody like every other ingest.
      t.byId[messageId] = sanitizeTicketMessage({ ...t.byId[messageId], ...full })
    }),
  )
}

/**
 * Insert an optimistic outbound message placeholder so the composer can show
 * its sent reply immediately. Reconciliation happens when the real message:create
 * event arrives via WS.
 */
export function insertPlaceholder(ticketId: string, placeholder: TicketMessage): void {
  setTicketMessageStore(
    produce((s) => {
      if (!s.threadsByTicketId[ticketId]) {
        s.threadsByTicketId[ticketId] = {
          byId: {},
          ids: [],
          nextCursor: null,
          loading: false,
          loaded: true,
          error: false,
        }
      }
      const t = s.threadsByTicketId[ticketId]
      t.byId[placeholder.id] = placeholder
      // Oldest-first order: a freshly-sent placeholder is the newest message,
      // so it lands at the END of the list (bottom of the conversation).
      if (!t.ids.includes(placeholder.id)) t.ids.push(placeholder.id)
    }),
  )
}

/** Drop a message from the local thread (note deletion — own action or WS echo). */
export function removeTicketMessage(ticketId: string, messageId: string): void {
  setTicketMessageStore(
    produce((s) => {
      const t = s.threadsByTicketId[ticketId]
      if (!t) return
      delete t.byId[messageId]
      t.ids = t.ids.filter((id) => id !== messageId)
    }),
  )
}

/** Patch a message's plain-text body in place (note edit — own action or WS echo). */
export function patchTicketMessageAttachments(
  ticketId: string,
  messageId: string,
  attachments: TicketMessageAttachment[],
): void {
  setTicketMessageStore(
    produce((s) => {
      const m = s.threadsByTicketId[ticketId]?.byId[messageId]
      if (m) m.attachments = attachments
    }),
  )
}

export function patchTicketMessageText(ticketId: string, messageId: string, text: string): void {
  setTicketMessageStore(
    produce((s) => {
      const m = s.threadsByTicketId[ticketId]?.byId[messageId]
      if (!m) return
      m.textBody = text
    }),
  )
}

/**
 * `tickets/note:create`: an internal note, announced as its own event (never
 * `message:create`, which routines read as a customer-thread message) in the
 * reply's data shape, so it lands in an open thread the same way.
 */
export function handleTicketNoteEvent(action: string, data: any): void {
  if (action === "create") handleTicketMessageEvent(action, data)
}

export function handleTicketMessageEvent(action: string, data: any): void {
  if (!data?.id || !data?.ticketId) return
  if (action === "delete") {
    removeTicketMessage(data.ticketId, data.id)
    return
  }
  if (action === "update") {
    if (typeof data.textBody === "string") {
      patchTicketMessageText(data.ticketId, data.id, data.textBody)
    }
    // The files a reply carried land on its message just after the send; the
    // server announces them so the card shows them without a reload.
    if (Array.isArray(data.attachments)) {
      patchTicketMessageAttachments(data.ticketId, data.id, data.attachments)
    }
    return
  }
  if (action !== "create") return
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("tickets:attention-invalidated"))
  }
  // Keep the inbox list row in sync with the live conversation — preview
  // snippet, unread indicator, and sort position. Lazy import mirrors
  // ticket-detail-store.ts's handleTicketEvent -> removeTicketFromList, which
  // avoids a static import cycle between the message and list stores.
  void import("~/modules/tickets/ticket-list-store").then(({ applyTicketMessageToList }) => {
    applyTicketMessageToList(data)
  })
  setTicketMessageStore(
    produce((s) => {
      const t = s.threadsByTicketId[data.ticketId]
      if (!t) return
      const incomingHash = ticketReplyPayloadHash({
        ticketId: data.ticketId,
        textBody: data.textBody ?? "",
        htmlBody: data.htmlBody ?? "",
      })
      const placeholderId = t.ids.find((id) => {
        const m = t.byId[id]
        if (!m || m.kind !== "outbound-pending") return false
        if (data.approvalRequestId && m.approvalRequestId === data.approvalRequestId) return true
        return m.payloadHash === incomingHash
      })
      // Reconcile in place: if a placeholder occupied a position, the real
      // message takes that SAME position (no visual jump). Otherwise (e.g. a
      // message from another agent/customer, or the WS echo racing ahead of
      // the placeholder insert) it's the newest message — append at the end.
      const insertAt = placeholderId ? t.ids.indexOf(placeholderId) : -1
      // The send's files are attached to the real message a moment after it
      // exists; until the server announces them, keep the ones the placeholder
      // showed so the card never goes blank in between.
      const placeholderFiles = placeholderId ? t.byId[placeholderId]?.attachments : undefined
      if (placeholderFiles?.length && !Array.isArray(data.attachments)) {
        data = { ...data, attachments: placeholderFiles }
      }
      if (placeholderId) {
        delete t.byId[placeholderId]
        t.ids = t.ids.filter((id) => id !== placeholderId)
      }
      t.byId[data.id] = sanitizeTicketMessage(data as TicketMessage)
      if (!t.ids.includes(data.id)) {
        if (insertAt >= 0 && insertAt <= t.ids.length) {
          t.ids.splice(insertAt, 0, data.id)
        } else {
          t.ids.push(data.id)
        }
      }
    }),
  )
}

/** Window event naming a decided `tickets:reply` approval: detail
 *  `{ ticketId, approvalId, status }`. The composer listens for the reply it
 *  parked under a two-approver policy. */
export const TICKET_REPLY_APPROVAL_EVENT = "tickets:reply-approval-status"

export function handleTicketApprovalUpdate(row: any, _currentUserId: string): void {
  if (!row || row.toolName !== "tickets:reply") return
  attachApprovalFromRow(row)
  const replyTicketId =
    typeof row.currentPayload?.ticketId === "string" ? row.currentPayload.ticketId : null
  if (replyTicketId && typeof row.id === "string" && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(TICKET_REPLY_APPROVAL_EVENT, {
        detail: { ticketId: replyTicketId, approvalId: row.id, status: row.status },
      }),
    )
  }
  if (row.status !== "denied" && row.status !== "expired") return
  const payload = row.currentPayload ?? {}
  const ticketId = typeof payload.ticketId === "string" ? payload.ticketId : null
  if (!ticketId) return
  const payloadHash = ticketReplyPayloadHash({
    ticketId,
    textBody: typeof payload.textBody === "string" ? payload.textBody : "",
    htmlBody: typeof payload.htmlBody === "string" ? payload.htmlBody : "",
  })
  setTicketMessageStore(
    produce((s) => {
      const t = s.threadsByTicketId[ticketId]
      if (!t) return
      const placeholderId = t.ids.find((id) => {
        const m = t.byId[id]
        if (!m || m.kind !== "outbound-pending") return false
        return m.approvalRequestId === row.id || m.payloadHash === payloadHash
      })
      if (!placeholderId) return
      delete t.byId[placeholderId]
      t.ids = t.ids.filter((id) => id !== placeholderId)
    }),
  )
  // Deliberately NO composer-draft restore here: a denied/expired gated reply
  // is dead (triage skill treats it as such), and the ApprovalCard's in-place
  // edit is the path for salvaging text — dumping the body into the composer
  // input just resurrects rejected copy.
}

export function handleTicketApprovalCreate(row: any): void {
  if (!row || row.toolName !== "tickets:reply") return
  attachApprovalFromRow(row)
}

function attachApprovalFromRow(row: any): void {
  const payload = row.currentPayload ?? {}
  const ticketId = typeof payload.ticketId === "string" ? payload.ticketId : null
  if (!ticketId) return
  const payloadHash = ticketReplyPayloadHash({
    ticketId,
    textBody: typeof payload.textBody === "string" ? payload.textBody : "",
    htmlBody: typeof payload.htmlBody === "string" ? payload.htmlBody : "",
  })
  setTicketMessageStore(
    produce((s) => {
      const t = s.threadsByTicketId[ticketId]
      if (!t) return
      const placeholder = Object.values(t.byId).find(
        (m) => m.kind === "outbound-pending" && m.payloadHash === payloadHash,
      )
      if (placeholder) placeholder.approvalRequestId = row.id
    }),
  )
  dispatchTicketApprovalsInvalidated(ticketId)
}

/**
 * Tell any mounted `TicketDetail` for this ticket that its approval list may
 * have changed (a new gated `tickets:reply` request was created, or an
 * existing one was decided) so it re-fetches `/approvals?threadId=...`
 * instead of waiting for a manual reload. Fired from the WS
 * `approval_request` create/update handlers above.
 */
export function dispatchTicketApprovalsInvalidated(ticketId: string): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("tickets:approvals-invalidated", { detail: { ticketId } }))
}

export function resetTicketMessageStore(): void {
  _disposeLive?.()
  _disposeLive = null
  _messagesApi = null
  for (const key of Object.keys(_inFlightLoads)) delete _inFlightLoads[key]
  for (const key of Object.keys(_inFlightAborts)) {
    _inFlightAborts[key]?.abort()
    delete _inFlightAborts[key]
  }
  for (const key of Object.keys(_queuedLoads)) delete _queuedLoads[key]
  setTicketMessageStore({ threadsByTicketId: {} })
}

onSessionTeardown(resetTicketMessageStore)
