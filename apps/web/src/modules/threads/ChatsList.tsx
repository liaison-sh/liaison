// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone Chats root: the conversation list as an INBOX, in Slack's mobile
// shape. From the top: a large title with the compose control, the org name,
// the search field, then four collapsible sections (D32 order):
//
//   Agents           the member's own agent first ("yours"), then the org's
//                    role agents, messaged yet or not. First, so they are in
//                    view without scrolling; an agent row with something to
//                    read keeps its place and shows its unread count.
//   Unread           the people DMs and channels with something to read,
//                    newest first, shown only when there is one. A row lives
//                    here OR in its group below, never both.
//   Direct messages  people (and another member's agent once a DM with it
//                    exists), then "New message".
//   Channels         the joined channels (pins first, then recency, folded to
//                    a few rows with an "N more channels" row, as the desktop
//                    sidebar does), then "Browse channels".
//
// The order, what is a channel, which DM twin survives, which agents are
// listed, what folds: all decided by `thread-list-model.ts` (`chatSections`),
// the module the desktop sidebar and the docked window group with, so the
// surfaces cannot disagree. This component
// only lays the rows out. HomeSidebar (its "dock" variant at phone width)
// owns the directory reads and the actions and passes them in.
//
// Each row is 64 px: a 40 px mark (hash tile for a channel, the face with its
// presence dot or the agent's mark for a DM), the name and relative time, the
// last message under it, and the unread count, louder when the member was
// mentioned. Swipe for Read / Pin, long press for the actions sheet.
import {
  BellOff,
  Check,
  ChevronDown,
  ExternalLink,
  Hash,
  Lock,
  MessageSquarePlus,
  Pin,
  Plus,
  Search,
} from "lucide-solid"
import {
  type Accessor,
  type Component,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { formatRelativeTime, rowLocaleFrom } from "~/modules/shell/attention-row-format"
import { attentionStore } from "~/modules/shell/attention-store"
import { ensureBrandingLoaded, orgName } from "~/modules/shell/branding-store"
import { openTab } from "~/modules/shell/tab-store"
import { closeTabletSidebar } from "~/modules/shell/tablet-sidebar-store"
import type { AgentDisplay } from "~/modules/threads/agent-directory"
import { agentStateLabel } from "~/modules/threads/agent-name"
import { isPinnedThread } from "~/modules/threads/chats-filter"
import {
  conversationDisplayName,
  conversationKind,
  resolvedParticipants,
} from "~/modules/threads/conversation-display"
import {
  openNewChannelDialog,
  openNewMessageDialog,
} from "~/modules/threads/new-conversation-store"
import { presenceStore } from "~/modules/threads/presence-store"
import { RoleAgentRowFrame } from "~/modules/threads/RoleAgentRowFrame"
import {
  isSectionCollapsed,
  type SidebarSectionId,
  toggleSectionCollapsed,
} from "~/modules/threads/sidebar-sections"
import { previewLine } from "~/modules/threads/system-line"
import { ThreadsLoadFailedNotice } from "~/modules/threads/ThreadsLoadFailedNotice"
import {
  type AgentRow,
  capChannels,
  chatSections,
  type DiscoverableChannel,
  mentionedThreadIds,
  orderedGroup,
  threadMatchesQuery,
  unjoinedChannels,
} from "~/modules/threads/thread-list-model"
import {
  allThreads,
  getThread,
  markThreadRead,
  pinnedThreads,
  type Thread,
  unpinnedThreads,
  userPinnedThreads,
} from "~/modules/threads/thread-store"
import { AgentGlyph } from "~/ui/AgentGlyph"
import { AvatarImage } from "~/ui/AvatarImage"
import { Avatar } from "~/ui/AvatarStack"
import { agentAvatarStyle } from "~/ui/avatar-palette"
import { OverlaySheet } from "~/ui/OverlaySheet"
import { ScrollFade } from "~/ui/ScrollFade"
import { SwipeRow } from "~/ui/SwipeRow"

export interface ChatsListProps {
  currentUserId: string
  personalAgent: AgentDisplay | undefined
  personalAgentThread: Thread | undefined
  /** The agent directory, for the Agents section's role agents. */
  agents: AgentDisplay[]
  startingAgentId: string | null
  /** Channels the member can join (`GET /threads/discoverable`). */
  discoverable: DiscoverableChannel[]
  joiningId: string | null
  listFailed: boolean
  retrying: boolean
  onRetry: () => void
  onOpen: (threadId: string, label: string) => void
  onOpenPersonalAgent: (agent: AgentDisplay) => void
  onJoin: (channel: DiscoverableChannel) => void
  onStartDm: (agent: AgentDisplay) => void
  onTogglePin: (thread: Thread) => void
  onToggleMute: (thread: Thread) => void
}

const ROW = "flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left"
const ROW_INTERACTION =
  "outline-none transition-colors hover:bg-surface-hover active:bg-surface-active focus-visible:bg-surface-hover"

const ChatsList: Component<ChatsListProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [query, setQuery] = createSignal("")
  // The conversation a long press opened the actions sheet for.
  const [sheetThread, setSheetThread] = createSignal<string | null>(null)
  const [composeSheet, setComposeSheet] = createSignal(false)

  // F3: this root screen hides the phone top bar (it owns its large title),
  // so the org name printed under that title needs its own load.
  onMount(() => void ensureBrandingLoaded())

  const uid = () => props.currentUserId
  const searching = () => query().trim().length > 0
  const matches = (t: Thread) => threadMatchesQuery(t, query(), uid())

  const inbox = createMemo(() =>
    chatSections({
      tiers: {
        pinned: pinnedThreads().filter(matches),
        userPinned: userPinnedThreads().filter(matches),
        unpinned: unpinnedThreads().filter(matches),
      },
      threads: allThreads(),
      agents: props.agents,
      personalAgent: props.personalAgent,
      currentUserId: uid(),
      query: query(),
      liftUnread: true,
    }),
  )
  const channels = createMemo(() => capChannels(inbox().channels, { searching: searching() }))
  const directMessages = () => orderedGroup(inbox().directMessages)
  const joinable = createMemo(() => unjoinedChannels(props.discoverable, allThreads(), query()))
  const mentioned = createMemo(() => mentionedThreadIds(attentionStore.items))

  const open = (t: Thread) => props.onOpen(t.id, conversationDisplayName(t, uid()))

  const nothingMatches = () =>
    searching() &&
    inbox().unread.length === 0 &&
    orderedGroup(inbox().channels).length === 0 &&
    directMessages().length === 0 &&
    joinable().length === 0 &&
    inbox().agents.length === 0

  const threadRow = (thread: Thread) => (
    <SwipeRow
      testid="chat-swipe-row"
      actions={[
        {
          label: i18n.t("kernel.markRead"),
          icon: <Check size={18} aria-hidden="true" />,
          tone: "accent",
          onSelect: () => markThreadRead(api, thread.id),
        },
        {
          label: isPinnedThread(thread) ? i18n.t("kernel.unpin") : i18n.t("kernel.pin"),
          icon: <Pin size={18} aria-hidden="true" />,
          onSelect: () => props.onTogglePin(thread),
        },
      ]}
      onLongPress={() => setSheetThread(thread.id)}
    >
      <InboxRow
        thread={thread}
        currentUserId={uid()}
        mentioned={mentioned().has(thread.id)}
        onOpen={() => open(thread)}
      />
    </SwipeRow>
  )

  // One Agents row: the member's own agent (it always opens through
  // `onOpenPersonalAgent`, which creates the DM when there is none yet), a
  // role agent's DM, or a role agent not messaged yet (pressing it creates
  // the DM). A Switch, not a Show
  // with a fallback: a fallback is read in a tracked scope, so every list
  // change would remount the row under the finger (and the children read
  // nothing eagerly, for the same reason). Keyed on the thread, so a row
  // follows its agent onto a newer DM.
  const agentRow = (row: Accessor<AgentRow>) => (
    <Switch>
      <Match when={row().mine}>
        <PersonalAgentInboxRow
          agent={row().agent}
          thread={props.personalAgentThread}
          onOpen={() => props.onOpenPersonalAgent(row().agent)}
        />
      </Match>
      <Match when={row().thread} keyed>
        {(thread) => <RoleAgentRowFrame agent={row().agent}>{threadRow(thread)}</RoleAgentRowFrame>}
      </Match>
      <Match when={true}>
        <RoleAgentRowFrame agent={row().agent}>
          <AgentOfferRow
            agent={row().agent}
            busy={props.startingAgentId === row().agent.id}
            onStart={() => props.onStartDm(row().agent)}
          />
        </RoleAgentRowFrame>
      </Match>
    </Switch>
  )

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid="chats-list">
      <div class="shrink-0 px-4 pb-2 pt-3">
        <div class="flex items-center justify-between gap-2">
          <h1
            class="font-display text-[32px] font-semibold leading-tight text-text"
            data-testid="chats-title"
          >
            {i18n.t("kernel.chats")}
          </h1>
          <button
            type="button"
            data-testid="chats-compose"
            aria-label={i18n.t("kernel.newConversation.compose")}
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-accent transition-colors hover:bg-surface-hover"
            onClick={() => setComposeSheet(true)}
          >
            <Plus size={22} />
          </button>
        </div>
        <Show when={orgName()}>
          {(name) => (
            <p data-testid="chats-title-org" class="truncate text-[12px] text-text-secondary">
              {name()}
            </p>
          )}
        </Show>
        <label class="mt-3 flex h-11 items-center gap-2 rounded-xl border border-border-subtle bg-surface px-3">
          <Search size={16} class="shrink-0 text-text-tertiary" aria-hidden="true" />
          <input
            type="search"
            data-testid="chats-search"
            placeholder={i18n.t("kernel.searchThreads")}
            aria-label={i18n.t("kernel.searchThreads")}
            class="w-full bg-transparent text-[16px] text-text outline-none placeholder:text-text-tertiary"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
      </div>

      <ScrollFade class="min-h-0 flex-1">
        <div role="list" aria-label={i18n.t("kernel.chats")} class="pb-6">
          <Show when={inbox().agents.length > 0 || (!searching() && inbox().agentCount > 0)}>
            <Section
              id="agents"
              label={i18n.t("kernel.chatsList.agents")}
              currentUserId={uid()}
              addLabel={i18n.t("kernel.chatsList.addAgent")}
              onAdd={openNewMessageDialog}
            >
              {/* By position: the rows are rebuilt on every list change, and a
                  keyed For would remount each one. */}
              <Index each={inbox().agents}>{(row) => agentRow(row)}</Index>
            </Section>
          </Show>

          <Show when={inbox().unread.length > 0}>
            <Section
              id="unread"
              label={i18n.t("kernel.chatsList.unread")}
              count={inbox().unread.length}
              currentUserId={uid()}
            >
              <For each={inbox().unread}>{(thread) => threadRow(thread)}</For>
            </Section>
          </Show>

          <Section
            id="directMessages"
            label={i18n.t("kernel.directMessages")}
            currentUserId={uid()}
            addLabel={i18n.t("kernel.newConversation.newMessage")}
            onAdd={openNewMessageDialog}
          >
            <For each={directMessages()}>{(thread) => threadRow(thread)}</For>
            <div role="listitem">
              <button
                type="button"
                data-testid="chats-new-message"
                class={`${ROW} ${ROW_INTERACTION} min-h-12 text-[15px] text-text-secondary`}
                onClick={openNewMessageDialog}
              >
                <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-active text-text-secondary">
                  <MessageSquarePlus size={18} aria-hidden="true" />
                </span>
                {i18n.t("kernel.newConversation.newMessage")}
              </button>
            </div>
          </Section>

          <Section
            id="channels"
            label={i18n.t("kernel.channels")}
            currentUserId={uid()}
            addLabel={i18n.t("kernel.newConversation.newChannel")}
            onAdd={openNewChannelDialog}
          >
            <For each={orderedGroup(channels().shown)}>{(thread) => threadRow(thread)}</For>
            <Show when={channels().folded.length > 0}>
              <Show when={!isSectionCollapsed("channelsMore")}>
                <For each={channels().folded}>{(thread) => threadRow(thread)}</For>
              </Show>
              <FooterToggle
                testid="chats-channels-more"
                collapsed={isSectionCollapsed("channelsMore")}
                label={
                  isSectionCollapsed("channelsMore")
                    ? moreChannelsLabel(channels().folded.length)
                    : i18n.t("kernel.channelsLess")
                }
                onToggle={() => toggleSectionCollapsed("channelsMore", uid())}
              />
            </Show>
            <Show when={joinable().length > 0}>
              <FooterToggle
                testid="chats-browse-channels"
                collapsed={isSectionCollapsed("joinableChannels")}
                label={i18n.t("kernel.chatsList.browseChannels")}
                count={joinable().length}
                onToggle={() => toggleSectionCollapsed("joinableChannels", uid())}
              />
              <Show when={!isSectionCollapsed("joinableChannels")}>
                <For each={joinable()}>
                  {(channel) => (
                    <JoinableRow
                      channel={channel}
                      busy={props.joiningId === channel.id}
                      onJoin={() => props.onJoin(channel)}
                    />
                  )}
                </For>
              </Show>
            </Show>
          </Section>

          <Show when={props.listFailed}>
            <ThreadsLoadFailedNotice onRetry={props.onRetry} retrying={props.retrying} />
          </Show>
          <Show when={nothingMatches() && !props.listFailed}>
            <div data-testid="chats-no-match" class="px-4 py-10 text-center text-text-tertiary">
              {i18n.t("kernel.noThreadsMatch")}
            </div>
          </Show>
        </div>
      </ScrollFade>

      {/* The compose sheet: the phone's pair to the section headers' "+". */}
      <OverlaySheet
        open={composeSheet()}
        onClose={() => setComposeSheet(false)}
        variant="bottom"
        title={i18n.t("kernel.newConversation.compose")}
        closeLabel={i18n.t("kernel.close")}
      >
        <div class="flex flex-col pb-2">
          <SheetButton
            testid="chats-compose-message"
            icon={<MessageSquarePlus size={18} class="shrink-0 text-text-secondary" />}
            label={i18n.t("kernel.newConversation.newMessage")}
            onClick={() => {
              setComposeSheet(false)
              openNewMessageDialog()
            }}
          />
          <SheetButton
            testid="chats-compose-channel"
            icon={<Hash size={18} class="shrink-0 text-text-secondary" />}
            label={i18n.t("kernel.newConversation.newChannel")}
            onClick={() => {
              setComposeSheet(false)
              openNewChannelDialog()
            }}
          />
        </div>
      </OverlaySheet>

      {/* The long-press sheet. `BottomSheetActions` owns its own trigger, which
          on a list would paint a "more" button on every row, so the rows drive
          the same bottom `OverlaySheet` directly. */}
      <OverlaySheet
        open={sheetThread() !== null}
        onClose={() => setSheetThread(null)}
        variant="bottom"
        title={i18n.t("kernel.chatActions")}
        closeLabel={i18n.t("kernel.close")}
      >
        <Show when={sheetThread() ? getThread(sheetThread() as string) : null}>
          {(thread) => (
            <div class="flex flex-col pb-2">
              <SheetButton
                testid="chat-sheet-pin"
                icon={<Pin size={18} class="shrink-0 text-text-secondary" />}
                label={isPinnedThread(thread()) ? i18n.t("kernel.unpin") : i18n.t("kernel.pin")}
                onClick={() => {
                  setSheetThread(null)
                  props.onTogglePin(thread())
                }}
              />
              <SheetButton
                testid="chat-sheet-mute"
                icon={<BellOff size={18} class="shrink-0 text-text-secondary" />}
                label={thread().isMuted ? i18n.t("kernel.unmute") : i18n.t("kernel.mute")}
                onClick={() => {
                  setSheetThread(null)
                  props.onToggleMute(thread())
                }}
              />
              <SheetButton
                testid="chat-sheet-open-home"
                icon={<ExternalLink size={18} class="shrink-0 text-text-secondary" />}
                label={i18n.t("kernel.openOnHome")}
                onClick={() => {
                  const t = thread()
                  setSheetThread(null)
                  openTab({
                    type: "thread",
                    entityId: t.id,
                    label: conversationDisplayName(t, uid()),
                  })
                  closeTabletSidebar()
                }}
              />
            </div>
          )}
        </Show>
      </OverlaySheet>
    </div>
  )
}

/** The fold row's label while closed: "N more channels", singular for one. */
export function moreChannelsLabel(count: number): string {
  return count === 1
    ? tNow("kernel.chatsList.moreChannelsOne", { count })
    : tNow("kernel.chatsList.moreChannelsMany", { count })
}

function SheetButton(props: {
  testid: string
  icon: JSX.Element
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      class="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-[15px] text-text hover:bg-surface-hover"
      onClick={props.onClick}
    >
      {props.icon}
      {props.label}
    </button>
  )
}

/** One collapsible section: a 44 px header that is the fold control, an
 *  optional "+" at its right edge, then its rows. The fold is remembered per
 *  user by the same store the desktop sidebar's headers use. */
function Section(props: {
  id: SidebarSectionId
  label: string
  count?: number
  currentUserId: string
  addLabel?: string
  onAdd?: () => void
  children: JSX.Element
}) {
  const collapsed = () => isSectionCollapsed(props.id)
  return (
    <section data-testid="chats-section" data-section={props.id} class="pt-2">
      <div class="flex items-center pr-1">
        <button
          type="button"
          data-testid={`chats-section-toggle-${props.id}`}
          aria-expanded={collapsed() ? "false" : "true"}
          class="flex h-11 min-w-0 flex-1 items-center gap-1.5 px-4 text-left outline-none"
          onClick={() => toggleSectionCollapsed(props.id, props.currentUserId)}
        >
          <ChevronDown
            size={14}
            aria-hidden="true"
            class={`shrink-0 text-text-tertiary transition-transform ${collapsed() ? "-rotate-90" : ""}`}
          />
          <span class="truncate text-[15px] font-semibold text-text">{props.label}</span>
          <Show when={props.count}>
            {(count) => (
              <span
                data-testid={`chats-section-count-${props.id}`}
                class="text-[13px] font-medium text-text-tertiary"
              >
                {count()}
              </span>
            )}
          </Show>
        </button>
        <Show when={props.onAdd}>
          {(onAdd) => (
            <button
              type="button"
              data-testid={`chats-section-add-${props.id}`}
              aria-label={props.addLabel}
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
              onClick={() => onAdd()()}
            >
              <Plus size={18} />
            </button>
          )}
        </Show>
      </div>
      <Show when={!collapsed()}>{props.children}</Show>
    </section>
  )
}

/** A quiet row at the foot of a section that opens or closes more rows. */
function FooterToggle(props: {
  testid: string
  collapsed: boolean
  label: string
  count?: number
  onToggle: () => void
}) {
  return (
    <div role="listitem">
      <button
        type="button"
        data-testid={props.testid}
        aria-expanded={props.collapsed ? "false" : "true"}
        class={`flex min-h-12 w-full items-center gap-3 px-4 text-left ${ROW_INTERACTION}`}
        onClick={props.onToggle}
      >
        <span class="flex h-10 w-10 shrink-0 items-center justify-center">
          <ChevronDown
            size={16}
            aria-hidden="true"
            class={`text-text-tertiary transition-transform ${props.collapsed ? "-rotate-90" : ""}`}
          />
        </span>
        <span class="min-w-0 flex-1 truncate text-[15px] text-text-secondary">{props.label}</span>
        <Show when={props.count}>
          {(count) => <span class="shrink-0 text-[13px] text-text-tertiary">{count()}</span>}
        </Show>
      </button>
    </div>
  )
}

/** The unread count. A mention makes it the loud red pill with an "@". */
function UnreadBadge(props: { count: number; mentioned: boolean }) {
  return (
    <Show when={props.count > 0}>
      <span
        role="status"
        data-testid="chat-row-unread"
        data-mention={props.mentioned ? "true" : undefined}
        aria-label={
          props.mentioned
            ? `${tNow("kernel.chatsList.mentioned")}, ${tNow("kernel.chatsList.unreadCount", { count: props.count })}`
            : tNow("kernel.chatsList.unreadCount", { count: props.count })
        }
        class="flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-semibold leading-none"
        classList={{
          "bg-danger text-white": props.mentioned,
          "bg-accent text-accent-foreground": !props.mentioned,
        }}
      >
        <Show when={props.mentioned}>
          <span aria-hidden="true">@</span>
        </Show>
        <span aria-hidden={props.mentioned ? "true" : undefined}>
          {props.count > 99 ? "99+" : props.count}
        </span>
      </span>
    </Show>
  )
}

/** One conversation: mark, name, relative time, last message, unread count. */
function InboxRow(props: {
  thread: Thread
  currentUserId: string
  mentioned: boolean
  onOpen: () => void
}) {
  const i18n = useI18n()
  const name = () => conversationDisplayName(props.thread, props.currentUserId)
  const unread = () => props.thread.unreadCount > 0 && !props.thread.isMuted
  const preview = () => {
    const last = props.thread.lastMessage?.content?.trim()
    return last ? previewLine(last, tNow, props.thread.lastMessage?.metadata) : props.thread.handle
  }

  return (
    <div role="listitem">
      <button
        type="button"
        data-testid="chat-row"
        data-thread-id={props.thread.id}
        data-unread={unread() ? "true" : undefined}
        onClick={props.onOpen}
        class={`${ROW} ${ROW_INTERACTION} ${props.thread.isMuted ? "opacity-60" : ""}`}
      >
        <RowMark thread={props.thread} currentUserId={props.currentUserId} />
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex items-center gap-1.5">
            <span
              data-testid="chat-row-title"
              class={`min-w-0 truncate text-[15px] ${
                unread() ? "font-bold text-text" : "font-medium text-text-secondary"
              }`}
            >
              {name()}
            </span>
            <Show when={isPinnedThread(props.thread)}>
              <Pin
                size={12}
                class="shrink-0 text-text-tertiary"
                aria-label={i18n.t("kernel.pinned")}
              />
            </Show>
            <Show when={props.thread.isMuted}>
              <BellOff
                size={12}
                class="shrink-0 text-text-tertiary"
                aria-label={i18n.t("kernel.muted")}
              />
            </Show>
            <span
              data-testid="chat-row-time"
              class={`ml-auto shrink-0 pl-2 text-[12px] ${unread() ? "text-text" : "text-text-tertiary"}`}
            >
              {formatRelativeTime(props.thread.lastMessage?.createdAt ?? props.thread.updatedAt, {
                i18n: rowLocaleFrom(i18n),
              })}
            </span>
          </span>
          <span class="flex items-center gap-2">
            <span
              data-testid="chat-row-preview"
              class={`min-w-0 flex-1 truncate text-[13px] ${
                unread() ? "text-text-secondary" : "text-text-tertiary"
              }`}
            >
              {preview()}
            </span>
            <UnreadBadge
              count={props.thread.isMuted ? 0 : props.thread.unreadCount}
              mentioned={props.mentioned}
            />
          </span>
        </span>
      </button>
    </div>
  )
}

/** The 40 px mark: a hash (or lock) tile for a channel, otherwise the face of
 *  the counterpart, with initials when there is no picture, the agent mark for
 *  an agent, and the presence dot for a person. */
function RowMark(props: { thread: Thread; currentUserId: string }) {
  const kind = () => conversationKind(props.thread, props.currentUserId)
  const counterpart = () => {
    const seats = resolvedParticipants(props.thread)
    return seats.find((p) => p.id !== props.currentUserId) ?? seats[0] ?? null
  }
  return (
    <span data-testid="chat-row-avatar" class="flex h-10 w-10 shrink-0 items-center justify-center">
      <Show
        when={kind().group !== "channel" && counterpart()}
        fallback={
          <span
            data-kind="channel"
            class="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-active text-text-secondary"
          >
            <Show
              when={(() => {
                const k = kind()
                return k.group === "channel" && k.visibility === "private"
              })()}
              fallback={<Hash size={18} aria-hidden="true" />}
            >
              <Lock size={16} aria-hidden="true" />
            </Show>
          </span>
        }
      >
        {(seat) => (
          <Avatar
            user={{
              id: seat().id,
              name: seat().name,
              avatarUrl: seat().avatarUrl,
              participantType: seat().participantType,
            }}
            size="lg"
            showPresence={seat().participantType !== "agent"}
            presenceStatus={presenceStore.users}
          />
        )}
      </Show>
    </span>
  )
}

/** The viewer's own agent as an inbox row: there whether or not the DM exists
 *  yet (pressing it opens or creates it), its state line under its name. */
function PersonalAgentInboxRow(props: {
  agent: AgentDisplay
  thread: Thread | undefined
  onOpen: () => void
}) {
  const i18n = useI18n()
  const unread = () => props.thread?.unreadCount ?? 0
  const subtitle = () => agentStateLabel(props.agent.state) || props.agent.purpose?.trim() || ""
  return (
    <div role="listitem">
      <button
        type="button"
        data-testid="chats-personal-agent-row"
        data-agent-id={props.agent.id}
        onClick={props.onOpen}
        class={`${ROW} ${ROW_INTERACTION}`}
      >
        <span
          data-testid="chat-row-avatar"
          class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full"
          style={agentAvatarStyle(props.agent.id, props.agent.avatarColor)}
        >
          <AvatarImage
            url={props.agent.avatarUrl}
            class="h-full w-full object-cover"
            loading="lazy"
            fallback={<AgentGlyph class="text-[20px]" />}
          />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex min-w-0 items-baseline gap-1">
            <span
              data-testid="chat-row-title"
              class={`min-w-0 truncate text-[15px] ${
                unread() > 0 ? "font-bold text-text" : "font-medium text-text-secondary"
              }`}
            >
              {props.agent.name}
            </span>
            <span
              data-testid="chats-personal-agent-yours"
              class="shrink-0 text-[13px] text-text-tertiary"
            >
              · {i18n.t("kernel.chatsList.yours")}
            </span>
          </span>
          <Show when={subtitle()}>
            <span data-testid="chat-row-preview" class="truncate text-[13px] text-text-tertiary">
              {subtitle()}
            </span>
          </Show>
        </span>
        <UnreadBadge count={unread()} mentioned={false} />
      </button>
    </div>
  )
}

/** A role agent the member has not messaged yet, in Agents: dimmed, and
 *  pressing it opens the DM through the same idempotent route the desktop row
 *  uses. */
function AgentOfferRow(props: { agent: AgentDisplay; busy: boolean; onStart: () => void }) {
  const i18n = useI18n()
  return (
    <div role="listitem">
      <button
        type="button"
        data-testid="chats-agent-offer"
        data-agent-id={props.agent.id}
        disabled={props.busy}
        aria-label={tNow("kernel.threadsUi.messageAgent", { handle: props.agent.handle })}
        class={`${ROW} ${ROW_INTERACTION} disabled:opacity-50`}
        onClick={props.onStart}
      >
        <span class="opacity-70">
          <Avatar
            user={{
              id: props.agent.id,
              name: props.agent.name,
              avatarUrl: props.agent.avatarUrl,
              participantType: "agent",
            }}
            size="lg"
          />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="truncate text-[15px] font-medium text-text-tertiary">
            {props.agent.name}
          </span>
          <span class="truncate text-[13px] text-text-tertiary">
            {props.agent.purpose?.trim() || i18n.t("kernel.chatsList.startConversation")}
          </span>
        </span>
      </button>
    </div>
  )
}

/** A channel the member can join: pressing it joins and opens it. */
function JoinableRow(props: { channel: DiscoverableChannel; busy: boolean; onJoin: () => void }) {
  const label = () => props.channel.title ?? props.channel.handle.replace(/^[@#]/, "")
  return (
    <div role="listitem">
      <button
        type="button"
        data-testid="chats-joinable-channel"
        data-channel-id={props.channel.id}
        disabled={props.busy}
        aria-label={tNow("kernel.joinAndOpenChannel", { name: label() })}
        class={`${ROW} ${ROW_INTERACTION} disabled:opacity-50`}
        onClick={props.onJoin}
      >
        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-border-subtle text-text-tertiary">
          <Hash size={18} aria-hidden="true" />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="truncate text-[15px] font-medium text-text-tertiary">{label()}</span>
          <Show when={props.channel.topic?.trim()}>
            {(topic) => <span class="truncate text-[13px] text-text-tertiary">{topic()}</span>}
          </Show>
        </span>
      </button>
    </div>
  )
}

export default ChatsList
