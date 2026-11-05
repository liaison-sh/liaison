// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  FileText,
  Hash,
  Link as LinkIcon,
  LogOut,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Users,
  X,
} from "lucide-solid"
import { type Component, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { searchMentions } from "~/lib/mention-service"
import { ambiguousNameKeys, foldName } from "~/lib/name-collision"
import { rovingFocus } from "~/lib/roving-focus"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { copyLink, entityRoute } from "~/modules/shell/entity-link"
import { openAgentPage } from "~/modules/threads/agent-directory"
import {
  ChannelDetailsDialog,
  type ChannelDetailsField,
} from "~/modules/threads/ChannelDetailsDialog"
import {
  conversationDisplayName,
  isChannel,
  isPersonToPersonConversation,
} from "~/modules/threads/conversation-display"
import { createInvokedModelMenu } from "~/modules/threads/InvokedModelMenu"
import OutsideTextMark from "~/modules/threads/OutsideTextMark"
import { presenceStore } from "~/modules/threads/presence-store"
import ThreadRuntimeSlot from "~/modules/threads/ThreadRuntimeSlot"
import { AvatarStack } from "~/ui/AvatarStack"
import { avatarColors } from "~/ui/avatar-palette"
import { FloatingPanel } from "~/ui/FloatingPanel"
import { Switch } from "~/ui/Switch"

interface ThreadHeaderProps {
  threadId: string
  title: string | null
  handle: string
  participants: Array<{
    id: string
    name: string
    avatarUrl: string | null
    role?: string
    participantType?: "user" | "agent"
    agentId?: string | null
  }>
  isPinned: boolean
  isPinnedByUser: boolean
  isMuted: boolean
  isArchived: boolean
  /** `kernel.threads.type`, so a titled agent DM is not mistaken for a channel. */
  threadType?: string
  /** A35: whether this channel is public (any member can find and join it). */
  discoverable: boolean
  /** The conversation read outside text (`threads.tainted`): the globe shows beside the name. */
  tainted?: boolean
  /** The Slack/Buzz pair. `topic` renders beside the name; `description` is
   *  edited from the menu and shown in the channel details. */
  topic: string | null
  description: string | null
  currentUserId: string
  createdBy?: string
  canAdminThreads?: boolean
  onTogglePin: () => void
  onTogglePinForAll: () => void
  onToggleMute: () => void
  /** The reader's opt-in to be interrupted by every post of this channel. */
  notifyAllPosts?: boolean
  /** Offered for channels only: by default a channel notifies its members for mentions only. */
  onToggleNotifyAllPosts?: (next: boolean) => void
  /** A35: publish or unpublish the channel. Offered for channels only. */
  onToggleDiscoverable: (next: boolean) => void
  /** Save one of the Slack/Buzz pair. `null` clears the field. */
  onSaveDetails: (field: ChannelDetailsField, value: string | null) => void | Promise<void>
  onArchive: () => void
  onLeave: () => void
  onAddParticipant: (userId: string, name: string, avatarUrl: string | null) => void
  onRemoveParticipant: (userId: string) => void
}

const ThreadHeader: Component<ThreadHeaderProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()

  // A35: "Discoverable" is a CHANNEL setting. `isChannel` is the shared rule
  // (a titled room that is not a 1:1 with an agent), so this menu and the
  // sidebar's grouping can never disagree about what a channel is.
  // THE NAME IS THE SHAPE'S, NOT THE ROW'S. A DM with an agent is headed by
  // the agent, even when the row carries a title: a personal agent DM that had
  // picked one up along the way was headed "System Test Confirmation" while
  // its own tab said "Personal agent". `conversationDisplayName` is the rule
  // the sidebar and the phone list already name rows with, so no two surfaces
  // can disagree about what a conversation is called.
  const headerName = () =>
    conversationDisplayName(
      {
        title: props.title,
        type: props.threadType,
        discoverable: props.discoverable,
        participants: props.participants,
      },
      props.currentUserId,
    )

  const isChannelRoom = () =>
    isChannel(
      {
        title: props.title,
        type: props.threadType,
        discoverable: props.discoverable,
        participants: props.participants,
      },
      props.currentUserId,
    )

  // Which of the pair the dialog is editing, or null for closed. One signal
  // rather than two booleans: the two fields can never be open at once.
  const [detailsField, setDetailsField] = createSignal<ChannelDetailsField | null>(null)

  const canRemoveOthers = () =>
    props.canAdminThreads === true || props.createdBy === props.currentUserId

  // Agent members are real participant rows, so the header renders them the
  // same way it renders humans: no synthetic seat, no hardcoded name.
  const displayParticipants = () => props.participants

  const otherParticipants = () => displayParticipants().filter((p) => p.id !== props.currentUserId)

  const onlineCount = () =>
    otherParticipants().filter((p) => presenceStore.users[p.id] === "online").length

  // --- Add participant popover ---
  const [addOpen, setAddOpen] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const [searchResults, setSearchResults] = createSignal<
    Array<{ id: string; name: string; email: string | null; avatarUrl: string | null }>
  >([])
  // The email is only worth showing next to a name that collides with
  // another candidate ALSO on screen (case/accent-insensitive).
  const ambiguousResultNames = createMemo(() =>
    ambiguousNameKeys(searchResults().map((r) => r.name)),
  )

  let searchTimeout: ReturnType<typeof setTimeout> | undefined
  let searchSeq = 0
  onCleanup(() => searchTimeout && clearTimeout(searchTimeout))

  function handleSearch(q: string) {
    setSearch(q)
    if (searchTimeout) clearTimeout(searchTimeout)
    if (q.length < 2) {
      searchSeq++
      setSearchResults([])
      return
    }
    const seq = ++searchSeq
    searchTimeout = setTimeout(async () => {
      try {
        const data = await searchMentions(api, q, "@", 10)
        if (seq !== searchSeq) return
        const existingIds = new Set(props.participants.map((p) => p.id))
        setSearchResults(
          data
            .filter((r) => r.type === "user" && !existingIds.has(r.id))
            .map((r) => ({
              id: r.id,
              name: r.label,
              email: r.secondaryLabel ?? null,
              avatarUrl: null,
            })),
        )
      } catch {
        if (seq === searchSeq) setSearchResults([])
      }
    }, 200)
  }

  // --- Hidden-history warning ---
  // Adding someone to a room that already holds messages they cannot read is a
  // decision, not a side effect: the server says whether this candidate would
  // arrive to a partly unreadable history, and the adder confirms it.
  const [pendingAdd, setPendingAdd] = createSignal<{
    id: string
    name: string
    avatarUrl: string | null
  } | null>(null)

  function commitAdd(user: { id: string; name: string; avatarUrl: string | null }) {
    props.onAddParticipant(user.id, user.name, user.avatarUrl)
    setSearch("")
    setSearchResults([])
    setPendingAdd(null)
    setAddOpen(false)
  }

  async function wouldHideHistory(candidateId: string): Promise<boolean> {
    try {
      const res: any = await api.get(
        `/threads/${props.threadId}/hidden-history-check?userId=${encodeURIComponent(candidateId)}`,
      )
      return (res?.data ?? res)?.wouldHideHistory === true
    } catch {
      // No answer is not a warning: the add proceeds as it always has rather
      // than the UI inventing a privacy claim it cannot stand behind.
      return false
    }
  }

  async function handleAddUser(user: { id: string; name: string; avatarUrl: string | null }) {
    if (await wouldHideHistory(user.id)) {
      setPendingAdd(user)
      return
    }
    commitAdd(user)
  }

  // --- Actions menu ---
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [confirmLeave, setConfirmLeave] = createSignal(false)
  const [confirmRemoveId, setConfirmRemoveId] = createSignal<string | null>(null)

  function handleMenuOpenChange(open: boolean) {
    setMenuOpen(open)
    if (!open) {
      setConfirmLeave(false)
      setConfirmRemoveId(null)
    }
  }

  // Between people the model choice is a menu entry, not a composer pill.
  const invokedModel = createInvokedModelMenu({
    threadId: () => props.threadId,
    enabled: () =>
      isPersonToPersonConversation(
        {
          title: props.title,
          type: props.threadType,
          discoverable: props.discoverable,
          participants: props.participants,
        },
        props.currentUserId,
      ),
    closeMenu: () => handleMenuOpenChange(false),
  })

  return (
    <div class="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-2.5">
      {/* Left: avatar + title + participant info */}
      <div class="flex min-w-0 items-center gap-3">
        <AvatarStack
          users={displayParticipants()}
          size="md"
          showPresence
          presenceStatus={presenceStore.users}
        />
        {/* min-w-0 is load bearing: the stack beside this block widens in flow
            when it expands, and this block gives way by truncating rather than
            being overlaid. */}
        <div data-testid="thread-header-title-block" class="min-w-0">
          <div class="flex items-center gap-1.5">
            <h2
              data-testid="thread-header-title"
              class="truncate text-[14px] font-semibold text-text"
            >
              {headerName()}
            </h2>
            <Show when={props.isPinned || props.isPinnedByUser}>
              <Pin size={12} class="shrink-0 text-text-tertiary" />
            </Show>
            <Show when={props.isMuted}>
              <BellOff size={12} class="shrink-0 text-text-tertiary" />
            </Show>
            <Show when={props.isArchived}>
              <Archive size={12} class="shrink-0 text-text-tertiary" />
            </Show>
            <OutsideTextMark
              threadId={props.threadId}
              marked={props.tainted === true}
              variant="label"
            />
            {/* The topic travels WITH the name, which is the whole point of it
                being separate from the description: it is what the room is on
                about, read at a glance. Truncated here and given in full by the
                native tooltip, because the header is a line and a topic can be
                250 characters. */}
            <Show when={props.topic?.trim()}>
              {(topic) => (
                <>
                  <span class="shrink-0 text-[12px] text-text-tertiary">
                    {i18n.t("kernel.threadsUi.text")}
                  </span>
                  <span
                    data-testid="thread-header-topic"
                    title={topic()}
                    class="min-w-0 truncate text-[12px] text-text-tertiary"
                  >
                    {topic()}
                  </span>
                </>
              )}
            </Show>
          </div>
          <div class="flex items-center gap-1.5 text-[11.5px] text-text-tertiary">
            <Users size={12} />
            <span data-testid="participant-count">{displayParticipants().length}</span>
            <Show when={onlineCount() > 0}>
              <span class="text-success">
                {i18n.t("kernel.threadsUi.text")} {onlineCount()}{" "}
                {i18n.t("kernel.threadsUi.online")}
              </span>
            </Show>

            {/* Add participant */}
            <FloatingPanel open={addOpen()} onOpenChange={setAddOpen}>
              <FloatingPanel.Trigger
                class="ml-1 flex h-4.5 w-4.5 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
                aria-label={i18n.t("kernel.addParticipant")}
              >
                <Plus size={12} />
              </FloatingPanel.Trigger>
              <FloatingPanel.Content class="w-64 p-2">
                <div class="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2 py-1.5">
                  <Search size={12} class="shrink-0 text-text-tertiary" />
                  <input
                    type="text"
                    placeholder={i18n.t("kernel.searchPeople")}
                    class="w-full bg-transparent text-[12px] text-text outline-none placeholder:text-text-tertiary"
                    value={search()}
                    onInput={(e) => handleSearch(e.currentTarget.value)}
                    autofocus
                  />
                </div>
                <Show when={searchResults().length > 0}>
                  <div class="mt-1.5 max-h-40 overflow-y-auto">
                    <For each={searchResults()}>
                      {(user) => (
                        <button
                          type="button"
                          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-surface-hover"
                          onClick={() => void handleAddUser(user)}
                        >
                          <div
                            class="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium"
                            style={{
                              "background-color": avatarColors(user.id).bg,
                              color: avatarColors(user.id).text,
                            }}
                          >
                            {user.name.charAt(0)}
                          </div>
                          <span class="flex min-w-0 flex-col">
                            <span class="truncate text-[12px] text-text">{user.name}</span>
                            <Show
                              when={user.email && ambiguousResultNames().has(foldName(user.name))}
                            >
                              <span class="truncate text-[10.5px] text-text-tertiary">
                                {user.email}
                              </span>
                            </Show>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={pendingAdd()}>
                  {(candidate) => (
                    <div data-testid="add-member-warning" class="mt-2 px-2">
                      <p class="text-[11px] text-text-secondary">
                        {i18n.t("kernel.addMemberHiddenHistoryWarning", {
                          name: candidate().name,
                        })}
                      </p>
                      <div class="mt-1.5 flex items-center gap-2">
                        <button
                          type="button"
                          data-testid="add-member-confirm"
                          class="rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-foreground"
                          onClick={() => commitAdd(candidate())}
                        >
                          {i18n.t("kernel.addMemberAddAnyway")}
                        </button>
                        <button
                          type="button"
                          data-testid="add-member-cancel"
                          class="rounded-md border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary"
                          onClick={() => setPendingAdd(null)}
                        >
                          {i18n.t("kernel.common.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </Show>

                <Show when={search().length >= 2 && searchResults().length === 0}>
                  <p class="mt-1.5 px-2 text-[11px] text-text-tertiary">
                    {i18n.t("kernel.noResults")}
                  </p>
                </Show>
              </FloatingPanel.Content>
            </FloatingPanel>
          </div>
        </div>
      </div>

      {/* Right: actions menu */}
      <div class="flex items-center gap-2">
        {/*
          Where this conversation's turns run, on the desktop only (P6d-T07).
          The predicate is ThreadRuntimeSlot's, shared with the dock tab that
          holds the same conversation (P4c-T19): one agent seat is a
          conversation with that agent and the offer means something; two or
          more is a channel and it belongs to none of them. In a browser
          RuntimeControl renders nothing at all, so this header is byte
          identical to what it was before the desktop UI moved in.
        */}
        <ThreadRuntimeSlot
          threadId={props.threadId}
          title={props.title}
          threadType={props.threadType}
          currentUserId={props.currentUserId}
          participants={displayParticipants()}
        />

        {/* Actions panel. The box is the Invoked model selector's anchor. */}
        <div class="relative flex">
          <FloatingPanel open={menuOpen()} onOpenChange={handleMenuOpenChange}>
            <FloatingPanel.Trigger
              class="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
              aria-label={i18n.t("kernel.threadActions")}
              data-testid="thread-header.actions"
            >
              <MoreHorizontal size={16} />
            </FloatingPanel.Trigger>
            <FloatingPanel.Content class="w-56" onCloseAutoFocus={invokedModel.onCloseAutoFocus}>
              <div onKeyDown={rovingFocus}>
                <button
                  type="button"
                  data-roving
                  class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                  onClick={() => {
                    props.onTogglePin()
                    handleMenuOpenChange(false)
                  }}
                >
                  <Show when={props.isPinnedByUser} fallback={<Pin size={14} />}>
                    <PinOff size={14} />
                  </Show>
                  {props.isPinnedByUser
                    ? i18n.t("kernel.threadsUi.unpin")
                    : i18n.t("kernel.threadsUi.pin")}
                </button>

                <button
                  type="button"
                  data-roving
                  data-testid="thread-header.copy-link"
                  class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                  onClick={() => {
                    void copyLink(entityRoute("kernel:thread", props.threadId))
                    handleMenuOpenChange(false)
                  }}
                >
                  <LinkIcon size={14} />
                  {i18n.t("kernel.copyLink")}
                </button>

                <Show when={props.canAdminThreads}>
                  <button
                    type="button"
                    data-roving
                    class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                    onClick={() => {
                      props.onTogglePinForAll()
                      handleMenuOpenChange(false)
                    }}
                  >
                    <Show when={props.isPinned} fallback={<Pin size={14} />}>
                      <PinOff size={14} />
                    </Show>
                    {props.isPinned
                      ? i18n.t("kernel.threadsUi.unpinForAll")
                      : i18n.t("kernel.threadsUi.pinForAll")}
                  </button>
                </Show>

                <button
                  type="button"
                  data-roving
                  data-testid="thread-header.mute"
                  class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                  onClick={() => {
                    props.onToggleMute()
                    handleMenuOpenChange(false)
                  }}
                >
                  <Show when={props.isMuted} fallback={<BellOff size={14} />}>
                    <Bell size={14} />
                  </Show>
                  {props.isMuted
                    ? i18n.t("kernel.threadsUi.unmute")
                    : i18n.t("kernel.threadsUi.mute")}
                </button>

                <button
                  type="button"
                  data-roving
                  class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                  onClick={() => {
                    props.onArchive()
                    handleMenuOpenChange(false)
                  }}
                >
                  <Show when={props.isArchived} fallback={<Archive size={14} />}>
                    <ArchiveRestore size={14} />
                  </Show>
                  {props.isArchived
                    ? i18n.t("kernel.threadsUi.unarchiveThread")
                    : i18n.t("kernel.threadsUi.archiveThread")}
                </button>

                <invokedModel.Item
                  roving
                  iconSize={14}
                  class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                />

                <Show when={isChannelRoom()}>
                  <div class="my-1 h-px bg-border-subtle" />
                  <button
                    type="button"
                    data-roving
                    data-testid="thread-set-topic"
                    class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                    onClick={() => {
                      setDetailsField("topic")
                      handleMenuOpenChange(false)
                    }}
                  >
                    <Hash size={14} />
                    {i18n.t("kernel.threadSetTopic")}
                  </button>

                  <button
                    type="button"
                    data-roving
                    data-testid="thread-edit-description"
                    class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                    onClick={() => {
                      setDetailsField("description")
                      handleMenuOpenChange(false)
                    }}
                  >
                    <FileText size={14} />
                    {i18n.t("kernel.threadEditDescription")}
                  </button>

                  {/* Label and switch share one line; the help line then spans the
                    whole row. Nesting the help text beside the switch reserved
                    the track's width for every line and wrapped the sentence
                    narrower than the description block above it. */}
                  <div data-testid="thread-discoverable-row" class="px-3 py-1.5">
                    <div class="flex items-center justify-between gap-3">
                      <p class="min-w-0 text-[13px] text-text-secondary">
                        {i18n.t("kernel.threadDiscoverable")}
                      </p>
                      <Switch
                        data-testid="thread-discoverable-switch"
                        checked={props.discoverable}
                        label={i18n.t("kernel.threadDiscoverable")}
                        onChange={(next) => props.onToggleDiscoverable(next)}
                      />
                    </div>
                    <p
                      data-testid="thread-discoverable-help"
                      class="mt-0.5 text-[11px] leading-snug text-text-tertiary"
                    >
                      {i18n.t("kernel.threadDiscoverableHelp")}
                    </p>
                  </div>

                  <Show when={props.onToggleNotifyAllPosts}>
                    {(toggle) => (
                      <div data-testid="thread-notify-all-row" class="px-3 py-1.5">
                        <div class="flex items-center justify-between gap-3">
                          <p class="min-w-0 text-[13px] text-text-secondary">
                            {i18n.t("kernel.threadNotifyAllPosts")}
                          </p>
                          <Switch
                            data-testid="thread-notify-all-switch"
                            checked={props.notifyAllPosts === true}
                            label={i18n.t("kernel.threadNotifyAllPosts")}
                            onChange={(next) => toggle()(next)}
                          />
                        </div>
                        <p
                          data-testid="thread-notify-all-help"
                          class="mt-0.5 text-[11px] leading-snug text-text-tertiary"
                        >
                          {i18n.t("kernel.threadNotifyAllPostsHelp")}
                        </p>
                      </div>
                    )}
                  </Show>
                </Show>

                <div class="my-1 h-px bg-border-subtle" />

                {/* The channel DETAILS: this menu's lower half is the only
                  details surface the desktop header has, so the standing
                  description belongs here rather than in the header line,
                  which is the topic's. Wrapped, not truncated: a description
                  is meant to be read. */}
                <Show when={isChannelRoom() && props.description?.trim()}>
                  {(description) => (
                    <>
                      <div class="px-3 py-1">
                        <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                          {i18n.t("kernel.threadDescription")}
                        </span>
                      </div>
                      <p
                        data-testid="thread-header-description"
                        class="whitespace-pre-wrap px-3 pb-1.5 text-[12px] leading-snug text-text-secondary"
                      >
                        {description()}
                      </p>
                      <div class="my-1 h-px bg-border-subtle" />
                    </>
                  )}
                </Show>

                <div class="px-3 py-1">
                  <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                    {i18n.t("kernel.threadsUi.participants")}
                  </span>
                </div>
                <div class={confirmRemoveId() ? "" : "max-h-36 overflow-y-auto"}>
                  <For each={props.participants}>
                    {(p) => (
                      <Show
                        when={confirmRemoveId() !== p.id}
                        fallback={
                          <div class="px-3 py-1.5">
                            <p class="mb-1.5 text-[12px] text-text-secondary">
                              {i18n.t("kernel.common.remove")} {p.name}?
                            </p>
                            <div class="flex gap-1.5">
                              <button
                                type="button"
                                data-roving
                                class="rounded-md bg-danger px-2.5 py-1 text-[12px] font-medium text-white outline-none transition-colors hover:bg-danger/90 focus-visible:ring-2 focus-visible:ring-danger/50"
                                onClick={() => {
                                  props.onRemoveParticipant(p.id)
                                  setConfirmRemoveId(null)
                                }}
                              >
                                {i18n.t("kernel.common.remove")}
                              </button>
                              <button
                                type="button"
                                data-roving
                                class="rounded-md border border-border-strong px-2.5 py-1 text-[12px] font-medium text-text-secondary outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
                                onClick={() => setConfirmRemoveId(null)}
                              >
                                {i18n.t("kernel.common.cancel")}
                              </button>
                            </div>
                          </div>
                        }
                      >
                        <div
                          data-roving
                          tabindex="0"
                          class="flex items-center justify-between rounded-md px-3 py-1 outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
                          onKeyDown={(e) => {
                            if (
                              e.key === "Enter" &&
                              p.id !== props.currentUserId &&
                              canRemoveOthers()
                            ) {
                              e.preventDefault()
                              setConfirmRemoveId(p.id)
                            }
                          }}
                        >
                          <div class="flex items-center gap-2">
                            <div
                              class="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium"
                              style={{
                                "background-color": avatarColors(p.id).bg,
                                color: avatarColors(p.id).text,
                              }}
                            >
                              {p.name.charAt(0)}
                            </div>
                            <span class="text-[12px] text-text-secondary">
                              {p.name}
                              {p.id === props.currentUserId && (
                                <span class="ml-1 text-text-tertiary">
                                  {i18n.t("kernel.threadsUi.you")}
                                </span>
                              )}
                            </span>
                          </div>
                          <Show when={p.participantType === "agent" && p.agentId}>
                            <button
                              type="button"
                              data-testid={`thread-header-agent-profile-${p.agentId}`}
                              class="ml-auto mr-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary outline-none transition-colors hover:bg-surface-hover hover:text-text-secondary"
                              aria-label={i18n.t("kernel.agentProfileOpen", { name: p.name })}
                              onClick={(e) => {
                                e.stopPropagation()
                                // The agent's own page, opened from the seat
                                // that names it: the memory tab is the reason a
                                // participant row is worth clicking at all.
                                openAgentPage({ id: p.agentId as string, name: p.name })
                                handleMenuOpenChange(false)
                              }}
                            >
                              {i18n.t("kernel.agentProfileTabProfile")}
                            </button>
                          </Show>
                          <Show when={p.id !== props.currentUserId && canRemoveOthers()}>
                            <button
                              type="button"
                              class="flex h-4.5 w-4.5 items-center justify-center rounded text-text-tertiary outline-none transition-colors hover:bg-danger/10 hover:text-danger"
                              aria-label={tNow("kernel.threadsUi.removeParticipant", {
                                name: p.name,
                              })}
                              tabindex="-1"
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirmRemoveId(p.id)
                              }}
                            >
                              <X size={12} />
                            </button>
                          </Show>
                        </div>
                      </Show>
                    )}
                  </For>
                </div>

                <div class="my-1 h-px bg-border-subtle" />

                {/* Leave thread — with inline confirmation */}
                <Show
                  when={!confirmLeave()}
                  fallback={
                    <div class="px-3 py-1.5">
                      <p class="mb-1.5 text-[12px] text-text-secondary">
                        {i18n.t("kernel.leaveThisThread")}
                      </p>
                      <div class="flex gap-1.5">
                        <button
                          type="button"
                          data-roving
                          class="rounded-md bg-danger px-2.5 py-1 text-[12px] font-medium text-white outline-none transition-colors hover:bg-danger/90 focus-visible:ring-2 focus-visible:ring-danger/50"
                          onClick={() => {
                            props.onLeave()
                            handleMenuOpenChange(false)
                          }}
                        >
                          {i18n.t("kernel.threadsUi.leave")}
                        </button>
                        <button
                          type="button"
                          data-roving
                          class="rounded-md border border-border-strong px-2.5 py-1 text-[12px] font-medium text-text-secondary outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
                          onClick={() => setConfirmLeave(false)}
                        >
                          {i18n.t("kernel.common.cancel")}
                        </button>
                      </div>
                    </div>
                  }
                >
                  <button
                    type="button"
                    data-roving
                    class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-danger outline-none transition-colors hover:bg-danger/10 focus-visible:bg-danger/10"
                    onClick={() => setConfirmLeave(true)}
                  >
                    <LogOut size={14} />
                    {i18n.t("kernel.threadsUi.leaveThread")}
                  </button>
                </Show>
              </div>
            </FloatingPanel.Content>
          </FloatingPanel>
          <invokedModel.Anchor />
        </div>
      </div>

      {/* One dialog for both menu entries: the field it is editing IS its open
          state, so neither can be open while the other is. */}
      <ChannelDetailsDialog
        field={detailsField()}
        initialValue={detailsField() === "description" ? props.description : props.topic}
        onSave={async (value) => {
          const field = detailsField()
          if (field) await props.onSaveDetails(field, value)
        }}
        onClose={() => setDetailsField(null)}
      />
    </div>
  )
}

export default ThreadHeader
