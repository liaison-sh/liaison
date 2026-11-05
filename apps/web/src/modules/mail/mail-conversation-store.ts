// SPDX-License-Identifier: FSL-1.1-ALv2
import { createMemo, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { userFromToken } from "~/modules/auth/auth-store"
import { allAccounts, getAccount } from "~/modules/mail/mail-account-store"
import {
  type MailCategory,
  mailCategoryFor,
  mailCategoryScope,
  matchesMailCategory,
} from "~/modules/mail/mail-category"
import { canOpenSealedRow, isSealedRow, openSealedRow } from "~/modules/mailbox/sealed-row"
import { liveSearchIndexAdapter } from "~/modules/mailbox/search-index/search-index-host"
import { invalidatePreview } from "~/modules/shell/entity-preview/entity-preview-store"

interface MailApi {
  getEnvelope?: <T = unknown>(path: string) => Promise<{ data: T; meta?: Record<string, unknown> }>
  patch?: <T = unknown>(path: string, body?: unknown) => Promise<T>
  post?: <T = unknown>(path: string, body?: unknown) => Promise<T>
}

export type ViewType =
  | "inbox"
  | "inbox:personal"
  | `inbox:${string}`
  | "assigned-to-me"
  | "starred"
  | "sent"
  | "drafts"
  | "trash"

export interface Conversation {
  id: string
  accountId: string
  subject: string
  snippet: string
  isRead: boolean
  isStarred: boolean
  status: string
  lastMessageAt: string
  messageCount: number
  assignedTo: string | null
  contactId: string | null
  internalThreadId: string | null
  labels: string[]
  senderName: string | null
  senderEmail: string | null
  escalatedTicketId: string | null
  escalatedTicketHandle: string | null
  escalatedTicketStatus: string | null
  /**
   * The server holds this conversation's subject and snippet as ciphertext
   * only (`encVersion > 0`). The list cannot open it, so an empty `subject`
   * here means "sealed", never "no subject".
   */
  sealed?: boolean
  /**
   * Where a sealed row's subject and snippet stand in THIS browser:
   * `sealed` not yet tried, `locked` the mailbox is locked, `opened` the
   * plaintext is in `subject` / `snippet`. Absent for a plaintext row.
   */
  encState?: "sealed" | "locked" | "opened"
  /** The sealed half as the list projects it (base64). Only on a sealed row. */
  encKeyId?: number | null
  encVersion?: number | null
  contentKeyWrapped?: string | null
  contentKeyEpk?: string | null
  subjectCiphertext?: string | null
  snippetCiphertext?: string | null
  snippetSourceMessageId?: string | null
}

interface ConversationStoreState {
  byId: Record<string, Conversation>
  ids: string[]
  /**
   * Rows the search box found beyond the loaded pages. Their rows live in
   * `byId` like any other, but they stay out of `ids` so the paginated order
   * and cursor are untouched.
   */
  searchIds: string[]
}

const [currentView, setCurrentView] = createSignal<ViewType>("inbox")
const [conversationStore, setConversationStore] = createStore<ConversationStoreState>({
  byId: {},
  ids: [],
  searchIds: [],
})
const [loading, setLoading] = createSignal(false)
const [deepSearching, setDeepSearching] = createSignal(false)
const [loadingMore, setLoadingMore] = createSignal(false)
const [hasMore, setHasMore] = createSignal(false)
const assignedToMeCount = createMemo(() => {
  const userId = userFromToken()?.userId
  if (!userId) return 0
  return Object.values(conversationStore.byId).filter(
    (conversation) => conversation.assignedTo === userId && !conversation.isRead,
  ).length
})
let cursor: string | null = null
let activeLoadRequestId = 0
let activeSearchId = 0

export {
  assignedToMeCount,
  conversationStore,
  currentView,
  deepSearching,
  hasMore,
  loading,
  loadingMore,
}

export function setView(view: ViewType): void {
  if (currentView() === view) return
  setCurrentView(view)
  activeSearchId++
  setDeepSearching(false)
  setConversationStore({ byId: {}, ids: [], searchIds: [] })
  cursor = null
  setHasMore(false)
}

export function upsertConversation(conversation: Conversation): void {
  setConversationStore(
    produce((state) => {
      state.byId[conversation.id] = conversation
      if (!state.ids.includes(conversation.id) && matchesCurrentView(conversation)) {
        state.ids.unshift(conversation.id)
      }
    }),
  )
}

interface ConversationLoadOptions {
  currentUserId?: string | null
}

function effectiveCurrentUserId(opts?: ConversationLoadOptions): string | null | undefined {
  return opts?.currentUserId ?? userFromToken()?.userId
}

/** The Primary / Other choice of the view, when its mailbox is Gmail. */
function viewCategory(view: ViewType): MailCategory | undefined {
  const accounts = allAccounts()
  return mailCategoryFor(mailCategoryScope(view, accounts), accounts)
}

function viewToQueryParams(view: ViewType, opts?: ConversationLoadOptions): Record<string, string> {
  if (view === "inbox") return { status: "open" }
  const category = viewCategory(view)
  // `all` does not narrow: the query says nothing, as for a non-Gmail mailbox.
  const withCategory = (params: Record<string, string>) =>
    category && category !== "all" ? { ...params, category } : params
  if (view === "inbox:personal") return withCategory({ status: "open", ownership: "personal" })
  if (view.startsWith("inbox:")) return withCategory({ status: "open", accountId: view.slice(6) })
  if (view === "assigned-to-me") {
    const currentUserId = effectiveCurrentUserId(opts)
    if (!currentUserId) throw new Error("currentUserId required for assigned-to-me view")
    return { assignedTo: currentUserId, status: "open" }
  }
  if (view === "starred") return { isStarred: "true" }
  if (view === "sent") return {}
  if (view === "trash") return { status: "trashed" }
  return {}
}

function matchesCurrentView(conversation: Conversation): boolean {
  const view = currentView()
  if (view === "inbox") return conversation.status === "open"
  if (view === "inbox:personal")
    return (
      conversation.status === "open" &&
      getAccount(conversation.accountId)?.ownerType === "user" &&
      matchesMailCategory(conversation.labels, viewCategory(view))
    )
  if (view === "assigned-to-me") {
    const currentUserId = effectiveCurrentUserId()
    return (
      conversation.status === "open" && !!currentUserId && conversation.assignedTo === currentUserId
    )
  }
  if (view.startsWith("inbox:"))
    return (
      conversation.status === "open" &&
      conversation.accountId === view.slice(6) &&
      matchesMailCategory(conversation.labels, viewCategory(view))
    )
  if (view === "starred") return conversation.isStarred
  if (view === "sent") return conversation.labels.includes("SENT")
  if (view === "trash") return conversation.status === "trashed"
  return false
}

function normalizeConversation(data: Partial<Conversation> & { id: string }): Conversation {
  const sealed = isSealedRow(data)
  return {
    ...data,
    id: data.id,
    accountId: data.accountId ?? "",
    // A sealed row's plaintext columns are NULL on the server: empty here, and
    // `sealed` says why, so it never reads as "no subject".
    subject: data.subject ?? "",
    snippet: data.snippet ?? "",
    isRead: data.isRead ?? false,
    isStarred: data.isStarred ?? false,
    status: data.status ?? "open",
    lastMessageAt: data.lastMessageAt ?? new Date().toISOString(),
    messageCount: data.messageCount ?? 0,
    assignedTo: data.assignedTo ?? null,
    contactId: data.contactId ?? null,
    internalThreadId: data.internalThreadId ?? null,
    labels: data.labels ?? [],
    senderName: data.senderName ?? null,
    senderEmail: data.senderEmail ?? null,
    escalatedTicketId: data.escalatedTicketId ?? null,
    escalatedTicketHandle: data.escalatedTicketHandle ?? null,
    escalatedTicketStatus: data.escalatedTicketStatus ?? null,
    sealed,
    encState: sealed ? (data.encState ?? "sealed") : undefined,
  }
}

function canOpen(conversation: Conversation): boolean {
  return conversation.encState !== "opened" && canOpenSealedRow(conversation)
}

/**
 * Ask the crypto worker to open every sealed row the list holds, writing the
 * plaintext into `subject` / `snippet` so the rows render unchanged. A locked
 * mailbox marks the row `locked`; the unlock bumps the resync bus, which
 * reloads this list and brings it back here.
 */
async function openSealedRows(ids: readonly string[], requestId: number): Promise<void> {
  for (const id of ids) {
    const row = conversationStore.byId[id]
    if (!row?.sealed || !canOpen(row)) continue
    const opened = await openSealedRow(row)
    if (requestId !== activeLoadRequestId) return
    setConversationStore(
      produce((state) => {
        const current = state.byId[id]
        if (!current) return
        if (!opened) {
          current.encState = "locked"
          return
        }
        current.subject = opened.subject ?? ""
        current.snippet = opened.snippet ?? ""
        current.encState = "opened"
      }),
    )
  }
}

// Last API client + load options seen — captured so the resync subscription
// refetches the CURRENT conversation-list query without a component context.
let _mailListApi: MailApi | null = null
let _mailListOpts: ConversationLoadOptions | undefined

export async function loadConversations(
  api: MailApi,
  opts?: ConversationLoadOptions,
): Promise<void> {
  _mailListApi = api
  _mailListOpts = opts
  if (currentView() === "drafts") return

  const requestId = ++activeLoadRequestId
  const view = currentView()

  setLoading(true)
  try {
    const params = new URLSearchParams(viewToQueryParams(view, opts))
    params.set("limit", "25")

    const res = await api.getEnvelope!<Conversation[]>(`/mail/conversations?${params.toString()}`)
    if (requestId !== activeLoadRequestId || currentView() !== view) return

    const data = res.data ?? []
    cursor = (res.meta?.nextCursor as string | null | undefined) ?? null
    setHasMore(!!cursor)

    const byId: Record<string, Conversation> = {}
    const ids: string[] = []
    for (const c of data) {
      byId[c.id] = normalizeConversation(c)
      ids.push(c.id)
    }
    // A reload while a search is showing keeps the rows it found.
    for (const id of conversationStore.searchIds) {
      const row = conversationStore.byId[id]
      if (row && !byId[id]) byId[id] = row
    }
    setConversationStore({ byId, ids })
    void openSealedRows(ids, requestId)
  } finally {
    setLoading(false)
  }
}

// --- Resync subscription ---
// On a resync bump, refetch the CURRENT conversation-list query in place
// (loadConversations builds a shadow byId/ids and swaps atomically — no wipe).
// Idempotent.
let _mailListResyncSubscribed = false

export function subscribeMailResync(): void {
  if (_mailListResyncSubscribed) return
  _mailListResyncSubscribed = true
  subscribeResync(() => {
    const api = _mailListApi
    if (api) void loadConversations(api, _mailListOpts)
  })
}

export async function loadMoreConversations(
  api: MailApi,
  opts?: ConversationLoadOptions,
): Promise<void> {
  if (!cursor || loadingMore()) return
  setLoadingMore(true)
  try {
    const params = new URLSearchParams(viewToQueryParams(currentView(), opts))
    params.set("limit", "25")
    params.set("cursor", cursor)

    const res = await api.getEnvelope!<Conversation[]>(`/mail/conversations?${params.toString()}`)
    const data = res.data ?? []
    cursor = (res.meta?.nextCursor as string | null | undefined) ?? null
    setHasMore(!!cursor)

    setConversationStore(
      produce((s) => {
        for (const c of data) {
          s.byId[c.id] = normalizeConversation(c)
          if (!s.ids.includes(c.id)) s.ids.push(c.id)
        }
      }),
    )
    void openSealedRows(
      data.map((c) => c.id),
      activeLoadRequestId,
    )
  } finally {
    setLoadingMore(false)
  }
}

// --- Search beyond the loaded pages ---
// The search box filters the rows the list has loaded. While more pages exist,
// the same query also runs over the whole view on the server. The search TEXT
// only goes to the server for mailboxes it can already read. A private mailbox
// is searched by this browser's own index, and only the MESSAGE IDS it matched
// are sent; with no index in this tab, its part is not searched at all (the
// search index banner says the answer is incomplete).
const DEEP_SEARCH_LIMIT = 50

/** The server holds only ciphertext for these: never send it their search text. */
function isPrivateAccount(accountId: string): boolean {
  const state = getAccount(accountId)?.encryptionState
  return !(state == null || state === "none" || state === "managed")
}

function viewAccountIds(view: ViewType, userId: string | null | undefined): string[] {
  const accounts = allAccounts()
  if (view === "inbox:personal")
    return accounts.filter((a) => a.ownerType === "user" && a.ownerId === userId).map((a) => a.id)
  if (view.startsWith("inbox:")) return [view.slice(6)]
  return accounts.map((a) => a.id)
}

/** The view's list filters, as the search route's JSON body takes them. */
function viewSearchFilters(
  view: ViewType,
  opts?: ConversationLoadOptions,
): Record<string, unknown> {
  const { accountId: _accountId, isStarred, isRead, ...rest } = viewToQueryParams(view, opts)
  return {
    ...rest,
    ...(isStarred !== undefined ? { isStarred: isStarred === "true" } : {}),
    ...(isRead !== undefined ? { isRead: isRead === "true" } : {}),
  }
}

export function clearDeepSearch(): void {
  activeSearchId++
  setDeepSearching(false)
  if (conversationStore.searchIds.length > 0) setConversationStore("searchIds", [])
}

export async function searchAllConversations(
  api: MailApi,
  query: string,
  opts?: ConversationLoadOptions,
): Promise<void> {
  const text = query.trim()
  const view = currentView()
  if (!api.post || !text || view === "drafts") return
  const searchId = ++activeSearchId
  const stale = () => searchId !== activeSearchId || currentView() !== view
  setDeepSearching(true)
  try {
    const accountIds = viewAccountIds(view, effectiveCurrentUserId(opts))
    const readable = accountIds.filter((id) => !isPrivateAccount(id))
    const sealed = accountIds.filter(isPrivateAccount)
    const filters = { ...viewSearchFilters(view, opts), limit: DEEP_SEARCH_LIMIT }
    const post = api.post
    const request = (body: Record<string, unknown>) =>
      post<Conversation[]>("/mail/conversations/search", { ...filters, ...body }).catch(
        () => [] as Conversation[],
      )

    const searchSealed = async (): Promise<Conversation[]> => {
      const index = liveSearchIndexAdapter()
      if (sealed.length === 0 || !index) return []
      const messageIds = await index
        .search({ text, accountIds: sealed, limit: 200 })
        .catch(() => [] as string[])
      if (messageIds.length === 0 || stale()) return []
      return request({ messageIds, accountIds: sealed })
    }
    const [plainRows, sealedRows] = await Promise.all([
      readable.length > 0 ? request({ query: text, accountIds: readable }) : [],
      searchSealed(),
    ])
    if (stale()) return

    const rows = [...plainRows, ...sealedRows]
    setConversationStore(
      produce((s) => {
        for (const raw of rows) {
          const next = normalizeConversation(raw)
          const existing = s.byId[next.id]
          if (existing?.encState === "opened" && next.sealed && sameSeal(existing, next)) {
            next.subject = existing.subject
            next.snippet = existing.snippet
            next.encState = "opened"
          }
          s.byId[next.id] = next
        }
        s.searchIds = [...new Set(rows.map((row) => row.id))]
      }),
    )
    void openSealedRows(
      rows.map((row) => row.id),
      activeLoadRequestId,
    )
  } finally {
    if (searchId === activeSearchId) setDeepSearching(false)
  }
}

function restoreConversation(conversation: Conversation, index: number): void {
  setConversationStore(
    produce((state) => {
      state.byId[conversation.id] = conversation
      if (!state.ids.includes(conversation.id)) {
        state.ids.splice(Math.max(index, 0), 0, conversation.id)
      }
    }),
  )
}

function applyConversationUpdate(conversationId: string, nextConversation: Conversation): void {
  setConversationStore(
    produce((state) => {
      if (!matchesCurrentView(nextConversation)) {
        delete state.byId[conversationId]
        state.ids = state.ids.filter((id) => id !== conversationId)
        return
      }

      state.byId[conversationId] = nextConversation
      if (!state.ids.includes(conversationId)) {
        state.ids.unshift(conversationId)
      }
    }),
  )
}

// --- Live rows ---
// A realtime event is not a list row: a sealed mailbox's event carries only
// `{ id, accountId }` (its content must never ride a durable event), and even a
// plaintext one lacks the snippet and sender. So the rows an event names are
// fetched through the SAME list projection a reload uses and handed to the same
// `openSealedRows`: unlocked they open in place, locked they stay `locked`.
const LIVE_FETCH_DELAY_MS = 150
const LIVE_FETCH_MAX_IDS = 100
const pendingLiveIds = new Set<string>()
let liveFetchTimer: ReturnType<typeof setTimeout> | null = null

function queueLiveFetch(id: string): void {
  if (!_mailListApi?.getEnvelope || currentView() === "drafts") return
  pendingLiveIds.add(id)
  if (liveFetchTimer) return
  liveFetchTimer = setTimeout(() => {
    liveFetchTimer = null
    void flushLiveFetch()
  }, LIVE_FETCH_DELAY_MS)
}

/** The same sealed fields: an opened row keeps its plaintext instead of flickering. */
function sameSeal(a: Conversation, b: Conversation): boolean {
  return (
    a.contentKeyWrapped === b.contentKeyWrapped &&
    a.subjectCiphertext === b.subjectCiphertext &&
    a.snippetCiphertext === b.snippetCiphertext
  )
}

async function flushLiveFetch(): Promise<void> {
  const api = _mailListApi
  if (!api?.getEnvelope || pendingLiveIds.size === 0) return
  const ids = [...pendingLiveIds].slice(0, LIVE_FETCH_MAX_IDS)
  for (const id of ids) pendingLiveIds.delete(id)
  if (pendingLiveIds.size > 0) {
    liveFetchTimer = setTimeout(() => {
      liveFetchTimer = null
      void flushLiveFetch()
    }, 0)
  }

  const view = currentView()
  if (view === "drafts") return
  const requestId = activeLoadRequestId
  const params = new URLSearchParams(viewToQueryParams(view, _mailListOpts))
  params.set("ids", ids.join(","))
  params.set("limit", String(ids.length))
  let data: Conversation[]
  try {
    const res = await api.getEnvelope<Conversation[]>(`/mail/conversations?${params.toString()}`)
    data = res.data ?? []
  } catch {
    return
  }
  // A reload that started meanwhile already carries these rows.
  if (requestId !== activeLoadRequestId || currentView() !== view) return

  setConversationStore(
    produce((s) => {
      for (const raw of data) {
        const next = normalizeConversation(raw)
        const existing = s.byId[next.id]
        if (existing?.encState === "opened" && next.sealed && sameSeal(existing, next)) {
          next.subject = existing.subject
          next.snippet = existing.snippet
          next.encState = "opened"
        }
        s.byId[next.id] = next
        if (!s.ids.includes(next.id)) s.ids.unshift(next.id)
      }
    }),
  )
  void openSealedRows(
    data.map((c) => c.id),
    requestId,
  )
}

export function handleConversationEvent(action: string, data: any): void {
  if ((action === "update" || action === "delete") && data?.id) {
    invalidatePreview("mail", "conversation", data.id)
  }

  if (action === "create") {
    if (!data?.id) return
    // Only a payload that carries the subject can stand in until the row
    // arrives; a sealed one would render as an empty, unsealed row. Under a
    // Primary / Other view it must carry its labels too, or a newsletter would
    // stand in Primary until the next reload: the fetch below filters it.
    const categoryUnknown = !!viewCategory(currentView()) && !Array.isArray(data.labels)
    if (typeof data.subject === "string" && !categoryUnknown) {
      const conversation = normalizeConversation(data)
      if (matchesCurrentView(conversation)) {
        setConversationStore(
          produce((s) => {
            if (s.byId[conversation.id]) return
            s.byId[conversation.id] = conversation
            s.ids.unshift(conversation.id)
          }),
        )
      }
    }
    queueLiveFetch(data.id)
  } else if (action === "update" || action === "converted") {
    const updatedId = data?.id ?? data?.conversationId
    // A new message re-seals the row's subject and snippet, and the event
    // cannot carry them: refetch the row so it opens again.
    if (action === "update" && updatedId && conversationStore.byId[updatedId]?.sealed) {
      queueLiveFetch(updatedId)
    }
    setConversationStore(
      produce((s) => {
        const conversationId = data.id ?? data.conversationId
        const existing = s.byId[conversationId]
        if (!existing) return
        const next = {
          ...existing,
          ...data,
          id: conversationId,
          status: data.status ?? existing.status,
        }
        if (action === "converted") {
          next.status = "escalated"
          next.escalatedTicketStatus = data.escalatedTicketStatus ?? "open"
        }
        if (!matchesCurrentView(next)) {
          if (action !== "converted") delete s.byId[conversationId]
          s.ids = s.ids.filter((id) => id !== conversationId)
          if (action === "converted") s.byId[conversationId] = next
          return
        }
        s.byId[conversationId] = next
        // A new message (sent or received) moves its conversation to the top,
        // where a reload would put it: the list reads newest activity first.
        const before = Date.parse(existing.lastMessageAt ?? "")
        const after = Date.parse(typeof data.lastMessageAt === "string" ? data.lastMessageAt : "")
        if (Number.isFinite(after) && (!Number.isFinite(before) || after > before)) {
          s.ids = [conversationId, ...s.ids.filter((id) => id !== conversationId)]
        }
      }),
    )
  } else if (action === "delete") {
    setConversationStore(
      produce((s) => {
        delete s.byId[data.id]
        s.ids = s.ids.filter((id) => id !== data.id)
      }),
    )
  }
}

export async function toggleStar(api: MailApi, conversationId: string): Promise<void> {
  const conv = conversationStore.byId[conversationId]
  if (!conv) return
  const was = conv.isStarred
  applyConversationUpdate(conversationId, { ...conv, isStarred: !was })
  try {
    await api.patch!(`/mail/conversations/${conversationId}`, { isStarred: !was })
  } catch {
    applyConversationUpdate(conversationId, conv)
  }
}

export async function toggleRead(api: MailApi, conversationId: string): Promise<void> {
  const conv = conversationStore.byId[conversationId]
  if (!conv) return
  const was = conv.isRead
  applyConversationUpdate(conversationId, { ...conv, isRead: !was })
  try {
    await api.patch!(`/mail/conversations/${conversationId}`, { isRead: !was })
  } catch {
    applyConversationUpdate(conversationId, conv)
  }
}

export async function claimConversation(
  api: MailApi,
  conversationId: string,
  userId: string,
): Promise<void> {
  await reassignConversation(api, conversationId, userId)
}

export async function reassignConversation(
  api: MailApi,
  conversationId: string,
  userId: string | null,
): Promise<void> {
  await api.patch!(`/mail/conversations/${conversationId}`, { assignedTo: userId })
  setConversationStore(
    produce((state) => {
      const conversation = state.byId[conversationId]
      if (!conversation) return
      const next = { ...conversation, assignedTo: userId }
      if (!matchesCurrentView(next)) {
        // Conversation no longer belongs in this view (e.g. reassigned away from
        // the current user while in the assigned-to-me view) — remove it.
        delete state.byId[conversationId]
        state.ids = state.ids.filter((id) => id !== conversationId)
      } else {
        conversation.assignedTo = userId
      }
    }),
  )
}

export async function unassignConversation(api: MailApi, conversationId: string): Promise<void> {
  await reassignConversation(api, conversationId, null)
}

export async function archiveConversation(api: MailApi, conversationId: string): Promise<void> {
  const conversation = conversationStore.byId[conversationId]
  if (!conversation) return

  const previous = { ...conversation }
  const previousIndex = conversationStore.ids.indexOf(conversationId)
  applyConversationUpdate(conversationId, { ...conversation, status: "archived" })

  try {
    await api.patch!(`/mail/conversations/${conversationId}`, { status: "archived" })
  } catch {
    restoreConversation(previous, previousIndex)
  }
}

export function resetMailConversationStore(): void {
  setCurrentView("inbox")
  activeSearchId++
  setDeepSearching(false)
  setConversationStore({ byId: {}, ids: [], searchIds: [] })
  cursor = null
  setLoading(false)
  setLoadingMore(false)
  setHasMore(false)
  activeLoadRequestId = 0
  pendingLiveIds.clear()
  if (liveFetchTimer) clearTimeout(liveFetchTimer)
  liveFetchTimer = null
}

onSessionTeardown(resetMailConversationStore)
