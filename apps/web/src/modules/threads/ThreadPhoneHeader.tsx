// SPDX-License-Identifier: FSL-1.1-ALv2
//
// F4. The phone thread screen's nav bar content: who the conversation is with,
// what its agent is doing, and the thread's own actions. The phone tier has no
// tab strip and the desktop `ThreadHeader` does not fit a 390px bar (avatar
// stack, participant row, add-participant popover, runtime slot), so the top
// bar resolves THIS through the tab type registry instead and the rest of the
// shell keeps its plain label bar.
//
// The mutations are the ones the desktop menu offers, written the same way:
// optimistic store update, PATCH, toast and rollback on failure.
import {
  Archive,
  Bell,
  BellOff,
  ChevronLeft,
  FileText,
  Hash,
  LogOut,
  MoreHorizontal,
  Pin,
  PinOff,
} from "lucide-solid"
import { type Component, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { closeTab, makeTabId } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { agentTurnState, pendingToolName } from "~/modules/threads/AgentStateLabel"
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
import { getChannelAgentStream } from "~/modules/threads/message-store"
import { presenceStore } from "~/modules/threads/presence-store"
import { closeReplyPanel, getOpenReplyPanel } from "~/modules/threads/reply-panel-store"
import ThreadRuntimeSlot from "~/modules/threads/ThreadRuntimeSlot"
import {
  agentTypingInThread,
  getThread,
  removeThread,
  setThreadDetails,
  setThreadDiscoverable,
  setThreadMuted,
  setThreadNotifyAllPosts,
  setThreadPinned,
  setThreadPinnedByUser,
} from "~/modules/threads/thread-store"
import { threadForTab, threadTabLabel } from "~/modules/threads/thread-tab-names"
import { createPushNav } from "~/primitives/createPushNav"
import { FloatingPanel } from "~/ui/FloatingPanel"
import { Switch } from "~/ui/Switch"

/** How often the agent state re-evaluates its idle threshold. */
const TICK_MS = 1_000

interface ThreadPhoneHeaderProps {
  entityId: string
}

const ThreadPhoneHeader: Component<ThreadPhoneHeaderProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  // K1: this header owns the ENTIRE bar once registered, so its own back
  // control has to replicate exactly what the shell's generic bar did (real
  // browser back when the detail was pushed, same "came from" label) rather
  // than a fixed destination — a thread is reachable from more than one
  // place (Chats' list, Home's attention feed, a mention), and only
  // `pushNav` knows which.
  const pushNav = createPushNav()
  // A reply thread covers the channel on the phone, so back leaves the reply
  // thread for its channel first; only from the channel does it leave for
  // wherever the channel was opened from. It used to skip the channel and land
  // on the Chats list, with the panel's own cross as the only way back.
  const replyOpen = () => getOpenReplyPanel(props.entityId) !== null
  const back = () => (replyOpen() ? closeReplyPanel(props.entityId) : pushNav.popDetail())
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => clearInterval(timer))

  const threadId = () => props.entityId
  // The list's copy, else the one the open tab keeps current once the
  // conversation left the list (archived while open): the bar keeps its name.
  const thread = () => getThread(threadId()) ?? threadForTab(threadId())
  const currentUserId = () => userFromToken()?.userId ?? ""
  const canAdminThreads = createMemo(
    () => hasScope("kernel:threads:admin") || hasScope("kernel:admin"),
  )

  const title = () => {
    const t = thread()
    if (t) return conversationDisplayName(t, currentUserId())
    // Opened outside the list (from Archived): read by id, once.
    return threadTabLabel(threadId(), currentUserId()) ?? i18n.t("kernel.threadTitle")
  }

  /** Queued / Working / Stuck / Failed, or "idle" when no turn is running. */
  const turnState = () => {
    const stream = getChannelAgentStream(threadId())
    return agentTurnState({
      streamState: stream.state,
      lastActivityAt: stream.lastActivityAt,
      announced: agentTypingInThread(threadId()),
      now: now(),
      awaitingTool: pendingToolName(stream.toolCalls) !== null,
    })
  }

  const stateLabel = () => {
    const state = turnState()
    if (state === "idle") return null
    return i18n.t(`kernel.agentState${state.charAt(0).toUpperCase()}${state.slice(1)}`)
  }

  /** The people in the room who are online right now, the viewer aside. */
  const onlineCount = () =>
    (thread()?.participants ?? []).filter(
      (p) => p.id !== currentUserId() && presenceStore.users[p.id] === "online",
    ).length

  const [menuOpen, setMenuOpen] = createSignal(false)
  const [confirmLeave, setConfirmLeave] = createSignal(false)

  function handleMenuOpenChange(open: boolean) {
    setMenuOpen(open)
    if (!open) setConfirmLeave(false)
  }

  // Between people the model choice is a menu entry, not a composer pill.
  // The control itself is the one ThreadView publishes for this thread.
  const invokedModel = createInvokedModelMenu({
    threadId,
    enabled: () => {
      const t = thread()
      return t ? isPersonToPersonConversation(t, currentUserId()) : false
    },
    closeMenu: () => handleMenuOpenChange(false),
  })

  async function togglePin() {
    const t = thread()
    if (!t) return
    const next = !(t.isPinnedByUser ?? false)
    setThreadPinnedByUser(threadId(), next)
    try {
      await api.patch(`/threads/${threadId()}/state`, { isPinned: next })
    } catch {
      setThreadPinnedByUser(threadId(), !next)
      addToast({ message: i18n.t("kernel.threadPinFailed"), type: "error" })
    }
  }

  async function togglePinForAll() {
    const t = thread()
    if (!t) return
    const next = !t.isPinned
    setThreadPinned(threadId(), next)
    try {
      await api.patch(`/threads/${threadId()}`, { isPinned: next })
    } catch {
      setThreadPinned(threadId(), !next)
      addToast({ message: i18n.t("kernel.threadPinFailed"), type: "error" })
    }
  }

  // A35: the same channel setting the desktop menu offers, written the same
  // way. `isChannel` is the shared rule, so a titled agent DM never shows it.
  const isChannelRoom = createMemo(() => {
    const t = thread()
    return t ? isChannel(t, currentUserId()) : false
  })

  // Which of the pair the dialog is editing, or null for closed. Same single
  // signal as the desktop menu, for the same reason.
  const [detailsField, setDetailsField] = createSignal<ChannelDetailsField | null>(null)

  async function saveDetails(field: ChannelDetailsField, value: string | null) {
    const t = thread()
    if (!t) return
    const previous = field === "topic" ? (t.topic ?? null) : (t.description ?? null)
    setThreadDetails(threadId(), { [field]: value })
    try {
      await api.patch(`/threads/${threadId()}`, { [field]: value })
    } catch {
      setThreadDetails(threadId(), { [field]: previous })
      addToast({
        message:
          field === "topic"
            ? i18n.t("kernel.threadTopicFailed")
            : i18n.t("kernel.threadDescriptionFailed"),
        type: "error",
      })
    }
  }

  async function toggleDiscoverable(next: boolean) {
    const t = thread()
    if (!t) return
    setThreadDiscoverable(threadId(), next)
    try {
      await api.patch(`/threads/${threadId()}`, { discoverable: next })
    } catch {
      setThreadDiscoverable(threadId(), !next)
      addToast({ message: i18n.t("kernel.threadDiscoverableFailed"), type: "error" })
    }
  }

  async function toggleNotifyAllPosts(next: boolean) {
    if (!thread()) return
    setThreadNotifyAllPosts(threadId(), next)
    try {
      await api.patch(`/threads/${threadId()}/state`, { notifyAllPosts: next })
    } catch {
      setThreadNotifyAllPosts(threadId(), !next)
      addToast({ message: i18n.t("kernel.threadNotifyAllPostsFailed"), type: "error" })
    }
  }

  async function toggleMute() {
    const t = thread()
    if (!t) return
    const next = !(t.isMuted ?? false)
    setThreadMuted(threadId(), next)
    try {
      await api.patch(`/threads/${threadId()}/state`, { isMuted: next })
    } catch {
      setThreadMuted(threadId(), !next)
      addToast({ message: i18n.t("kernel.threadMuteFailed"), type: "error" })
    }
  }

  // The client thread store holds only unarchived rows (loadThreads asks for
  // `archived=false` and the archive path removes the row), so this screen
  // archives and leaves; unarchiving lives in the archived list.
  async function archive() {
    try {
      await api.patch(`/threads/${threadId()}/state`, { isArchived: true })
      removeThread(threadId())
      closeTab(makeTabId("thread", threadId()))
    } catch {
      addToast({ message: i18n.t("kernel.threadArchiveFailed"), type: "error" })
    }
  }

  async function leave() {
    try {
      await api.delete(`/threads/${threadId()}/participants/${currentUserId()}`)
      removeThread(threadId())
      closeTab(makeTabId("thread", threadId()))
    } catch {
      addToast({ message: i18n.t("kernel.threadLeaveFailed"), type: "error" })
    }
  }

  const itemClass =
    "flex w-full items-center gap-2.5 px-3 py-2 text-[14px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text"

  return (
    <div data-testid="phone-thread-header" class="flex min-w-0 flex-1 items-center gap-2">
      <button
        type="button"
        data-testid="phone-thread-back"
        aria-label={i18n.t("kernel.back")}
        onClick={back}
        class="flex min-h-11 shrink-0 items-center gap-0.5 rounded-md pl-1 pr-1.5 text-text-secondary hover:bg-surface-hover"
      >
        <ChevronLeft size={20} />
        <Show when={!replyOpen() && pushNav.backLabel()}>
          {(label) => (
            <span data-testid="phone-thread-back-label" class="max-w-24 truncate text-[14px]">
              {label()}
            </span>
          )}
        </Show>
      </button>
      <div class="flex min-w-0 flex-1 flex-col">
        <span data-testid="phone-thread-title" class="truncate text-[15px] font-semibold text-text">
          {title()}
        </span>
        {/* The topic sits UNDER the name here: a phone header has no room
            beside it, and the line is still what says what the room is on
            about. Truncated, with the full text on the element's own title. */}
        <Show when={thread()?.topic?.trim()}>
          {(topic) => (
            <span
              data-testid="phone-thread-topic"
              title={topic()}
              class="truncate text-[11px] text-text-tertiary"
            >
              {topic()}
            </span>
          )}
        </Show>
        <Show
          when={stateLabel()}
          fallback={
            <Show when={onlineCount() > 0}>
              <span data-testid="phone-thread-presence" class="truncate text-[11px] text-success">
                {i18n.t("kernel.threadOnlineCount", { count: String(onlineCount()) })}
              </span>
            </Show>
          }
        >
          {(label) => (
            <span
              data-testid="phone-thread-state"
              data-state={turnState()}
              class="truncate text-[11px] text-text-tertiary"
            >
              {label()}
            </span>
          )}
        </Show>
      </div>

      {/* Where this conversation's turns run (P4 N-D T6, S24): on the phone it
          is My node or Liaison, offered only to a person with an enabled node;
          the slot renders nothing otherwise. */}
      <ThreadRuntimeSlot
        threadId={threadId()}
        title={thread()?.title ?? null}
        threadType={thread()?.type}
        currentUserId={currentUserId()}
        participants={thread()?.participants ?? []}
        compact
      />
      {/* The box is the Invoked model selector's anchor. */}
      <div class="relative flex shrink-0">
        <FloatingPanel open={menuOpen()} onOpenChange={handleMenuOpenChange}>
          <FloatingPanel.Trigger
            class="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-hover"
            aria-label={i18n.t("kernel.threadActions")}
            data-testid="phone-thread-actions"
          >
            <MoreHorizontal size={20} />
          </FloatingPanel.Trigger>
          <FloatingPanel.Content class="w-56" onCloseAutoFocus={invokedModel.onCloseAutoFocus}>
            {/* The channel's description, read where it is written. The desktop
              menu shows it here too and this is the phone's ONLY reading
              surface for it: Edit description without it means a channel a
              phone can write about but never read about. Wrapped, not
              truncated: a description is meant to be read. */}
            <Show when={isChannelRoom() && thread()?.description?.trim()}>
              {(description) => (
                <>
                  <div class="px-3 py-1">
                    <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                      {i18n.t("kernel.threadDescription")}
                    </span>
                  </div>
                  <p
                    data-testid="phone-thread-description"
                    class="whitespace-pre-wrap px-3 pb-1.5 text-[12px] leading-snug text-text-secondary"
                  >
                    {description()}
                  </p>
                  <div class="my-1 h-px bg-border-subtle" />
                </>
              )}
            </Show>

            <button
              type="button"
              data-testid="phone-thread-action-pin"
              class={itemClass}
              onClick={() => {
                void togglePin()
                handleMenuOpenChange(false)
              }}
            >
              <Show when={thread()?.isPinnedByUser} fallback={<Pin size={16} />}>
                <PinOff size={16} />
              </Show>
              {thread()?.isPinnedByUser ? i18n.t("kernel.unpin") : i18n.t("kernel.pin")}
            </button>

            <Show when={canAdminThreads()}>
              <button
                type="button"
                data-testid="phone-thread-action-pin-all"
                class={itemClass}
                onClick={() => {
                  void togglePinForAll()
                  handleMenuOpenChange(false)
                }}
              >
                <Show when={thread()?.isPinned} fallback={<Pin size={16} />}>
                  <PinOff size={16} />
                </Show>
                {thread()?.isPinned
                  ? i18n.t("kernel.threadUnpinForAll")
                  : i18n.t("kernel.threadPinForAll")}
              </button>
            </Show>

            <button
              type="button"
              data-testid="phone-thread-action-mute"
              class={itemClass}
              onClick={() => {
                void toggleMute()
                handleMenuOpenChange(false)
              }}
            >
              <Show when={thread()?.isMuted} fallback={<BellOff size={16} />}>
                <Bell size={16} />
              </Show>
              {thread()?.isMuted ? i18n.t("kernel.unmute") : i18n.t("kernel.mute")}
            </button>

            <button
              type="button"
              data-testid="phone-thread-action-archive"
              class={itemClass}
              onClick={() => {
                void archive()
                handleMenuOpenChange(false)
              }}
            >
              <Archive size={16} />
              {i18n.t("kernel.threadArchive")}
            </button>

            <invokedModel.Item iconSize={16} class={itemClass} />

            <Show when={isChannelRoom()}>
              <div class="my-1 h-px bg-border-subtle" />
              <button
                type="button"
                data-testid="phone-thread-action-set-topic"
                class={itemClass}
                onClick={() => {
                  setDetailsField("topic")
                  handleMenuOpenChange(false)
                }}
              >
                <Hash size={16} />
                {i18n.t("kernel.threadSetTopic")}
              </button>

              <button
                type="button"
                data-testid="phone-thread-action-edit-description"
                class={itemClass}
                onClick={() => {
                  setDetailsField("description")
                  handleMenuOpenChange(false)
                }}
              >
                <FileText size={16} />
                {i18n.t("kernel.threadEditDescription")}
              </button>

              {/* The ROW carries the 44px tap area; the track is the documented
                touch-density exception (see ui/Switch.tsx). Label and switch
                share one line and the help line then spans the whole row:
                beside the switch it kept the track's width reserved on every
                line and wrapped narrower than the description block above. */}
              <div data-testid="phone-thread-discoverable-row" class="min-h-11 px-3 py-2">
                <div class="flex items-center justify-between gap-3">
                  <p class="min-w-0 text-[14px] text-text-secondary">
                    {i18n.t("kernel.threadDiscoverable")}
                  </p>
                  <Switch
                    data-testid="phone-thread-discoverable-switch"
                    checked={thread()?.discoverable ?? false}
                    label={i18n.t("kernel.threadDiscoverable")}
                    onChange={(next) => void toggleDiscoverable(next)}
                  />
                </div>
                <p
                  data-testid="phone-thread-discoverable-help"
                  class="mt-0.5 text-[11px] leading-snug text-text-tertiary"
                >
                  {i18n.t("kernel.threadDiscoverableHelp")}
                </p>
              </div>

              <div data-testid="phone-thread-notify-all-row" class="min-h-11 px-3 py-2">
                <div class="flex items-center justify-between gap-3">
                  <p class="min-w-0 text-[14px] text-text-secondary">
                    {i18n.t("kernel.threadNotifyAllPosts")}
                  </p>
                  <Switch
                    data-testid="phone-thread-notify-all-switch"
                    checked={thread()?.notifyAllPosts === true}
                    label={i18n.t("kernel.threadNotifyAllPosts")}
                    onChange={(next) => void toggleNotifyAllPosts(next)}
                  />
                </div>
                <p
                  data-testid="phone-thread-notify-all-help"
                  class="mt-0.5 text-[11px] leading-snug text-text-tertiary"
                >
                  {i18n.t("kernel.threadNotifyAllPostsHelp")}
                </p>
              </div>
            </Show>

            <div class="my-1 h-px bg-border-subtle" />

            <Show
              when={!confirmLeave()}
              fallback={
                <div class="px-3 py-1.5">
                  <p class="mb-1.5 text-[13px] text-text-secondary">
                    {i18n.t("kernel.leaveThisThread")}
                  </p>
                  <div class="flex gap-1.5">
                    <button
                      type="button"
                      data-testid="phone-thread-action-leave-confirm"
                      class="rounded-md bg-danger px-2.5 py-1 text-[13px] font-medium text-white"
                      onClick={() => {
                        void leave()
                        handleMenuOpenChange(false)
                      }}
                    >
                      {i18n.t("kernel.threadLeave")}
                    </button>
                    <button
                      type="button"
                      class="rounded-md border border-border-strong px-2.5 py-1 text-[13px] font-medium text-text-secondary"
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
                data-testid="phone-thread-action-leave"
                class="flex w-full items-center gap-2.5 px-3 py-2 text-[14px] text-danger outline-none transition-colors hover:bg-danger/10"
                onClick={() => setConfirmLeave(true)}
              >
                <LogOut size={16} />
                {i18n.t("kernel.threadLeave")}
              </button>
            </Show>
          </FloatingPanel.Content>
        </FloatingPanel>
        <invokedModel.Anchor />
      </div>

      <ChannelDetailsDialog
        field={detailsField()}
        initialValue={
          detailsField() === "description"
            ? (thread()?.description ?? null)
            : (thread()?.topic ?? null)
        }
        onSave={async (value) => {
          const field = detailsField()
          if (field) await saveDetails(field, value)
        }}
        onClose={() => setDetailsField(null)}
      />
    </div>
  )
}

export default ThreadPhoneHeader
