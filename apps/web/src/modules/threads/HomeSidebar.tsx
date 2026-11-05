// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Home sidebar, A35 + A36.
//
// A35: a conversation with a TITLE is a channel (public when discoverable,
// private otherwise), a DIRECT MESSAGE has no title and is named by its people
// or by the agent it is a 1:1 with. A titled room stays a channel whatever its
// membership (amended 2026-10-12: a channel holding the viewer and their agent
// had taken the agent DM's head row); only an `agent_chat` keeps a title and
// stays a DM. The rule is `classifyConversation` in
// `@liaison/shared`, shared with the API's DM shape so the sidebar and the
// push fanout cannot drift apart. Nothing is renamed: legacy titled threads
// simply list under Channels.
//
// A36: one line per row. A hash or a lock for a channel, a face or the agent
// mark for a DM, the name, and ONE trailing slot. No preview line, no
// timestamp. The preview carried real information and losing it is the trade
// the mock priced (impl/ws06d-sidebar-mock.md); what is left has to be read
// as a directory rather than as an inbox.
//
// THE TRAILING SLOT IS ONE SLOT. The row this replaces put the agent profile
// control in an `absolute right-2` overlay while the relative timestamp sat at
// the same right edge in normal flow, so on an agent DM the little person
// glyph was drawn ON TOP of the time ("3" over the people icon, 6b walk
// capture 06). Everything trailing is now in flow, and the slot renders
// exactly one thing, in a fixed order: the unread count, else the pin, else
// the mute bell, else nothing. The participant count is gone from the list
// entirely: a DM is named by its people and a channel by its name, so the
// count belongs in the thread header where there is room to say it.
//
// AND ITS RIGHT EDGE IS THE SAME ON EVERY ROW. The agent profile control is a
// flow sibling of the row button, so a row that had one was 24 px narrower
// than a row that did not and its trailing slot ended 24 px early. Every row
// reserves the same box (`RowTrailingGutter`) whether or not anything goes in
// it, so the column of pills is true.
//
// A37: a role agent the member has no DM with is a row here too, one dimmed
// line, and pressing it opens or creates the DM through the same path the old
// two line invite card's button used.
//
// D32: the groups run Agents (the member's own agent, then the role agents),
// Direct messages, Channels (folded to a few rows), Followed threads. The
// order and the membership of each group are `chatSections` in
// thread-list-model.ts, shared with the phone Chats root.

import type { AttentionItem, FollowedReplyThread } from "@liaison/shared"
import {
  Archive,
  ArrowLeft,
  BellOff,
  ChevronDown,
  Hash,
  Lock,
  MessageSquareText,
  Pin,
  Plus,
  Search,
  User,
} from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { rovingFocus } from "~/lib/roving-focus"
import { userFromToken } from "~/modules/auth/auth-store"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { makeTabId, openTab, tabStore } from "~/modules/shell/tab-store"
import { closeTabletSidebar } from "~/modules/shell/tablet-sidebar-store"
import {
  type AgentDisplay,
  listAgentDirectory,
  loadAgentDirectory,
  openAgentPage,
  personalAgentFor,
} from "~/modules/threads/agent-directory"
import ChatsList, { moreChannelsLabel } from "~/modules/threads/ChatsList"
import { loadChannelSort, saveChannelSort } from "~/modules/threads/channel-list-prefs"
import {
  conversationDisplayName,
  conversationKind,
  namingAgentSeat,
  resolvedParticipants,
} from "~/modules/threads/conversation-display"
import {
  followedReplies,
  loadFollowedReplies,
  markFollowedReplyRead,
  splitFollowedReplies,
} from "~/modules/threads/followed-replies-store"
import {
  openNewChannelDialog,
  openNewMessageDialog,
} from "~/modules/threads/new-conversation-store"
import { ensurePersonalAgentDm, rememberPersonalAgentDm } from "~/modules/threads/personal-dm-store"
import { presenceStore } from "~/modules/threads/presence-store"
import { plainQuoteText } from "~/modules/threads/quote-excerpt"
import { RoleAgentRowFrame } from "~/modules/threads/RoleAgentRowFrame"
import { getOpenReplyPanel, openThreadWithReplyPanel } from "~/modules/threads/reply-panel-store"
import { sidebarMetrics } from "~/modules/threads/sidebar-density"
import {
  hydrateSidebarSections,
  isSectionCollapsed,
  type SidebarSectionId,
  toggleSectionCollapsed,
} from "~/modules/threads/sidebar-sections"
import { ThreadsLoadFailedNotice } from "~/modules/threads/ThreadsLoadFailedNotice"
import {
  type AgentRow,
  type ChannelMembership,
  type ChannelSort,
  capChannels,
  chatSections,
  type DiscoverableChannel,
  groupIsEmpty,
  needsReading,
  pickAgentDmThread,
  sortGroup,
  type ThreadGroup,
  threadMatchesQuery,
  unjoinedChannels,
} from "~/modules/threads/thread-list-model"
import {
  addThread,
  allThreads,
  archivedThreads,
  hideArchivedSidebar,
  loadingArchived,
  loadThreads,
  pinnedThreads,
  requestThreadReload,
  setThreadMuted,
  setThreadPinnedByUser,
  setThreadReloadHandler,
  showArchivedSidebar,
  sidebarArchivedView,
  type Thread,
  threadsLoadFailed,
  unpinnedThreads,
  userPinnedThreads,
} from "~/modules/threads/thread-store"
import { AgentGlyph } from "~/ui/AgentGlyph"
import { Avatar } from "~/ui/AvatarStack"
import { agentAvatarStyle } from "~/ui/avatar-palette"
import { ScrollFade } from "~/ui/ScrollFade"

/** Sidebar filter. Threads are grouped into Channels and Direct messages, so
 *  the only chip left is the cross-cutting "unread" one, applied within both
 *  groups rather than forming a group of its own. */
type ThreadFilter = "all" | "unread" | "mentions" | "muted"

// Mentions (D21): they left Home with the rest of the conversations, so
// Messages gets the filter that finds them: the conversations holding an
// unread mention of the viewer.
const FILTERS: Array<{ key: ThreadFilter; labelKey: string }> = [
  { key: "all", labelKey: "kernel.chatsFilterAll" },
  { key: "unread", labelKey: "kernel.chatsFilterUnread" },
  { key: "mentions", labelKey: "kernel.chatsFilterMentions" },
  { key: "muted", labelKey: "kernel.chatsFilterMuted" },
]

const CHANNEL_SORT_OPTIONS: Array<{ key: ChannelSort; labelKey: string }> = [
  { key: "recent", labelKey: "kernel.channelSortRecent" },
  { key: "name", labelKey: "kernel.channelSortName" },
  { key: "unread", labelKey: "kernel.channelSortUnread" },
]

const CHANNEL_MEMBERSHIP_OPTIONS: Array<{ key: ChannelMembership; labelKey: string }> = [
  { key: "all", labelKey: "kernel.channelMembershipAll" },
  { key: "in", labelKey: "kernel.channelMembershipIn" },
  { key: "not-in", labelKey: "kernel.channelMembershipNotIn" },
]

/** The conversations holding an unread mention of the viewer (attention feed:
 *  a mention row is keyed on its thread; one in a reply names its channel). */
export function mentionedThreadIds(items: readonly AttentionItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.kind !== "mention") continue
    const channel = item.metadata?.threadId
    ids.add(typeof channel === "string" && channel.length > 0 ? channel : item.entityId)
  }
  return ids
}

export interface HomeSidebarProps {
  /** "sidebar" (default) opens rows as tabs through the tab store. "dock"
   *  (P4c-T07) is the same list rendered inside the chat dock's Chats panel:
   *  a row click never opens a tab, it calls `onSelect` with the id instead
   *  and the dock decides what that means (`openConversation`). */
  variant?: "sidebar" | "dock"
  /** Required in "dock" variant. Called with a thread id in place of every
   *  conversation openTab call the sidebar variant would have made. The per-row
   *  agent-profile control is navigation, not a conversation: it keeps opening
   *  the profile in the main panel in both variants. */
  onSelect?: (id: string) => void
}

const HomeSidebar: Component<HomeSidebarProps> = (props) => {
  const i18n = useI18n()
  const variant = () => props.variant ?? "sidebar"
  const api = useApi()
  const [searchQuery, setSearchQuery] = createSignal("")
  const [activeFilter, setActiveFilter] = createSignal<ThreadFilter>("all")
  const [channelSort, setChannelSort] = createSignal<ChannelSort>(loadChannelSort())
  const [membership, setMembership] = createSignal<ChannelMembership>("all")
  function chooseChannelSort(sort: ChannelSort) {
    setChannelSort(sort)
    saveChannelSort(sort)
  }
  // M1-B T7: the Chats ROOT, which exists only inside the dock variant at
  // phone width. Everywhere else this component is still the directory.
  const phoneChats = () => (props.variant ?? "sidebar") === "dock" && shellTier() === "phone"
  const [discoverable, setDiscoverable] = createSignal<DiscoverableChannel[]>([])
  const [joining, setJoining] = createSignal<string | null>(null)
  // The agent directory, for the Agents group, read once it resolves.
  const [dmAgents, setDmAgents] = createSignal<AgentDisplay[]>([])
  const [startingDm, setStartingDm] = createSignal<string | null>(null)

  async function loadDiscoverable() {
    try {
      const res: any = await api.get("/threads/discoverable")
      const raw = res?.data ?? res
      setDiscoverable(Array.isArray(raw) ? (raw as DiscoverableChannel[]) : [])
    } catch {
      // An older backend has no such route: the Channels group simply shows
      // nothing to join rather than the sidebar failing to render.
      setDiscoverable([])
    }
  }

  // The list this sidebar has nothing to show without, asked for as an effect
  // rather than once at mount: when a load fails the store remembers it, and
  // when that memory lapses (the cool-down passed) this asks exactly once more.
  // Without it a sidebar that mounted while the API was refusing stayed empty
  // for the whole session unless a WebSocket event happened to wake it.
  //
  // What it tracks is the FAILURE and nothing else. Reading the thread list
  // here instead would loop on a workspace whose list is legitimately empty: a
  // successful load writes fresh arrays into the store, which re-runs whatever
  // reads it, the list is still empty, and the effect asks again on every round
  // trip. A latch answers "have we asked yet", which is the actual question.
  let askedForList = false
  createEffect(() => {
    if (threadsLoadFailed()) {
      // The refusal lapses, and this is allowed to ask exactly once more.
      askedForList = false
      return
    }
    if (askedForList) return
    // Another surface may have loaded the list already (startup does), and this
    // read must not be tracked or an arriving list would re-run the effect.
    // The ask reads the access token on its way out, so it is untracked too:
    // this effect depends on the remembered failure and on nothing else.
    if (untrack(() => allThreads().length) > 0) return
    askedForList = true
    untrack(() => {
      void loadThreads(api)
    })
  })

  // Nothing to show BECAUSE the list never arrived. Said out loud, with the
  // retry that recovers it: an empty column that is really a failed read used
  // to read as a workspace with no conversations in it.
  const listFailed = () => threadsLoadFailed() && allThreads().length === 0
  const [retryingThreads, setRetryingThreads] = createSignal(false)
  const retryThreads = () => {
    if (retryingThreads()) return
    setRetryingThreads(true)
    void loadThreads(api, { fresh: true, userInitiated: true }).finally(() =>
      setRetryingThreads(false),
    )
  }

  onMount(() => {
    setThreadReloadHandler(() => loadThreads(api, { fresh: true }))
    void loadAgentDirectory(api).then(() => setDmAgents(listAgentDirectory()))
    void loadDiscoverable()
    void loadFollowedReplies(api)
    hydrateSidebarSections(currentUserId())
  })

  onCleanup(() => setThreadReloadHandler(null))

  const currentUserId = () => userFromToken()?.userId ?? ""

  const matchesSearch = (t: Thread) => threadMatchesQuery(t, searchQuery(), currentUserId())

  const mentioned = createMemo(() => mentionedThreadIds(attentionStore.items))

  function matchesFilter(t: Thread): boolean {
    if (activeFilter() === "mentions") return mentioned().has(t.id)
    if (activeFilter() === "muted") return t.isMuted
    // The Unread filter shows what there is to read: the same predicate the
    // inbox split and the badges use, so a muted room never shows (LIF-26).
    return activeFilter() === "all" || needsReading(t)
  }

  const visible = (t: Thread) => matchesSearch(t) && matchesFilter(t)

  const pinnedFiltered = createMemo(() => pinnedThreads().filter(visible))
  const userPinnedFiltered = createMemo(() => userPinnedThreads().filter(visible))
  const unpinnedFiltered = createMemo(() => unpinnedThreads().filter(visible))

  // M1-A T4b: the viewer's own agent is a PERSON in the list, not a button
  // somewhere else on the screen, so its DM is simply the first row, above the
  // pinned threads. No personal agent (an older backend, a member whose agent
  // has not been provisioned) means no row at all.
  //
  // Declared ABOVE the group memos: a memo body runs eagerly on creation, and
  // the Direct messages group reads this one to keep the personal DM out of
  // its tiers, so a declaration further down is a temporal dead zone throw.
  const personalAgent = () => personalAgentFor(currentUserId())
  //
  // The 1:1 with the viewer's own agent: the rule is `pickAgentDmThread`
  // (thread-list-model.ts), shared with the phone Chats root.
  const personalAgentThread = createMemo<Thread | undefined>(() =>
    pickAgentDmThread(allThreads(), personalAgent()?.id, currentUserId()),
  )

  // D32 Agents, then Direct messages, then Channels; A35 channels vs DMs, one
  // row per DM counterpart, the agents' DMs kept out of Direct messages (they
  // have rows of their own under Agents), the channel cap with its fold: all
  // decided by `chatSections`, which the phone Chats root shares. The search
  // and the filter chips narrow the tiers first.
  const sections = createMemo(() =>
    chatSections({
      tiers: {
        pinned: pinnedFiltered(),
        userPinned: userPinnedFiltered(),
        unpinned: unpinnedFiltered(),
      },
      threads: allThreads(),
      agents: dmAgents(),
      personalAgent: personalAgent(),
      currentUserId: currentUserId(),
      query: searchQuery(),
      liftUnread: false,
      chip: activeFilter() === "all" ? undefined : matchesFilter,
      // The member's own agent row is always there, whatever the search or the
      // chips say: the guided tours ring it (`chats-personal-agent-row`).
      mineAlwaysListed: true,
    }),
  )
  const agentRows = () => sections().agents
  // Channels the viewer is not in are the unjoined list, so "not in" empties
  // the joined rows; the sort applies inside each pin tier.
  const channels = createMemo(() =>
    membership() === "not-in"
      ? { pinned: [], userPinned: [], unpinned: [] }
      : sortGroup(sections().channels, channelSort(), currentUserId()),
  )
  const directMessages = () => sections().directMessages
  // THE CHANNEL BEING READ ALWAYS HAS A ROW, even inside the fold.
  const cappedChannels = createMemo(() =>
    capChannels(channels(), {
      searching: searchQuery().trim().length > 0,
      isActive: (id) => tabStore.activeTabId === makeTabId("thread", id),
    }),
  )
  const shownChannels = () => cappedChannels().shown
  const foldedChannels = () => cappedChannels().folded

  // A channel the user joins leaves the unjoined list and enters the joined one
  // immediately, so the row moves without waiting for the list refetch.
  async function joinChannel(channel: DiscoverableChannel) {
    if (joining()) return
    setJoining(channel.id)
    try {
      await api.post(`/threads/${channel.id}/join`)
      setDiscoverable((rows) => rows.filter((r) => r.id !== channel.id))
      addThread({
        id: channel.id,
        handle: channel.handle,
        title: channel.title,
        discoverable: true,
        // Carried across the join so the header renders the topic the unjoined
        // row already showed, instead of blanking until the thread read lands.
        topic: channel.topic ?? null,
        description: channel.description ?? null,
      })
      requestThreadReload()
      // No read-only preview route exists yet (apps/api has `/threads/:id/join`
      // and the discoverable LISTING, nothing that reads a thread the member is
      // not seated in), so pressing the row joins and opens in one gesture. The
      // topic, description and member count the old card printed on the row now
      // live in the thread header this lands on.
      selectThread(channel.id, channel.title ?? channel.handle)
    } catch {
      // Left in the unjoined list so the user can try again.
    } finally {
      setJoining(null)
    }
  }

  /** Opens (or reopens) the member's 1:1 chat with one agent and shows it. The
   *  route is idempotent, so a second press lands in the same conversation. */
  async function startDm(agent: AgentDisplay) {
    if (startingDm()) return
    setStartingDm(agent.id)
    try {
      const res: any = await api.post("/threads/dm", { agentId: agent.id })
      const dm = res?.data ?? res
      if (!dm?.id) return
      addThread({
        id: dm.id,
        handle: dm.handle ?? "",
        title: null,
        discoverable: false,
        participants: [
          {
            id: agent.id,
            name: agent.name,
            avatarUrl: agent.avatarUrl,
            participantType: "agent",
            agentId: agent.id,
          },
        ],
      })
      requestThreadReload()
      selectThread(dm.id, agent.name)
    } catch {
      // Left in the list so the member can press again.
    } finally {
      setStartingDm(null)
    }
  }

  // Threads the store already knows are joined, whatever the last listing said.
  const unjoined = createMemo(() =>
    membership() === "in" ? [] : unjoinedChannels(discoverable(), allThreads(), searchQuery()),
  )

  function selectThread(id: string, label: string) {
    if (variant() === "dock" && props.onSelect) {
      props.onSelect(id)
      closeTabletSidebar()
      return
    }
    openTab({ type: "thread", entityId: id, label, preview: true })
    // On a tablet the sidebar is an overlay drawer over the content: having
    // picked a thread, drop it back to the rail instead of leaving it parked
    // on top of what was just opened.
    closeTabletSidebar()
  }

  function selectArchivedThread(thread: Thread) {
    if (variant() === "dock" && props.onSelect) {
      props.onSelect(thread.id)
      closeTabletSidebar()
      return
    }
    // Open in a tab without adding to the active thread list — archived threads
    // remain archived until explicitly unarchived
    openTab({
      type: "thread",
      entityId: thread.id,
      label: conversationDisplayName(thread, currentUserId()),
      preview: true,
    })
    closeTabletSidebar()
  }

  async function openPersonalAgentDm(agent: AgentDisplay) {
    const known = personalAgentThread()
    if (known) {
      rememberPersonalAgentDm(known.id)
      selectThread(known.id, agent.name)
      return
    }
    // The DM is created on first use, by the SAME store call `mod+.` runs, so
    // there is one path to this thread and never a second row for it.
    try {
      const id = await ensurePersonalAgentDm(api)
      requestThreadReload()
      selectThread(id, agent.name)
    } catch {
      // No agent reachable: the row stays, pressing it again retries.
    }
  }

  /** The member's own pin, the one the thread header's Pin control writes.
   *  Optimistic, then persisted; a failed request rolls the row back so the
   *  glyph never lies about what the server holds. */
  async function toggleUserPin(thread: Thread): Promise<void> {
    const next = !(thread.isPinnedByUser ?? false)
    setThreadPinnedByUser(thread.id, next)
    try {
      await api.patch(`/threads/${thread.id}/state`, { isPinned: next })
    } catch {
      setThreadPinnedByUser(thread.id, !next)
    }
  }

  async function toggleMute(thread: Thread): Promise<void> {
    const next = !thread.isMuted
    setThreadMuted(thread.id, next)
    try {
      await api.patch(`/threads/${thread.id}/state`, { isMuted: next })
    } catch {
      setThreadMuted(thread.id, !next)
    }
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <Show
        when={!phoneChats()}
        fallback={
          <ChatsList
            currentUserId={currentUserId()}
            personalAgent={personalAgent()}
            personalAgentThread={personalAgentThread()}
            agents={dmAgents()}
            startingAgentId={startingDm()}
            discoverable={discoverable()}
            joiningId={joining()}
            listFailed={listFailed()}
            retrying={retryingThreads()}
            onRetry={retryThreads}
            onOpen={selectThread}
            onOpenPersonalAgent={(agent) => void openPersonalAgentDm(agent)}
            onJoin={(channel) => void joinChannel(channel)}
            onStartDm={(agent) => void startDm(agent)}
            onTogglePin={(thread) => void toggleUserPin(thread)}
            onToggleMute={(thread) => void toggleMute(thread)}
          />
        }
      >
        <Show
          when={!sidebarArchivedView()}
          fallback={
            <>
              {/* Archived header */}
              <div class="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => hideArchivedSidebar()}
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
                  aria-label={i18n.t("kernel.backToThreads")}
                >
                  <ArrowLeft size={16} />
                </button>
                <span class="text-[13px] font-semibold text-text">{i18n.t("kernel.archived")}</span>
              </div>

              {/* Archived thread list */}
              <ScrollFade class="min-h-0 flex-1">
                <div
                  role="list"
                  aria-label={i18n.t("kernel.archivedThreads")}
                  onKeyDown={rovingFocus}
                  tabindex="-1"
                >
                  <Show
                    when={!loadingArchived()}
                    fallback={
                      <div class="px-4 py-8 text-center text-[13px] text-text-tertiary">
                        {i18n.t("kernel.common.loading3")}
                      </div>
                    }
                  >
                    <For each={archivedThreads()}>
                      {(thread) => (
                        <ThreadItem
                          thread={thread}
                          isActive={tabStore.activeTabId === makeTabId("thread", thread.id)}
                          currentUserId={currentUserId()}
                          onClick={() => selectArchivedThread(thread)}
                        />
                      )}
                    </For>
                    <Show when={archivedThreads().length === 0}>
                      <div class="px-4 py-8 text-center text-[13px] text-text-tertiary">
                        {i18n.t("kernel.threadsUi.noArchivedThreads")}
                      </div>
                    </Show>
                  </Show>
                </div>
              </ScrollFade>
            </>
          }
        >
          {/* Search. Creating lives on the section headers: "+" beside
              Channels makes a channel, "+" beside Direct messages writes to
              somebody. */}
          <div class="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
            <div class="flex flex-1 items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5">
              <Search size={14} class="shrink-0 text-text-tertiary" />
              <input
                type="text"
                placeholder={i18n.t("kernel.searchThreads")}
                class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
              />
            </div>
          </div>

          {/* Type filter chips */}
          <div
            class="flex items-center gap-1 overflow-x-auto border-b border-border-subtle px-3 py-1.5"
            role="tablist"
            aria-label={i18n.t("kernel.threadsUi.filterThreads")}
          >
            <For each={FILTERS}>
              {(f) => (
                <button
                  type="button"
                  role="tab"
                  data-testid={`chats-filter-${f.key}`}
                  aria-selected={activeFilter() === f.key}
                  class={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors ${
                    activeFilter() === f.key
                      ? "bg-surface-active text-text"
                      : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                  }`}
                  onClick={() => setActiveFilter(f.key)}
                >
                  {i18n.t(f.labelKey)}
                </button>
              )}
            </For>
          </div>

          {/* Channels: sort order and membership. Small and quiet; the sort is
              remembered on this device. */}
          <div class="flex items-center gap-2 border-b border-border-subtle px-3 py-1">
            <select
              data-testid="channels-sort"
              aria-label={i18n.t("kernel.channelSortLabel")}
              class="min-w-0 flex-1 rounded bg-transparent py-0.5 text-[12px] text-text-tertiary outline-none hover:text-text-secondary"
              value={channelSort()}
              onChange={(e) => chooseChannelSort(e.currentTarget.value as ChannelSort)}
            >
              <For each={CHANNEL_SORT_OPTIONS}>
                {(o) => (
                  <option value={o.key} selected={channelSort() === o.key}>
                    {i18n.t(o.labelKey)}
                  </option>
                )}
              </For>
            </select>
            <select
              data-testid="channels-membership"
              aria-label={i18n.t("kernel.channelMembershipLabel")}
              class="min-w-0 flex-1 rounded bg-transparent py-0.5 text-[12px] text-text-tertiary outline-none hover:text-text-secondary"
              value={membership()}
              onChange={(e) => setMembership(e.currentTarget.value as ChannelMembership)}
            >
              <For each={CHANNEL_MEMBERSHIP_OPTIONS}>
                {(o) => (
                  <option value={o.key} selected={membership() === o.key}>
                    {i18n.t(o.labelKey)}
                  </option>
                )}
              </For>
            </select>
          </div>

          {/* Thread list */}
          <ScrollFade class="min-h-0 flex-1">
            <div
              role="list"
              aria-label={i18n.t("kernel.threads")}
              onKeyDown={rovingFocus}
              tabindex="-1"
            >
              <Show
                when={
                  agentRows().length > 0 ||
                  (searchQuery() === "" && activeFilter() === "all" && sections().agentCount > 0)
                }
              >
                <ThreadGroupSection
                  id="agents"
                  label={i18n.t("kernel.chatsList.agents")}
                  addLabel={i18n.t("kernel.chatsList.addAgent")}
                  onAdd={openNewMessageDialog}
                  group={EMPTY_GROUP}
                  currentUserId={currentUserId()}
                  onSelect={selectThread}
                  lead={
                    // By position, not by object: the rows are rebuilt on every
                    // list change, and a keyed For would remount each one.
                    <Index each={agentRows()}>
                      {(row) => (
                        <SidebarAgentRow
                          row={row()}
                          personalThread={personalAgentThread()}
                          currentUserId={currentUserId()}
                          busy={startingDm() === row().agent.id}
                          onOpenPersonal={() => void openPersonalAgentDm(row().agent)}
                          onStart={() => void startDm(row().agent)}
                          onSelect={selectThread}
                          inDock={variant() === "dock"}
                        />
                      )}
                    </Index>
                  }
                  hasLead={agentRows().length > 0}
                />
              </Show>

              <ThreadGroupSection
                id="directMessages"
                label={i18n.t("kernel.directMessages")}
                addLabel={i18n.t("kernel.newConversation.newMessage")}
                onAdd={openNewMessageDialog}
                group={directMessages()}
                currentUserId={currentUserId()}
                onSelect={selectThread}
              />

              <ThreadGroupSection
                id="channels"
                label={i18n.t("kernel.channels")}
                addLabel={i18n.t("kernel.newConversation.newChannel")}
                onAdd={openNewChannelDialog}
                group={shownChannels()}
                currentUserId={currentUserId()}
                onSelect={selectThread}
                extra={
                  <>
                    <ChannelOverflow
                      channels={foldedChannels()}
                      currentUserId={currentUserId()}
                      onSelect={selectThread}
                    />
                    <JoinableChannelsSection
                      channels={unjoined()}
                      currentUserId={currentUserId()}
                      joiningId={joining()}
                      onJoin={(channel) => void joinChannel(channel)}
                    />
                  </>
                }
                hasExtra={unjoined().length > 0 || foldedChannels().length > 0}
              />

              {/* Last: a reply thread is a side conversation of a channel the
                  member already sees above, so it follows the rooms. */}
              <FollowedThreadsSection
                currentUserId={currentUserId()}
                onOpen={(threadId, rootId, label) => {
                  markFollowedReplyRead(rootId)
                  openThreadWithReplyPanel(threadId, rootId, { label })
                  closeTabletSidebar()
                }}
              />

              <Show when={listFailed()}>
                <ThreadsLoadFailedNotice onRetry={retryThreads} retrying={retryingThreads()} />
              </Show>

              {/* Only a narrowed list can come back empty and need saying so:
                  an empty workspace still shows both headers and their "+". */}
              <Show
                when={
                  !listFailed() &&
                  (searchQuery() !== "" || activeFilter() !== "all") &&
                  groupIsEmpty(channels()) &&
                  groupIsEmpty(directMessages()) &&
                  agentRows().length === 0 &&
                  unjoined().length === 0
                }
              >
                <div class="px-4 py-8 text-center text-[13px] text-text-tertiary">
                  {i18n.t("kernel.threadsUi.noThreadsMatchYourFilters")}
                </div>
              </Show>

              {/* Archived link */}
              <button
                type="button"
                data-roving
                class="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-text-tertiary outline-none transition-colors hover:bg-surface-hover hover:text-text-secondary focus-visible:bg-surface-hover focus-visible:text-text-secondary"
                onClick={() => showArchivedSidebar(api)}
              >
                <Archive size={14} />
                {i18n.t("kernel.archived")}
              </button>
            </div>
          </ScrollFade>
        </Show>
      </Show>
    </div>
  )
}

const EMPTY_GROUP: ThreadGroup = { pinned: [], userPinned: [], unpinned: [] }

/** One row of the Agents group: the member's own agent, a role agent's DM, or
 *  a role agent not messaged yet. The rows keep the test ids they carried
 *  under Direct messages, so anything that finds them still does. */
function SidebarAgentRow(props: {
  row: AgentRow
  personalThread: Thread | undefined
  currentUserId: string
  busy: boolean
  onOpenPersonal: () => void
  onStart: () => void
  onSelect: (id: string, label: string) => void
  /** The dock's Chats list: a guided step rings this row, not the Chats screen's. */
  inDock: boolean
}) {
  // A Switch, not a Show with a fallback: a fallback is read in a tracked
  // scope, so every list change would remount the row.
  return (
    <Switch>
      <Match when={props.row.mine}>
        <PersonalAgentRow
          agent={props.row.agent}
          thread={props.personalThread}
          onOpen={props.onOpenPersonal}
          inDock={props.inDock}
        />
      </Match>
      <Match when={props.row.thread} keyed>
        {(thread) => (
          <RoleAgentRowFrame agent={props.row.agent}>
            <ThreadItem
              thread={thread}
              isActive={tabStore.activeTabId === makeTabId("thread", thread.id)}
              currentUserId={props.currentUserId}
              onClick={() =>
                props.onSelect(thread.id, conversationDisplayName(thread, props.currentUserId))
              }
            />
          </RoleAgentRowFrame>
        )}
      </Match>
      <Match when={true}>
        <RoleAgentRowFrame agent={props.row.agent}>
          <AgentDmRow agent={props.row.agent} busy={props.busy} onStart={props.onStart} />
        </RoleAgentRowFrame>
      </Match>
    </Switch>
  )
}

/**
 * The viewer's own agent, at the head of Agents, marked as theirs. It reads
 * as a person because it IS one in this model, and it is there whether or not the DM
 * thread exists: pressing it opens the thread or creates it through the one
 * idempotent `POST /threads/dm` path. The phone Chats root draws the same
 * person as an inbox row (ChatsList).
 */
function PersonalAgentRow(props: {
  agent: AgentDisplay
  thread: Thread | undefined
  onOpen: () => void
  inDock: boolean
}) {
  const i18n = useI18n()
  const m = sidebarMetrics()
  const unread = () => props.thread?.unreadCount ?? 0

  return (
    <div role="listitem" class="flex items-center">
      <button
        type="button"
        data-testid="chats-personal-agent-row"
        data-agent-id={props.agent.id}
        data-in-dock={props.inDock ? "true" : undefined}
        data-roving
        onClick={props.onOpen}
        class={`flex min-w-0 flex-1 items-center gap-2 px-3 ${m.row} text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover`}
      >
        <span
          data-testid="row-mark"
          class="flex h-6 w-6 shrink-0 items-center justify-center"
          data-kind="dm-agent"
        >
          <span
            class={`flex items-center justify-center rounded-full ${m.agentMark}`}
            style={agentAvatarStyle(props.agent.id, props.agent.avatarColor)}
          >
            <AgentGlyph />
          </span>
        </span>
        <span class={`flex min-w-0 flex-1 items-baseline gap-1 ${m.name}`}>
          <span
            class={`min-w-0 truncate ${
              unread() > 0 ? "font-semibold text-text" : "font-medium text-text-secondary"
            }`}
          >
            {props.agent.name}
          </span>
          <span data-testid="chats-personal-agent-yours" class="shrink-0 text-text-tertiary">
            · {i18n.t("kernel.chatsList.yours")}
          </span>
        </span>
        <span data-testid="row-trailing" class="flex shrink-0 items-center justify-end">
          <Show when={unread() > 0}>
            <span
              role="status"
              class="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-foreground"
              aria-label={`${unread()} unread`}
            >
              {unread() > 99 ? "99+" : unread()}
            </span>
          </Show>
        </span>
      </button>
      <RowTrailingGutter />
    </div>
  )
}

interface ThreadGroupSectionProps {
  id: SidebarSectionId
  label: string
  group: ThreadGroup
  currentUserId: string
  onSelect: (id: string, label: string) => void
  /** Rows rendered after the pin tiers, inside the same labeled group. */
  extra?: JSX.Element
  hasExtra?: boolean
  /** Rows rendered BEFORE the pin tiers, inside the same labeled group: the
   *  viewer's own agent, which leads Direct messages whether or not a thread
   *  with it exists yet. */
  lead?: JSX.Element
  hasLead?: boolean
  /** The header's "+": create something that belongs in this group. A group
   *  that has one is always rendered, empty or not, so the way to start the
   *  first channel or the first DM is never hidden. */
  onAdd?: () => void
  addLabel?: string
}

/** One labeled sidebar group (Channels or Direct messages). A36: the header is
 *  the collapse control, and the fold is remembered per user. An empty group
 *  renders nothing at all, header included. */
function ThreadGroupSection(props: ThreadGroupSectionProps) {
  const m = sidebarMetrics()
  const collapsed = () => isSectionCollapsed(props.id)
  const ordered = (): Thread[] => [
    ...props.group.pinned,
    ...props.group.userPinned,
    ...props.group.unpinned,
  ]

  return (
    <Show when={!groupIsEmpty(props.group) || props.hasExtra || props.hasLead || props.onAdd}>
      <div data-testid="thread-group" data-group={props.id}>
        <div class={`group/header flex items-center ${m.headerPad}`}>
          <button
            type="button"
            data-testid={`thread-group-toggle-${props.id}`}
            aria-expanded={collapsed() ? "false" : "true"}
            class="flex min-w-0 flex-1 items-center gap-1 pl-3 text-left outline-none transition-colors hover:text-text focus-visible:text-text"
            onClick={() => toggleSectionCollapsed(props.id, props.currentUserId)}
          >
            <ChevronDown
              size={11}
              class={`shrink-0 text-text-tertiary transition-transform ${collapsed() ? "-rotate-90" : ""}`}
            />
            <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-secondary">
              {props.label}
            </span>
          </button>
          <Show when={props.onAdd}>
            {(onAdd) => (
              // Sits in the same trailing gutter every row reserves, so the "+"
              // lines up with the column of unread pills below it. Shown on
              // hover like Slack's, and always on a touch screen, which has no
              // hover to reveal it.
              <RowTrailingGutter>
                <button
                  type="button"
                  data-testid={`thread-group-add-${props.id}`}
                  aria-label={props.addLabel}
                  title={props.addLabel}
                  class="flex h-5 w-5 items-center justify-center rounded text-text-tertiary opacity-0 outline-none transition-opacity hover:bg-surface-hover hover:text-text focus-visible:opacity-100 group-hover/header:opacity-100 [@media(hover:none)]:opacity-100"
                  onClick={() => onAdd()()}
                >
                  <Plus size={13} />
                </button>
              </RowTrailingGutter>
            )}
          </Show>
        </div>
        <Show when={!collapsed()}>
          {props.lead}
          <For each={ordered()}>
            {(thread) => (
              <ThreadItem
                thread={thread}
                isActive={tabStore.activeTabId === makeTabId("thread", thread.id)}
                currentUserId={props.currentUserId}
                onClick={() =>
                  props.onSelect(thread.id, conversationDisplayName(thread, props.currentUserId))
                }
              />
            )}
          </For>
          {props.extra}
        </Show>
      </div>
    </Show>
  )
}

/**
 * FOLLOWED THREADS (S11, A23): the reply threads this member follows, unread
 * first then the newest reply, each a single row naming the channel and the
 * root's first words, with the unread count in the trailing pill. A click
 * opens the channel with the reply panel on that root. Folds like the others;
 * absent while there is nothing to follow.
 */
function FollowedThreadsSection(props: {
  currentUserId: string
  onOpen: (threadId: string, rootId: string, label: string) => void
}) {
  const i18n = useI18n()
  const m = sidebarMetrics()
  const collapsed = () => isSectionCollapsed("followedThreads")
  const moreCollapsed = () => isSectionCollapsed("followedThreadsMore")
  // The root whose panel is open in the channel being read keeps its row, as
  // the channel being read keeps its own under Channels.
  const activeRootId = () => {
    for (const item of followedReplies()) {
      if (tabStore.activeTabId !== makeTabId("thread", item.channel.id)) continue
      const open = getOpenReplyPanel(item.channel.id)?.rootId
      if (open === item.rootMessage.id) return open
    }
    return null
  }
  const split = createMemo(() =>
    splitFollowedReplies(followedReplies(), { activeRootId: activeRootId(), now: Date.now() }),
  )
  const Row = (rowProps: { item: FollowedReplyThread }) => {
    const item = rowProps.item
    const unread = () => item.unreadCount > 0
    const channel = () => item.channel.name?.trim() || i18n.t("kernel.replyThreads.title")
    const excerpt = () =>
      item.rootMessage.content
        ? plainQuoteText(item.rootMessage.content)
        : i18n.t("kernel.messageDeleted")
    return (
      <div role="listitem" class="flex items-center">
        <button
          type="button"
          data-testid="followed-thread-row"
          data-root-id={item.rootMessage.id}
          data-roving
          title={excerpt()}
          class={`group flex min-w-0 flex-1 items-center gap-2 px-3 ${m.row} text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover`}
          onClick={() => props.onOpen(item.channel.id, item.rootMessage.id, channel())}
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center">
            <MessageSquareText size={m.glyph} class="text-text-tertiary" aria-hidden="true" />
          </span>
          <span class={`min-w-0 flex-1 truncate ${m.name}`}>
            <span class={unread() ? "font-semibold text-text" : "font-medium text-text-secondary"}>
              {channel()}
            </span>
            <span class="ml-1.5 text-text-tertiary">{excerpt()}</span>
          </span>
          <span data-testid="row-trailing" class="flex shrink-0 items-center justify-end">
            <Show when={unread()}>
              <span
                role="status"
                data-testid="followed-thread-unread"
                class="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-foreground"
                aria-label={i18n.t("kernel.replyThreads.unreadCount", {
                  count: item.unreadCount,
                })}
              >
                {item.unreadCount > 99 ? "99+" : item.unreadCount}
              </span>
            </Show>
          </span>
        </button>
        <RowTrailingGutter />
      </div>
    )
  }
  return (
    <Show when={followedReplies().length > 0}>
      <div data-testid="thread-group" data-group="followedThreads">
        <div class={`group/header flex items-center ${m.headerPad}`}>
          <button
            type="button"
            data-testid="thread-group-toggle-followedThreads"
            aria-expanded={collapsed() ? "false" : "true"}
            class="flex min-w-0 flex-1 items-center gap-1 pl-3 text-left outline-none transition-colors hover:text-text focus-visible:text-text"
            onClick={() => toggleSectionCollapsed("followedThreads", props.currentUserId)}
          >
            <ChevronDown
              size={11}
              class={`shrink-0 text-text-tertiary transition-transform ${collapsed() ? "-rotate-90" : ""}`}
            />
            <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-secondary">
              {i18n.t("kernel.replyThreads.followedThreads")}
            </span>
          </button>
          <RowTrailingGutter />
        </div>
        <Show when={!collapsed()}>
          <For each={split().shown}>{(item) => <Row item={item} />}</For>
          {/* The rest, behind one "More" row, as Channels folds its own. */}
          <Show when={split().folded.length > 0}>
            <Show when={!moreCollapsed()}>
              <For each={split().folded}>{(item) => <Row item={item} />}</For>
            </Show>
            <div role="listitem" class="flex items-center">
              <button
                type="button"
                data-testid="followed-threads-more-toggle"
                data-roving
                aria-expanded={moreCollapsed() ? "false" : "true"}
                class={`flex min-w-0 flex-1 items-center gap-2 px-3 ${m.row} text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover`}
                onClick={() => toggleSectionCollapsed("followedThreadsMore", props.currentUserId)}
              >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center">
                  <ChevronDown
                    size={m.glyph}
                    class={`text-text-tertiary transition-transform ${moreCollapsed() ? "-rotate-90" : ""}`}
                    aria-hidden="true"
                  />
                </span>
                <span class={`min-w-0 flex-1 truncate ${m.name} font-medium text-text-tertiary`}>
                  {moreCollapsed()
                    ? i18n.t("kernel.channelsMore", { count: split().folded.length })
                    : i18n.t("kernel.channelsLess")}
                </span>
                <span data-testid="row-trailing" class="flex shrink-0 items-center justify-end" />
              </button>
              <RowTrailingGutter />
            </div>
          </Show>
        </Show>
      </div>
    </Show>
  )
}

/** The channels beyond the visible cap, and the one row that opens them.
 *
 *  Not a labeled sub-section: these ARE channels, already under the Channels
 *  header, so the fold is a single row at the foot of the group rather than a
 *  second heading that would read as a different kind of thing. The rows
 *  inside it are ordinary channel rows, in the same recency order, and the
 *  open state is remembered per user by the same mechanism the section folds
 *  use. */
function ChannelOverflow(props: {
  channels: Thread[]
  currentUserId: string
  onSelect: (id: string, label: string) => void
}) {
  const i18n = useI18n()
  const m = sidebarMetrics()
  const collapsed = () => isSectionCollapsed("channelsMore")

  return (
    <Show when={props.channels.length > 0}>
      <Show when={!collapsed()}>
        <For each={props.channels}>
          {(thread) => (
            <ThreadItem
              thread={thread}
              isActive={tabStore.activeTabId === makeTabId("thread", thread.id)}
              currentUserId={props.currentUserId}
              onClick={() =>
                props.onSelect(thread.id, conversationDisplayName(thread, props.currentUserId))
              }
            />
          )}
        </For>
      </Show>
      <div role="listitem" class="flex items-center">
        <button
          type="button"
          data-testid="channels-more-toggle"
          data-roving
          aria-expanded={collapsed() ? "false" : "true"}
          class={`flex min-w-0 flex-1 items-center gap-2 px-3 ${m.row} text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover`}
          onClick={() => toggleSectionCollapsed("channelsMore", props.currentUserId)}
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center">
            <ChevronDown
              size={m.glyph}
              class={`text-text-tertiary transition-transform ${collapsed() ? "-rotate-90" : ""}`}
              aria-hidden="true"
            />
          </span>
          <span class={`min-w-0 flex-1 truncate ${m.name} font-medium text-text-tertiary`}>
            {collapsed() ? moreChannelsLabel(props.channels.length) : i18n.t("kernel.channelsLess")}
          </span>
          <span data-testid="row-trailing" class="flex shrink-0 items-center justify-end" />
        </button>
        <RowTrailingGutter />
      </div>
    </Show>
  )
}

interface JoinableChannelsSectionProps {
  channels: DiscoverableChannel[]
  currentUserId: string
  joiningId: string | null
  onJoin: (channel: DiscoverableChannel) => void
}

/** The channels this member can join, as a collapsed sub-section at the foot of
 *  Channels (card 31).
 *
 *  It used to be a four line card per channel (name, #handle, topic, member
 *  count, Join button) sitting under rows that are one line each, so the one
 *  part of the list nobody had opted into was the loudest thing in it. It is a
 *  folded group now, closed until asked for, and what is inside it is an
 *  ORDINARY row: the same height, mark box and type as a joined channel, dimmed
 *  the way an agent nobody has messaged yet is dimmed. The topic, description
 *  and member count belong to the thread header the row opens. */
function JoinableChannelsSection(props: JoinableChannelsSectionProps) {
  const i18n = useI18n()
  const m = sidebarMetrics()
  const collapsed = () => isSectionCollapsed("joinableChannels")

  return (
    <Show when={props.channels.length > 0}>
      <div data-testid="thread-group" data-group="joinableChannels">
        <button
          type="button"
          data-testid="thread-group-toggle-joinableChannels"
          aria-expanded={collapsed() ? "false" : "true"}
          class={`flex w-full items-center gap-1 px-3 ${m.headerPad} text-left outline-none transition-colors hover:text-text focus-visible:text-text`}
          onClick={() => toggleSectionCollapsed("joinableChannels", props.currentUserId)}
        >
          <ChevronDown
            size={11}
            class={`shrink-0 text-text-tertiary transition-transform ${collapsed() ? "-rotate-90" : ""}`}
          />
          <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
            {i18n.t("kernel.channelsYouCanJoin")}
          </span>
          <span
            data-testid="joinable-channels-count"
            class="text-[11px] font-semibold text-text-tertiary"
          >
            {props.channels.length}
          </span>
        </button>
        <Show when={!collapsed()}>
          <For each={props.channels}>
            {(channel) => (
              <JoinableChannelRow
                channel={channel}
                busy={props.joiningId === channel.id}
                onJoin={() => props.onJoin(channel)}
              />
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}

interface JoinableChannelRowProps {
  channel: DiscoverableChannel
  busy: boolean
  onJoin: () => void
}

/** One channel the member can join: an ordinary sidebar row. Public hash mark,
 *  name, dimmed. Pressing it joins and opens it. */
function JoinableChannelRow(props: JoinableChannelRowProps) {
  const i18n = useI18n()
  const m = sidebarMetrics()
  const label = () => props.channel.title ?? props.channel.handle.replace(/^[@#]/, "")

  return (
    <div role="listitem" class="flex items-center">
      <button
        type="button"
        data-testid="unjoined-channel"
        data-roving
        disabled={props.busy}
        aria-label={i18n.t("kernel.joinAndOpenChannel", { name: label() })}
        class={`flex min-w-0 flex-1 items-center gap-2 px-3 ${m.row} text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover disabled:opacity-50`}
        onClick={props.onJoin}
      >
        <span
          data-testid="row-mark"
          class="flex h-6 w-6 shrink-0 items-center justify-center"
          data-kind="channel-public"
        >
          <Hash size={m.glyph} class="text-text-tertiary" aria-hidden="true" />
        </span>
        <span class={`min-w-0 flex-1 truncate ${m.name} font-medium text-text-tertiary`}>
          {label()}
        </span>
        <span data-testid="row-trailing" class="flex shrink-0 items-center justify-end" />
      </button>
      <RowTrailingGutter />
    </div>
  )
}

interface AgentDmRowProps {
  agent: AgentDisplay
  busy: boolean
  onStart: () => void
}

/** The trailing gutter EVERY row reserves (A37 pass, P6d-FX6).
 *
 *  The agent profile control used to be rendered, at `opacity-0`, only on rows
 *  that name exactly one agent. Those rows' button therefore stopped 24 px
 *  early and their trailing slot ended at x=271 while every other row's ended
 *  at x=295 (measured on the real render, impl/ws06d-sidebar-real.md). The
 *  column was true only as long as none of those rows was unread. The box is
 *  reserved on every row now; what goes in it is the row's business. */
function RowTrailingGutter(props: { children?: JSX.Element }) {
  return (
    <span
      data-testid="row-agent-gutter"
      class="mr-1 flex h-5 w-5 shrink-0 items-center justify-center"
    >
      {props.children}
    </span>
  )
}

/** A role agent the member has no chat with yet, listed under Agents: the
 *  only entry point in the product that starts one.
 *
 *  A37: one dimmed line, not an invite card. The agent mark in the shared mark
 *  box, the name, no handle and no button, at the row height the density
 *  constant gives every other row. Pressing it runs the same `startDm` the
 *  "Message" button ran; once the DM exists the agent is a real DM row above
 *  and this offer is gone. */
function AgentDmRow(props: AgentDmRowProps) {
  const m = sidebarMetrics()
  return (
    <div role="listitem" class="flex items-center">
      <button
        type="button"
        data-testid="agent-dm-row"
        data-roving
        disabled={props.busy}
        aria-label={tNow("kernel.threadsUi.messageAgent", { handle: props.agent.handle })}
        class={`flex min-w-0 flex-1 items-center gap-2 px-3 ${m.row} text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover disabled:opacity-50`}
        onClick={props.onStart}
      >
        <span
          data-testid="row-mark"
          class="flex h-6 w-6 shrink-0 items-center justify-center"
          data-kind="dm-agent-unstarted"
        >
          <span
            class={`flex items-center justify-center rounded-full ${m.agentMark}`}
            style={agentAvatarStyle(props.agent.id, props.agent.avatarColor)}
          >
            <AgentGlyph />
          </span>
        </span>
        <span class={`min-w-0 flex-1 truncate ${m.name} font-medium text-text-tertiary`}>
          {props.agent.name}
        </span>
        <span data-testid="row-trailing" class="flex shrink-0 items-center justify-end" />
      </button>
      <RowTrailingGutter />
    </div>
  )
}

interface ThreadItemProps {
  thread: {
    id: string
    handle: string
    title: string | null
    type?: string
    discoverable?: boolean
    isPinned: boolean
    isPinnedByUser: boolean
    isMuted: boolean
    participants: Array<{
      id: string
      name: string
      avatarUrl: string | null
      participantType?: "user" | "agent"
      agentId?: string | null
    }>
    unreadCount: number
    updatedAt: string
    tainted?: boolean
  }
  isActive: boolean
  currentUserId: string
  onClick: () => void
}

interface RowMarkProps {
  thread: ThreadItemProps["thread"]
  currentUserId: string
}

/** The leading mark: what KIND of conversation this row is, at a glance.
 *  `#` public channel, lock private channel, the agent mark for an agent DM,
 *  and a person as a face (density "slack") or a presence dot ("slack-dense"). */
function RowMark(props: RowMarkProps) {
  const m = sidebarMetrics()
  const kind = () => conversationKind(props.thread, props.currentUserId)
  const isChannelRow = () => kind().group === "channel"
  const isPublicChannel = () => {
    const k = kind()
    return k.group === "channel" && k.visibility === "public"
  }
  const markKind = () => {
    const k = kind()
    return k.group === "channel" ? `channel-${k.visibility}` : `dm-${k.namedBy}`
  }
  const agent = () => namingAgentSeat(props.thread, props.currentUserId)
  const person = () => {
    const seats = resolvedParticipants(props.thread)
    return seats.find((p) => p.id !== props.currentUserId) ?? seats[0] ?? null
  }
  const online = () => {
    const p = person()
    return p !== null && presenceStore.users[p.id] === "online"
  }

  return (
    <span
      data-testid="row-mark"
      class="flex h-6 w-6 shrink-0 items-center justify-center"
      data-kind={markKind()}
    >
      <Show when={isChannelRow()}>
        <Show
          when={isPublicChannel()}
          fallback={<Lock size={m.glyph} class="text-text-tertiary" aria-hidden="true" />}
        >
          <Hash size={m.glyph} class="text-text-tertiary" aria-hidden="true" />
        </Show>
      </Show>
      <Show when={!isChannelRow() && agent()}>
        {(seat) => (
          <span
            class={`flex items-center justify-center rounded-full ${m.agentMark}`}
            style={agentAvatarStyle(seat().id)}
            title={seat().name}
          >
            <AgentGlyph />
          </span>
        )}
      </Show>
      <Show when={!isChannelRow() && !agent()}>
        <Show
          when={m.person === "avatar" && person()}
          fallback={
            <span
              data-testid="row-presence-dot"
              class={`h-2.5 w-2.5 rounded-full ${online() ? "bg-success" : "border border-text-tertiary"}`}
            />
          }
        >
          <Avatar user={person()!} size="sm" showPresence presenceStatus={presenceStore.users} />
        </Show>
      </Show>
    </span>
  )
}

function ThreadItem(props: ThreadItemProps) {
  const i18n = useI18n()
  const m = sidebarMetrics()
  const unread = () => props.thread.unreadCount > 0
  const pinned = () => props.thread.isPinned || props.thread.isPinnedByUser
  const agentSeat = () => {
    const seats = resolvedParticipants(props.thread).filter(
      (p) => p.participantType === "agent" && p.agentId,
    )
    return seats.length === 1 ? seats[0] : null
  }

  // ONE trailing element, in a fixed order. Anything else here is how the row
  // this replaces ended up drawing a glyph on top of the timestamp.
  const trailing = () => {
    if (unread()) {
      return (
        <span
          role="status"
          class="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-foreground"
          aria-label={`${props.thread.unreadCount} unread`}
        >
          {props.thread.unreadCount > 99 ? "99+" : props.thread.unreadCount}
        </span>
      )
    }
    if (pinned()) {
      return (
        <Pin size={m.glyph - 2} class="text-text-tertiary" aria-label={i18n.t("kernel.pinned")} />
      )
    }
    if (props.thread.isMuted) {
      return (
        <BellOff
          size={m.glyph - 3}
          class="text-text-tertiary"
          aria-label={i18n.t("kernel.muted")}
        />
      )
    }
    return null
  }

  return (
    <div role="listitem" class="group/item flex items-center">
      <button
        type="button"
        data-testid="thread-item"
        data-thread-id={props.thread.id}
        data-roving
        aria-current={props.isActive ? "true" : undefined}
        class={`group flex min-w-0 flex-1 items-center gap-2 px-3 ${m.row} text-left outline-none transition-colors ${
          props.isActive
            ? "bg-surface-active"
            : "hover:bg-surface-hover focus-visible:bg-surface-hover"
        }`}
        onClick={props.onClick}
      >
        <RowMark thread={props.thread} currentUserId={props.currentUserId} />
        <span
          class={`min-w-0 flex-1 truncate ${m.name} ${
            unread() ? "font-semibold text-text" : "font-medium text-text-secondary"
          }`}
        >
          {conversationDisplayName(props.thread, props.currentUserId)}
        </span>
        <span data-testid="row-trailing" class="flex shrink-0 items-center justify-end">
          {trailing()}
        </span>
      </button>
      <RowTrailingGutter>
        <Show when={agentSeat()}>
          {(seat) => (
            <button
              type="button"
              data-testid={`agent-profile-open-${seat().agentId}`}
              class="flex h-5 w-5 items-center justify-center rounded text-text-tertiary opacity-0 outline-none transition-opacity hover:bg-surface-hover hover:text-text-secondary focus-visible:opacity-100 group-hover/item:opacity-100"
              aria-label={tNow("kernel.threadsUi.agentProfile", { name: seat().name })}
              onClick={(e) => {
                e.stopPropagation()
                // The agent's own page, opened from the row that names it.
                openAgentPage({ id: seat().agentId as string, name: seat().name })
              }}
            >
              <User size={13} />
            </button>
          )}
        </Show>
      </RowTrailingGutter>
    </div>
  )
}

export default HomeSidebar
