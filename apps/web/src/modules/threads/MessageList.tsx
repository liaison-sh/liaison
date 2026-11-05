// SPDX-License-Identifier: FSL-1.1-ALv2

import type { ApprovalRequestSummary, MessageQuote, ReasoningLevel } from "@liaison/shared"
import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { ArrowDown, Square } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { capitalize } from "~/lib/relative-time"
import AgentTurnBlock from "~/modules/agent/AgentTurnBlock"
import { APPROVAL_DECIDED_EVENT } from "~/modules/approvals/decided-event"
import { userFromToken } from "~/modules/auth/auth-store"
import {
  desktopState,
  interruptLocalTurn,
  isDesktop,
  localFolderFor,
  localFreshSessionFor,
  localSessionFor,
  localTurnFailureFor,
  retryLocalTurn,
} from "~/modules/desktop/desktop-store"
import { currentLocalPrompt } from "~/modules/desktop/LocalPermissionCard"
import { currentLocale, tNow, useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { dockWindowOpen } from "~/modules/shell/dock-store"
import { createMentionDelegate, renderContent } from "~/modules/shell/markdown-content"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import AgentStateLabel from "~/modules/threads/AgentStateLabel"
import { getAgentDisplay } from "~/modules/threads/agent-directory"
import { localizeAgentName } from "~/modules/threads/agent-name"
import { localizeAgentNotice } from "~/modules/threads/agent-notice"
import MessageRow from "~/modules/threads/MessageRow"
import type { Message } from "~/modules/threads/message-store"
import {
  addReaction,
  deleteMessage,
  editMessage,
  getAgentStream,
  getGroupedMessages,
  getHiddenRuns,
  getLiveAgentStreams,
  getMessage,
  isNestedExpanded,
  loadMessages,
  loadMoreMessages,
  messageStore,
  type NestedMessage,
  removeReaction,
  toggleNestedExpanded,
} from "~/modules/threads/message-store"
import QuoteSelection from "~/modules/threads/QuoteSelection"
import { jumpToMessage } from "~/modules/threads/quote-jump"
import { quoteSurfaceKey } from "~/modules/threads/quote-store"
import {
  channelJumpRequest,
  consumeChannelJump,
  openReplyPanel,
} from "~/modules/threads/reply-panel-store"
import { allThreads } from "~/modules/threads/thread-store"
import { refusalShownInThread, refusedTurnIsEmpty } from "~/modules/threads/turn-refusal"
import type { WithheldItem } from "~/modules/threads/WithheldCapabilityCard"
import { WithheldCapabilityCard } from "~/modules/threads/WithheldCapabilityCard"
import { settledValue } from "~/primitives/settledValue"
import { AgentGlyph } from "~/ui/AgentGlyph"
import { AvatarImage } from "~/ui/AvatarImage"
import { agentAvatarStyle } from "~/ui/avatar-palette"
import { ScrollFade } from "~/ui/ScrollFade"

interface MessageListProps {
  threadId: string
  currentUserId: string
  /** Approval threads render each "approval-created" post as the live inline
   *  ApprovalCard (chronological, at the bottom). Off elsewhere: agent threads
   *  already render the card via the gated tool-call row, so a second card here
   *  would duplicate it. */
  isApprovalThread?: boolean
  agentModelId?: string | null
  agentReasoningLevels?: Record<string, string>
  hasPurchasedCredits?: boolean
  availableModelIds?: Set<string> | null
  onSelectAgentModel?: (modelId: string | null) => void
  onSelectReasoning?: (modelId: string, level: ReasoningLevel) => void
  /** The message the agent's fed context resumes after (P4c-T51). One thin
   *  boundary row follows it. Null or absent renders nothing. */
  agentContextFrom?: string | null
  /** Display name of the agent that boundary belongs to. Without one there is
   *  nobody to name in the copy, so no row is drawn. */
  agentContextAgentName?: string | null
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const locale = currentLocale()
  const dayWord = (offset: number) =>
    capitalize(new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(offset, "day"))
  if (date.toDateString() === now.toDateString()) return dayWord(0)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return dayWord(-1)
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" })
}

function shouldGroup(prev: Message | null, curr: Message): boolean {
  if (!prev || prev.authorId !== curr.authorId) return false
  // Agent messages use the calling user's authorId — never group across authorType boundaries
  if (prev.authorType !== curr.authorType) return false
  // TWO AGENTS ANSWERING ONE MESSAGE ARE TWO SPEAKERS. Every agent row in a
  // room carries the SAME authorId (the human whose turn it is), so authorId
  // alone said "the same speaker" for a Support Desk reply and a Finance Desk
  // reply 1.6 s apart, and the second one rendered with no header, no avatar
  // and no AGENT badge. The speaker of an agent row is its authorAgentId.
  if ((prev.authorAgentId ?? null) !== (curr.authorAgentId ?? null)) return false
  const diff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime()
  return diff < 120000 // 2 minutes
}

const NEAR_BOTTOM_THRESHOLD = 80 // px
const NEAR_TOP_THRESHOLD = 300 // px — prefetch older messages before hitting the top

type FlatItem =
  | { kind: "date"; label: string }
  | { kind: "msg"; msg: Message; grouped: boolean; nested: NestedMessage[] }
  | { kind: "hidden"; count: number }
  | { kind: "context-boundary"; uptoMessageId: string; agentName: string }

/** The withheld set the server attached to this message, for this reader
 *  only. Absent on every message that withheld nothing, which is most of them. */
function withheldItems(msg: Message): WithheldItem[] | null {
  const items = (msg.metadata as { withheld?: { items?: unknown } } | undefined)?.withheld?.items
  if (!Array.isArray(items) || items.length === 0) return null
  return items.filter((i: any) => typeof i?.label === "string") as WithheldItem[]
}

/** Continue in a DM: the card has already opened or reused the requester's
 *  1:1 with the agent through the route, so this only puts it on screen. */
function openAgentDm(threadId: string, agentId: string | null): void {
  const known = allThreads().find((t) => t.id === threadId)
  openTab({
    type: "thread",
    entityId: threadId,
    label:
      (agentId ? getAgentDisplay(agentId)?.name : null) ??
      known?.title ??
      tNow("kernel.threadsUi.directMessage"),
  })
}

/** spec.md's normative strings, byte for byte. */
function hiddenMessagesLabel(count: number): string {
  return count === 1
    ? tNow("kernel.threadsUi.hiddenOne")
    : tNow("kernel.threadsUi.hiddenMany", { count })
}

/** The collapsed line over an agent to agent exchange. No dash punctuation. */
function nestedExchangeLabel(count: number): string {
  return count === 1
    ? tNow("kernel.threadsUi.betweenAgentsOne")
    : tNow("kernel.threadsUi.betweenAgentsMany", { count })
}

/**
 * The copy table row for the agent context boundary (P4c-T51, A50): after a
 * cold resume the chat still shows the whole conversation while the agent is
 * fed the brief plus the tail, and this line is where that boundary sits.
 * spec.md's wording, byte for byte. No dash punctuation.
 *
 * The wording lives in the kernel catalog (`kernel.dock.contextBoundary`) in
 * every shipped locale, so the caller passes its translator in.
 */
/**
 * THE READER HAS TO SEE THE BOUNDARY (surface 19). The row renders in place,
 * which on a long conversation is thousands of pixels above the fold: the view
 * opens at the bottom, so the one marker that says where the agent's own view
 * of the conversation starts was never on screen. This is the compact notice
 * that rides at the top of the viewport while the row is above it, and says how
 * far up it is.
 */
export function agentContextBoundaryAboveLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  count: number,
): string {
  return count === 1
    ? t("kernel.dock.contextBoundaryAboveOne")
    : t("kernel.dock.contextBoundaryAboveMany", { count })
}

export function agentContextBoundaryLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  agentName: string,
): string {
  return t("kernel.dock.contextBoundary", { name: agentName })
}

/**
 * WHO IS TALKING, WHILE THEY TALK.
 *
 * A room that names two agents streams two blocks at once (A29/A30), and the
 * blocks carried the acting agent only as `data-agent-id`: on screen the two
 * were identical until their rows landed, so a reader watching two turns could
 * not tell which answer was whose. The header is the landed agent row's, one
 * step smaller: the same avatar disc, the same accent name, the same badge.
 */
export const LiveTurnHeader: Component<{ agentId: string | null }> = (props) => {
  const i18n = useI18n()
  const display = () => getAgentDisplay(props.agentId)
  const name = () =>
    display()?.name || display()?.handle || localizeAgentName(PERSONAL_AGENT_DISPLAY_NAME)
  return (
    <div
      class="mb-1 flex items-center gap-2"
      data-testid="agent-stream-author"
      data-agent-id={props.agentId ?? ""}
    >
      <div
        class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-medium"
        style={agentAvatarStyle(props.agentId)}
      >
        <AvatarImage
          url={display()?.avatarUrl}
          class="h-full w-full object-cover"
          fallback={<AgentGlyph />}
        />
      </div>
      <span class="text-[13px] font-semibold text-accent" data-testid="agent-stream-author-name">
        {name()}
      </span>
      <span class="rounded bg-accent/10 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-accent/80">
        {i18n.t("kernel.threadsUi.agent")}
      </span>
    </div>
  )
}

/** The message scrollport's padding: its bottom reserves the dock (LIF-3). */
export const MESSAGE_SCROLL_CLASS = "px-4 pt-3 pb-dock-window-clearance"

/** A pane outside the main panel: an offset no dock clearance can exceed. */
const DOCK_PANE_OUTSIDE = 100_000

/**
 * How far the pane's bottom edge sits above the main panel's, in px (never
 * negative). The pane reserves the dock clearance minus this distance.
 */
export function dockPaneOffset(paneBottom: number, panelBottom: number): number {
  return Math.max(0, Math.round(panelBottom - paneBottom))
}

/** Where the flat item list reads its thread and its context boundary from. */
interface MessageItemsSource {
  threadId: string
  agentContextFrom?: string | null
  agentContextAgentName?: string | null
}

/**
 * The thread's messages as the list draws them: grouped in the store, then
 * flattened with date separators, hidden-run markers and the agent context
 * boundary. Shared by every surface that renders a thread's stream (the
 * thread view's list, a task's discussion).
 */
export function createMessageItems(props: MessageItemsSource) {
  // Grouped in the STORE (P3b-T14): a nested agent to agent message is carried
  // on its parent's entry rather than emitted as a top level row, so the flat
  // human facing sequence is unchanged and nothing reorders.
  const groups = createMemo(() => getGroupedMessages(props.threadId))
  const messages = createMemo(() => groups().map((g) => g.msg))

  // Build flat item list: interleave date separators and messages.
  //
  // `<For>` reconciles by REFERENTIAL identity of each array element, so a fresh
  // `{ kind, msg, grouped }` wrapper per message on every recompute makes it
  // dispose and recreate EVERY row on any store change (a new message, an edit).
  // Rebuilt rows remount their children — including an inline ApprovalCard,
  // which then re-runs its mount effects and visibly flickers on each new agent
  // message. Reuse the previous wrapper whenever its identity-bearing fields are
  // unchanged (message proxy identity + grouped flag, or date label) so `<For>`
  // only touches rows that actually changed and stable rows stay mounted.
  let itemCache = new Map<string, FlatItem>()
  const items = createMemo((): FlatItem[] => {
    const grouping = groups()
    const msgs = grouping.map((g) => g.msg)
    const nextCache = new Map<string, FlatItem>()
    const result: FlatItem[] = []
    const boundaryAfter = props.agentContextFrom ?? null
    const boundaryAgent = props.agentContextAgentName ?? null
    let lastDate = ""
    // Gaps the server reported for this viewer, keyed by the visible message
    // they follow. A run anchored to nothing opens the page.
    const runsAfter = new Map<string, number>()
    let leadingRun = 0
    for (const run of getHiddenRuns(props.threadId)) {
      if (run.afterMessageId === null) leadingRun += run.count
      else runsAfter.set(run.afterMessageId, (runsAfter.get(run.afterMessageId) ?? 0) + run.count)
    }
    const pushHidden = (key: string, count: number) => {
      const cached = itemCache.get(key)
      const item: FlatItem =
        cached && cached.kind === "hidden" && cached.count === count
          ? cached
          : { kind: "hidden", count }
      nextCache.set(key, item)
      result.push(item)
    }
    if (leadingRun > 0) pushHidden("hidden:top", leadingRun)
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const dateStr = new Date(msg.createdAt).toDateString()
      if (dateStr !== lastDate) {
        const label = formatDate(msg.createdAt)
        const key = `date:${dateStr}`
        const prev = itemCache.get(key)
        const item: FlatItem =
          prev && prev.kind === "date" && prev.label === label ? prev : { kind: "date", label }
        nextCache.set(key, item)
        result.push(item)
        lastDate = dateStr
      }
      const prev = i > 0 ? msgs[i - 1] : null
      // After a date separator, the message is never grouped
      const isAfterDateSep = result.length > 0 && result[result.length - 1].kind === "date"
      // NEVER ACROSS A NESTED EXCHANGE. The "between agents" block renders under
      // the previous row, so a row grouped onto that author read, headerless,
      // as a line of the block (a person's second question, 12 s after their
      // first, sat glued under the agents' exchange with no name on it).
      const prevHasNested = i > 0 && grouping[i - 1].nested.length > 0
      const grouped = !isAfterDateSep && !prevHasNested && shouldGroup(prev, msg)
      const key = `msg:${msg.id}`
      const cached = itemCache.get(key)
      const nested = grouping[i].nested
      const item: FlatItem =
        cached &&
        cached.kind === "msg" &&
        cached.msg === msg &&
        cached.grouped === grouped &&
        cached.nested.length === nested.length
          ? cached
          : { kind: "msg", msg, grouped, nested }
      nextCache.set(key, item)
      result.push(item)
      const runAfter = runsAfter.get(msg.id)
      if (runAfter) pushHidden(`hidden:${msg.id}`, runAfter)
      // The checkpoint COVERS `uptoMessageId`, so the boundary follows it:
      // everything above the row is what the agent reads as a summary.
      if (boundaryAfter && boundaryAgent && msg.id === boundaryAfter) {
        const key = `boundary:${boundaryAfter}`
        const cachedBoundary = itemCache.get(key)
        const item: FlatItem =
          cachedBoundary &&
          cachedBoundary.kind === "context-boundary" &&
          cachedBoundary.agentName === boundaryAgent
            ? cachedBoundary
            : { kind: "context-boundary", uptoMessageId: boundaryAfter, agentName: boundaryAgent }
        nextCache.set(key, item)
        result.push(item)
      }
    }
    itemCache = nextCache
    return result
  })
  return { groups, messages, items }
}

export interface MessageStreamProps {
  threadId: string
  currentUserId: string
  /** The flat list, from `createMessageItems`. */
  items: FlatItem[]
  isApprovalThread?: boolean
  agentModelId?: string | null
  agentReasoningLevels?: Record<string, string>
  hasPurchasedCredits?: boolean
  availableModelIds?: Set<string> | null
  onSelectAgentModel?: (modelId: string | null) => void
  onSelectReasoning?: (modelId: string, level: ReasoningLevel) => void
  /** Draws "Reply in thread" and the reply summaries (S10). A surface with no
   *  reply panel leaves it out. */
  onReplyInThread?: (rootId: string) => void
  onQuoteClick?: (quote: MessageQuote) => void
  /** The element holding the rows, for a host that observes their growth. */
  listRef?: (el: HTMLDivElement) => void
  /** Test ids an embedding surface gives the list, each message row and each
   *  message body. */
  listTestId?: string
  rowTestId?: (messageId: string) => string
  contentTestId?: string
}

/**
 * THE CONVERSATION ITSELF, WHEREVER IT IS SHOWN. The rows (each agent message
 * with its tool-call rows, thinking block, citations and inline approval
 * cards) and every live turn (streaming text, tool calls as they run, the
 * local turn with its stop control). No scroller and no empty state: the host
 * owns those. A task's discussion is the same thread, posted to through the
 * same route, and an agent tagged there runs the same turn, so it shows the
 * turn exactly as the thread view does.
 */
export const MessageStream: Component<MessageStreamProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const handleMentionDelegate = createMentionDelegate(api)
  // A relative path in a message resolves against this conversation's local
  // session folder, read once per render (untracked, so a change of the
  // shell's state does not rebuild every message).
  // An embedding surface may name the body of each message for its own tests
  // and tours (the task discussion's `task-discussion.message-body`).
  const renderMessageContent = (content: string) => {
    const body = renderContent(
      localizeAgentNotice(content, i18n.t, null, { withDetail: true }),
      handleMentionDelegate,
      {
        localPathBase: untrack(() => localFolderFor(props.threadId)),
      },
    )
    return props.contentTestId ? (
      <div data-testid={props.contentTestId} class="contents">
        {body}
      </div>
    ) : (
      body
    )
  }
  const messages = () => props.items.flatMap((item) => (item.kind === "msg" ? [item.msg] : []))
  const agentStream = () => getAgentStream(props.threadId)
  /**
   * EVERY agent streaming into this room right now. A message that names two
   * agents gives both a turn (A29/A30), so a room can carry two live blocks at
   * once; it used to draw one, and the second agent showed no state at all.
   */
  const liveStreams = () =>
    // A turn answering in a reply thread streams in that thread's panel (A7).
    // A turn refused before it ran, with nothing of its own, is said by the
    // conversation's refusal line: no empty block with the agent's name beside
    // it (turn-refusal.ts).
    getLiveAgentStreams(props.threadId).filter(
      (run) => !run.stream.replyRootId && !refusedTurnIsEmpty(props.threadId, run.stream),
    )

  /**
   * A TURN RUNNING ON THIS MACHINE IS STILL A TURN (P6d-FX3, W7).
   *
   * The block below mounted on `agentStream().state !== "idle"`, which is the
   * SERVER's stream for this conversation. A local session runs the turn on
   * the operator's own machine and opens no server stream at all, so the block
   * never mounted: the tool activity rows had nowhere to render and, with
   * them, the inline permission card. The turn then sat blocked on a prompt
   * the window could not draw, which is the whole live surface of this slice
   * dead in the product.
   *
   * Scoped to THIS conversation the same way the rows themselves are (A32): a
   * session claimed for another DM is none of this thread's business.
   */
  const localTurnLive = () =>
    isDesktop() &&
    localSessionFor(props.threadId, desktopState().agentId) &&
    (desktopState().toolActivity.length > 0 || desktopState().pendingPermissions.length > 0)
  const currentUser = () => {
    const token = userFromToken()
    return token ? { id: token.userId, name: token.name } : undefined
  }
  const isAdmin = () => userFromToken()?.scopes?.includes("*") ?? false

  // Approval threads embed the live ApprovalCard inline at each "approval-created"
  // message (mirroring how agent chats render a gated tool call). New/live messages
  // carry the approval requestId in metadata directly and need no lookup; only
  // messages predating that stamp must resolve their handle via the thread's
  // /approvals list. Gate the fetch on there being such an unresolved message (so
  // normal threads — and fully-stamped approval threads — never touch /approvals)
  // and re-key on the count so a newly-arrived unresolved approval refetches.
  const unresolvedApprovalCount = createMemo(() =>
    props.isApprovalThread
      ? messages().filter(
          (m) =>
            m.authorType === "system" &&
            m.metadata?.type === "approval-created" &&
            !m.metadata?.requestId,
        ).length
      : 0,
  )
  const [approvalHandleIndex] = createResource(
    () =>
      unresolvedApprovalCount() > 0 ? { id: props.threadId, n: unresolvedApprovalCount() } : null,
    async (key) => {
      const res = await api.getEnvelope<ApprovalRequestSummary[]>(`/approvals?threadId=${key.id}`)
      return new Map(res.data.map((a) => [a.handle, a.id] as const))
    },
  )
  // Never suspends: a refetch here would blank the whole tab (see settledValue).
  const resolveApprovalId = (handle: string | undefined): string | undefined =>
    handle ? settledValue(approvalHandleIndex)?.get(handle) : undefined

  return (
    <>
      <Show when={props.items.length > 0}>
        {/* Natural document flow — the loaded window is a bounded page (last N
            messages + older pages fetched on scroll-up), so rows lay out at
            their true heights. No absolute positioning / estimate-based
            virtualization, which mis-measured variable-height messages and
            stacked them at wrong offsets. The bottom anchor observes this
            container so late-loading images re-pin a follower to the bottom. */}
        <div ref={(el) => props.listRef?.(el)} data-testid={props.listTestId} class="flex flex-col">
          <For each={props.items}>
            {(item, index) => (
              <div
                data-index={index()}
                data-testid={
                  item.kind === "msg" && props.rowTestId ? props.rowTestId(item.msg.id) : undefined
                }
              >
                <Show when={item.kind === "date"}>
                  <div class="flex items-center gap-3 py-3">
                    <div class="h-px flex-1 bg-border-subtle" />
                    <span class="text-[11px] font-medium text-text-tertiary">
                      {(item as FlatItem & { kind: "date" }).label}
                    </span>
                    <div class="h-px flex-1 bg-border-subtle" />
                  </div>
                </Show>

                <Show when={item.kind === "hidden"}>
                  <div data-testid="hidden-messages-marker" class="flex items-center gap-3 py-2">
                    <div class="h-px flex-1 bg-border-subtle" />
                    <span class="text-[11px] font-medium text-text-tertiary">
                      {hiddenMessagesLabel((item as FlatItem & { kind: "hidden" }).count)}
                    </span>
                    <div class="h-px flex-1 bg-border-subtle" />
                  </div>
                </Show>

                {/* Not a message: no author, no actions, no selection, and
                    nothing of it is ever sent to the agent. It only marks where
                    the agent's own view of this conversation resumes. */}
                <Show when={item.kind === "context-boundary"}>
                  <div
                    data-testid="agent-context-boundary"
                    data-upto-message-id={
                      (item as FlatItem & { kind: "context-boundary" }).uptoMessageId
                    }
                    class="flex select-none items-center gap-3 py-2"
                  >
                    <div class="h-px flex-1 bg-border-subtle" />
                    <span class="text-[11px] text-text-tertiary">
                      {agentContextBoundaryLabel(
                        i18n.t,
                        (item as FlatItem & { kind: "context-boundary" }).agentName,
                      )}
                    </span>
                    <div class="h-px flex-1 bg-border-subtle" />
                  </div>
                </Show>

                <Show when={item.kind === "msg"}>
                  <MessageRow
                    agentReasoningLevels={props.agentReasoningLevels}
                    onSelectReasoning={props.onSelectReasoning}
                    message={(item as FlatItem & { kind: "msg" }).msg}
                    grouped={(item as FlatItem & { kind: "msg" }).grouped}
                    currentUserId={props.currentUserId}
                    isAdmin={isAdmin()}
                    agentModelId={props.agentModelId}
                    hasPurchasedCredits={props.hasPurchasedCredits}
                    availableModelIds={props.availableModelIds}
                    onSelectAgentModel={props.onSelectAgentModel}
                    onEdit={(msg) => editMessage(api, props.threadId, msg.id, msg.content!)}
                    onDelete={(messageId) => deleteMessage(api, props.threadId, messageId)}
                    onReaction={(messageId, emoji) =>
                      addReaction(api, props.threadId, messageId, emoji, currentUser())
                    }
                    onRemoveReaction={(messageId, emoji) =>
                      removeReaction(api, props.threadId, messageId, emoji, currentUser())
                    }
                    renderContent={renderMessageContent}
                    isApprovalThread={props.isApprovalThread}
                    resolveApprovalId={resolveApprovalId}
                    onReplyInThread={props.onReplyInThread}
                    onQuoteClick={props.onQuoteClick}
                    quoteSurfaceKey={quoteSurfaceKey(props.threadId)}
                  />
                  <Show when={(item as FlatItem & { kind: "msg" }).nested.length > 0}>
                    <div class="ml-10 border-l border-border-subtle pl-3">
                      <button
                        type="button"
                        data-testid="nested-exchange-toggle"
                        class="py-1 text-[12px] text-text-tertiary hover:text-text-secondary"
                        onClick={() =>
                          toggleNestedExpanded((item as FlatItem & { kind: "msg" }).msg.id)
                        }
                      >
                        {nestedExchangeLabel((item as FlatItem & { kind: "msg" }).nested.length)}
                      </button>
                      <Show when={isNestedExpanded((item as FlatItem & { kind: "msg" }).msg.id)}>
                        <div data-testid="nested-exchange">
                          <For each={(item as FlatItem & { kind: "msg" }).nested}>
                            {(child) => (
                              <div
                                data-nested-depth={child.depth}
                                style={{ "padding-left": `${(child.depth - 1) * 12}px` }}
                              >
                                <MessageRow
                                  agentReasoningLevels={props.agentReasoningLevels}
                                  onSelectReasoning={props.onSelectReasoning}
                                  message={child.msg}
                                  grouped={false}
                                  currentUserId={props.currentUserId}
                                  isAdmin={isAdmin()}
                                  agentModelId={props.agentModelId}
                                  hasPurchasedCredits={props.hasPurchasedCredits}
                                  availableModelIds={props.availableModelIds}
                                  onSelectAgentModel={props.onSelectAgentModel}
                                  onEdit={(msg) =>
                                    editMessage(api, props.threadId, msg.id, msg.content!)
                                  }
                                  onDelete={(messageId) =>
                                    deleteMessage(api, props.threadId, messageId)
                                  }
                                  onReaction={(messageId, emoji) =>
                                    addReaction(
                                      api,
                                      props.threadId,
                                      messageId,
                                      emoji,
                                      currentUser(),
                                    )
                                  }
                                  onRemoveReaction={(messageId, emoji) =>
                                    removeReaction(
                                      api,
                                      props.threadId,
                                      messageId,
                                      emoji,
                                      currentUser(),
                                    )
                                  }
                                  renderContent={renderMessageContent}
                                  isApprovalThread={props.isApprovalThread}
                                  resolveApprovalId={resolveApprovalId}
                                  onQuoteClick={props.onQuoteClick}
                                  quoteSurfaceKey={quoteSurfaceKey(props.threadId)}
                                />
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </Show>
                  <Show when={withheldItems((item as FlatItem & { kind: "msg" }).msg)}>
                    {(items) => (
                      <WithheldCapabilityCard
                        api={api}
                        threadId={props.threadId}
                        messageId={(item as FlatItem & { kind: "msg" }).msg.id}
                        agentId={(item as FlatItem & { kind: "msg" }).msg.authorAgentId}
                        items={items()}
                        onContinueInDm={(threadId) =>
                          openAgentDm(
                            threadId,
                            (item as FlatItem & { kind: "msg" }).msg.authorAgentId,
                          )
                        }
                      />
                    )}
                  </Show>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* ONE BLOCK PER LIVE RUN. A local turn runs on the operator's own
          machine and opens no server stream, so it gets a block of its own
          when nothing else is streaming. */}
      <For each={liveStreams()}>
        {(run) => (
          <div class="px-1 py-2" data-testid="agent-stream-block" data-agent-id={run.agentId ?? ""}>
            <LiveTurnHeader agentId={run.agentId} />
            <Show
              when={run.stream.content || run.stream.toolCalls.length > 0 || run.stream.reasoning}
            >
              <AgentTurnBlock
                mode="expanded"
                toolCalls={run.stream.toolCalls}
                content={run.stream.content}
                reasoning={run.stream.reasoning}
                reasoningStreaming={run.stream.reasoningStreaming}
                timeline={run.stream.timeline}
                renderText={renderMessageContent}
                isStreaming={run.stream.state === "streaming"}
                isLastMessage={true}
                threadId={props.threadId}
                turnId={run.stream.turnId}
                askId={run.stream.askId}
              />
            </Show>
            {/* A refusal the conversation already says as its system line is not
                repeated here (turn-refusal.ts). */}
            <Show
              when={
                run.stream.state === "error" &&
                run.stream.error &&
                !refusalShownInThread(props.threadId, run.stream.error.message)
              }
            >
              <div
                data-testid="agent-stream-error"
                class="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-[12px] text-red-400"
              >
                {run.stream.error?.message}
              </div>
            </Show>
          </div>
        )}
      </For>
      {/* A NEW LOCAL SESSION BECAUSE THE AGENT CHANGED (2026-09-23). The
          shell resumes a session only under the definition it was created
          with; this says, quietly, why the agent may not remember the local
          work of the session before. Gone once that session's first turn ends. */}
      <Show when={isDesktop() ? localFreshSessionFor(props.threadId) : null}>
        <div
          data-testid="local-session-fresh"
          role="status"
          class="mx-1 my-2 text-center text-[12px] text-text-tertiary"
        >
          {i18n.t("kernel.desktopUi.freshSession.definitionChanged")}
        </div>
      </Show>

      <Show when={liveStreams().length === 0 && localTurnLive()}>
        <div class="px-1 py-2" data-testid="agent-stream-block">
          {/* THE AGENT THE SESSION RUNS AS, not null: null fell back to
              "Personal agent" for every local turn, a Data DM included. */}
          <div class="flex items-center justify-between gap-2">
            <LiveTurnHeader agentId={desktopState().agentId} />
            {/* A LOCAL TURN CAN ALWAYS BE STOPPED, including one parked on a
                permission question: the sidecar answers the question no and
                interrupts the SDK. Without it a turn blocked on an unseen
                prompt had no way out but quitting the app. */}
            <Show when={desktopState().turnActive || desktopState().pendingPermissions.length > 0}>
              <button
                type="button"
                data-testid="local-turn-stop"
                aria-label={i18n.t("kernel.desktopUi.stopTurn.label")}
                class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium text-text-secondary hover:bg-surface-hover hover:text-text"
                onClick={() => void interruptLocalTurn()}
              >
                <Square size={11} class="shrink-0" />
                <span>{i18n.t("kernel.desktopUi.stopTurn.action")}</span>
              </button>
            </Show>
          </div>
          <AgentTurnBlock
            mode="expanded"
            toolCalls={agentStream().toolCalls}
            content={agentStream().content}
            reasoning={agentStream().reasoning}
            reasoningStreaming={agentStream().reasoningStreaming}
            // The ROWS outlive the turn, the turn does not: the rows are the
            // only place a local turn's calls are drawn, so the block stays
            // after `turn_done`, and reading it as still streaming is what
            // left a finished turn saying "Generating..." for ever.
            isStreaming={desktopState().turnActive}
            localTurnRows={true}
            isLastMessage={true}
            threadId={props.threadId}
          />
        </div>
      </Show>

      {/* A LOCAL TURN THAT DIED WITH ITS SIDECAR (2026-09-23). The shell
          ended the session and released the claim; without this the message
          simply never got a reply and nothing on screen said why. Retry
          starts the session again and runs the same message. */}
      <Show when={isDesktop() ? localTurnFailureFor(props.threadId) : null}>
        {(failure) => (
          <div
            data-testid="local-turn-failed"
            role="alert"
            class="mx-1 my-2 flex items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-[12px] text-red-400"
          >
            <span class="min-w-0 break-words" data-failure-kind={failure().kind ?? "stopped"}>
              {failure().kind === "undelivered"
                ? i18n.t("kernel.desktopUi.turnFailed.undelivered", { reason: failure().reason })
                : i18n.t("kernel.desktopUi.turnFailed.message", { reason: failure().reason })}
            </span>
            <button
              type="button"
              data-testid="local-turn-retry"
              aria-label={
                failure().kind === "undelivered"
                  ? i18n.t("kernel.desktopUi.turnFailed.retryUndeliveredLabel")
                  : i18n.t("kernel.desktopUi.turnFailed.retryLabel")
              }
              class="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-[12px] text-text hover:bg-surface-hover"
              onClick={() => void retryLocalTurn(props.threadId)}
            >
              {i18n.t("kernel.desktopUi.turnFailed.retry")}
            </button>
          </div>
        )}
      </Show>
    </>
  )
}

const MessageList: Component<MessageListProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const isTabActive = useTabIsActive()
  let containerRef!: HTMLDivElement
  // "Following the newest message" — STICKY: cleared only by a deliberate
  // upward user scroll, never by content growth. Async previews/thumbnails grow
  // rows *without* firing a scroll event, so recomputing this purely from the
  // current gap would flip it false mid-load and strand the viewport above the
  // bottom. Latching on scroll *direction* keeps "following" stable.
  let isNearBottom = true
  let lastScrollTop = 0
  let parkedScrollTop = 0
  /**
   * SOMETHING HAPPENED BELOW THE FOLD. Set when a turn adds to the view while
   * the reader has scrolled up (so the view does not follow), cleared when the
   * bottom is reached again. It draws the "new activity" button: a local turn
   * running for ten minutes under a reader who scrolled up once looked, from
   * where she sat, like nothing at all.
   */
  const [newActivityBelow, setNewActivityBelow] = createSignal(false)

  // Grouped in the STORE (P3b-T14), flattened with date separators, hidden
  // runs and the context boundary (createMessageItems).
  const { messages, items } = createMessageItems(props)
  const agentStream = () => getAgentStream(props.threadId)
  const [boundaryAbove, setBoundaryAbove] = createSignal(false)
  /** How far back the boundary row is: the messages that follow it. */
  const messagesAfterBoundary = createMemo(() => {
    const upto = props.agentContextFrom ?? null
    if (!upto) return 0
    const list = messages()
    const idx = list.findIndex((m) => m.id === upto)
    if (idx < 0) return 0
    return list.length - idx - 1
  })
  const loading = () => messageStore.loading[props.threadId] ?? false
  /** A run that is still going. An ERRORED run is over, so an empty room after
   *  one says "No messages yet" rather than nothing at all. */
  const anyRunLive = () =>
    agentStream().state !== "idle" &&
    agentStream().state !== "error" &&
    agentStream().state !== "complete"
  function scrollToBottom() {
    if (containerRef) containerRef.scrollTop = containerRef.scrollHeight
  }

  // Re-anchor to the newest message whenever content grows *after* it was laid
  // out — image previews / thumbnails resolve asynchronously and change row
  // heights below the fold, which the browser's own scroll anchoring does not
  // pull downward. A plain scrollTop write is idempotent and loop-free (it
  // changes no content height, so it never re-triggers this observer);
  // correctness comes from the sticky `isNearBottom`, which growth never clears.
  function pinToBottomIfFollowing() {
    if (!containerRef || !isTabActive() || !isNearBottom) return
    const bottom = containerRef.scrollHeight - containerRef.clientHeight
    if (containerRef.scrollTop < bottom) containerRef.scrollTop = bottom
  }
  const bottomAnchorObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => pinToBottomIfFollowing())
      : undefined
  /**
   * THE PIN LANDS ON THE FRAME THAT GROWS (walk 3). The ResizeObserver above
   * re-pins after the frame has laid the growth out, and the follow effects
   * wait for the next animation frame, so a new row, a composer taking a row
   * of staged files or an image that decoded showed 55-180px below the fold
   * for one frame. A mutation observer's callback runs as a microtask right
   * after the task that changed the DOM, and a `load` event is its own task:
   * both come before the next frame, so re-pinning there (reading the layout
   * forces it) means no frame ever shows the gap. The ResizeObserver stays as
   * the backstop for growth neither sees (a font, a viewport resize).
   */
  const sameFramePin =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => pinToBottomIfFollowing())
      : undefined
  const pinOnLoad = () => pinToBottomIfFollowing()

  function handleScroll() {
    const { scrollTop, scrollHeight, clientHeight } = containerRef
    parkedScrollTop = scrollTop
    const gap = scrollHeight - scrollTop - clientHeight
    const scrolledUp = scrollTop < lastScrollTop - 1
    lastScrollTop = scrollTop
    if (scrolledUp && gap > 1) {
      // Deliberate upward scroll away from the bottom → stop following, at
      // once, even inside the near-bottom band. Checked first: a small step
      // (a trackpad) lands inside the band, and a reader still counted as
      // following there was re-pinned by the next DOM change (the scroll
      // fade's own class flip on that very step), so she could never leave.
      // Gaps that open from content growth (scrollTop unchanged) never land
      // here, and a clamp from shrinking content leaves no gap.
      isNearBottom = false
    } else if (gap < NEAR_BOTTOM_THRESHOLD) {
      // Reached (or re-reached) the bottom → resume following.
      isNearBottom = true
      setNewActivityBelow(false)
    }

    measureContextBoundary()

    // Prefetch older messages when scrolling near the top.
    if (
      scrollTop < NEAR_TOP_THRESHOLD &&
      messageStore.hasMore[props.threadId] &&
      !messageStore.loadingMore[props.threadId]
    ) {
      fetchOlderMessages()
    }
  }

  /**
   * IS THE BOUNDARY ROW ABOVE THE FOLD? Measured against the scrollport, not
   * against the document: the row sits in natural flow inside the list and the
   * view opens at the bottom, so on a long conversation it is thousands of
   * pixels up and the reader never meets it. While it is above the top edge the
   * notice rides at the top of the viewport instead.
   */
  function measureContextBoundary(): void {
    if (!containerRef) {
      setBoundaryAbove(false)
      return
    }
    const row = containerRef.querySelector('[data-testid="agent-context-boundary"]')
    if (!row) {
      setBoundaryAbove(false)
      return
    }
    setBoundaryAbove(row.getBoundingClientRect().bottom < containerRef.getBoundingClientRect().top)
  }

  /** Put the boundary row on screen. */
  function scrollToContextBoundary(): void {
    const row = containerRef?.querySelector(
      '[data-testid="agent-context-boundary"]',
    ) as HTMLElement | null
    if (!row) return
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center" })
    } else if (containerRef) {
      containerRef.scrollTop = row.offsetTop
    }
    isNearBottom = false
  }

  async function fetchOlderMessages() {
    const prevScrollHeight = containerRef.scrollHeight
    const prevScrollTop = containerRef.scrollTop

    await loadMoreMessages(api, props.threadId)

    // Preserve the reading position after prepending older messages — the
    // content above shifted down by exactly the height of the new page. In
    // natural flow the heights are real, so this delta is exact.
    requestAnimationFrame(() => {
      if (!containerRef) return
      const delta = containerRef.scrollHeight - prevScrollHeight
      if (delta > 0) containerRef.scrollTop = prevScrollTop + delta
    })
  }

  /** S10: "Reply in thread", the summary under a root, a reply's "view thread". */
  function openReplies(rootId: string): void {
    openReplyPanel(props.threadId, rootId)
  }

  /** S14: to the quoted message, loading older pages if it is above the window. */
  /** Resolves once the channel's first page is in (a jump asked for while the
   *  tab was still opening), or after five seconds regardless. */
  async function firstPageLoaded(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (messageStore.threads[props.threadId] && !messageStore.loading[props.threadId]) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  async function jumpInChannel(messageId: string): Promise<void> {
    await firstPageLoaded()
    isNearBottom = false
    await jumpToMessage({
      container: () => containerRef,
      messageId,
      hasMore: () => messageStore.hasMore[props.threadId] ?? false,
      loadMore: () => loadMoreMessages(api, props.threadId),
      onMissing: () =>
        addToast({ message: i18n.t("kernel.replyThreads.messageNotFound"), type: "warning" }),
    })
  }

  function handleQuoteClick(q: MessageQuote): void {
    // A source that is a reply lives in its thread's panel.
    if (q.replyRootId) {
      openReplyPanel(props.threadId, q.replyRootId, { focusMessageId: q.messageId })
      return
    }
    void jumpInChannel(q.messageId)
  }

  // A jump asked for from elsewhere (a quote in the reply panel, a search hit).
  createEffect(
    on(channelJumpRequest, (req) => {
      if (!req || req.threadId !== props.threadId) return
      consumeChannelJump(req)
      requestAnimationFrame(() => void jumpInChannel(req.messageId))
    }),
  )

  // The view OPENS at the bottom, so the first measurement cannot wait for a
  // scroll: on a long conversation the row is already thousands of pixels up
  // when the thread is opened and no scroll event ever fires.
  createEffect(
    on(
      () => [items().length, props.agentContextFrom] as const,
      () => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(measureContextBoundary)
        } else {
          measureContextBoundary()
        }
      },
    ),
  )

  /**
   * THE LAST MESSAGE ENDS ABOVE THE DOCK (LIF-3). The pane reserves what
   * floats over the main panel's bottom right corner (pb-dock-window-clearance,
   * index.css): the dock strip, or the open dock window. The list usually
   * ends above its composer, which already clears the strip, so it publishes
   * how far its bottom sits above the panel's and reserves only the rest.
   * Outside the main panel (the dock's own window, the Chats sheet) nothing
   * floats over it and it reserves nothing.
   */
  function measureDockOffset() {
    if (!containerRef) return
    const panel = containerRef.closest<HTMLElement>('[data-testid="main-panel"]')
    const inPanel = panel !== null && containerRef.closest("[data-dock-window]") === null
    const offset = inPanel
      ? dockPaneOffset(
          containerRef.getBoundingClientRect().bottom,
          panel.getBoundingClientRect().bottom,
        )
      : DOCK_PANE_OUTSIDE
    const value = `${offset}px`
    if (containerRef.style.getPropertyValue("--dock-pane-offset") === value) return
    containerRef.style.setProperty("--dock-pane-offset", value)
    // The reserve changed the scroll height: a follower stays on the newest line.
    pinToBottomIfFollowing()
  }
  const dockOffsetObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => measureDockOffset())
      : undefined

  // A dock window opening (or closing) over the pane changes its reserve; a
  // reader following the newest message keeps it in view above the window.
  createEffect(
    on(
      dockWindowOpen,
      () => {
        if (!isTabActive()) return
        requestAnimationFrame(() => {
          measureDockOffset()
          pinToBottomIfFollowing()
        })
      },
      { defer: true },
    ),
  )

  onMount(() => {
    containerRef.addEventListener("scroll", handleScroll, { passive: true })
    containerRef.addEventListener(APPROVAL_DECIDED_EVENT, followAfterDecision)
    measureDockOffset()
    dockOffsetObserver?.observe(containerRef)
    // The scrollport itself resizes too: a composer that grows (a staged file,
    // a second line) or shrinks takes its height from the list, with no
    // content change and no scroll event. A reader at the bottom stays there.
    bottomAnchorObserver?.observe(containerRef)
    // The host column (the list, the typing line and the composer: the
    // ScrollFade's parent) is where both growths start. Falls back to the
    // list alone when the list is mounted on its own.
    const host = containerRef.parentElement?.parentElement ?? containerRef
    sameFramePin?.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })
    // `load` does not bubble: caught on the way down.
    host.addEventListener("load", pinOnLoad, true)
    onCleanup(() => {
      containerRef.removeEventListener("scroll", handleScroll)
      containerRef.removeEventListener(APPROVAL_DECIDED_EVENT, followAfterDecision)
      bottomAnchorObserver?.disconnect()
      dockOffsetObserver?.disconnect()
      sameFramePin?.disconnect()
      host.removeEventListener("load", pinOnLoad, true)
    })
  })

  // On (re)activation, restore the viewport now that the container has real
  // layout (inactive tabs are display:none, so scroll can't be applied while
  // hidden): snap to the newest message if the user was following the bottom,
  // otherwise restore the parked position.
  createEffect(() => {
    if (!containerRef || !isTabActive()) return
    requestAnimationFrame(() => {
      if (!containerRef) return
      if (isNearBottom) scrollToBottom()
      else if (parkedScrollTop > 0) containerRef.scrollTop = parkedScrollTop
    })
  })

  // Follow the newest message when the item count changes (message sent /
  // received). rAF so freshly-rendered markdown/images are laid out first.
  createEffect(
    on(
      () => items().length,
      (len, prevLen) => {
        if (len === 0 || !isTabActive()) return
        if (prevLen == null || prevLen === 0 || isNearBottom) {
          requestAnimationFrame(scrollToBottom)
        }
      },
    ),
  )

  /**
   * A turn added something: follow it when the reader is following, say so
   * when she is not. Never yanks a reader who scrolled up to read.
   */
  function followActivity() {
    if (!isTabActive()) return
    if (isNearBottom) requestAnimationFrame(scrollToBottom)
    else setNewActivityBelow(true)
  }

  /** Back to the newest line, following again. */
  function jumpToNewActivity() {
    isNearBottom = true
    setNewActivityBelow(false)
    scrollToBottom()
  }

  /**
   * AN APPROVAL DECIDED HERE BRINGS THE CHAT BACK TO ITS NEWEST MESSAGE. The
   * reader scrolled up to the card (or a guided tour brought it into view),
   * which stopped the chat following; the agent's follow-up to her decision
   * then landed below the fold, behind "New activity below".
   */
  function followAfterDecision() {
    if (!isTabActive()) return
    isNearBottom = true
    setNewActivityBelow(false)
    requestAnimationFrame(scrollToBottom)
  }

  // Keep pinned to the bottom as an agent turn streams in.
  createEffect(
    on(
      () => [agentStream().content, agentStream().toolCalls.length, agentStream().state] as const,
      () => followActivity(),
    ),
  )

  /**
   * A TURN RUNNING ON THIS MACHINE MOVES THE VIEW TOO (2026-09-23).
   *
   * The effect above follows the SERVER's stream. A local turn draws its rows
   * from the shell's tool activity and its question from the shell's pending
   * prompts, neither of which it read, and its block sits outside the list the
   * bottom anchor observes. So a local turn grew below the fold: new rows, then
   * the permission card, with the view parked where it was. A Bash command sat
   * waiting on an Allow nobody could see for ten minutes.
   */
  const localActivity = () => {
    if (!isDesktop() || !localSessionFor(props.threadId, desktopState().agentId)) return ""
    const state = desktopState()
    return [
      state.turnActive ? "on" : "off",
      state.toolActivity.map((row) => `${row.id}:${row.status}`).join(","),
      state.pendingPermissions.map((prompt) => prompt.requestId).join(","),
    ].join("|")
  }
  createEffect(
    on(localActivity, (now) => {
      if (now !== "") followActivity()
    }),
  )

  /**
   * A QUESTION IS ALWAYS SEEN. Whatever the reader was doing, a new permission
   * prompt for this conversation brings its card into view: the turn is
   * stopped until someone answers it, and a card below the fold is a turn
   * stopped for ever.
   */
  const promptHere = () => {
    if (!isDesktop() || !localSessionFor(props.threadId, desktopState().agentId)) return null
    return currentLocalPrompt()?.requestId ?? null
  }
  createEffect(
    on(promptHere, (requestId) => {
      if (!requestId || !isTabActive()) return
      requestAnimationFrame(() => {
        const cards = containerRef?.querySelectorAll<HTMLElement>(
          '[data-testid="local-permission-card"]',
        )
        const card = Array.from(cards ?? []).find((el) => el.dataset.requestId === requestId)
        if (!card) return
        if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest" })
        // The card is the newest thing in the turn: the reader is at the
        // bottom again, and the rows after her answer follow.
        isNearBottom = true
        setNewActivityBelow(false)
      })
    }),
  )

  return (
    <ScrollFade
      class="min-h-0 flex-1"
      fadeColor="var(--color-bg)"
      scrollRef={(el) => {
        containerRef = el
      }}
      scrollTestId="message-scroll-container"
      scrollClass={MESSAGE_SCROLL_CLASS}
    >
      {/* THE BOUNDARY, WHERE THE READER IS (surface 19). The row itself stays
          in flow where it belongs; while it is above the fold this rides at the
          top of the scrollport and says how far up it is. Clicking it goes
          there. */}
      <Show when={boundaryAbove() && props.agentContextFrom && props.agentContextAgentName}>
        <button
          type="button"
          data-testid="agent-context-boundary-notice"
          class="sticky top-0 z-10 -mx-1 mb-1 flex w-[calc(100%+0.5rem)] items-center justify-center gap-2 rounded-md border border-border-subtle bg-surface/95 px-2 py-1 text-[11px] text-text-tertiary backdrop-blur hover:bg-surface-hover"
          onClick={scrollToContextBoundary}
        >
          {agentContextBoundaryAboveLabel(i18n.t, messagesAfterBoundary())}
        </button>
      </Show>

      <Show when={loading()}>
        <div class="flex items-center justify-center py-8 text-[13px] text-text-tertiary">
          {i18n.t("kernel.threadsUi.loadingMessages")}
        </div>
      </Show>

      <Show when={messageStore.loadingMore[props.threadId]}>
        <div class="flex items-center justify-center py-4 text-[12px] text-text-tertiary">
          {i18n.t("kernel.threadsUi.loadingOlderMessages")}
        </div>
      </Show>

      <MessageStream
        threadId={props.threadId}
        currentUserId={props.currentUserId}
        items={items()}
        isApprovalThread={props.isApprovalThread}
        agentModelId={props.agentModelId}
        agentReasoningLevels={props.agentReasoningLevels}
        hasPurchasedCredits={props.hasPurchasedCredits}
        availableModelIds={props.availableModelIds}
        onSelectAgentModel={props.onSelectAgentModel}
        onSelectReasoning={props.onSelectReasoning}
        onReplyInThread={openReplies}
        onQuoteClick={handleQuoteClick}
        listRef={(el) => bottomAnchorObserver?.observe(el)}
      />

      {/* A FAILED TURN IS NOT AN EMPTY ROOM. The messages this thread holds are
          rendered above whatever the turn did; when the LOAD itself failed
          there were no rows to render, no error line, and the empty state below
          was gated on the agent stream being idle, which a failed turn is not.
          So a failed turn showed the banner and the state line over a blank
          room, with the user's own message nowhere. The load error is now
          rendered, with the retry that recovers the rows. */}
      <Show when={messageStore.error[props.threadId] && !loading()}>
        <div
          data-testid="message-load-error"
          class="flex flex-col items-center justify-center gap-2 py-10 text-[13px] text-text-tertiary"
        >
          <span>{messageStore.error[props.threadId]}</span>
          <button
            type="button"
            class="rounded-md border border-border-subtle px-2 py-1 text-[12px] text-text hover:bg-surface-hover"
            onClick={() => void loadMessages(api, props.threadId, { userInitiated: true })}
          >
            {i18n.t("kernel.threadsUi.tryAgain")}
          </button>
        </div>
      </Show>

      <Show
        when={
          messages().length === 0 &&
          !loading() &&
          !messageStore.error[props.threadId] &&
          !anyRunLive()
        }
      >
        <div class="flex items-center justify-center py-16 text-[13px] text-text-tertiary">
          {i18n.t("kernel.threadsUi.noMessagesYetStartTheConversation")}
        </div>
      </Show>

      <AgentStateLabel threadId={props.threadId} />

      <QuoteSelection
        container={() => containerRef}
        surfaceKey={quoteSurfaceKey(props.threadId)}
        resolveMessage={(id) => getMessage(props.threadId, id)}
      />

      <Show when={newActivityBelow()}>
        <div class="pointer-events-none sticky bottom-2 z-10 flex justify-center">
          <button
            type="button"
            data-testid="new-activity-below"
            class="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-border bg-elevated px-3 py-1 text-[12px] font-medium text-text shadow-popover hover:bg-surface-hover"
            onClick={jumpToNewActivity}
          >
            <span>{i18n.t("kernel.threadsUi.newActivityBelow")}</span>
            <ArrowDown size={12} class="shrink-0" />
          </button>
        </div>
      </Show>
    </ScrollFade>
  )
}

export default MessageList
