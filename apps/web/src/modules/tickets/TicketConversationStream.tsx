// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketConversationStream — renders the per-ticket message thread,
// trusting backend HTML sanitization (server returns sanitized htmlBody).
// Oldest-first (newest at the bottom, email/chat convention) — the store
// (ticket-message-store.ts) already keeps `ids` in that order; this component
// owns the scroll container and autoscroll behavior on top of it.

import { type ApprovalRequestSummary, htmlToText } from "@liaison/shared"
import type { Component } from "solid-js"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { cn } from "~/lib/cn"
import { FLAT_QUOTES_CLASS } from "~/lib/email-html"
import {
  createQuoteCache,
  hasTrimmedQuoteMarker,
  removeTrimmedQuoteMarker,
  splitQuotedHistory,
  splitQuotedHtml,
} from "~/lib/email-quote"
import { runTool } from "~/lib/run-tool"
import ApprovalCard from "~/modules/approvals/ApprovalCard"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow, WithDictation } from "~/modules/assist/RecorderBar"
import { TrustedSenderControl } from "~/modules/contacts/TrustedSenderControl"
import { trustEntryFor } from "~/modules/contacts/trusted-senders-store"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { AttachmentStrip } from "~/modules/files/AttachmentStrip"
import { downloadFile } from "~/modules/files/file-service"
import { ImageLightbox } from "~/modules/files/ImageLightbox"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { MarkdownContent } from "~/modules/shell/markdown-content"
import { presentMessageKind } from "~/modules/shell/message-kind"
import { quotedHistoryLabels } from "~/modules/shell/quoted-history-labels"
import { shellTier } from "~/modules/shell/shell-tier"
import { addToast } from "~/modules/shell/toast-store"
import { localizeKnownTicketNotes } from "~/modules/tickets/known-notes"
import { TicketHtmlBody } from "~/modules/tickets/TicketHtmlBody"
import {
  fetchFullTicketMessage,
  loadMessages,
  loadMoreMessages,
  patchTicketMessageText,
  removeTicketMessage,
  ticketMessageStore,
} from "~/modules/tickets/ticket-message-store"
import type { TicketMessage } from "~/modules/tickets/ticket-types"
import { QuotedHistory } from "~/ui/QuotedHistory"
import { ThreadMap } from "~/ui/ThreadMap"
import { ThreadMapDrawer } from "~/ui/ThreadMapDrawer"
import { type ThreadMapItem, threadMapFirstLine, threadMapPlainText } from "~/ui/thread-map-model"
import {
  clearThreadMapSize,
  closeThreadMap,
  isThreadMapOpen,
  openThreadMap,
  setThreadMapSize,
} from "~/ui/thread-map-store"

interface TicketQuoteSplit {
  mode: "html" | "text"
  visible: string
  quoted: string
}

// Rows remount whenever their message object is replaced (a re-fetch, a live
// update), so the split of a long quoted chain is cached per message instead
// of per row.
const quoteSplitCache = createQuoteCache<TicketQuoteSplit>()
const visibleTextCache = createQuoteCache<string>()

/**
 * Unified quoted-history split for BOTH render paths: HTML emails (real
 * tickets) split structurally (quote containers, attribution lines, header
 * blocks); plain-text-only messages fall back to the line-matching heuristic
 * against the previous message. A reply written in Liaison holds only what was
 * written: a quote in it is part of the reply, never history to fold away.
 */
function splitTicketMessage(m: TicketMessage, prev: TicketMessage | undefined): TicketQuoteSplit {
  const writtenHere = m.kind === "outbound-pending" || (m.kind === "outbound" && !!m.createdBy)
  const html = m.htmlBody
  if (html) {
    if (writtenHere) return { mode: "html", visible: html, quoted: "" }
    return quoteSplitCache.get(`html:${m.id}`, html, () => {
      const s = splitQuotedHtml(html)
      return { mode: "html", visible: s.visibleHtml, quoted: s.quotedHtml }
    })
  }
  const text = m.textBody ?? ""
  if (writtenHere) return { mode: "text", visible: text, quoted: "" }
  // A note quotes no email history: matched against the message before it, a
  // note repeating it was folded away whole behind "•••".
  const prevText = m.kind === "note" ? "" : (prev?.textBody ?? "")
  return quoteSplitCache.get(`text:${m.id}`, `${text}\u0000${prevText}`, () => {
    const s = splitQuotedHistory(text, prevText)
    return { mode: "text", visible: s.visible, quoted: s.quoted }
  })
}

/** Fullscreen preview target — a body image the reader clicked. `fileId` (when
 *  set) unlocks the filename + download affordance in the lightbox. */
interface LightboxTarget {
  src: string
  fileId: string | null
  filename?: string
  sizeBytes?: number
}

interface Props {
  ticketId: string
  /**
   * The ticket's internal/approval thread id (when set) — human-raised gated
   * drafts host their approval_request there rather than carrying a
   * `tool_params.ticketId`, so the pending-approvals fetch needs both keys.
   */
  approvalThreadId?: string | null
}
// How close to the bottom (px) counts as "at the bottom" for the purpose of
// resuming autoscroll after the user scrolls back down. Mirrors the threads
// MessageList convention (NEAR_BOTTOM_THRESHOLD).
const NEAR_BOTTOM_THRESHOLD = 80
// How close to the TOP (px) triggers an automatic older-page load while an
// older cursor exists — infinite upward scroll; the "Load more" button stays
// as a fallback.
const NEAR_TOP_AUTOLOAD_THRESHOLD = 200

/** Plain addresses from a stored To or Cc list (strings or {email} objects). */
function addressList(list: unknown[] | null | undefined): string[] {
  return (list ?? [])
    .map((a) =>
      typeof a === "string" ? a : ((a as { email?: unknown } | null)?.email as string | undefined),
    )
    .filter((a): a is string => typeof a === "string" && a.length > 0)
}

/** The recipients a message card names: To and Cc on what we sent, Cc on what
 *  the customer sent. Null when there is nothing worth a line. */
export function recipientLine(m: TicketMessage): { to: string[]; cc: string[] } | null {
  const outbound = m.kind === "outbound" || m.kind === "outbound-pending"
  const to = outbound ? addressList(m.toEmails) : []
  const cc = m.kind === "note" ? [] : addressList(m.ccEmails)
  return to.length > 0 || cc.length > 0 ? { to, cc } : null
}

export const TicketConversationStream: Component<Props> = (props) => {
  const i18n = useI18n()
  // Agent-authored rows (outbound replies, notes) show the Liaison user who
  // sent them; inbound rows show the customer's email identity. Shared by the
  // card header and the thread map's titles.
  const messageAuthor = (m: TicketMessage): string =>
    m.kind === "inbound"
      ? m.fromName || m.fromEmail || i18n.t("tickets.unknownSender")
      : /* A routine executes as its OWNER, so authorName would name
           whoever created it rather than the actor. */
        m.authorLabel ||
        m.authorName ||
        m.fromName ||
        m.fromEmail ||
        (m.kind === "note" ? i18n.t("tickets.internalNote") : i18n.t("tickets.support"))
  const api = useApi()
  const [lightbox, setLightbox] = createSignal<LightboxTarget | null>(null)
  let containerRef: HTMLDivElement | undefined
  // "Following the newest message" — sticky like MessageList's isNearBottom:
  // cleared only by a deliberate upward scroll, not by content growth (e.g. an
  // inline image finishing layout below the fold).
  let isNearBottom = true
  let lastScrollTop = 0
  // True while a "Load more" (older-page) fetch is in flight or being
  // re-anchored — suppresses the trailing-message autoscroll effect so
  // prepending older messages never yanks the viewport to the bottom.
  let loadingOlder = false

  const thread = createMemo(() => ticketMessageStore.threadsByTicketId[props.ticketId])

  // Pending gated approvals for this ticket, rendered INLINE at the bottom of
  // the conversation (pending drafts are chronologically the newest item) so
  // the gate reads as part of the exchange instead of a detached panel.
  //
  // Queries BOTH sources and dedupes by id:
  //  1. `/approvals?ticketId=...` — matches on `tool_params.ticketId`, which
  //     catches approvals raised by a ROUTINE (its approval_request lives on
  //     the routine's own output thread, so a threadId-only fetch misses it).
  //  2. `/approvals?threadId=...` — human-raised drafts living on the ticket's
  //     internal/approval thread (when set).
  //
  // Refresh: on ticket/thread change and on the `tickets:approvals-invalidated`
  // window event (dispatched by ticket-message-store's WS approval_request
  // handlers and by TicketComposer right after a reply comes back blocked).
  const [approvalsRefreshKey, setApprovalsRefreshKey] = createSignal(0)
  onMount(() => {
    function onInvalidated(e: Event): void {
      const detail = (e as CustomEvent<{ ticketId?: string }>).detail
      if (detail?.ticketId !== props.ticketId) return
      setApprovalsRefreshKey((k) => k + 1)
    }
    window.addEventListener("tickets:approvals-invalidated", onInvalidated)
    onCleanup(() => window.removeEventListener("tickets:approvals-invalidated", onInvalidated))
  })
  const [approvals] = createResource(
    // No ticket id yet (a live ticket still opening): nothing to ask for, never `ticketId=undefined`.
    () =>
      props.ticketId
        ? ([props.ticketId, props.approvalThreadId ?? null, approvalsRefreshKey()] as const)
        : false,
    async ([ticketId, threadId]) => {
      const byTicket = await api.getEnvelope<ApprovalRequestSummary[]>(
        `/approvals?ticketId=${encodeURIComponent(ticketId)}`,
      )
      if (!threadId) return byTicket.data
      const byThread = await api.getEnvelope<ApprovalRequestSummary[]>(
        `/approvals?threadId=${threadId}`,
      )
      const merged = new Map<string, ApprovalRequestSummary>()
      for (const a of [...byTicket.data, ...byThread.data]) merged.set(a.id, a)
      return [...merged.values()]
    },
  )
  // Read `.latest` (not `approvals()`): the whole tab tree sits under
  // MainPanel's single <Suspense>, so reading the resource accessor during an
  // approval-invalidation refetch re-suspends the ENTIRE ticket tab (visible
  // blank + reload on every approve/deny). `.latest` keeps serving the previous
  // list while the refetch is in flight, so decisions patch in place.
  const pendingApprovals = createMemo(() =>
    approvals.error ? [] : (approvals.latest ?? []).filter((a) => a.status === "pending"),
  )
  const pendingApprovalIds = createMemo(() => new Set(pendingApprovals().map((a) => a.id)))

  // Acknowledgement emails are real, delivered outbound messages (kept
  // server-side for audit/threading) but are system-generated boilerplate,
  // not agent conversation — hide them from the agent-facing thread.
  // Outbound-pending placeholders whose approval renders as an inline card
  // below are hidden too: the card shows the same draft with the actual
  // approve/deny/edit controls, so the placeholder would be a duplicate.
  const items = createMemo(() => {
    const t = thread()
    if (!t) return []
    return t.ids
      .map((id) => t.byId[id])
      .filter((m): m is TicketMessage => !!m && !m.isAcknowledgement)
      .filter(
        (m) =>
          !(
            m.kind === "outbound-pending" &&
            m.approvalRequestId &&
            pendingApprovalIds().has(m.approvalRequestId)
          ),
      )
  })

  // The thread map's entries, one per message card (each carries
  // `data-thread-map-id`), in stream order.
  const threadMapItems = createMemo<ThreadMapItem[]>(() =>
    items().map((m) => {
      const at = m.sentAt ?? m.createdAt
      return {
        id: m.id,
        kind:
          m.kind === "note"
            ? "note"
            : m.kind === "outbound" || m.kind === "outbound-pending"
              ? "out"
              : "in",
        who: messageAuthor(m),
        dateLabel: at
          ? new Date(at).toLocaleDateString(i18n.locale(), { day: "numeric", month: "short" })
          : "",
        line: threadMapFirstLine(m.textBody || threadMapPlainText(m.htmlBody) || m.snippet),
      }
    }),
  )

  // The phone header (TicketPhoneHeader, a separate component) offers the
  // thread drawer only from 3 messages: it learns the count through the store.
  const threadMapKey = () => `tickets:${props.ticketId}`
  createEffect(
    on(threadMapKey, (key) => {
      onCleanup(() => clearThreadMapSize(key))
    }),
  )
  createEffect(() => setThreadMapSize(threadMapKey(), items().length))

  // Which messages have their quoted history expanded, and which show its
  // original, keyed by message id. Kept here, not in the row: re-fetching a
  // trimmed message replaces its row.
  const [expandedQuotes, setExpandedQuotes] = createSignal<Record<string, boolean>>({})
  function setQuoteOpen(id: string, open: boolean): void {
    setExpandedQuotes((prev) => ({ ...prev, [id]: open }))
  }
  const [originalQuotes, setOriginalQuotes] = createSignal<Record<string, boolean>>({})
  function setQuoteOriginalOpen(id: string, open: boolean): void {
    setOriginalQuotes((prev) => ({ ...prev, [id]: open }))
  }
  // Per-message "fetching the full body" flag for trimmed messages — the page
  // load trims quoted tails server-side (QUOTE_TRIMMED_MARKER), so expanding
  // one first re-fetches that single message untrimmed.
  const [quoteFetching, setQuoteFetching] = createSignal<Record<string, boolean>>({})
  async function fetchTrimmedQuote(m: TicketMessage): Promise<boolean> {
    setQuoteFetching((prev) => ({ ...prev, [m.id]: true }))
    try {
      await fetchFullTicketMessage(api, props.ticketId, m.id)
      return true
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : i18n.t("tickets.failedToLoadQuotedText"),
        type: "error",
      })
      return false
    } finally {
      setQuoteFetching((prev) => ({ ...prev, [m.id]: false }))
    }
  }
  const quoteLabels = createMemo(() => quotedHistoryLabels(i18n.t))
  // The thread's emails as plain visible text, once per thread: a quoted copy
  // of one of them links up to it instead of repeating it.
  const threadTexts = createMemo(() => {
    const list = items()
    return list.flatMap((m, i) => {
      if (m.kind === "note") return []
      const s = splitTicketMessage(m, list[i - 1])
      const text =
        s.mode === "html"
          ? visibleTextCache.get(m.id, s.visible, () => htmlToText(s.visible))
          : s.visible
      return [{ id: m.id, text }]
    })
  })
  function scrollToMessage(id: string): void {
    const el = containerRef?.querySelector(`[data-testid="tickets-message-${id}"]`)
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    el?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" })
  }

  // Internal-note maintenance (edit/delete). Human clicks run through the same
  // gated tools agents use — the direct-human-approver bypass executes them
  // immediately for reviewers; otherwise the call stages an approval.
  const [editingNote, setEditingNote] = createSignal<{ id: string; text: string } | null>(null)
  // One note is edited at a time: its editor, for the writing helpers.
  let noteEditor: RichEditorHandle | undefined
  const [confirmingDeleteId, setConfirmingDeleteId] = createSignal<string | null>(null)
  const [noteBusy, setNoteBusy] = createSignal(false)

  async function deleteNote(messageId: string): Promise<void> {
    setNoteBusy(true)
    try {
      const r = await runTool<{ blocked?: unknown }>(api, "tickets:deleteNote", {
        ticketId: props.ticketId,
        messageId,
      })
      if (r && typeof r === "object" && "blocked" in r) {
        addToast({ message: i18n.t("tickets.noteDeletionStagedForApproval"), type: "info" })
        setApprovalsRefreshKey((k) => k + 1)
      } else {
        removeTicketMessage(props.ticketId, messageId)
      }
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : i18n.t("tickets.failedToDeleteNote"),
        type: "error",
      })
    } finally {
      setNoteBusy(false)
      setConfirmingDeleteId(null)
    }
  }

  async function saveNoteEdit(): Promise<void> {
    const edit = editingNote()
    if (!edit?.text.trim()) return
    setNoteBusy(true)
    try {
      const r = await runTool<{ blocked?: unknown }>(api, "tickets:editNote", {
        ticketId: props.ticketId,
        messageId: edit.id,
        text: edit.text,
      })
      if (r && typeof r === "object" && "blocked" in r) {
        addToast({ message: i18n.t("tickets.noteEditStagedForApproval"), type: "info" })
        setApprovalsRefreshKey((k) => k + 1)
      } else {
        patchTicketMessageText(props.ticketId, edit.id, edit.text)
      }
      setEditingNote(null)
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : i18n.t("tickets.failedToEditNote"),
        type: "error",
      })
    } finally {
      setNoteBusy(false)
    }
  }

  function scrollToBottom(): void {
    if (containerRef) containerRef.scrollTop = containerRef.scrollHeight
  }

  function handleScroll(): void {
    if (!containerRef) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef
    const gap = scrollHeight - scrollTop - clientHeight
    const scrolledUp = scrollTop < lastScrollTop - 1
    lastScrollTop = scrollTop
    if (gap < NEAR_BOTTOM_THRESHOLD) {
      isNearBottom = true
    } else if (scrolledUp) {
      isNearBottom = false
    }
    // Infinite upward scroll: fetch the next older page as the reader nears
    // the top, when a cursor exists and no older-page load is in flight.
    if (
      scrollTop < NEAR_TOP_AUTOLOAD_THRESHOLD &&
      thread()?.nextCursor &&
      !thread()?.loading &&
      !loadingOlder
    ) {
      void handleLoadMore()
    }
  }

  onMount(() => {
    if (!containerRef) return
    containerRef.addEventListener("scroll", handleScroll, { passive: true })
  })

  // Autoscroll to the bottom on initial load, and whenever a NEW TRAILING
  // message arrives while the reader is following the bottom (own reply,
  // customer reply, WS echo). Never fires for "Load more" (guarded by
  // `loadingOlder`) and never yanks the viewport if the user has scrolled up
  // to read older history (guarded by `isNearBottom`).
  createEffect(
    on(
      () => items().length + pendingApprovals().length,
      (len, prevLen) => {
        if (len === 0) return
        if (loadingOlder) return
        if (prevLen == null || prevLen === 0 || isNearBottom) {
          requestAnimationFrame(scrollToBottom)
        }
      },
    ),
  )

  // Opening a ticket with a pending agent reply lands ON that draft's card,
  // not merely at the bottom: the card renders after the messages and grows
  // once its own content loads, so the bottom autoscroll left it half out of
  // view. Once per ticket; a second pass after the card has filled in.
  const draftCardRefs = new Map<string, HTMLElement>()
  let scrolledToDraftFor: string | null = null
  createEffect(
    on(pendingApprovals, (rows) => {
      if (scrolledToDraftFor === props.ticketId) return
      const draft = rows.find((r) => r.toolName === "tickets:reply")
      if (!draft) return
      scrolledToDraftFor = props.ticketId
      const reveal = (): void => {
        const el = draftCardRefs.get(draft.id)
        if (!el?.isConnected) return
        el.scrollIntoView({ block: "start" })
        // Reading the draft, not following the bottom: a later message must
        // not yank the view away from it.
        isNearBottom = false
      }
      requestAnimationFrame(reveal)
      setTimeout(reveal, 400)
    }),
  )

  async function handleLoadMore(): Promise<void> {
    if (!containerRef) {
      await loadMoreMessages(api, props.ticketId)
      return
    }
    loadingOlder = true
    const prevScrollHeight = containerRef.scrollHeight
    const prevScrollTop = containerRef.scrollTop
    try {
      await loadMoreMessages(api, props.ticketId)
    } finally {
      // Preserve reading position: the newly-prepended older page pushes
      // existing content down by exactly its rendered height.
      requestAnimationFrame(() => {
        if (containerRef) {
          const delta = containerRef.scrollHeight - prevScrollHeight
          if (delta > 0) containerRef.scrollTop = prevScrollTop + delta
        }
        loadingOlder = false
      })
    }
  }

  // The scroller is THIS element (`containerRef`: the autoscroll, the
  // load-older restore and the near-top autoload all drive it), not
  // TicketDetail's `tickets-detail-stream` around it, so the thread map sits
  // beside it here. Built as a value so the stream's markup keeps its place.
  const conversation = (
    <div
      class="flex h-full min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
      data-testid="tickets-conversation"
      ref={(el) => {
        containerRef = el
      }}
    >
      {/* Load failure with nothing to show: a silent empty stream reads as
          "no conversation" (only the approvals fetch below succeeds) — render
          an explicit error + retry instead. */}
      <Show when={thread()?.error && items().length === 0}>
        <div
          class="m-auto flex flex-col items-center gap-2 text-sm text-text-secondary"
          data-testid="tickets-messages-error"
        >
          <span>{i18n.t("tickets.failedToLoadTheConversation")}</span>
          <button
            type="button"
            class="rounded border border-border bg-surface px-3 py-1 text-sm hover:bg-surface/70"
            data-testid="tickets-messages-retry"
            disabled={thread()?.loading}
            onClick={() => void loadMessages(api, props.ticketId)}
          >
            {i18n.t("kernel.common.retry2")}
          </button>
        </div>
      </Show>
      <Show when={thread()?.nextCursor}>
        <button
          type="button"
          class="self-center rounded border border-border px-2 py-1 text-sm"
          data-testid="tickets-load-more-messages"
          onClick={() => void handleLoadMore()}
        >
          {i18n.t("kernel.common.loadMore")}
        </button>
      </Show>
      <For each={items()}>
        {(m, index) => {
          // removeTrimmedQuoteMarker: a server-trimmed body carries an
          // elision note in place of the quoted tail — hide the note (in
          // either part); the fold below (isTrimmed) is the affordance for
          // the full text.
          const quoteSplit = createMemo(() => {
            const s = splitTicketMessage(m, items()[index() - 1])
            return {
              mode: s.mode,
              visible: localizeKnownTicketNotes(removeTrimmedQuoteMarker(s.visible), i18n.t),
              quoted: removeTrimmedQuoteMarker(s.quoted),
            }
          })
          // Trimmed server-side: the quoted tail exists but is not loaded yet —
          // still show the fold ("•••"); expanding lazily fetches the full
          // message, whose tail then lists its earlier emails.
          const isTrimmed = createMemo(() => hasTrimmedQuoteMarker(m))
          const hasQuote = createMemo(() => !!quoteSplit().quoted || isTrimmed())
          const quotedHistory = () => (
            <Show when={hasQuote()}>
              <QuotedHistory
                quoted={isTrimmed() ? "" : quoteSplit().quoted}
                mode={quoteSplit().mode}
                cacheKey={m.id}
                threadMessages={threadTexts().filter((t) => t.id !== m.id)}
                onJump={scrollToMessage}
                labels={quoteLabels()}
                open={!!expandedQuotes()[m.id]}
                onOpenChange={(open) => setQuoteOpen(m.id, open)}
                originalOpen={!!originalQuotes()[m.id]}
                onOriginalOpenChange={(open) => setQuoteOriginalOpen(m.id, open)}
                loading={!!quoteFetching()[m.id]}
                onExpand={isTrimmed() ? () => fetchTrimmedQuote(m) : undefined}
                testIdPrefix="tickets-message-quote"
                testIdKey={m.id}
                renderOriginal={(quoted) =>
                  quoteSplit().mode === "html" ? (
                    <TicketHtmlBody
                      class={cn(
                        "border-l-2 border-border-subtle pl-2 text-text-tertiary [&_img]:cursor-zoom-in",
                        FLAT_QUOTES_CLASS,
                      )}
                      html={quoted}
                      onImageClick={openImage}
                    />
                  ) : (
                    <pre class="whitespace-pre-wrap border-l-2 border-border-subtle pl-2 font-sans text-text-tertiary">
                      {quoted}
                    </pre>
                  )
                }
              />
            </Show>
          )
          const attachments = createMemo(() => ((m as any).attachments ?? []) as any[])
          // "inline if inline, at the bottom if attached, like a true email":
          // anything the body actually references renders inline above, so the
          // strip lists only the true (unreferenced) attachments — no dupes.
          const strippedAttachments = createMemo(() => {
            const html = m.htmlBody ?? ""
            // The server writes the bare `/api/files/<id>/inline`; a body that went
            // through the mail rewrite carries it on the server's origin. Both end
            // the same way, so that is what is matched.
            return attachments().filter((a) => !html.includes(`/files/${a.id}/inline`))
          })
          // Resolve a clicked inline image back to its attachment so the
          // fullscreen lightbox can show its name and offer a download.
          const openImage = (src: string, fileId: string | null): void => {
            const att = fileId ? attachments().find((a) => a.id === fileId) : null
            setLightbox({ src, fileId, filename: att?.filename, sizeBytes: att?.sizeBytes })
          }
          return (
            <article
              class={cn(
                // NO `overflow-hidden` here. It was added to clip the rail to
                // the rounded corners and it collapsed every card: these cards
                // are flex items, and overflow-hidden makes a flex item
                // shrinkable below its content, so each one squashed to a 26px
                // sliver with 1618px of message clipped inside it. The text
                // stayed in the DOM, so every text assertion still passed while
                // the stream was unreadable. The rail rounds itself instead.
                "relative rounded-lg border p-3 shadow-sm",
                // Surface only. The rail is a real ELEMENT below, not a
                // border utility: `border-border` here sets all four sides and
                // silently beat `border-l-accent`, so outbound rendered a 3px
                // left border in the ORDINARY colour -- correct in the class
                // string, invisible on screen (ticket-10175).
                presentMessageKind(m.kind).surface,
              )}
              data-tone={presentMessageKind(m.kind).tone}
              data-testid={`tickets-message-${m.id}`}
              data-thread-map-id={m.id}
              data-kind={m.kind}
            >
              {/* The non-colour cue. An absolutely positioned span owns its own
                  background and cannot be overridden by the card's border
                  utilities. Inbound has no rail by design. */}
              <Show when={presentMessageKind(m.kind).rail}>
                <span
                  aria-hidden="true"
                  data-testid={`tickets-message-rail-${m.id}`}
                  class={cn(
                    "pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-l-lg",
                    presentMessageKind(m.kind).rail,
                  )}
                />
              </Show>
              {/* Wraps as whole items: at phone width a note's author, time,
                  actions and badges each squeezed into a column of words. */}
              <header class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-tertiary">
                <span class="font-medium text-text-secondary">
                  {/* Agent-authored rows (outbound replies, notes) show the
                      Liaison user who sent them; inbound rows show the
                      customer's email identity. */}
                  {messageAuthor(m)}
                </span>
                {/* The sender's address sits beside their name: a ticket whose
                    sender is linked to no contact has no contact chip, so the
                    name alone left staff without the address to answer. */}
                <Show when={m.kind === "inbound" && m.fromName && m.fromEmail}>
                  <span
                    data-testid={`tickets-message-from-email-${m.id}`}
                    class="select-text break-all"
                  >
                    {`<${m.fromEmail}>`}
                  </span>
                </Show>
                {/* A gated reply is DRAFTED by the requester and AUTHORISED by
                    whoever approved it. The handler runs as the requester, so
                    authorName alone read as "written by" the wrong person
                    (prod 2026-08-05: the requester shown for replies a teammate approved).
                    Show both whenever they differ. */}
                <Show when={m.approverName && m.approverName !== m.authorName}>
                  <span data-testid={`tickets-message-approver-${m.id}`}>
                    {" "}
                    {i18n.t("tickets.approvedBy")} {m.approverName})
                  </span>
                </Show>
                {/* The separator is rendered WITH the timestamp, never on its
                    own: a message with no send time left a bare "·" hanging
                    after the author, and at phone width the same standalone
                    span wrapped to a line of its own. */}
                <Show when={m.sentAt}>
                  {(sentAt) => (
                    <span data-testid={`tickets-message-sent-${m.id}`} class="whitespace-nowrap">
                      {"\u00b7 "}
                      {new Date(sentAt()).toLocaleString()}
                    </span>
                  )}
                </Show>
                {/* The From of an email is whatever the sender typed. Show when
                    the receiving provider did not authenticate it. */}
                <Show when={m.kind === "inbound" && m.senderAuth && m.senderAuth !== "pass"}>
                  {/* Staff can trust an unverified sender (an address, or its domain):
                      it then counts as verified for the inbound rules. A sender that
                      FAILED verification may be forged, so it is never offered. */}
                  <Show when={m.senderAuth === "fail" || !trustEntryFor(m.fromEmail)}>
                    <span
                      data-testid={`tickets-message-sender-auth-${m.id}`}
                      class="rounded border border-amber-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300/80"
                    >
                      {m.senderAuth === "fail"
                        ? i18n.t("tickets.senderFailedVerification")
                        : i18n.t("tickets.senderUnverified")}
                    </span>
                  </Show>
                  <Show when={m.senderAuth !== "fail" && m.fromEmail}>
                    {(from) => (
                      <TrustedSenderControl
                        email={from()}
                        testId={`tickets-message-sender-trust-${m.id}`}
                      />
                    )}
                  </Show>
                </Show>
                <Show when={m.kind === "note"}>
                  <span class="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      class="rounded border border-transparent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300/70 hover:border-amber-900/40 hover:text-amber-300"
                      data-testid={`tickets-note-edit-${m.id}`}
                      disabled={noteBusy()}
                      onClick={() => {
                        setConfirmingDeleteId(null)
                        setEditingNote({ id: m.id, text: m.textBody ?? "" })
                      }}
                    >
                      {i18n.t("kernel.common.edit")}
                    </button>
                    <Show
                      when={confirmingDeleteId() === m.id}
                      fallback={
                        <button
                          type="button"
                          class="rounded border border-transparent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300/70 hover:border-amber-900/40 hover:text-amber-300"
                          data-testid={`tickets-note-delete-${m.id}`}
                          disabled={noteBusy()}
                          onClick={() => setConfirmingDeleteId(m.id)}
                        >
                          {i18n.t("kernel.common.delete")}
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="rounded bg-red-950/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-300 hover:bg-red-900/60"
                        data-testid={`tickets-note-delete-confirm-${m.id}`}
                        disabled={noteBusy()}
                        onClick={() => void deleteNote(m.id)}
                      >
                        {i18n.t("tickets.confirmDelete")}
                      </button>
                      <button
                        type="button"
                        class="px-1 text-[10px] uppercase tracking-wide text-text-tertiary hover:text-text-secondary"
                        onClick={() => setConfirmingDeleteId(null)}
                      >
                        {i18n.t("kernel.common.cancel")}
                      </button>
                    </Show>
                  </span>
                </Show>
                {/* Words, not the enum. Operators were reading
                    "outbound-pending" and "inbound" -- machine vocabulary for a
                    human judgement about who can see what (ticket-10175). An
                    internal note also states its reach outright, because that is
                    the fact most costly to get wrong in either direction. */}
                <span
                  class={cn(
                    m.kind === "note" ? "" : "ml-auto",
                    "whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                    presentMessageKind(m.kind).badge,
                  )}
                  title={i18n.t(presentMessageKind(m.kind).visibilityKey)}
                  data-kind-label={presentMessageKind(m.kind).label}
                >
                  {i18n.t(presentMessageKind(m.kind).labelKey)}
                </span>
                <Show when={presentMessageKind(m.kind).tone === "internal"}>
                  <span class="whitespace-nowrap text-[10px] text-text-tertiary">
                    {i18n.t(presentMessageKind(m.kind).visibilityKey)}
                  </span>
                </Show>
              </header>
              {/* Who the email went to. An outbound card names its To and Cc (the
                  reply may copy people beyond the customer); an inbound card
                  names who the customer copied. */}
              <Show when={recipientLine(m)}>
                {(line) => (
                  <div
                    class="mt-1 break-words text-[11px] text-text-tertiary"
                    data-testid={`tickets-message-recipients-${m.id}`}
                  >
                    <Show when={line().to.length > 0}>
                      <span>
                        {i18n.t("kernel.to")}: {line().to.join(", ")}
                      </span>
                    </Show>
                    <Show when={line().to.length > 0 && line().cc.length > 0}>
                      <span>{"\u00b7 "}</span>
                    </Show>
                    <Show when={line().cc.length > 0}>
                      <span data-testid={`tickets-message-cc-${m.id}`}>
                        {i18n.t("tickets.cc")}: {line().cc.join(", ")}
                      </span>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={m.kind === "note" && editingNote()?.id === m.id}>
                <div class="mt-2">
                  <RichEditor
                    preset="full"
                    autofocus
                    ref={(handle) => {
                      noteEditor = handle
                    }}
                    value={editingNote()?.text ?? ""}
                    onChange={(text) => setEditingNote((prev) => (prev ? { ...prev, text } : prev))}
                    onSubmit={() => void saveNoteEdit()}
                    onCancel={() => setEditingNote(null)}
                    data-testid={`tickets-note-edit-input-${m.id}`}
                    class="rounded border border-amber-900/40 bg-surface p-2 [--editor-bg:var(--color-surface)]"
                    editorClass="min-h-16"
                  />
                  <div class="mt-1 flex items-center gap-2">
                    <WithDictation target={() => noteEditor}>
                      {(dictation) => (
                        <RecorderRow dictation={dictation}>
                          <ComposerAssist target={() => noteEditor} disabled={noteBusy()} />
                          {/* The mic immediately left of Save, the row's primary action. */}
                          <span class="flex items-center gap-0.5">
                            <DictationMic dictation={dictation} disabled={noteBusy()} />
                            <button
                              type="button"
                              class="rounded border border-border bg-surface px-2 py-0.5 text-xs"
                              data-testid={`tickets-note-edit-save-${m.id}`}
                              disabled={noteBusy() || !editingNote()?.text.trim()}
                              onClick={() => void saveNoteEdit()}
                            >
                              {i18n.t("kernel.common.save")}
                            </button>
                          </span>
                          <button
                            type="button"
                            class="px-2 py-0.5 text-xs text-text-tertiary hover:text-text-secondary"
                            onClick={() => setEditingNote(null)}
                          >
                            {i18n.t("kernel.common.cancel")}
                          </button>
                        </RecorderRow>
                      )}
                    </WithDictation>
                  </div>
                </div>
              </Show>
              <div class="mt-1 text-sm" classList={{ hidden: editingNote()?.id === m.id }}>
                <Show
                  when={quoteSplit().mode === "html"}
                  fallback={
                    <>
                      {/* A note is markdown, whoever wrote it (a person in the
                          composer, an agent through tickets:addNote); an email
                          without HTML is shown as the plain text it is. */}
                      <Show
                        when={m.kind === "note"}
                        fallback={
                          <pre class="whitespace-pre-wrap font-sans">{quoteSplit().visible}</pre>
                        }
                      >
                        <MarkdownContent
                          content={quoteSplit().visible}
                          api={api}
                          data-testid={`tickets-note-body-${m.id}`}
                        />
                      </Show>
                      {quotedHistory()}
                    </>
                  }
                >
                  {/* htmlBody is sanitized server-side via sanitizeCustomerHtml;
                      TicketHtmlBody streams CID inline images through the authed
                      route (a native <img> can't carry the Bearer header). */}
                  <TicketHtmlBody
                    testId={`tickets-message-html-${m.id}`}
                    class="[&_img]:cursor-zoom-in"
                    html={quoteSplit().visible}
                    onImageClick={openImage}
                  />
                  {quotedHistory()}
                </Show>
              </div>
              <Show when={strippedAttachments().length > 0}>
                <AttachmentStrip
                  files={strippedAttachments().map((a) => ({
                    id: a.id,
                    filename: a.filename,
                    mimeType: a.mimeType,
                    sizeBytes: a.sizeBytes,
                    thumbnailUrl: a.thumbnailUrl ?? null,
                    disposition: a.disposition,
                    contentId: a.contentId ?? null,
                  }))}
                  onDownload={(f) => {
                    void downloadFile(api, f).catch(() => {
                      /* swallowed: user can retry */
                    })
                  }}
                />
              </Show>
            </article>
          )
        }}
      </For>
      <For each={pendingApprovals()}>
        {(a) => (
          <div
            data-testid="tickets-detail-approval-card"
            data-approval-id={a.id}
            data-tool-name={a.toolName}
            ref={(el) => draftCardRefs.set(a.id, el)}
          >
            <ApprovalCard requestId={a.id} compact />
          </div>
        )}
      </For>
      <ImageLightbox
        open={lightbox() !== null}
        onOpenChange={(open) => {
          if (!open) setLightbox(null)
        }}
        src={lightbox()?.src}
        filename={lightbox()?.filename}
        sizeBytes={lightbox()?.sizeBytes}
        onDownload={
          lightbox()?.fileId
            ? () => {
                const lb = lightbox()
                if (lb?.fileId) {
                  void downloadFile(api, {
                    id: lb.fileId,
                    filename: lb.filename ?? "image",
                  }).catch(() => {
                    /* swallowed: user can retry */
                  })
                }
              }
            : undefined
        }
      />
    </div>
  )

  return (
    <div class="relative flex h-full min-h-0">
      {conversation}
      <Show
        when={shellTier() !== "phone"}
        fallback={
          <ThreadMapDrawer
            scrollEl={() => containerRef}
            contentEl={() => containerRef}
            items={threadMapItems}
            open={isThreadMapOpen(threadMapKey())}
            onOpen={() => openThreadMap(threadMapKey())}
            onClose={() => closeThreadMap()}
            title={i18n.t("kernel.threadMap.drawerTitle")}
            summary={(count, from, to) =>
              i18n.t("kernel.threadMap.drawerSummary", { count, from, to })
            }
            pill={(index, total, who) => i18n.t("kernel.threadMap.position", { index, total, who })}
            openLabel={i18n.t("kernel.threadMap.open")}
            closeLabel={i18n.t("kernel.close")}
            noteTag={i18n.t("kernel.threadMap.noteTag")}
          />
        }
      >
        <ThreadMap
          scrollEl={() => containerRef}
          contentEl={() => containerRef}
          items={threadMapItems}
          label={i18n.t("kernel.threadMap.label")}
          counter={(index, total) => i18n.t("kernel.threadMap.counter", { index, total })}
        />
      </Show>
    </div>
  )
}
