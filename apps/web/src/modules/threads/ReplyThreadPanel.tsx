// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE REPLY THREAD PANEL (S10).
//
// A Slack-style side panel on one root: the root, its replies oldest first,
// and a composer that posts into the thread. On a wide screen it is the
// 380px right rail TaskDetail uses for its thread; in the dock and on a phone
// it covers the conversation. Opening it marks the
// thread read; its close button and Escape close it. Reactions, edit and
// delete work on its rows as they do in the channel, and a selection quoted
// here goes to this composer, not the channel's.

import type { MessageQuote } from "@liaison/shared"
import { X } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import AgentTurnBlock from "~/modules/agent/AgentTurnBlock"
import { userFromToken } from "~/modules/auth/auth-store"
import { localFolderFor } from "~/modules/desktop/desktop-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { createMentionDelegate, renderContent } from "~/modules/shell/markdown-content"
import { addToast } from "~/modules/shell/toast-store"
import { localizeAgentNotice } from "~/modules/threads/agent-notice"
import ComposeBar from "~/modules/threads/ComposeBar"
import { markFollowedReplyRead } from "~/modules/threads/followed-replies-store"
import {
  LocalRuntimeUnavailableError,
  localSendRefusalCopy,
} from "~/modules/threads/local-runtime-send"
import { LiveTurnHeader } from "~/modules/threads/MessageList"
import MessageRow from "~/modules/threads/MessageRow"
import {
  addReaction,
  deleteMessage,
  editMessage,
  getLiveAgentStreams,
  getReplies,
  getReplyRoot,
  getReplyThread,
  loadOlderReplies,
  loadReplies,
  type Message,
  type QuoteDraft,
  removeReaction,
  sendMessage,
} from "~/modules/threads/message-store"
import QuoteSelection from "~/modules/threads/QuoteSelection"
import { jumpToMessage } from "~/modules/threads/quote-jump"
import {
  clearQuoteDraft,
  getQuoteDraft,
  quoteSurfaceKey,
  setQuoteDraft,
} from "~/modules/threads/quote-store"
import { openReplyPanel, requestChannelJump } from "~/modules/threads/reply-panel-store"

export interface ReplySendOptions {
  attachmentSessionId?: string
  replyRootId: string
  quote?: QuoteDraft
}

interface ReplyThreadPanelProps {
  threadId: string
  rootId: string
  currentUserId: string
  onClose: () => void
  /** A message to bring into view once the replies are loaded. */
  focusMessageId?: string | null
  /** Bumped on every open of the panel, so the same focus re-applies. */
  focusNonce?: number
  /** The conversation's send path (mailbox turn scopes, current view). The
   *  panel falls back to a plain store send when the host supplies none. */
  onSend?: (content: string, opts: ReplySendOptions) => Promise<boolean>
  /** "aside": the 380px right rail. "overlay": covers its container (dock, phone). */
  variant?: "aside" | "overlay"
  /** The host composer's `compact`: the panel's composer sits on the same
   *  bottom line as the channel's, clear of the dock's floating bar. */
  compact?: boolean
  /** Overrides the markdown renderer (tests). */
  renderContent?: (content: string) => JSX.Element
  /** The channel's name, under the title. */
  channelName?: string | null
  /** False on the phone, where the nav bar's back arrow closes the panel. */
  showClose?: boolean
}

/** Same rule as the channel list: one author, one kind, within two minutes. */
function shouldGroup(prev: Message | null, curr: Message): boolean {
  if (!prev || prev.authorId !== curr.authorId || prev.authorType !== curr.authorType) return false
  if ((prev.authorAgentId ?? null) !== (curr.authorAgentId ?? null)) return false
  return new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime() < 120_000
}

/** A refusal the server explains (S2, S13), in the reader's words. */
function sendRefusalMessage(err: unknown, t: (key: string) => string): string {
  const code = err instanceof ApiError ? err.code : undefined
  if (code === "reply_root_deleted") return t("kernel.replyThreads.rootDeleted")
  if (code === "quote_not_found" || code === "quote_excerpt_mismatch") {
    return t("kernel.replyThreads.quoteRefused")
  }
  return t("kernel.sendMessageFailed")
}

const ReplyThreadPanel: Component<ReplyThreadPanelProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const mentionDelegate = createMentionDelegate(api)
  const render = (content: string): JSX.Element =>
    props.renderContent
      ? props.renderContent(content)
      : renderContent(
          localizeAgentNotice(content, i18n.t, null, { withDetail: true }),
          mentionDelegate,
          {
            localPathBase: untrack(() => localFolderFor(props.threadId)),
          },
        )
  let scrollEl: HTMLDivElement | undefined
  let panelEl: HTMLElement | undefined

  const cache = () => getReplyThread(props.rootId)
  const root = () => getReplyRoot(props.rootId, props.threadId)
  const replies = createMemo(() => getReplies(props.rootId))
  const liveStreams = () =>
    getLiveAgentStreams(props.threadId).filter((r) => r.stream.replyRootId === props.rootId)
  const surfaceKey = () => quoteSurfaceKey(props.threadId, props.rootId)
  const quote = () => getQuoteDraft(surfaceKey())
  const currentUser = () => {
    const token = userFromToken()
    return { id: token?.userId ?? props.currentUserId, name: token?.name ?? "" }
  }
  const isAdmin = () => userFromToken()?.scopes?.includes("*") ?? false
  // A system line in the thread (an agent's seat line) shows but is no reply.
  const liveReplyCount = () =>
    replies().filter(
      (m) => !m.deletedAt && !m.pending && (m.authorType === "user" || m.authorType === "agent"),
    ).length

  function markRead(): void {
    markFollowedReplyRead(props.rootId)
    void api
      .post(`/threads/${props.threadId}/messages/${props.rootId}/replies/read`, {})
      .catch(() => {
        // Best effort: the next open marks it again.
      })
  }

  // Load and mark read on open, and again for another root.
  createEffect(
    on(
      () => [props.threadId, props.rootId] as const,
      ([threadId, rootId]) => {
        void loadReplies(api, threadId, rootId).then(() => focusRequested())
        markRead()
      },
    ),
  )

  // Another root opened in the same panel: its composer takes the focus too,
  // as it did on the first open (THR-01).
  createEffect(
    on(
      () => props.rootId,
      () => {
        if (root()?.deletedAt) return
        panelEl?.querySelector<HTMLElement>('[data-testid="compose-editor"]')?.focus()
      },
      { defer: true },
    ),
  )

  // A reply landing while the panel is open is read too.
  createEffect(
    on(
      () => replies().length,
      (len, prev) => {
        if (prev !== undefined && len > prev) {
          markRead()
          requestAnimationFrame(() => {
            if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
          })
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.focusNonce,
      () => {
        if (!cache()?.loading) focusRequested()
      },
      { defer: true },
    ),
  )

  function jumpInPanel(messageId: string): void {
    void jumpToMessage({
      container: () => scrollEl,
      messageId,
      hasMore: () => cache()?.hasMore ?? false,
      loadMore: () => loadOlderReplies(api, props.threadId, props.rootId),
      onMissing: () =>
        addToast({ message: i18n.t("kernel.replyThreads.messageNotFound"), type: "warning" }),
    })
  }

  function focusRequested(): void {
    const id = props.focusMessageId
    if (id && id !== props.rootId) jumpInPanel(id)
  }

  /** S14 from inside the panel: the source here, in another reply thread, or
   *  in the channel list. */
  function handleQuoteClick(q: MessageQuote): void {
    if (
      scrollEl?.querySelector(`[data-message-id="${q.messageId}"]`) ||
      q.replyRootId === props.rootId
    ) {
      jumpInPanel(q.messageId)
      return
    }
    if (q.replyRootId) {
      openReplyPanel(props.threadId, q.replyRootId, { focusMessageId: q.messageId })
      return
    }
    requestChannelJump(props.threadId, q.messageId)
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      if (panelEl && !panelEl.isConnected) return
      // An open menu, picker or dialog owns its own Escape: only the innermost
      // layer closes. The reaction picker is a NON-modal dialog (no
      // aria-modal) and does not mark the event, so any dialog counts, except
      // one the panel itself sits in (the dock, a modal host).
      if (document.querySelector('[role="menu"], [role="listbox"]')) return
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (!panelEl || !dialog.contains(panelEl)) return
      }
      props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  function send(content: string, opts?: { attachmentSessionId?: string }): Promise<boolean> {
    const q = quote() ?? undefined
    const key = surfaceKey()
    clearQuoteDraft(key)
    const sendOpts: ReplySendOptions = {
      ...opts,
      replyRootId: props.rootId,
      ...(q ? { quote: q } : {}),
    }
    const sent = props.onSend
      ? props.onSend(content, sendOpts)
      : sendMessage(api, props.threadId, content, currentUser(), sendOpts).then(
          () => true,
          (err) => {
            if (err instanceof LocalRuntimeUnavailableError) {
              addToast({ message: localSendRefusalCopy(err.reason), type: "warning" })
              return false
            }
            addToast({ message: sendRefusalMessage(err, i18n.t), type: "error" })
            return true
          },
        )
    return sent.then((posted) => {
      // A send held back hands the draft back, quote and box included.
      if (posted === false) {
        if (q && !getQuoteDraft(key)) setQuoteDraft(key, q)
      }
      return posted
    })
  }

  const rowProps = (m: Message, grouped: boolean) => ({
    message: m,
    grouped,
    currentUserId: props.currentUserId,
    isAdmin: isAdmin(),
    onEdit: (msg: { id: string; content: string | null }) =>
      editMessage(api, props.threadId, msg.id, msg.content ?? ""),
    onDelete: (messageId: string) => deleteMessage(api, props.threadId, messageId),
    onReaction: (messageId: string, emoji: string) =>
      addReaction(api, props.threadId, messageId, emoji, currentUser()),
    onRemoveReaction: (messageId: string, emoji: string) =>
      removeReaction(api, props.threadId, messageId, emoji, currentUser()),
    renderContent: render,
    onQuoteClick: handleQuoteClick,
    quoteSurfaceKey: surfaceKey(),
  })

  return (
    <aside
      ref={panelEl}
      data-testid="reply-thread-panel"
      data-root-id={props.rootId}
      class={
        props.variant === "overlay"
          ? "absolute inset-0 z-20 flex flex-col bg-bg"
          : "flex w-[380px] shrink-0 flex-col border-l border-border-subtle bg-bg"
      }
    >
      <header class="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-semibold text-text">
            {i18n.t("kernel.replyThreads.title")}
          </div>
          <Show when={props.channelName}>
            {(name) => <div class="truncate text-[11px] text-text-tertiary">{name()}</div>}
          </Show>
        </div>
        <Show when={props.showClose !== false}>
          <button
            type="button"
            data-testid="reply-thread-close"
            aria-label={i18n.t("kernel.replyThreads.close")}
            title={i18n.t("kernel.replyThreads.close")}
            class="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            onClick={() => props.onClose()}
          >
            <X size={15} />
          </button>
        </Show>
      </header>

      <div
        ref={scrollEl}
        data-testid="reply-thread-scroll"
        class="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        <Show
          when={root()}
          fallback={
            <div class="py-8 text-center text-[12px] text-text-tertiary">
              {cache()?.error
                ? i18n.t("kernel.replyThreads.repliesLoadFailed")
                : i18n.t("kernel.replyThreads.loadingReplies")}
            </div>
          }
        >
          {(r) => <MessageRow {...rowProps(r(), false)} />}
        </Show>

        <div class="my-2 flex items-center gap-3 px-1">
          <span class="text-[11px] font-medium text-text-tertiary">
            {liveReplyCount() === 1
              ? i18n.t("kernel.replyThreads.replyCountOne")
              : i18n.t("kernel.replyThreads.replyCountMany", { count: liveReplyCount() })}
          </span>
          <div class="h-px flex-1 bg-border-subtle" />
        </div>

        <Show when={cache()?.hasMore}>
          <button
            type="button"
            data-testid="reply-thread-load-older"
            class="mb-1 w-full py-1 text-center text-[12px] text-text-tertiary hover:text-text-secondary"
            disabled={cache()?.loadingMore}
            onClick={() => void loadOlderReplies(api, props.threadId, props.rootId)}
          >
            {i18n.t("kernel.replyThreads.loadOlderReplies")}
          </button>
        </Show>

        <For each={replies()}>
          {(m, index) => (
            <MessageRow {...rowProps(m, shouldGroup(replies()[index() - 1] ?? null, m))} />
          )}
        </For>

        <For each={liveStreams()}>
          {(run) => (
            <div
              class="px-1 py-2"
              data-testid="reply-agent-stream-block"
              data-agent-id={run.agentId ?? ""}
            >
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
                  renderText={render}
                  isStreaming={run.stream.state === "streaming"}
                  isLastMessage={true}
                  threadId={props.threadId}
                />
              </Show>
              <Show when={run.stream.state === "error" && run.stream.error}>
                <div class="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-[12px] text-red-400">
                  {run.stream.error?.message}
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      <QuoteSelection
        container={() => scrollEl}
        surfaceKey={surfaceKey()}
        resolveMessage={(id) => (id === props.rootId ? root() : replies().find((m) => m.id === id))}
      />

      <ComposeBar
        onSend={send}
        threadId={props.threadId}
        compact={props.compact}
        autofocus
        placeholder={i18n.t("kernel.replyThreads.replyPlaceholder")}
        disabled={!!root()?.deletedAt}
        quote={quote()}
        onClearQuote={() => clearQuoteDraft(surfaceKey())}
      />
    </aside>
  )
}

export default ReplyThreadPanel
