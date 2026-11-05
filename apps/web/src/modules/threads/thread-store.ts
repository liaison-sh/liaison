// SPDX-License-Identifier: FSL-1.1-ALv2

import { isChatListThreadType, isStatusLine } from "@liaison/shared"
import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import { rememberAgentAvatarColor } from "~/lib/agent-avatar-colors"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { tNow } from "~/modules/i18n/i18n-context"
import { close as closeDockTab } from "~/modules/shell/dock-store"
import { localizeAgentName } from "~/modules/threads/agent-name"
import {
  getTypingAgents,
  handleAgentTypingStart,
  handleAgentTypingStop,
} from "~/modules/threads/presence-store"

export interface ThreadParticipant {
  id: string
  name: string
  avatarUrl: string | null
  /** Whether this seat is a human member or an agent member. Rows predating
   *  the agent-membership schema carry no field: they are humans. */
  participantType: "user" | "agent"
  /** The `kernel.agents` id for an agent seat, null for a human one. */
  agentId: string | null
  /** An agent seat's `role` ("guest" for a one-turn seat); absent for a person. */
  role?: string
  /** An agent seat's origin ("mention" when an @mention seated it, D23a). */
  seatOrigin?: string | null
}

/** Normalize one participant row from the API or a websocket frame. The read
 *  side may not carry the agent fields yet, so absence means a human seat. */
export function normalizeParticipant(p: any): ThreadParticipant {
  const participantType = p?.participantType === "agent" ? "agent" : "user"
  // An agent seat carries the agent's colour slot, also for an agent the
  // directory does not list (a colleague's personal agent in the room).
  if (participantType === "agent") rememberAgentAvatarColor(p?.agentId ?? p?.id, p?.avatarColor)
  return {
    id: p?.id,
    name: p?.name,
    avatarUrl: p?.avatarUrl ?? null,
    participantType,
    agentId: participantType === "agent" ? (p?.agentId ?? null) : null,
    ...(participantType === "agent" && p?.role != null ? { role: p.role } : {}),
    ...(participantType === "agent" && p?.seatOrigin != null ? { seatOrigin: p.seatOrigin } : {}),
  }
}

interface ThreadLastMessage {
  content: string | null
  authorId: string
  /** For an agent reply, the AGENT's name (the server labels it as the thread view does);
   *  `authorId` stays the requester, which is why the name is never derived from it. */
  authorName: string
  authorType?: string
  /** Carries `agentNotice` when the runtime wrote this message for a failed turn. */
  metadata?: Record<string, unknown> | null
  createdAt: string
}

/** `kernel.threads.type`. Only `thread` and `agent_chat` are rooms the chat
 *  lists show (`belongsInChatList`); the others reach a view by id only. */
export type ThreadType = "thread" | "agent_chat" | "approval" | "routine" | "subrun"

export interface ThreadCreatedFrom {
  app: string
  entityType: string
  entityId: string
}

export interface Thread {
  id: string
  handle: string
  title: string | null
  type: ThreadType
  createdFrom: ThreadCreatedFrom | null
  isPinned: boolean
  isPinnedByUser: boolean
  isMuted: boolean
  /** The reader's opt-in to be interrupted by every post of this channel. */
  notifyAllPosts?: boolean
  /** True for a channel: any org member can discover and join it. */
  discoverable: boolean
  /** The Slack/Buzz pair on a channel. `topic` is the one line beside the name
   *  in the header, `description` the standing few sentences in the channel
   *  details. Null, never "", when the channel has set none: the header renders
   *  the line only when there is one. A DM carries neither. */
  topic: string | null
  description: string | null
  createdBy?: string
  participants: ThreadParticipant[]
  lastMessage: ThreadLastMessage | null
  unreadCount: number
  updatedAt: string
  tainted?: boolean
  agentModelId?: string | null
  /**
   * The seated agent's OWN default model, which is what the composer's chip
   * resolves "Default (...)" against. Carried ONLY by the thread read model,
   * never by the listing, so an absent field means "unknown", not "none" (see
   * `addThread`). It lives on the store rather than in each view's local
   * signal because two surfaces can show the same conversation at once (the
   * dock and the main panel), and a view that has not read the detail yet must
   * not contradict one that has.
   */
  agentDefaultModelId?: string | null
  agentReasoningLevels?: Record<string, string>
  /**
   * The message the agent's fed context resumes after (P4c-T51, A50): the
   * `uptoMessageId` of the sole agent counterpart's checkpoint. Null when that
   * agent has no checkpoint, and null on any room that is not a DM with one
   * agent. Carried ONLY by the thread read model, never by the listing, so an
   * absent field means "unknown", not "none" (see `addThread`).
   */
  agentContextFrom?: string | null
  /** The agent that boundary belongs to, named by the server (A50). */
  agentContextAgentId?: string | null
  agentContextAgentName?: string | null
}

interface ThreadStoreState {
  byId: Record<string, Thread>
  pinnedIds: string[]
  userPinnedIds: string[]
  unpinnedIds: string[]
}

const [threadStore, setThreadStore] = createStore<ThreadStoreState>({
  byId: {},
  pinnedIds: [],
  userPinnedIds: [],
  unpinnedIds: [],
})

export { threadStore }

// --- Public accessors (O(1) lookups) ---

export function getThread(id: string): Thread | undefined {
  return threadStore.byId[id]
}

/** Most-recent-activity first. Insertion order in the id lists can drift
 *  (WS events, pin toggles, merges), so recency is enforced at read time. */
function byRecency(a: Thread, b: Thread): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
}

export function pinnedThreads(): Thread[] {
  return threadStore.pinnedIds
    .map((id) => threadStore.byId[id])
    .filter(Boolean)
    .sort(byRecency)
}

export function userPinnedThreads(): Thread[] {
  return threadStore.userPinnedIds
    .map((id) => threadStore.byId[id])
    .filter(Boolean)
    .sort(byRecency)
}

export function unpinnedThreads(): Thread[] {
  return threadStore.unpinnedIds
    .map((id) => threadStore.byId[id])
    .filter(Boolean)
    .sort(byRecency)
}

/** All threads in display order (pinned → userPinned → unpinned) */
export function allThreads(): Thread[] {
  return [...pinnedThreads(), ...userPinnedThreads(), ...unpinnedThreads()]
}

/**
 * Aggregate unread count across all threads currently known to the store,
 * excluding muted threads (Slack semantics — muted threads never surface
 * unread state anywhere). Archived threads need NO exclusion clause here:
 * `loadThreads` fetches only `archived=false` and the archive path calls
 * `removeThread`, so an archived thread is structurally absent from `byId`
 * — there is no `isArchived` field on the client `Thread` type.
 *
 * Known limit: `loadThreads` caps at the 50 most recently active threads
 * (see its `/threads?limit=50` call), so this total can undercount for a
 * user with unread activity beyond that window. The bootstrap `message`
 * handler's unknown-threadId self-heal (`requestThreadReload`) narrows the
 * practical gap by pulling in newly-active threads as they message in, but
 * a thread that has been silently accumulating unreads outside the 50 most
 * recent for the whole session is not corrected until the next full reload.
 */
export function totalUnreadCount(): number {
  let total = 0
  for (const id in threadStore.byId) {
    const t = threadStore.byId[id]
    if (t && !t.isMuted) total += t.unreadCount
  }
  return total
}

// --- Internal helpers ---

interface MessageEventContext {
  isVisibleActiveThread?: boolean
  isOwnAction?: boolean
  /** Persists the read mark for a message the reader sees arrive in the open thread. */
  onReadWhileVisible?: (threadId: string) => void
}

function partitionIdForThread(thread: Thread): "pinnedIds" | "userPinnedIds" | "unpinnedIds" {
  if (thread.isPinned) return "pinnedIds"
  if (thread.isPinnedByUser) return "userPinnedIds"
  return "unpinnedIds"
}

function removeIdFromPartitions(s: ThreadStoreState, id: string): void {
  const pinnedIdx = s.pinnedIds.indexOf(id)
  if (pinnedIdx !== -1) s.pinnedIds.splice(pinnedIdx, 1)
  const userPinnedIdx = s.userPinnedIds.indexOf(id)
  if (userPinnedIdx !== -1) s.userPinnedIds.splice(userPinnedIdx, 1)
  const unpinnedIdx = s.unpinnedIds.indexOf(id)
  if (unpinnedIdx !== -1) s.unpinnedIds.splice(unpinnedIdx, 1)
}

function normalizeCreatedFrom(value: unknown): ThreadCreatedFrom | null {
  if (!value) return null
  if (typeof value === "string") {
    try {
      return normalizeCreatedFrom(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Partial<ThreadCreatedFrom>
  if (!candidate.app || !candidate.entityType || !candidate.entityId) return null
  return {
    app: candidate.app,
    entityType: candidate.entityType,
    entityId: candidate.entityId,
  }
}

/**
 * MAY THIS ROW BE A CHAT LIST ROW AT ALL? The store IS the Channels and Direct
 * messages lists (and every unread count read from them), and the server list
 * only ever returns chat rooms. A thread that reaches the store another way
 * (its view read the detail, a socket create, a type change) has to pass the
 * same rule, or opening a routine's run log from its routine page made that
 * log a channel in the sidebar, with an unread pill every run raised again.
 * By TYPE first (`isChatListThreadType`), so any future run log thread is out
 * without a flag; `hiddenFromList` covers the anchors (approvals, entity
 * threads) the detail says are not list rows.
 */
export function belongsInChatList(data: { type?: unknown; hiddenFromList?: unknown }): boolean {
  if (data.hiddenFromList === true) return false
  return isChatListThreadType(typeof data.type === "string" ? data.type : null)
}

/** A thread API row as the client's Thread. Exported for the surfaces that
 *  read ONE thread by id without adding it to the sidebar list. */
export function normalizeThread(data: any): Thread {
  return {
    id: data.id,
    handle: data.handle ?? "",
    title: data.title ?? null,
    type: (data.type as ThreadType) ?? "thread",
    createdFrom: normalizeCreatedFrom(data.createdFrom ?? data.created_from),
    isPinned: data.isPinned ?? false,
    isPinnedByUser: data.isPinnedByUser ?? false,
    isMuted: data.isMuted ?? false,
    notifyAllPosts: data.notifyAllPosts === true,
    discoverable: data.discoverable ?? false,
    topic: data.topic ?? null,
    description: data.description ?? null,
    participants: (data.participants ?? []).map(normalizeParticipant),
    lastMessage: data.lastMessage ?? null,
    unreadCount: data.unreadCount ?? 0,
    updatedAt: data.updatedAt ?? new Date().toISOString(),
    tainted: data.tainted ?? false,
    agentModelId: data.agentModelId ?? null,
    agentDefaultModelId: data.agentDefaultModelId ?? null,
    agentContextFrom: data.agentContextFrom ?? null,
    agentContextAgentId: data.agentContextAgentId ?? null,
    agentContextAgentName: data.agentContextAgentName ?? null,
  }
}

// --- Mutations ---

// Whether the last `loadThreads` failed. An empty thread list is otherwise
// indistinguishable from a list that never arrived, so every surface that
// reloads "when the list is empty" reloaded on every reactive pass while the
// API was refusing, which is how one 429 became hundreds. A surface reads this
// to tell "nothing to show" from "the load failed", and only an explicit
// reload (user action, resync, WS self heal) tries again.
const [threadsLoadFailed, setThreadsLoadFailed] = createSignal(false)

export { threadsLoadFailed }

// Remembering the failure must not mean remembering it forever. The sidebar
// loads the list in its own onMount and has no other trigger, so a flag that
// only a success cleared left an empty sidebar for the rest of the session
// whenever the WebSocket stayed quiet. The flag is therefore armed again once
// the refusal has had time to pass: after the 429's Retry-After when the server
// named one, otherwise after a backoff that starts at five seconds and doubles
// to at most a minute while the refusals continue.
const kBaseRetryMs = 5_000
const kMaxRetryMs = 60_000
let _threadsRetryTimer: ReturnType<typeof setTimeout> | null = null
let _threadsRetryDelayMs = kBaseRetryMs

function armThreadsRetry(err: unknown): void {
  if (_threadsRetryTimer) return
  const hinted = (err as { retryAfter?: number } | null)?.retryAfter
  const hintedMs =
    typeof hinted === "number" && Number.isFinite(hinted) && hinted > 0 ? hinted * 1000 : 0
  // The hint says the earliest the server will answer again, never how often we
  // may ask: `Retry-After: 1` on a limiter that stays angry would otherwise be
  // one list read a second for as long as it lasts. The backoff is the floor,
  // the hint only ever pushes the next attempt further out.
  const delay = Math.min(Math.max(hintedMs, _threadsRetryDelayMs), kMaxRetryMs)
  _threadsRetryDelayMs = Math.min(_threadsRetryDelayMs * 2, kMaxRetryMs)
  _threadsRetryTimer = setTimeout(() => {
    _threadsRetryTimer = null
    // Clearing the flag re-arms the surfaces that load an empty list: exactly
    // one more attempt, then the flag stands again until the next window.
    setThreadsLoadFailed(false)
  }, delay)
}

function clearThreadsRetry(): void {
  if (_threadsRetryTimer) clearTimeout(_threadsRetryTimer)
  _threadsRetryTimer = null
  _threadsRetryDelayMs = kBaseRetryMs
}

// The list load in flight, if any, and the one run queued behind it. Several
// surfaces ask for the same list on the same reactive pass (the sidebar
// mounting, a view finding the list empty) and can share one answer. An ask
// raised AFTER a load left (a WS self heal naming a thread the store does not
// know) cannot: the answer on the wire was composed before the row it is
// looking for existed. Such an ask chains exactly one more run behind the
// current one, and further asks in that window join the chained run.
let _threadsLoadInFlight: Promise<void> | null = null
let _threadsLoadQueued: Promise<void> | null = null
// The options the queued run will start with. An ask that joins the queue may
// need MORE than the ask that created it (a person's Try again joining a self
// heal), and the queued run has not left yet, so it takes the union.
let _threadsQueuedOptions: LoadThreadsOptions | null = null
// Which run owns the store. Two runs can overlap (a plain ask landing in the
// microtask between one run clearing itself and the queued run starting), and
// the one that started FIRST can answer last, so a stale list would win. Only
// the newest run writes; mirrors message-store's per thread epoch.
let _threadsLoadGeneration = 0
// Bumped by every teardown. A run queued behind another one is scheduled on a
// promise the teardown cannot cancel, so the queued callback checks this before
// it starts anything: its session is gone, and starting there would mint a new
// generation and so write, with full authority, into the next session's store
// (and its 401 would leave that fresh session remembering a failure it never
// had). The run generation cannot answer this: the stale run increments it.
let _threadsResetEpoch = 0

export interface LoadThreadsOptions {
  /**
   * Demand a list composed AFTER this call. An event driven reload (the WS self
   * heal naming a thread the store has never seen, a resync) must not be
   * answered by a response that left the server before that thread existed. An
   * opportunistic ask (a surface noticing it has nothing to show) has no such
   * need and shares whatever is already on the wire.
   */
  fresh?: boolean
  /** A person pressed Try again: it is let through the client rate limit
   *  cool-down, which is otherwise the reason the button would do nothing. */
  userInitiated?: boolean
}

type ThreadsApi = {
  get: (path: string, init?: { userInitiated?: boolean }) => Promise<any>
}

export function loadThreads(api: ThreadsApi, options?: LoadThreadsOptions): Promise<void> {
  // A person's Try again needs a request of its own for the same reason an
  // event driven reload does: the answer on the wire was composed before they
  // pressed, and it is their press that carries it through the cool-down.
  const wantsOwnRun = Boolean(options?.fresh || options?.userInitiated)
  if (_threadsLoadInFlight) {
    if (!wantsOwnRun) return _threadsLoadInFlight
    if (_threadsLoadQueued) {
      _threadsQueuedOptions = {
        fresh: _threadsQueuedOptions?.fresh || options?.fresh,
        userInitiated: _threadsQueuedOptions?.userInitiated || options?.userInitiated,
      }
      return _threadsLoadQueued
    }
    _threadsQueuedOptions = { ...options }
    const scheduledEpoch = _threadsResetEpoch
    const queuedRun: Promise<void> = _threadsLoadInFlight.then(() => {
      if (scheduledEpoch !== _threadsResetEpoch) return // the session it belonged to is gone
      const queuedOptions = _threadsQueuedOptions ?? undefined
      if (_threadsLoadQueued === queuedRun) {
        _threadsLoadQueued = null
        _threadsQueuedOptions = null
      }
      return startThreadsLoad(api, queuedOptions)
    })
    _threadsLoadQueued = queuedRun
    return queuedRun
  }
  return startThreadsLoad(api, options)
}

function startThreadsLoad(api: ThreadsApi, options?: LoadThreadsOptions): Promise<void> {
  const run = runLoadThreads(api, options).finally(() => {
    if (_threadsLoadInFlight === run) _threadsLoadInFlight = null
  })
  _threadsLoadInFlight = run
  return run
}

// THE LIST ON THE WIRE IS OLDER THAN A READ THAT LANDED MEANWHILE (LIF-26).
// A list answer is composed when the request reaches the server; a read mark
// (this device, or another one's `kernel:read_state` frame) or a counted
// message that lands while it is on the wire is NEWER than the count it
// carries. Writing that answer as is put a read thread's pill back (and the
// Unread filter kept showing it) until the next reload. Every run in flight
// collects what moved under it, per thread:
// - a read mark (`read`): the local count is newer than the answer, keep it
//   (later bumps already added onto it);
// - only message bumps: the local count may itself be stale, so the server's
//   count wins, plus the bumped messages the answer cannot have counted (newer
//   than the newest message it carries; all of them when it carries none).
interface UnreadMoves {
  read: boolean
  /** createdAt of each message bumped meanwhile ("" when unknown). */
  bumps: string[]
}
const _unreadMovesByRun = new Set<Map<string, UnreadMoves>>()

function movesFor(run: Map<string, UnreadMoves>, threadId: string): UnreadMoves {
  let m = run.get(threadId)
  if (!m) {
    m = { read: false, bumps: [] }
    run.set(threadId, m)
  }
  return m
}

function noteUnreadRead(threadId: string): void {
  for (const run of _unreadMovesByRun) movesFor(run, threadId).read = true
}

function noteUnreadBump(threadId: string, createdAt: unknown): void {
  const at = typeof createdAt === "string" ? createdAt : ""
  for (const run of _unreadMovesByRun) movesFor(run, threadId).bumps.push(at)
}

function reconcileUnread(server: Thread, prior: Thread, moves: UnreadMoves): number {
  if (moves.read) return prior.unreadCount
  const newest = server.lastMessage?.createdAt ? Date.parse(server.lastMessage.createdAt) : NaN
  let missed = 0
  for (const at of moves.bumps) {
    const t = at ? Date.parse(at) : NaN
    if (Number.isNaN(newest) || Number.isNaN(t) || t > newest) missed++
  }
  return server.unreadCount + missed
}

async function runLoadThreads(api: ThreadsApi, options?: LoadThreadsOptions): Promise<void> {
  const moves = new Map<string, UnreadMoves>()
  _unreadMovesByRun.add(moves)
  try {
    await runLoadThreadsTracked(api, moves, options)
  } finally {
    _unreadMovesByRun.delete(moves)
  }
}

async function runLoadThreadsTracked(
  api: ThreadsApi,
  moves: ReadonlyMap<string, UnreadMoves>,
  options?: LoadThreadsOptions,
): Promise<void> {
  const generation = ++_threadsLoadGeneration
  let res: any
  try {
    res = await api.get(
      "/threads?limit=50",
      options?.userInitiated ? { userInitiated: true } : undefined,
    )
  } catch (err) {
    // Recorded, not rethrown: every call site is fire and forget, so a throw
    // here left the page with an unhandled rejection per attempt on top of the
    // refetch storm itself.
    if (generation !== _threadsLoadGeneration) return // a newer run owns the store
    setThreadsLoadFailed(true)
    armThreadsRetry(err)
    return
  }
  if (generation !== _threadsLoadGeneration) return // a newer run owns the store
  clearThreadsRetry()
  setThreadsLoadFailed(false)
  // An empty body unwraps to null: no list, read like any other non-array answer.
  const raw = res?.data ?? res?.threads ?? res
  const threads: Thread[] = Array.isArray(raw) ? raw.map(normalizeThread) : []

  const byId: Record<string, Thread> = {}
  const pinnedIds: string[] = []
  const userPinnedIds: string[] = []
  const unpinnedIds: string[] = []

  for (const t of threads) {
    // The listing does not carry the agent context boundary (P4c-T51): it is a
    // per row checkpoint query and the sidebar has nowhere to put it. A refresh
    // must therefore not erase a position the thread read model already gave
    // us, or an open thread loses its boundary the moment the list reloads.
    const prior = threadStore.byId[t.id]
    const known = prior?.agentContextFrom
    const merged: Thread =
      known === undefined
        ? t
        : {
            ...t,
            agentContextFrom: known,
            agentContextAgentId: prior?.agentContextAgentId ?? null,
            agentContextAgentName: prior?.agentContextAgentName ?? null,
          }
    // A count that moved while this answer was on the wire is newer than it.
    const moved = moves.get(t.id)
    if (prior && moved) merged.unreadCount = reconcileUnread(t, prior, moved)
    byId[t.id] = merged
    if (t.isPinned) pinnedIds.push(t.id)
    else if (t.isPinnedByUser) userPinnedIds.push(t.id)
    else unpinnedIds.push(t.id)
  }

  setThreadStore({ byId, pinnedIds, userPinnedIds, unpinnedIds })
  notifyThreadsKnown()
}

export function handleThreadEvent(action: string, data: any): void {
  let created = false
  if (action === "create") {
    if (!belongsInChatList(data ?? {})) return
    setThreadStore(
      produce((s) => {
        if (s.byId[data.id]) return
        const thread: Thread = {
          id: data.id,
          handle: data.handle,
          title: data.title,
          type: (data.type as ThreadType) ?? "thread",
          createdFrom: normalizeCreatedFrom(data.createdFrom ?? data.created_from),
          isPinned: data.isPinned ?? false,
          isPinnedByUser: data.isPinnedByUser ?? false,
          isMuted: data.isMuted ?? false,
          notifyAllPosts: data.notifyAllPosts === true,
          discoverable: data.discoverable ?? false,
          topic: data.topic ?? null,
          description: data.description ?? null,
          participants: (data.participants ?? []).map(normalizeParticipant),
          lastMessage: null,
          unreadCount: 0,
          updatedAt: new Date().toISOString(),
        }
        s.byId[data.id] = thread
        const partition = partitionIdForThread(thread)
        s[partition].unshift(data.id)
        created = true
      }),
    )
    if (created) notifyThreadsKnown()
  } else if (action === "update") {
    setThreadStore(
      produce((s) => {
        const thread = s.byId[data.id]
        if (thread && data.changes) {
          if (data.changes.title !== undefined) thread.title = data.changes.title
          if (data.changes.isPinned !== undefined) {
            const wasPinned = thread.isPinned
            thread.isPinned = data.changes.isPinned
            if (wasPinned !== data.changes.isPinned) {
              removeIdFromPartitions(s, data.id)
              s[partitionIdForThread(thread)].push(data.id)
            }
          }
          if (data.changes.isPinnedByUser !== undefined) {
            const wasUserPinned = thread.isPinnedByUser
            thread.isPinnedByUser = data.changes.isPinnedByUser
            if (wasUserPinned !== data.changes.isPinnedByUser) {
              removeIdFromPartitions(s, data.id)
              s[partitionIdForThread(thread)].push(data.id)
            }
          }
          if (data.changes.isMuted !== undefined) thread.isMuted = data.changes.isMuted
          if (data.changes.tainted !== undefined) thread.tainted = data.changes.tainted
          if (data.changes.agentModelId !== undefined)
            thread.agentModelId = data.changes.agentModelId
          if (data.changes.type !== undefined) {
            thread.type = data.changes.type as ThreadType
            // A room turned into something that is not a chat row leaves the list.
            if (!belongsInChatList(thread)) {
              removeIdFromPartitions(s, data.id)
              delete s.byId[data.id]
            }
          }
          if (data.changes.createdFrom !== undefined)
            thread.createdFrom = normalizeCreatedFrom(data.changes.createdFrom)
        }
      }),
    )
  }
}

// The same row reaches the socket twice: an agent turn's low-latency copy and
// its outbox event (persist-agent-turn.ts). The list counts a message once.
const _countedMessageIds = new Set<string>()
const kCountedMessageIdsMax = 500

function countOnce(messageId: unknown): boolean {
  if (typeof messageId !== "string") return true
  if (_countedMessageIds.has(messageId)) return false
  _countedMessageIds.add(messageId)
  if (_countedMessageIds.size > kCountedMessageIdsMax) {
    const oldest = _countedMessageIds.values().next().value
    if (oldest !== undefined) _countedMessageIds.delete(oldest)
  }
  return true
}

export function handleMessageEvent(
  action: string,
  data: any,
  context: MessageEventContext = {},
): void {
  if (action === "create") {
    let seenWhileVisible = false
    // A reply not also sent to the channel lives in its reply thread (S9, A4),
    // system lines there included (an agent's seat line). It is not channel
    // activity: no preview, no unread bump, no reordering. Its followers hear
    // of it through the followed threads and their thread_followup instead.
    // The server's channel unread count already leaves it out; bumping here
    // raised a badge and a Home row a reload took away (QA THR-09).
    if (data?.replyRootId && data.alsoInChannel !== true) return
    setThreadStore(
      produce((s) => {
        const thread = s.byId[data.threadId]
        if (!thread) return
        thread.lastMessage = {
          content: data.content,
          authorId: data.authorId,
          authorName: data.authorName,
          authorType: data.authorType,
          metadata:
            data.metadata && typeof data.metadata.agentNotice === "string"
              ? { agentNotice: data.metadata.agentNotice }
              : data.metadata?.type === "approval-decision"
                ? {
                    type: data.metadata.type,
                    decision: data.metadata.decision ?? null,
                    reason: data.metadata.reason ?? null,
                  }
                : null,
          createdAt: data.createdAt,
        }
        thread.updatedAt = data.createdAt
        const isVisibleActiveThread = context.isVisibleActiveThread ?? false
        // The reader's own words, as the server reads them: an agent row carries
        // the reader as its actor (the person whose turn it is) and is still
        // news to them. Taking it for their own message left it unread on the
        // server once watched arriving (desktop local turn, demo 2026-10-12).
        const isOwnAction = (context.isOwnAction ?? false) && data.authorType !== "agent"
        // A status line ("Routine X is running") is never unread, as the
        // server's counts say (`notStatusLine`).
        if (!isVisibleActiveThread && !isOwnAction && !isStatusLine(data) && countOnce(data.id)) {
          thread.unreadCount++
          noteUnreadBump(data.threadId, data.createdAt)
        }
        // Seen as it arrived, so it is read on the server too. Only skipping the
        // local bump left the server mark behind: the next list load (a resync, a
        // reload) brought the pill back on a thread the reader had watched, and it
        // never cleared while they stayed in it.
        if (isVisibleActiveThread && !isOwnAction) seenWhileVisible = true
        // Move to top of unpinned list (only if not pinned)
        if (!thread.isPinned && !thread.isPinnedByUser) {
          const idx = s.unpinnedIds.indexOf(data.threadId)
          if (idx > 0) {
            s.unpinnedIds.splice(idx, 1)
            s.unpinnedIds.unshift(data.threadId)
          }
        }
      }),
    )
    if (seenWhileVisible) context.onReadWhileVisible?.(data.threadId)
  }
}

export function handleParticipantEvent(action: string, data: any): void {
  if (action === "add") {
    addParticipantToThread(data.threadId, {
      id: data.agentId ?? data.userId,
      name: data.userName ?? data.agentName ?? "",
      avatarUrl: data.avatarUrl ?? null,
      participantType: data.participantType === "agent" ? "agent" : "user",
      agentId: data.agentId ?? null,
      role: data.role ?? undefined,
      seatOrigin: data.seatOrigin ?? null,
    })
  } else if (action === "remove") {
    removeParticipantFromThread(data.threadId, data.userId)
  }
}

// --- "A thread just became known" notification ---
//
// Every ROW-ADDING write to the store announces itself here: the WS create,
// the merge from an API response, and the list reload that replaces the store
// wholesale. It exists for the work that arrives BEFORE the thread does: a
// message event for a conversation the store has never seen cannot be
// classified (DM or channel? am I even in it?), so the interested module parks
// the id and drains it from this callback once the row lands.
//
// Subscribers are module-lifetime and deliberately survive resetThreadStore:
// they are registered once at bootstrap, while the store is reset on every
// logout and in every test.
const _threadsKnownListeners = new Set<() => void>()

export function subscribeThreadsKnown(listener: () => void): () => void {
  _threadsKnownListeners.add(listener)
  return () => {
    _threadsKnownListeners.delete(listener)
  }
}

function notifyThreadsKnown(): void {
  for (const listener of _threadsKnownListeners) {
    try {
      listener()
    } catch {
      /* a listener must never break the store write that fed it */
    }
  }
}

// A thread leaving the list for this viewer (archive, delete, leave), told
// BEFORE it goes: an open tab on it keeps naming it from the copy the list held
// (thread-tab-names.ts) instead of falling back to an older one.
const _threadRemovedListeners = new Set<(thread: Thread) => void>()

export function subscribeThreadRemoved(listener: (thread: Thread) => void): () => void {
  _threadRemovedListeners.add(listener)
  return () => {
    _threadRemovedListeners.delete(listener)
  }
}

function notifyThreadRemoved(thread: Thread): void {
  for (const listener of _threadRemovedListeners) {
    try {
      listener(thread)
    } catch {
      /* a listener must never break the removal */
    }
  }
}

/** Add or merge a thread from an API response. List-loaded rows can later learn
 *  detail-only fields (`type`, `createdFrom`) when the same id is fetched via detail.
 *  When merging, fields that aren't present in the incoming payload (e.g. detail
 *  responses don't include `lastMessage` or `unreadCount`) preserve the existing
 *  value rather than getting overwritten with the normalizer's null/0 default. */
export function addThread(data: any): void {
  let added = false
  const listable = belongsInChatList(data ?? {})
  setThreadStore(
    produce((s) => {
      const incoming = normalizeThread(data)
      const existing = s.byId[data.id]
      if (!listable) {
        // The detail says this is not a chat row: a copy an older client put
        // in the list goes, and nothing new is added.
        if (existing) {
          removeIdFromPartitions(s, data.id)
          delete s.byId[data.id]
        }
        return
      }
      if (existing) {
        const merged: Thread = { ...existing, ...incoming }
        if (data.lastMessage === undefined) merged.lastMessage = existing.lastMessage
        if (data.unreadCount === undefined) merged.unreadCount = existing.unreadCount
        // Only the thread read model carries the boundary; a listing refresh
        // says nothing about it, so absence must not erase a known position.
        if (data.agentContextFrom === undefined) {
          merged.agentContextFrom = existing.agentContextFrom
          merged.agentContextAgentId = existing.agentContextAgentId
          merged.agentContextAgentName = existing.agentContextAgentName
        }
        // Same rule for the model pair: the listing carries neither, so a
        // listing refresh that erased them left the dock's chip reading
        // "Default (Auto)" beside a panel that had read the detail.
        if (data.agentModelId === undefined) merged.agentModelId = existing.agentModelId
        if (data.agentDefaultModelId === undefined) {
          merged.agentDefaultModelId = existing.agentDefaultModelId
        }
        s.byId[data.id] = merged
        return
      }
      s.byId[data.id] = incoming
      s[partitionIdForThread(incoming)].unshift(data.id)
      added = true
    }),
  )
  if (added) notifyThreadsKnown()
}

// --- Thread reload callback ---
// Allows bootstrap.ts (leaf, no component context) to trigger a reload
// after a WS sync reset or the unknown-thread self-heal. Two tiers:
// - `_defaultReloadThreadsCallback`: a session-level handler registered once
//   at startup (startup.ts's hydrateThreadStoreOnce), so the self-heal works
//   even when HomeSidebar isn't mounted (user is on Mail/Tickets/Settings, or
//   Home is closed) — it was a silent no-op before this handler existed.
// - `_reloadThreadsCallback`: an optional override set by HomeSidebar while
//   mounted (it has a real component-scoped API client via useApi()).
// requestThreadReload() prefers the override, falling back to the default.
let _reloadThreadsCallback: (() => void) | null = null
let _defaultReloadThreadsCallback: (() => void) | null = null

export function setThreadReloadHandler(fn: (() => void) | null): void {
  _reloadThreadsCallback = fn
}

export function setDefaultThreadReloadHandler(fn: (() => void) | null): void {
  _defaultReloadThreadsCallback = fn
}

export function requestThreadReload(): void {
  ;(_reloadThreadsCallback ?? _defaultReloadThreadsCallback)?.()
}

// --- Resync subscription ---
// On a resync bump (WS sync frame / reconnect), refetch the thread list IN
// PLACE via the existing reload callback. HomeSidebar's reload merges rows into
// the store (no wipe), so the list never flashes empty. Idempotent: subscribes
// at most once for the module lifetime.
let _threadResyncSubscribed = false

export function subscribeThreadResync(): void {
  if (_threadResyncSubscribed) return
  _threadResyncSubscribed = true
  subscribeResync(() => {
    requestThreadReload()
  })
}

/** Reset store to empty state — used in tests and on logout */
export function resetThreadStore(): void {
  setThreadStore({ byId: {}, pinnedIds: [], userPinnedIds: [], unpinnedIds: [] })
  setSidebarArchivedView(false)
  setArchivedThreads([])
  setLoadingArchived(false)
  setThreadsLoadFailed(false)
  clearThreadsRetry()
  _threadsLoadInFlight = null
  _threadsLoadQueued = null
  _threadsQueuedOptions = null
  // Nothing already on the wire may write into the next session's store, and
  // nothing queued behind it may start in that session either.
  _threadsLoadGeneration += 1
  _threadsResetEpoch += 1
  // The sidebar's reload handler closes over the ENDING session's api client,
  // and teardown runs before Solid unmounts the sidebar (which is what would
  // otherwise clear it). A resync bump in that window would reload the list
  // with dead credentials, and the 401 would leave the next session
  // remembering a failure it never had. The session-level default handler
  // clears itself on its own teardown (startup.ts).
  _reloadThreadsCallback = null
}
onSessionTeardown(resetThreadStore)

export function resetUnreadCount(threadId: string): void {
  noteUnreadRead(threadId)
  setThreadStore(
    produce((s) => {
      const thread = s.byId[threadId]
      if (thread) thread.unreadCount = 0
    }),
  )
}

/**
 * The server's unread count for a thread, as another device of this reader
 * left it (a `kernel:read_state` frame). Only ever sets what the server said:
 * a zero clears the pill, a count a message landed into mid-read keeps it.
 */
export function setThreadUnreadCount(threadId: string, count: number): void {
  if (!threadStore.byId[threadId]) return
  noteUnreadRead(threadId)
  setThreadStore(
    produce((s) => {
      const thread = s.byId[threadId]
      if (thread) thread.unreadCount = count
    }),
  )
}

/** Reset local count immediately, then persist read state to the backend */
export function markThreadRead(
  api: { patch: (path: string, body?: unknown) => Promise<unknown> },
  threadId: string,
): void {
  resetUnreadCount(threadId)
  api.patch(`/threads/${threadId}/read`, {}).catch(() => {})
}

export function addParticipantToThread(
  threadId: string,
  participant: Omit<ThreadParticipant, "participantType" | "agentId"> &
    Partial<Pick<ThreadParticipant, "participantType" | "agentId">>,
  index?: number,
): void {
  const thread = threadStore.byId[threadId]
  if (!thread) return
  const present = thread.participants.find((p) => p.id === participant.id)
  if (present) {
    // An agent seat re-recorded in place (D23a: a mention seat added on
    // purpose) carries its new origin; anything else is a repeat.
    const next = normalizeParticipant(participant)
    if (
      next.participantType === "agent" &&
      (present.seatOrigin ?? null) !== (next.seatOrigin ?? null)
    ) {
      setThreadStore(
        produce((s) => {
          const seat = s.byId[threadId]?.participants.find((p) => p.id === participant.id)
          if (seat) seat.seatOrigin = next.seatOrigin ?? null
        }),
      )
    }
    return
  }
  setThreadStore(
    produce((s) => {
      const t = s.byId[threadId]
      if (!t) return
      const insertionIndex =
        index === undefined
          ? t.participants.length
          : Math.max(0, Math.min(index, t.participants.length))
      t.participants.splice(insertionIndex, 0, normalizeParticipant(participant))
    }),
  )
}

export function removeParticipantFromThread(threadId: string, userId: string): void {
  setThreadStore(
    produce((s) => {
      const t = s.byId[threadId]
      if (!t) return
      t.participants = t.participants.filter((p) => p.id !== userId)
    }),
  )
}

export function setThreadPinned(threadId: string, isPinned: boolean): void {
  setThreadStore(
    produce((s) => {
      const thread = s.byId[threadId]
      if (!thread) return
      thread.isPinned = isPinned
      removeIdFromPartitions(s, threadId)
      s[partitionIdForThread(thread)].push(threadId)
    }),
  )
}

export function setThreadPinnedByUser(threadId: string, isPinned: boolean): void {
  setThreadStore(
    produce((s) => {
      const thread = s.byId[threadId]
      if (!thread) return
      thread.isPinnedByUser = isPinned
      removeIdFromPartitions(s, threadId)
      s[partitionIdForThread(thread)].push(threadId)
    }),
  )
}

/** A35: flip a titled channel between public and private. Shared-row state, so
 *  it rides the same optimistic-then-PATCH pattern as the org pin. */
export function setThreadDiscoverable(threadId: string, discoverable: boolean): void {
  setThreadStore(
    produce((s) => {
      const thread = s.byId[threadId]
      if (thread) thread.discoverable = discoverable
    }),
  )
}

/** Write a channel's topic or description into the store. Shared-row state, so
 *  it takes the same optimistic-then-PATCH shape as the Discoverable switch;
 *  `null` is the CLEAR and is written as such, never coerced to "". */
export function setThreadDetails(
  threadId: string,
  details: { topic?: string | null; description?: string | null },
): void {
  setThreadStore(
    produce((s) => {
      const thread = s.byId[threadId]
      if (!thread) return
      if (details.topic !== undefined) thread.topic = details.topic
      if (details.description !== undefined) thread.description = details.description
    }),
  )
}

/** The reader's per-channel opt-in to every post moved (here, or on another device). */
export function setThreadNotifyAllPosts(threadId: string, on: boolean): void {
  setThreadStore(
    produce((s) => {
      const thread = s.byId[threadId]
      if (thread) thread.notifyAllPosts = on
    }),
  )
}

export function setThreadMuted(threadId: string, isMuted: boolean): void {
  setThreadStore(
    produce((s) => {
      const thread = s.byId[threadId]
      if (thread) thread.isMuted = isMuted
    }),
  )
}

/** The outside-text mark changed here first (the globe's "Clear the mark"); the thread event
 *  every other view receives says the same a moment later. */
export function setThreadTainted(threadId: string, tainted: boolean): void {
  setThreadStore(
    produce((s) => {
      const thread = s.byId[threadId]
      if (thread) thread.tainted = tainted
    }),
  )
}

/** Compute display title: explicit title, or first names of other participants, or "Just you" */
export function threadDisplayName(
  thread: { title: string | null; participants: Array<{ id: string; name: string }> },
  currentUserId: string,
): string {
  if (thread.title) return thread.title
  const others = thread.participants.filter((p) => p.id !== currentUserId)
  if (others.length === 0) return tNow("kernel.threadsUi.justYou")
  return others.map((p) => localizeAgentName(p.name).split(" ")[0]).join(", ")
}

/**
 * The thread is gone FOR THIS VIEWER: deleted, archived, or left. Its dock tab
 * goes with it. The dock persists its tabs in localStorage, so a tab left
 * behind here is rehydrated on every page load, and its ConversationTab then
 * asks the server for a thread that answers 404 (or 403 once the viewer is no
 * longer a participant) for the rest of time.
 */
export function removeThread(threadId: string): void {
  const leaving = threadStore.byId[threadId]
  if (leaving) notifyThreadRemoved(leaving)
  setThreadStore(
    produce((s) => {
      removeIdFromPartitions(s, threadId)
      delete s.byId[threadId]
    }),
  )
  closeDockTab(threadId)
}

// --- Archived sidebar view state (shared between HomeSidebar and ThreadView) ---
const [sidebarArchivedView, setSidebarArchivedView] = createSignal(false)
const [archivedThreads, setArchivedThreads] = createSignal<Thread[]>([])
const [loadingArchived, setLoadingArchived] = createSignal(false)

export { archivedThreads, loadingArchived, sidebarArchivedView }

export async function fetchArchivedThreads(api: {
  get: (path: string) => Promise<any>
}): Promise<void> {
  setLoadingArchived(true)
  try {
    const res: any = await api.get("/threads?archived=true&limit=50")
    const threads = res.data ?? res.threads ?? res
    setArchivedThreads(Array.isArray(threads) ? threads.map(normalizeThread) : [])
  } catch {
    setArchivedThreads([])
  } finally {
    setLoadingArchived(false)
  }
}

export function showArchivedSidebar(api: { get: (path: string) => Promise<any> }): void {
  setSidebarArchivedView(true)
  fetchArchivedThreads(api)
}

export function hideArchivedSidebar(): void {
  setSidebarArchivedView(false)
}

export function removeArchivedThread(threadId: string): void {
  setArchivedThreads((prev) => prev.filter((t) => t.id !== threadId))
}

// --- Agent typing state ---
// Which agents are taking a turn in which thread. The state itself lives in
// presence-store, keyed by (threadId, participantId), so a room with several
// agent members shows one indicator per agent instead of collapsing them.

export function agentTypingInThread(threadId: string): boolean {
  return getTypingAgents(threadId).length > 0
}

export function handleTypingEvent(event: {
  type: "typing:start" | "typing:stop"
  threadId: string
  userId: string
  authorType?: string
  /** The `kernel.agents` id of the agent taking the turn. Frames that predate
   *  multi-agent rooms carry none, so the actor id keys the entry instead. */
  agentId?: string | null
  /** The reply thread the turn answers in (A7). Such a turn is announced in
   *  its root's panel, never on the channel's state line, so the channel
   *  registry does not take it (start or stop). */
  replyRootId?: string | null
}): void {
  if (event.authorType !== "agent") return
  if (event.replyRootId) return
  const participantId = event.agentId ?? event.userId
  if (!participantId) return
  if (event.type === "typing:start") handleAgentTypingStart(event.threadId, participantId)
  else handleAgentTypingStop(event.threadId, participantId)
}
