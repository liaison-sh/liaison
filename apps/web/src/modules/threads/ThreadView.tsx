// SPDX-License-Identifier: FSL-1.1-ALv2
import { parseThreadAnchor, type ReasoningLevel, soleAgentCounterpart } from "@liaison/shared"
import {
  batch,
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { log } from "~/lib/logger"
import {
  availableModelIds,
  creditsBalance,
  creditsBalanceStale,
  ensureAvailableModels,
  ensureCreditsBalance,
} from "~/modules/agent/credits/credits-store"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ThreadNodePermissions } from "~/modules/nodes/ThreadNodePermissions"
import { useApi } from "~/modules/shell/ApiContext"
import { markAttentionRead } from "~/modules/shell/entity-opener"
import { shellTier } from "~/modules/shell/shell-tier"
import { closeTab, makeTabId, promoteTab, tabStore } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { useWs } from "~/modules/shell/WsContext"
import ComposeBar from "~/modules/threads/ComposeBar"
import {
  conversationDisplayName,
  isPersonToPersonConversation,
} from "~/modules/threads/conversation-display"
import {
  provideThreadModelControl,
  type ThreadModelControl,
} from "~/modules/threads/InvokedModelMenu"
import { LocalRuntimeUnavailableError } from "~/modules/threads/local-runtime-send"
import MessageList from "~/modules/threads/MessageList"
import {
  getMessages,
  loadMessages,
  messageStore,
  type QuoteDraft,
  reconcileThreadWithList,
  seedAgentStreamState,
} from "~/modules/threads/message-store"
import {
  clearQuoteDraft,
  getQuoteDraft,
  quoteSurfaceKey,
  setQuoteDraft,
} from "~/modules/threads/quote-store"
import ReplyThreadPanel from "~/modules/threads/ReplyThreadPanel"
import { userIsLookingAtWindow } from "~/modules/threads/reading-focus"
import { closeReplyPanel, getOpenReplyPanel } from "~/modules/threads/reply-panel-store"
import ThreadAnchorHeader from "~/modules/threads/ThreadAnchorHeader"
import ThreadHeader from "~/modules/threads/ThreadHeader"
import ThreadModelChip from "~/modules/threads/ThreadModelChip"
import TypingIndicator from "~/modules/threads/TypingIndicator"
import {
  releaseHeldScopes,
  sendFailureToast,
  sendThreadMessage,
} from "~/modules/threads/thread-send"
import {
  addParticipantToThread,
  addThread,
  allThreads,
  getThread,
  hideArchivedSidebar,
  loadThreads,
  markThreadRead,
  removeArchivedThread,
  removeParticipantFromThread,
  removeThread,
  setThreadDetails,
  setThreadDiscoverable,
  setThreadMuted,
  setThreadPinned,
  setThreadPinnedByUser,
  threadStore,
  threadsLoadFailed,
} from "~/modules/threads/thread-store"
import { threadForTab } from "~/modules/threads/thread-tab-names"
import {
  createOptimisticStep,
  createValueStep,
  type OptimisticMutationStep,
  runOptimisticMutation,
} from "~/modules/threads/thread-view-optimistic"
import { createVisualViewport } from "~/primitives/createVisualViewport"

interface ThreadViewProps {
  entityId: string
  // "tab" (default): a normal shell tab, mounted always-on with the tab
  // system owning activity/read-state via tabStore.activeTabId.
  // "dock": the same view rendered inside a dock tab's expanded 460px box —
  // the dock owns activity (collapsed dock tabs must NOT be treated as
  // read/focused), so isActive is required in that case.
  surface?: "tab" | "dock"
  // Explicit activity signal, overriding the tabStore-derived default.
  // Required in practice for surface="dock" (the dock tab's own expanded
  // state), optional for surface="tab" (falls back to tabStore.activeTabId).
  isActive?: () => boolean
}

const ThreadView: Component<ThreadViewProps> = (props) => {
  const api = useApi()
  const ws = useWs()
  const i18n = useI18n()
  const threadId = () => props.entityId

  interface ThreadDetail {
    id: string
    handle: string
    title: string | null
    type?: "thread" | "agent_chat" | "approval"
    createdFrom?: { app: string; entityType: string; entityId: string } | null
    /** The entity the thread belongs to, with its words (GET /threads/:id). */
    anchor?: unknown
    isPinned: boolean
    isPinnedByUser?: boolean
    isMuted?: boolean
    isArchived?: boolean
    /** The reader's opt-in to be interrupted by every post of this channel. */
    notifyAllPosts?: boolean
    createdBy?: string
    tainted?: boolean
    discoverable?: boolean
    /** The Slack/Buzz pair on a channel; both absent on a DM. */
    topic?: string | null
    description?: string | null
    participants: Array<{
      id: string
      name: string
      avatarUrl: string | null
      role?: string
      participantType?: "user" | "agent"
    }>
    /** P4c-T51: the `uptoMessageId` of the sole agent counterpart's checkpoint. */
    agentContextFrom?: string | null
    lastMessage: {
      content: string | null
      authorId: string
      authorName: string
      createdAt: string
    } | null
    unreadCount: number
    updatedAt: string
    /** The conversation's model override, and the seated agent's own default
     *  it falls back to. */
    agentModelId?: string | null
    agentDefaultModelId?: string | null
    agentReasoningLevels?: Record<string, string>
  }

  const [isMuted, setIsMuted] = createSignal(false)
  const [notifyAllPosts, setNotifyAllPosts] = createSignal(false)
  const [isArchived, setIsArchived] = createSignal(false)
  const [detailLoaded, setDetailLoaded] = createSignal<ThreadDetail | null>(null)

  // The thread payload's agentDefaultModelId, typed on the detail above.

  const [agentModelId, setAgentModelId] = createSignal<string | null>(null)
  // The seated agent's OWN default. Picking nothing in this chat falls back to
  // it, so the chip can say which model is actually answering.
  const [ownAgentDefaultModelId, setAgentDefaultModelId] = createSignal<string | null>(null)
  /**
   * What "Default" resolves to for the chip. This view's own read first, then
   * the thread store, which another surface showing the SAME conversation (the
   * dock beside the main panel) may have filled in already. Without the store
   * leg a dock tab that mounted before the detail landed read "Default (Auto)"
   * while the panel read the real model.
   */
  const agentDefaultModelId = (): string | null =>
    ownAgentDefaultModelId() ?? threadStore.byId[threadId()]?.agentDefaultModelId ?? null
  const [agentReasoningLevels, setAgentReasoningLevels] = createSignal<Record<string, string>>({})

  const hasAgentMessages = createMemo(() =>
    getMessages(threadId()).some((m) => m.authorType === "agent"),
  )

  // A conversation WITH AN AGENT, whether or not the agent has spoken yet. The
  // model chip belongs to the conversation, not to the transcript: a fresh
  // agent chat must be able to pick its model before the first turn.
  const hasAgentSeat = createMemo(
    () =>
      (detailLoaded()?.participants ?? []).some((p) => p.participantType === "agent") ||
      detailLoaded()?.type === "agent_chat" ||
      hasAgentMessages(),
  )

  // Credits: the composer's model chip needs the balance (which models are
  // unlocked) and the org's usable model ids. BOTH come from the session-wide
  // credits store, never from a per-view resource.
  //
  // They used to be two `createResource`s per ThreadView, read DURING RENDER.
  // Every mounted conversation asked for its own copy on every mount, which
  // the box measured as 15 500 balance reads and 6 800 model reads in forty
  // minutes, most of them answered 429; and a render-time resource read
  // suspends the nearest Suspense boundary, which for a dock conversation was
  // the app root. One cached single-flight fetch per session, read as plain
  // signals, removes both.
  createEffect(() => {
    if (!hasAgentSeat()) return
    void ensureCreditsBalance(api)
    void ensureAvailableModels(api)
  })
  const balance = creditsBalance
  const hasPurchasedCredits = () => Number(balance()?.purchased ?? 0) > 0

  // The one thing that moves the balance perceptibly is a finished turn, so
  // that is the one thing allowed to jump the minute-long throttle. The
  // backoff still wins: a 429 is never argued with.
  createEffect(
    on(
      () => getMessages(threadId()).filter((m) => m.authorType === "agent").length,
      () => {
        if (!hasAgentSeat()) return
        creditsBalanceStale()
        void ensureCreditsBalance(api, { force: true })
      },
      { defer: true },
    ),
  )

  const surface = () => props.surface ?? "tab"
  // Dock tabs pass isActive() (their own expanded/collapsed state); a plain
  // shell tab falls back to the tabStore comparison it always used.
  const isActiveTab = () =>
    props.isActive?.() ?? tabStore.activeTabId === makeTabId("thread", threadId())
  const canAdminThreads = createMemo(
    () => hasScope("kernel:threads:admin") || hasScope("kernel:admin"),
  )

  // M1-B T6, keyboard avoidance. The layout viewport keeps its full height
  // when the software keyboard opens, so a `h-full` (100vh) thread pane puts
  // its composer UNDER the keyboard. At phone tier the pane is sized from the
  // VISUAL viewport instead. The surface is NOT part of the test: under
  // 1024px the floating dock is unavailable and its "dock" surface is the
  // full screen Chats sheet, which needs this exactly as a tab does.
  const viewport = createVisualViewport()
  const phoneLayout = () => shellTier() === "phone"
  let rootRef: HTMLDivElement | undefined
  // A reader parked at the bottom must still be at the bottom once the
  // keyboard has taken a third of the screen; a reader who had scrolled up is
  // left where they were.
  let stuckToBottom = true

  onMount(() => {
    const root = rootRef
    if (!root) return
    // `scroll` does not bubble, but it DOES reach a capture-phase listener on
    // an ancestor, so the message list keeps owning its own scrolling.
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | null
      if (el?.dataset?.testid !== "message-scroll-container") return
      stuckToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    root.addEventListener("scroll", onScroll, true)
    onCleanup(() => root.removeEventListener("scroll", onScroll, true))
  })

  createEffect(
    on(
      () => viewport.height(),
      () => {
        if (!phoneLayout() || !stuckToBottom) return
        const el = rootRef?.querySelector<HTMLElement>('[data-testid="message-scroll-container"]')
        if (!el) return
        // After the reflow the new height causes, not before it.
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight
        })
      },
      { defer: true },
    ),
  )

  // Mark read when this tab becomes active (covers both tab switches and re-activations).
  // Only while the user is looking at the window (`userIsLookingAtWindow`): a
  // visible page behind other apps is not being read, and its read mark would
  // clear the unread pill on the reader's other devices, the phone included.
  createEffect(() => {
    const id = threadId()
    if (!id) return
    if (isActiveTab() && userIsLookingAtWindow()) {
      markThreadRead(api, id)
      // Clear any thread_reply/mention attention rows for this thread too —
      // nothing today links thread read-state to attention rows on its own,
      // so without this an orphaned row would sit unclearable and re-surface
      // in the next digest (liaison-messaging-visibility Task 8).
      markAttentionRead(api, "kernel", "thread", id)
    }
  })

  // ON SCREEN MEANS READ, on the server too, whatever raised the count. The
  // socket's message handler only knows the shell's active TAB, so a thread
  // open in the dock or the tablet Chats sheet counted every message that
  // arrived while it was being read as unread, and never told the server: the
  // pill came back on the list and stayed lit on every other device. A list
  // reload or another device's frame that lands a stale count on the open
  // thread is corrected the same way. Tracks the count only: opening the
  // thread is the effect above's job.
  createEffect(
    on(
      () => {
        const id = threadId()
        return id ? (getThread(id)?.unreadCount ?? 0) : 0
      },
      (count) => {
        const id = threadId()
        if (!id || count === 0) return
        if (!isActiveTab() || !userIsLookingAtWindow()) return
        markThreadRead(api, id)
      },
      { defer: true },
    ),
  )

  // Separate effect for data loading — no markThreadRead dependency
  const streamSeeded = new Set<string>()
  createEffect(() => {
    const id = threadId()
    if (!id) return
    // A FAILED LOAD IS NOT A MISSING LOAD. This effect tracks the very store
    // cells a load writes (the thread list, `loading[id]`, `error[id]`), so
    // when a load fails the list stays empty and `loading[id]` falls back to
    // false, and the effect re-runs and asks again, immediately and forever.
    // Under a rate limit that is a self feeding storm: hundreds of requests,
    // all of them refused. A failure is therefore remembered and the effect
    // stops asking. The retry is an explicit one: the "Try again" button under
    // the message list, a reload of the sidebar list, a resync, or moving to
    // another thread (the error is keyed by thread).
    if (allThreads().length === 0 && !threadsLoadFailed()) void loadThreads(api)
    if (!messageStore.threads[id] && !messageStore.loading[id] && !messageStore.error[id]) {
      void loadMessages(api, id)
    }
    // Catch up on an in-flight agent run this view wasn't listening for (an
    // agent chat promoted to a thread mid-run, or a page load mid-run) —
    // otherwise the live thinking/tool-call block and "working" indicator
    // only appear from the NEXT WS delta onwards. Once per thread per mount.
    if (!streamSeeded.has(id)) {
      streamSeeded.add(id)
      seedAgentStreamState(api, id)
    }
  })

  // THE CONVERSATION NEVER LAGS ITS OWN ROW IN THE LIST. A cached page is
  // reused on every open, and the list can learn of a message the page missed
  // (a pull-to-refresh, a resync, a reload while the socket was asleep). When
  // the list's preview is newer than anything loaded here, read the page again
  // (once per preview, see `reconcileThreadWithList`).
  createEffect(() => {
    const id = threadId()
    if (!id) return
    const listLastAt = getThread(id)?.lastMessage?.createdAt
    if (!messageStore.threads[id] || messageStore.loading[id]) return
    untrack(() => reconcileThreadWithList(api, id, listLastAt))
  })

  // Mark read when the user comes back: the page shown again after being
  // hidden, or its window focused again (what landed while it sat behind
  // other apps stayed unread until now).
  onMount(() => {
    const handleReturn = () => {
      const id = threadId()
      if (id && userIsLookingAtWindow() && isActiveTab()) {
        markThreadRead(api, id)
        markAttentionRead(api, "kernel", "thread", id)
      }
    }
    document.addEventListener("visibilitychange", handleReturn)
    window.addEventListener("focus", handleReturn)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", handleReturn)
      window.removeEventListener("focus", handleReturn)
    })
  })

  // Load thread detail (references, muted, archived) without suspending the component.
  // The thread header renders from store data; detail data loads in the background.
  // Note: batch() wraps synchronous signal resets to avoid per-write reactive cascades.
  let detailController: AbortController | null = null
  onCleanup(() => detailController?.abort())
  // The checkpoint advance emits no thread event: it writes an audit row and a
  // log line (checkpoint.ts `logHistoryPrefixRebuilt`) and nothing the browser
  // subscribes to. So the agent context boundary moves on the NEXT thread read,
  // which is the read after the conversation itself moved. Bumped from an
  // effect rather than derived, because it is an edge (a message landed), not
  // a value.
  const [detailRefresh, setDetailRefresh] = createSignal(0)
  const newestMessageId = () => {
    const loaded = getMessages(threadId())
    return loaded.length > 0 ? loaded[loaded.length - 1].id : null
  }
  createEffect(
    on(newestMessageId, (id, previous) => {
      if (previous !== undefined && id !== previous) setDetailRefresh((n) => n + 1)
    }),
  )
  createEffect(() => {
    const id = threadId()
    detailRefresh()
    if (!id) return
    batch(() => {
      setIsMuted(false)
      setIsArchived(false)
    })
    detailController?.abort()
    const ac = new AbortController()
    detailController = ac
    api
      .get(`/threads/${id}`, { signal: ac.signal })
      .then((res: any) => {
        if (ac.signal.aborted) return
        const data = res.data ?? res
        batch(() => {
          setIsMuted(data.isMuted ?? false)
          setNotifyAllPosts(data.notifyAllPosts === true)
          setIsArchived(data.isArchived ?? false)
          setAgentModelId(data.agentModelId ?? null)
          setAgentDefaultModelId(data.agentDefaultModelId ?? null)
          setAgentReasoningLevels(data.agentReasoningLevels ?? {})
          setDetailLoaded(data)
        })
        addThread(data)
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        if (err instanceof DOMException && err.name === "AbortError") return
        // The server has answered DEFINITIVELY that this conversation is not
        // this viewer's to read: 404 (gone, or a stale tab restored from a
        // different org's localStorage) or 403 (still there, viewer no longer
        // a participant). Either way the surface holding it must go, in the
        // shell AND in the dock (removeThread closes its dock tab), or every
        // page load reopens it and refetches the same refusal. A retryable
        // failure (429/5xx/network) closes nothing: it is logged and the
        // surface stays.
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          closeTab(makeTabId("thread", id))
          removeThread(id)
          return
        }
        log.child({ component: "ThreadView" }).error("detail fetch failed for %s: %o", id, err)
      })
  })

  const currentUser = () => {
    const token = userFromToken()
    return { id: token?.userId ?? "", name: token?.name ?? "Unknown" }
  }

  // The list's copy, else the one the tab keeps current once the conversation
  // left the list (archived while open), else the detail this view read.
  const thread = () => getThread(threadId()) ?? threadForTab(threadId()) ?? detailLoaded() ?? null
  /** A task's comments opened as a thread: the task they belong to (ThreadAnchorHeader). */
  const anchor = createMemo(() => {
    const detail = detailLoaded()
    return detail && detail.id === threadId() ? parseThreadAnchor(detail.anchor) : null
  })
  // The header's mute toggle follows the store too: another device of this
  // reader muting the thread (a `kernel:read_state` thread_state frame) moves
  // the store's flag, and the switch here must not keep saying the opposite.
  createEffect(
    on(
      () => getThread(threadId())?.isMuted,
      (muted) => {
        if (muted !== undefined) setIsMuted(muted)
      },
      { defer: true },
    ),
  )

  /**
   * WHOSE boundary the row draws (P4c-T51, A50). The name travels with the
   * position on the thread read: deriving it here from a SOLE agent counterpart
   * meant a DM that had picked up a second agent by mention could never draw
   * the row at all, and neither could a channel. The seat lookup stays only as
   * the fallback for a payload that predates the field.
   */
  const boundaryAgentName = createMemo(() => {
    const t = thread()
    if (!t) return null
    const named = (t as { agentContextAgentName?: string | null }).agentContextAgentName
    if (named) return named
    const participants = t.participants ?? []
    const seat = soleAgentCounterpart({
      title: t.title ?? null,
      type: t.type ?? "thread",
      discoverable: (t as { discoverable?: boolean }).discoverable ?? false,
      currentUserId: currentUser().id,
      participants: participants.map((p) => ({
        id: p.id,
        participantType:
          (p as { participantType?: "user" | "agent" }).participantType === "agent"
            ? "agent"
            : "user",
      })),
    })
    if (!seat) return null
    return participants.find((p) => p.id === seat.id)?.name ?? null
  })

  const agentContextFrom = () =>
    boundaryAgentName()
      ? ((thread() as { agentContextFrom?: string | null })?.agentContextFrom ?? null)
      : null

  // Mailbox turn scopes this view opened and whose turn has not ended yet.
  // Leaving one open past unmount would leave the server believing a browser is
  // still there to answer its decrypt requests.
  const heldTurnScopeReleases = new Set<() => void>()
  onCleanup(() => releaseHeldScopes(heldTurnScopeReleases))

  function handleSend(
    content: string,
    opts?: {
      attachmentSessionId?: string
      replyRootId?: string
      quote?: QuoteDraft
    },
  ): Promise<boolean> {
    promoteTab(makeTabId("thread", threadId()))
    // The turn context (the view on screen, the mailbox turn nonce) is the
    // same from every surface that posts into a thread (thread-send.ts).
    const sent = sendThreadMessage(
      api,
      threadId(),
      content,
      currentUser(),
      opts ?? {},
      heldTurnScopeReleases,
    )
    sent.catch((err) => addToast(sendFailureToast(err, i18n.t)))
    // False hands the draft back to the composer, which has already emptied
    // its field: only for a send held back before anything reached the
    // server. A POST that failed may still have landed, and handing that text
    // back would invite a duplicate.
    return sent.then(
      () => true,
      (err) => !(err instanceof LocalRuntimeUnavailableError),
    )
  }

  /** The channel composer's send: its quote, if any, travels with it (S12). */
  function handleChannelSend(
    content: string,
    opts?: { attachmentSessionId?: string },
  ): Promise<boolean> {
    const key = quoteSurfaceKey(threadId())
    const quote = getQuoteDraft(key) ?? undefined
    clearQuoteDraft(key)
    return handleSend(content, { ...opts, ...(quote ? { quote } : {}) }).then((posted) => {
      if (!posted && quote && !getQuoteDraft(key)) setQuoteDraft(key, quote)
      return posted
    })
  }

  // THE REPLY PANEL (S10): a 380px right rail beside the conversation in a
  // shell tab, covering the conversation in the dock and on a phone.
  const replyPanel = () => getOpenReplyPanel(threadId())
  const panelVariant = (): "aside" | "overlay" =>
    surface() === "tab" && !phoneLayout() ? "aside" : "overlay"

  function handleTyping() {
    ws.send({ type: "typing", threadId: threadId() })
  }

  async function runThreadMutation(options: {
    request: () => Promise<unknown>
    steps?: readonly OptimisticMutationStep[]
    onSuccess?: () => void
    errorMessage: string
  }) {
    try {
      await runOptimisticMutation({
        request: options.request,
        steps: options.steps,
        onSuccess: options.onSuccess,
      })
    } catch {
      addToast({ message: options.errorMessage, type: "error" })
    }
  }

  async function handleTogglePin() {
    const t = thread()
    if (!t) return
    const newPinned = !t.isPinnedByUser
    await runThreadMutation({
      steps: [
        createValueStep(
          (value) => setThreadPinnedByUser(threadId(), value),
          t.isPinnedByUser ?? false,
          newPinned,
        ),
      ],
      request: () => api.patch(`/threads/${threadId()}/state`, { isPinned: newPinned }),
      errorMessage: "Couldn't update pin state.",
    })
  }

  async function handleTogglePinForAll() {
    const t = thread()
    if (!t) return
    const newPinned = !t.isPinned
    await runThreadMutation({
      steps: [
        createValueStep((value) => setThreadPinned(threadId(), value), t.isPinned, newPinned),
      ],
      request: () => api.patch(`/threads/${threadId()}`, { isPinned: newPinned }),
      errorMessage: "Couldn't update org pin state.",
    })
  }

  // A35: publishing the channel is shared-row state, so it takes the same
  // optimistic-then-PATCH shape as the org pin and rolls back on refusal.
  async function handleToggleDiscoverable(next: boolean) {
    const t = thread()
    if (!t) return
    await runThreadMutation({
      steps: [
        createValueStep(
          (value) => setThreadDiscoverable(threadId(), value),
          t.discoverable ?? false,
          next,
        ),
      ],
      request: () => api.patch(`/threads/${threadId()}`, { discoverable: next }),
      errorMessage: i18n.t("kernel.threadDiscoverableFailed"),
    })
  }

  // The Slack/Buzz pair is shared-row state like the publish above, so it takes
  // the same optimistic-then-PATCH shape and rolls back on refusal.
  async function handleSaveDetails(field: "topic" | "description", value: string | null) {
    const t = thread()
    if (!t) return
    const previous = field === "topic" ? (t.topic ?? null) : (t.description ?? null)
    await runThreadMutation({
      steps: [
        createValueStep(
          (v: string | null) => setThreadDetails(threadId(), { [field]: v }),
          previous,
          value,
        ),
      ],
      request: () => api.patch(`/threads/${threadId()}`, { [field]: value }),
      errorMessage:
        field === "topic"
          ? i18n.t("kernel.threadTopicFailed")
          : i18n.t("kernel.threadDescriptionFailed"),
    })
  }

  async function handleToggleMute() {
    const previousMuted = isMuted()
    const newMuted = !isMuted()
    await runThreadMutation({
      steps: [
        createValueStep(setIsMuted, previousMuted, newMuted),
        createValueStep((value) => setThreadMuted(threadId(), value), previousMuted, newMuted),
      ],
      request: () => api.patch(`/threads/${threadId()}/state`, { isMuted: newMuted }),
      errorMessage: "Couldn't update thread notification settings.",
    })
  }

  async function handleToggleNotifyAllPosts(next: boolean) {
    const previous = notifyAllPosts()
    await runThreadMutation({
      steps: [createValueStep(setNotifyAllPosts, previous, next)],
      request: () => api.patch(`/threads/${threadId()}/state`, { notifyAllPosts: next }),
      errorMessage: i18n.t("kernel.threadNotifyAllPostsFailed"),
    })
  }

  async function handleArchive() {
    const capturedThreadId = threadId()
    const newArchived = !isArchived()
    await runThreadMutation({
      request: () => api.patch(`/threads/${capturedThreadId}/state`, { isArchived: newArchived }),
      onSuccess: () => {
        setIsArchived(newArchived)
        if (newArchived) {
          removeThread(capturedThreadId)
          closeTab(makeTabId("thread", capturedThreadId))
        } else {
          // Unarchiving: move thread to main list, exit archived sidebar view
          removeArchivedThread(capturedThreadId)
          const detail = detailLoaded()
          if (detail) addThread(detail)
          hideArchivedSidebar()
        }
      },
      errorMessage: newArchived
        ? "Couldn't archive this thread."
        : "Couldn't unarchive this thread.",
    })
  }

  async function handleSelectAgentModel(modelId: string | null) {
    const prev = agentModelId()
    setAgentModelId(modelId)
    try {
      await api.patch(`/threads/${threadId()}`, { agentModelId: modelId })
    } catch {
      setAgentModelId(prev)
      addToast({ message: i18n.t("kernel.threadsUi.couldnTUpdateModelSelection"), type: "error" })
    }
  }

  // The conversation's model control: the composer chip's props, published
  // so the "..." menus can offer the same selector as "Invoked model".
  const modelControlProps = (): ThreadModelControl => {
    const effective = agentModelId() ?? agentDefaultModelId() ?? ""
    return {
      threadId: threadId(),
      balance: balance() ?? null,
      availableModelIds: availableModelIds() ?? null,
      agentModelId: agentModelId(),
      agentDefaultModelId: agentDefaultModelId(),
      // Unset is the model's default, which is what the server runs: the
      // menu resolves the shown level by the server's rule (ReasoningLevelRow).
      reasoningLevel: agentReasoningLevels()[effective] as ReasoningLevel | undefined,
      onSelect: handleSelectAgentModel,
      onSelectReasoning: (level) => handleSelectReasoning(effective, level),
    }
  }
  // Between PEOPLE the model choice leaves the composer for the menu: a pill
  // beside send made a chat with a colleague read like a chat with a bot.
  const personToPerson = createMemo(() => {
    const t = thread()
    return t ? isPersonToPersonConversation(t, currentUser().id) : false
  })
  createEffect(() => {
    if (!hasAgentSeat()) return
    onCleanup(provideThreadModelControl(threadId(), modelControlProps))
  })

  async function handleSelectReasoning(modelId: string, level: ReasoningLevel) {
    const prev = agentReasoningLevels()
    const next = { ...prev, [modelId]: level }
    setAgentReasoningLevels(next)
    try {
      await api.patch(`/threads/${threadId()}`, { agentReasoningLevels: next })
    } catch {
      setAgentReasoningLevels(prev)
      addToast({ message: i18n.t("kernel.threadsUi.couldnTUpdateReasoningLevel"), type: "error" })
    }
  }

  async function handleLeave() {
    await runThreadMutation({
      request: () => api.delete(`/threads/${threadId()}/participants/${currentUser().id}`),
      onSuccess: () => {
        removeThread(threadId())
        closeTab(makeTabId("thread", threadId()))
      },
      errorMessage: "Couldn't leave this thread.",
    })
  }

  async function handleAddParticipant(userId: string, name: string, avatarUrl: string | null) {
    await runThreadMutation({
      steps: [
        createOptimisticStep(
          () => addParticipantToThread(threadId(), { id: userId, name, avatarUrl }),
          () => removeParticipantFromThread(threadId(), userId),
        ),
      ],
      request: () => api.post(`/threads/${threadId()}/participants`, { userId }),
      errorMessage: "Couldn't add participant to this thread.",
    })
  }

  async function handleRemoveParticipant(userId: string) {
    const participantIndex = thread()?.participants.findIndex((entry) => entry.id === userId) ?? -1
    const participant = participantIndex >= 0 ? thread()?.participants[participantIndex] : undefined
    await runThreadMutation({
      steps: [
        createOptimisticStep(
          () => removeParticipantFromThread(threadId(), userId),
          () => {
            if (participant) addParticipantToThread(threadId(), participant, participantIndex)
          },
        ),
      ],
      request: () => api.delete(`/threads/${threadId()}/participants/${userId}`),
      errorMessage: "Couldn't remove participant from this thread.",
    })
  }

  return (
    <div
      ref={rootRef}
      class="relative flex h-full flex-col"
      // The dock panel's own chrome is the tab around it: an 8px inset here
      // pulled the composer's top border away from both edges and turned the
      // bar into a band around a bordered box. The message list keeps its own
      // scroll padding; the composer carries its own (ComposeBar compact).
      classList={{ "gap-0 p-0": surface() === "dock" }}
      // Phone: the pane may never be taller than the VISUAL viewport, so the
      // composer sits above the software keyboard instead of under it. A CAP
      // rather than a fixed height: the pane is already correctly sized inside
      // the full screen Chats sheet, and a hard 844px there would push the
      // composer below the sheet's own header.
      style={phoneLayout() ? { "max-height": `${viewport.height()}px` } : undefined}
    >
      <Show
        when={thread()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-[13px] text-text-tertiary">
            {i18n.t("kernel.threadsUi.selectAThreadFromTheSidebar")}
          </div>
        }
      >
        {(t) => (
          <>
            {/* Dock surface: the dock tab's own pill/header owns identity —
                a second ThreadHeader in the 460px box would duplicate title,
                participants and actions in a space that can't fit them.
                Phone: the top bar IS this conversation's nav bar (F4), for the
                same reason and with the same actions. */}
            <Show when={surface() === "tab" && !phoneLayout()}>
              <ThreadHeader
                threadId={threadId()}
                title={t().title}
                handle={t().handle}
                participants={t().participants}
                isPinned={t().isPinned}
                isPinnedByUser={t().isPinnedByUser ?? false}
                isMuted={isMuted()}
                isArchived={isArchived()}
                threadType={t().type}
                discoverable={t().discoverable ?? false}
                tainted={t().tainted === true}
                topic={t().topic ?? null}
                description={t().description ?? null}
                currentUserId={currentUser().id}
                createdBy={t().createdBy}
                canAdminThreads={canAdminThreads()}
                onTogglePin={handleTogglePin}
                onTogglePinForAll={handleTogglePinForAll}
                onToggleMute={handleToggleMute}
                notifyAllPosts={notifyAllPosts()}
                onToggleNotifyAllPosts={handleToggleNotifyAllPosts}
                onToggleDiscoverable={handleToggleDiscoverable}
                onSaveDetails={handleSaveDetails}
                onArchive={handleArchive}
                onLeave={handleLeave}
                onAddParticipant={handleAddParticipant}
                onRemoveParticipant={handleRemoveParticipant}
              />
            </Show>
            <Show when={anchor()}>{(a) => <ThreadAnchorHeader anchor={a()} />}</Show>
            <div class="relative flex min-h-0 flex-1">
              <div class="flex min-w-0 flex-1 flex-col">
                {/* Approvals render inline in the message stream (MessageList) at each
                "approval-created" post, chronologically — the same inline
                treatment agent chats give a gated tool call. No separate top
                card section: it duplicated the request and split the interactive
                card from the thread's non-clickable status posts. */}
                <MessageList
                  threadId={threadId()}
                  currentUserId={currentUser().id}
                  isApprovalThread={t().type === "approval"}
                  agentModelId={agentModelId()}
                  agentReasoningLevels={agentReasoningLevels()}
                  hasPurchasedCredits={hasPurchasedCredits()}
                  availableModelIds={availableModelIds() ?? null}
                  agentContextFrom={agentContextFrom()}
                  agentContextAgentName={boundaryAgentName()}
                  onSelectAgentModel={handleSelectAgentModel}
                  onSelectReasoning={handleSelectReasoning}
                />
                <TypingIndicator threadId={threadId()} currentUserId={currentUser().id} />
                <ThreadNodePermissions threadId={threadId()} />
                {/* Dock surface: composer pinned to the bottom of the fixed
                460px box — flex-col + mt-auto on the last child keeps it
                there whether the message list is short or overflowing. */}
                <div classList={{ "mt-auto": surface() === "dock" }}>
                  <ComposeBar
                    onSend={handleChannelSend}
                    onTyping={handleTyping}
                    threadId={threadId()}
                    compact={surface() === "dock"}
                    quote={getQuoteDraft(quoteSurfaceKey(threadId()))}
                    onClearQuote={() => clearQuoteDraft(quoteSurfaceKey(threadId()))}
                    modelControl={
                      hasAgentSeat() && !personToPerson()
                        ? () => <ThreadModelChip {...modelControlProps()} />
                        : undefined
                    }
                  />
                </div>
              </div>
              <Show when={replyPanel()}>
                {(panel) => (
                  <ReplyThreadPanel
                    threadId={threadId()}
                    rootId={panel().rootId}
                    focusMessageId={panel().focusMessageId}
                    focusNonce={panel().nonce}
                    currentUserId={currentUser().id}
                    variant={panelVariant()}
                    compact={surface() === "dock"}
                    channelName={conversationDisplayName(t(), currentUser().id)}
                    showClose={!phoneLayout()}
                    onClose={() => closeReplyPanel(threadId())}
                    onSend={(content, opts) => handleSend(content, opts)}
                  />
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

export default ThreadView
