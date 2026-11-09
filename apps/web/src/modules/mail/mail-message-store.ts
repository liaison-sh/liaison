// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import { apiUrl } from "~/lib/env"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { getAccount } from "~/modules/mail/mail-account-store"
import {
  type Conversation,
  conversationStore,
  upsertConversation,
} from "~/modules/mail/mail-conversation-store"
import type { SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import { openSealedMessage } from "~/modules/mailbox/mailbox-store"

interface MailApi {
  get: <T = unknown>(path: string, init?: { signal?: AbortSignal }) => Promise<T>
}

export interface MailMessageAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  thumbnailUrl?: string | null
  disposition?: "inline" | "attachment"
  contentId?: string | null
  ordinal?: number
}

/**
 * Where a row sits in the encryption regime.
 *   plaintext: a legacy row, or a shared org mailbox. Nothing to open.
 *   sealed:    ciphertext arrived, the open has not been attempted yet.
 *   opened:    the worker returned plaintext into the string fields below.
 *   locked:    the mailbox is locked. A STATE to render, never an error.
 */
export type MailMessageEncState = "plaintext" | "sealed" | "opened" | "locked"

export interface MailMessage {
  id: string
  conversationId: string
  fromAddress: { name?: string; email: string }
  toAddresses: Array<{ name?: string; email: string }>
  ccAddresses: Array<{ name?: string; email: string }>
  subject: string
  htmlBody: string
  textBody: string
  direction: "inbound" | "outbound"
  sentAt: string
  isRead: boolean
  /** The provider's Message-ID. Recorded in the client ledger, never rendered. */
  externalMessageId?: string | null
  sentByUser?: { id: string; name: string; avatarUrl: string | null } | null
  attachments?: MailMessageAttachment[]
  /** 0 or absent for a legacy plaintext row, 1 for a sealed row. */
  encVersion?: number
  encKeyId?: number
  contentKeyWrapped?: string | null
  contentKeyEpk?: string | null
  subjectCiphertext?: string | null
  textBodyCiphertext?: string | null
  htmlBodyCiphertext?: string | null
  snippetCiphertext?: string | null
  encState?: MailMessageEncState
}

/**
 * Dual read (spec section 7 step 5): prefer ciphertext when it is there, fall
 * back to the plaintext columns, so a partially migrated mailbox is fully
 * usable throughout the migration.
 */
export function isSealedMessage(message: MailMessage): boolean {
  return (message.encVersion ?? 0) > 0 && !!message.contentKeyWrapped && !!message.contentKeyEpk
}

function sealedPayload(message: MailMessage): SealedMessagePayload {
  return {
    id: message.id,
    encVersion: message.encVersion ?? 1,
    encKeyId: message.encKeyId ?? 0,
    contentKeyWrapped: message.contentKeyWrapped ?? "",
    contentKeyEpk: message.contentKeyEpk ?? "",
    subjectCiphertext: message.subjectCiphertext,
    textBodyCiphertext: message.textBodyCiphertext,
    htmlBodyCiphertext: message.htmlBodyCiphertext,
    snippetCiphertext: message.snippetCiphertext,
  }
}

/**
 * A sealed row carries no readable text until the worker answers. Blank the
 * string fields rather than trusting whatever the server sent in them: a
 * renderer must never be handed ciphertext to display.
 */
function markEncState(message: MailMessage): MailMessage {
  if (!isSealedMessage(message)) return { ...message, encState: "plaintext" }
  return { ...message, subject: "", htmlBody: "", textBody: "", encState: "sealed" }
}

export interface DiscussionMarker {
  id: string
  threadMessageId: string
  anchorMessageId: string | null
  author: { id: string; name: string | null }
  excerpt: string
  createdAt: string
  markerKind: string
}

interface ConversationMessages {
  ids: string[]
  byId: Record<string, MailMessage>
  discussionMarkers: DiscussionMarker[]
  hasMore: boolean
  cursor: string | null
}

const [messages, setMessages] = createStore<Record<string, ConversationMessages>>({})

export function getMessages(conversationId: string): MailMessage[] {
  const conv = messages[conversationId]
  if (!conv) return []
  return conv.ids.map((id) => conv.byId[id]).filter(Boolean)
}

/**
 * Every loaded row belonging to a PERSONAL mailbox the server says is `ready`,
 * in the shape the downgrade detector checks (blueprint task 13.1).
 *
 * The account gate is the whole reason this lives here rather than in the
 * mailbox module: on a shared org mailbox a plaintext row is correct, and
 * alarming on one would be a false positive, which is the one failure a
 * detector may not have. `encVersion` is taken RAW, never defaulted to 1 the
 * way `sealedPayload` does for the read path, because defaulting it is exactly
 * how an unsealed row would be made to look sealed.
 */
/**
 * One loaded sealed row by message id, for the approval card's quote decryption
 * (blueprint Task 9.8).
 *
 * Loaded rows only, on purpose: this module holds what the mail surface has
 * fetched, and inventing a second fetch path for the approvals card would give
 * the card its own way to pull mail rows. A message that is not loaded yields
 * undefined, the fulfilment builder refuses, and the user is told to open the
 * conversation in Mail first. A refusal is the correct outcome; a send with a
 * missing quote is not.
 */
/**
 * Every message id the mail surface currently has loaded.
 *
 * This is the id SCOPE a turn may ask to decrypt: the conversations the user
 * actually has open. It is deliberately not "every id in the mailbox", which is
 * what would let one turn walk the whole thing.
 */
export function loadedMailMessageIds(): string[] {
  const ids: string[] = []
  for (const conversationId of Object.keys(messages)) {
    for (const id of messages[conversationId]?.ids ?? []) ids.push(id)
  }
  return ids
}

export function sealedMessageById(messageId: string): SealedMessagePayload | undefined {
  for (const conversationId of Object.keys(messages)) {
    const message = messages[conversationId]?.byId[messageId]
    if (message && isSealedMessage(message)) return sealedPayload(message)
  }
  return undefined
}

export function sealedRowsForDowngradeCheck(): SealedMessagePayload[] {
  const rows: SealedMessagePayload[] = []
  for (const conversationId of Object.keys(messages)) {
    const conversation = conversationStore.byId[conversationId]
    const account = conversation ? getAccount(conversation.accountId) : undefined
    if (!account || account.ownerType !== "user" || account.encryptionState !== "ready") continue
    const entry = messages[conversationId]
    if (!entry) continue
    for (const id of entry.ids) {
      const message = entry.byId[id]
      if (!message) continue
      rows.push({
        id: message.id,
        encVersion: message.encVersion ?? 0,
        encKeyId: message.encKeyId ?? 0,
        contentKeyWrapped: message.contentKeyWrapped ?? "",
        contentKeyEpk: message.contentKeyEpk ?? "",
        subjectCiphertext: message.subjectCiphertext,
        textBodyCiphertext: message.textBodyCiphertext,
        htmlBodyCiphertext: message.htmlBodyCiphertext,
        snippetCiphertext: message.snippetCiphertext,
      })
    }
  }
  return rows
}

export interface DowngradeLedgerMeta {
  externalMessageId: string
  receivedAt: string
}

/**
 * The two non-ciphertext values the client ledger records alongside each row
 * (spec section 9.6), keyed by message id, for exactly the rows
 * `sealedRowsForDowngradeCheck` returns.
 *
 * They are taken from what the server sent, which is the point: they are part
 * of the statement this browser MACs, so a later attempt to restate when a
 * message arrived or which provider message it was breaks the MAC.
 */
export function ledgerMetaForDowngradeCheck(): Record<string, DowngradeLedgerMeta> {
  const meta: Record<string, DowngradeLedgerMeta> = {}
  for (const conversationId of Object.keys(messages)) {
    const conversation = conversationStore.byId[conversationId]
    const account = conversation ? getAccount(conversation.accountId) : undefined
    if (!account || account.ownerType !== "user" || account.encryptionState !== "ready") continue
    const entry = messages[conversationId]
    if (!entry) continue
    for (const id of entry.ids) {
      const message = entry.byId[id]
      if (!message) continue
      meta[message.id] = {
        externalMessageId: message.externalMessageId ?? "",
        receivedAt: message.sentAt ?? "",
      }
    }
  }
  return meta
}

export function getDiscussionMarkers(conversationId: string): DiscussionMarker[] {
  return messages[conversationId]?.discussionMarkers ?? []
}

// Last API client seen — captured so the resync subscription can refetch the
// open conversation's messages without a component context.
let _mailMsgApi: MailApi | null = null

// Per-conversation generation counter. Bumped whenever
// evictConversationMessages() runs for that conversation. loadMessages() /
// loadOlderMessages() capture the generation at call time and drop their
// write-back if the counter moved before the request resolved — otherwise an
// in-flight load that resolves AFTER eviction silently re-creates the
// conversation entry, undoing the eviction (mirrors the requestId guard in
// MailMessageRenderer's blob-url fix).
const _conversationEpoch: Record<string, number> = {}

function currentConversationEpoch(conversationId: string): number {
  return _conversationEpoch[conversationId] ?? 0
}

// First-paint page: tiny (newest 3) so a big conversation shows readable
// content within a few hundred ms; the standard page (server default 20)
// follows immediately and is authoritative.
const FIRST_PAINT_LIMIT = 3

interface ConversationPayload {
  conversation: Conversation
  messages: MailMessage[]
  discussionMarkers?: DiscussionMarker[]
  nextMessageCursor: string | null
}

// In-flight full loads keyed by conversationId — a mount kickoff racing a
// resync refetch costs one two-stage load, not two.
const _inFlightLoads: Record<string, Promise<void>> = {}
// The abort handle of each in-flight load, so a restart can end it (S26).
const _inFlightAborts: Record<string, AbortController> = {}

/**
 * `restart`: a resync after a network blip (S26). A load in flight may have
 * been swallowed by the blip, so joining it could show nothing of the gap: it
 * is aborted (it settles quietly, its write-back dropped) and a new one starts.
 */
/**
 * The stored attachment ids of one loaded message, or undefined when the
 * message is not loaded. A forward's approval re-attaches exactly these.
 */
export function attachmentIdsOfLoadedMessage(messageId: string): string[] | undefined {
  for (const conversationId of Object.keys(messages)) {
    const message = messages[conversationId]?.byId[messageId]
    if (message) return (message.attachments ?? []).map((attachment) => attachment.id)
  }
  return undefined
}

export function loadMessages(
  api: MailApi,
  conversationId: string,
  opts: { restart?: boolean } = {},
): Promise<void> {
  if (opts.restart && conversationId in _inFlightLoads) {
    _inFlightAborts[conversationId]?.abort()
    delete _inFlightAborts[conversationId]
    delete _inFlightLoads[conversationId]
  }
  const existing = _inFlightLoads[conversationId]
  if (existing) return existing
  const controller = new AbortController()
  const p = loadTwoStage(api, conversationId, controller.signal).finally(() => {
    if (_inFlightLoads[conversationId] === p) {
      delete _inFlightLoads[conversationId]
      delete _inFlightAborts[conversationId]
    }
  })
  _inFlightLoads[conversationId] = p
  _inFlightAborts[conversationId] = controller
  return p
}

// One follow-up load per conversation, queued behind an in-flight one.
const _queuedReloads: Record<string, Promise<void>> = {}

/**
 * Re-read a conversation because something new is known to be stored (a
 * realtime message event). A load already in flight was requested before that
 * news and may have been answered without it, so joining it, as `loadMessages`
 * does, could leave the new message an empty stub: one more load runs after
 * it, shared by every event that arrives meanwhile. A conversation evicted in
 * the meantime is not brought back.
 */
export function reloadMessages(api: MailApi, conversationId: string): Promise<void> {
  const inFlight = _inFlightLoads[conversationId]
  if (!inFlight) return loadMessages(api, conversationId)
  const queued = _queuedReloads[conversationId]
  if (queued) return queued
  const next = inFlight
    .catch(() => {})
    .then(() => {
      delete _queuedReloads[conversationId]
      if (!messages[conversationId]) return
      return loadMessages(api, conversationId)
    })
  _queuedReloads[conversationId] = next
  return next
}

/**
 * Progressive two-stage load, mirroring tickets' ticket-message-store: both
 * fetches fire in parallel; the small page (`messageLimit=3`) commits first so
 * the newest exchange (and the conversation header, carried on the same
 * payload) paints ASAP; the standard page then re-commits authoritatively and
 * owns the pagination cursor. Races: the full page landing first skips the
 * small commit; a reload of an already-populated conversation skips the small
 * commit (never shrink a loaded thread to 3 rows); locally-present messages
 * not in the committed page (WS arrivals) are preserved. Throws only when
 * BOTH stages failed — the caller's error state is for "nothing to show".
 */
async function loadTwoStage(
  api: MailApi,
  conversationId: string,
  signal: AbortSignal,
): Promise<void> {
  _mailMsgApi = api
  const epoch = currentConversationEpoch(conversationId)
  let fullCommitted = false

  const applyPage = (data: ConversationPayload, stage: "first" | "full"): void => {
    if (currentConversationEpoch(conversationId) !== epoch) return // evicted mid-flight — drop the write-back
    if (signal.aborted) return // restarted: the load that replaced this one owns it
    if (stage === "first" && (fullCommitted || messages[conversationId])) return

    if (data.conversation) upsertConversation(data.conversation)

    const msgList: MailMessage[] = data.messages ?? []
    const byId: Record<string, MailMessage> = {}
    const ids: string[] = []
    for (const raw of msgList) {
      const m = markEncState(raw)
      byId[m.id] = m
      ids.push(m.id)
    }
    // Preserve rows the page doesn't cover (WS arrivals racing the fetch;
    // display order is timestamp-sorted downstream, so position here is free).
    const prev = messages[conversationId]
    if (prev) {
      for (const id of prev.ids) {
        if (byId[id]) continue
        const m = prev.byId[id]
        if (!m) continue
        byId[id] = m
        ids.push(id)
      }
    }

    setMessages(conversationId, {
      ids,
      byId,
      discussionMarkers: data.discussionMarkers ?? [],
      hasMore: !!data.nextMessageCursor,
      cursor: data.nextMessageCursor ?? null,
    })
  }

  let firstErr: unknown
  let fullErr: unknown
  const firstOk = api
    .get<ConversationPayload>(
      `/mail/conversations/${conversationId}?messageLimit=${FIRST_PAINT_LIMIT}`,
      { signal },
    )
    .then((data) => {
      applyPage(data, "first")
      return true
    })
    .catch((err) => {
      firstErr = err
      return false
    })
  const fullOk = api
    .get<ConversationPayload>(`/mail/conversations/${conversationId}`, { signal })
    .then((data) => {
      fullCommitted = true
      applyPage(data, "full")
      return true
    })
    .catch((err) => {
      fullErr = err
      return false
    })

  const [a, b] = await Promise.all([firstOk, fullOk])
  // Restarted: ends quietly, the new load reports for the conversation.
  if (signal.aborted) return
  // Only surface a failure when BOTH stages failed (nothing to show). The
  // authoritative page's error is the more representative one.
  if (!a && !b) throw fullErr ?? firstErr ?? new Error("Failed to load conversation")
  await hydrateSealedMessages(conversationId, epoch)
}

/**
 * Point every `cid:` reference at the attachment's inline route, the same
 * rewrite the server does for a body it can read.
 *
 * Only `inline` attachments with a content id take part, exactly as on the
 * server: Gmail stamps a Content-ID on ordinary attachments too, and rewriting
 * those would turn a downloadable file into an image nobody asked for.
 */
export function rewriteInlineCids(
  html: string,
  attachments: readonly MailMessageAttachment[] | undefined,
): string {
  if (!html || !attachments || attachments.length === 0) return html
  let out = html
  for (const attachment of attachments) {
    if (attachment.disposition !== "inline" || !attachment.contentId) continue
    const escaped = attachment.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Built on the server's base: under the desktop shell a relative path
    // would ask the page's own origin for the image.
    out = out.replace(new RegExp(`cid:${escaped}`, "gi"), apiUrl(`/files/${attachment.id}/inline`))
  }
  return out
}

/**
 * Ask the crypto worker to open every sealed row of one conversation and write
 * the plaintext into the same string fields the renderers already read, so
 * MailConversation and MailMessageRenderer need no change.
 *
 * A locked mailbox is not a failure here: the row is marked `locked` and the
 * surface renders a lock placeholder. Nothing is logged, because the only thing
 * there would be to log is mail.
 */
async function hydrateSealedMessages(conversationId: string, epoch: number): Promise<void> {
  const entry = messages[conversationId]
  if (!entry) return
  const pending = entry.ids
    .map((id) => entry.byId[id])
    .filter((message): message is MailMessage => !!message && message.encState === "sealed")
  if (pending.length === 0) return

  for (const message of pending) {
    const opened = await openSealedMessage(sealedPayload(message))
    if (currentConversationEpoch(conversationId) !== epoch) return
    setMessages(
      produce((s) => {
        const current = s[conversationId]?.byId[message.id]
        if (!current) return
        if (!opened) {
          current.encState = "locked"
          return
        }
        current.subject = opened.subject ?? ""
        current.textBody = opened.textBody ?? ""
        // The server rewrites `cid:` references while it assembles the
        // conversation, but it can only do that for a body it can read, and a
        // sealed row's `html_body` is NULL. So the rewrite happens here, on the
        // decrypted body, or every embedded image renders broken.
        current.htmlBody = rewriteInlineCids(opened.htmlBody ?? "", current.attachments)
        current.encState = "opened"
      }),
    )
  }
}

// --- Resync subscription ---
// On a resync bump, refetch every conversation whose messages are loaded, in
// place (setMessages swaps atomically per conversation — no wipe). Idempotent.
let _mailMsgResyncSubscribed = false

export function subscribeMailMessageResync(): void {
  if (_mailMsgResyncSubscribed) return
  _mailMsgResyncSubscribed = true
  subscribeResync(() => {
    const api = _mailMsgApi
    if (!api) return
    // Every loaded conversation, and every one whose load is still in
    // flight: a conversation opened just before the blip has no messages yet,
    // and its load may never answer (S26).
    const ids = new Set([...Object.keys(messages), ...Object.keys(_inFlightLoads)])
    for (const conversationId of ids) {
      // A conversation that stopped being readable since it was loaded (a
      // mailbox unshared, a thread merged away) must not reject into the void:
      // the open tab shows its own error on its next load.
      void loadMessages(api, conversationId, { restart: true }).catch(() => {})
    }
  })
}

/**
 * Drop a conversation's per-entity messages — called when the last open tab
 * for that conversation closes (tab-store's onTabClosed wiring). The
 * conversation LIST (mail-conversation-store) is a separate record and is
 * never touched here.
 */
export function evictConversationMessages(conversationId: string): void {
  _conversationEpoch[conversationId] = currentConversationEpoch(conversationId) + 1
  setMessages(
    produce((s) => {
      delete s[conversationId]
    }),
  )
}

export async function loadOlderMessages(api: MailApi, conversationId: string): Promise<void> {
  const conv = messages[conversationId]
  if (!conv?.hasMore || !conv.cursor) return

  const epoch = currentConversationEpoch(conversationId)
  const data = await api.get<{
    messages: MailMessage[]
    nextMessageCursor: string | null
  }>(`/mail/conversations/${conversationId}?messageCursor=${conv.cursor}`)
  if (currentConversationEpoch(conversationId) !== epoch) return // evicted mid-flight — drop the write-back
  const older: MailMessage[] = data.messages ?? []

  setMessages(
    produce((s) => {
      const entry = s[conversationId]
      if (!entry) return
      for (const raw of older) {
        const m = markEncState(raw)
        if (!entry.byId[m.id]) {
          entry.byId[m.id] = m
          entry.ids.unshift(m.id)
        }
      }
      entry.hasMore = !!data.nextMessageCursor
      entry.cursor = data.nextMessageCursor ?? null
    }),
  )
  await hydrateSealedMessages(conversationId, epoch)
}

export function handleMessageEvent(action: string, data: any): void {
  if (action === "create" && data.conversationId) {
    let inserted = false
    setMessages(
      produce((s) => {
        const entry = s[data.conversationId]
        if (!entry) return
        if (entry.byId[data.id]) return // dedupe
        entry.byId[data.id] = {
          ...data,
          fromAddress: data.fromAddress ?? data.from ?? {},
          toAddresses: data.toAddresses ?? [],
          ccAddresses: data.ccAddresses ?? [],
          bccAddresses: data.bccAddresses ?? [],
          sentAt: data.sentAt ?? new Date().toISOString(),
          labels: data.labels ?? [],
        }
        entry.ids.push(data.id)
        inserted = true
      }),
    )
    // The WS event payload is a privacy-safe stub (id/direction/from only —
    // message bodies never ride the org-wide broadcast), so the inserted row
    // renders "(No content)". Refetch the conversation under the caller's own
    // credentials so the full message replaces the stub without a reload.
    if (inserted && _mailMsgApi) {
      void reloadMessages(_mailMsgApi, data.conversationId).catch(() => {})
    }
  }
}

/**
 * WS approval_request create/update for a gated mail:reply/forward — tell any
 * mounted MailConversation for that conversation to re-fetch its pending
 * approvals (`/approvals?conversationId=...`) so the inline gate card appears
 * and disappears in real time. Mirrors tickets' `tickets:approvals-invalidated`.
 */
export function handleMailApprovalWs(row: any): void {
  if (!row || (row.toolName !== "mail:reply" && row.toolName !== "mail:forward")) return
  const payload = row.currentPayload ?? {}
  const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : null
  if (!conversationId || typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent("mail:approvals-invalidated", { detail: { conversationId } }),
  )
}

export function resetMailMessageStore(): void {
  for (const key of Object.keys(_inFlightLoads)) delete _inFlightLoads[key]
  for (const key of Object.keys(_inFlightAborts)) {
    _inFlightAborts[key]?.abort()
    delete _inFlightAborts[key]
  }
  for (const key of Object.keys(_queuedReloads)) delete _queuedReloads[key]
  // A store setter MERGES a plain object, so `setMessages({})` emptied nothing:
  // every conversation stayed loaded across logout and mailbox reset. Delete
  // each key instead.
  setMessages(
    produce((draft) => {
      for (const key of Object.keys(draft)) delete draft[key]
    }),
  )
}

onSessionTeardown(resetMailMessageStore)
