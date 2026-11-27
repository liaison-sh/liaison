// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Messages — DM conversations. Left pane lists conversations; right pane is the
// thread with a reply-window pill AND the message history (fetched fresh via
// dm_get on selection — the list row has no messages[]). When the window is
// CLOSED the compose box is REPLACED by an "Open in Instagram ↗" native-app
// fallback notice (no API send is possible past 7d). Within the window the
// compose is enabled and the send is tagged (none ≤24h / human_agent ≤7d).

import { app } from "@liaison/host"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { type DmWindowTag, dmWindowTag } from "../dm-window"
import { gatedResultNote } from "./Findings"
import {
  Badge,
  type BadgeTone,
  Button,
  cx,
  EmptyState,
  PageHeader,
  stripExternalFence,
} from "./kit"

/** Snippet honesty (B), thread-bubble side: Graph API omits `message` on
 *  attachment/sticker-only messages, landing as an EMPTY string body (not
 *  absent) — a REAL message with no text, not a missing one. Renders as a
 *  muted "[attachment]" placeholder instead of an empty bubble or the
 *  misleading "(no text)" wording (which read as a bug, not a platform
 *  fact). A genuinely absent body (null/undefined — shouldn't happen for a
 *  landed message, but defensive) keeps the neutral "(no text)" wording. */
export function messageBubbleText(body: string | null | undefined): {
  text: string
  muted: boolean
} {
  if (body == null) return { text: "(no text)", muted: true }
  if (body.length === 0) return { text: "[attachment]", muted: true }
  return { text: body, muted: false }
}

export interface ConversationRow {
  id: string
  platform: "facebook" | "instagram"
  participant_handle?: string | null
  last_inbound_at?: string | null
  status: string
  /** dm_list / dm_get enrichment: the window as the send path computes it (24 h for a
   *  Unified-login Instagram account, which sends without the human agent tag). */
  reply_window?: { tag: DmWindowTag } | null
}

export interface MessageRow {
  id: string
  conversation_id: string
  direction: "inbound" | "outbound"
  body?: string | null
  occurred_at?: string | null
}

/** dm_get's `{ conversation, messages }` envelope (reads.ts). The conversation
 *  row is FRESH — it carries `withReplyWindow` enrichment (last_inbound_at as
 *  of the actual fetch, not the possibly-stale list row). */
export interface DmGetResult {
  conversation: ConversationRow | null
  messages: MessageRow[]
}

// ── Pure helper (unit-tested) ────────────────────────────────────────────────
export interface WindowPillState {
  tag: DmWindowTag
  label: string
  tone: BadgeTone
  composeEnabled: boolean
  showFallback: boolean
}

/** Derive the reply-window pill + whether the compose box or the native-app
 *  fallback is shown, recomputed from the last inbound time at render. */
const WINDOW_RANK: Record<DmWindowTag, number> = { none: 0, human_agent: 1, closed: 2 }

export function windowPillState(
  lastInboundAt: string | null,
  now: Date = new Date(),
  serverTag?: DmWindowTag | null,
): WindowPillState {
  // The clock recomputes freshness; the server's tag knows the account's window rule. The
  // stricter of the two wins, so neither a stale tag nor the 7-day default reopens a window.
  const clockTag = dmWindowTag(lastInboundAt, now)
  const tag = serverTag && WINDOW_RANK[serverTag] > WINDOW_RANK[clockTag] ? serverTag : clockTag
  if (tag === "none")
    return { tag, label: "Open (24h)", tone: "success", composeEnabled: true, showFallback: false }
  if (tag === "human_agent")
    return {
      tag,
      label: "Human-agent (7d)",
      tone: "warning",
      composeEnabled: true,
      showFallback: false,
    }
  return { tag, label: "Window closed", tone: "muted", composeEnabled: false, showFallback: true }
}

function nativeAppName(platform: ConversationRow["platform"]): string {
  return platform === "instagram" ? "Instagram" : "Facebook"
}

/** Short timestamp for a message bubble (falls back to the raw date). */
function messageTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ""
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

async function loadConversationDetail(conversationId: string): Promise<DmGetResult> {
  try {
    const res = await app.invokeTool<DmGetResult>("dm_get", { conversation_id: conversationId })
    return res ?? { conversation: null, messages: [] }
  } catch {
    return { conversation: null, messages: [] }
  }
}

// ── Detail panel ─────────────────────────────────────────────────────────────
// Receives the (possibly stale) list row for instant render, then fetches the
// FRESH conversation + message history via dm_get on selection. The window
// pill is derived from the fresh conversation row (dm_get's enrichment), not
// the stale list row, so it doesn't lag behind messages that landed since the
// list was last fetched. The compose box sends with send_dm as the person: their
// own scope decides, so it sends at once unless an org policy parks it, which the
// note then says ("Waiting for approval"), never "sent".
export const ConversationDetailPanel: Component<{ conversation: ConversationRow | null }> = (
  props,
) => {
  // The source function re-runs whenever `props.conversation?.id` changes,
  // which re-triggers the dm_get fetch — no extra effect needed.
  const [detail, { refetch }] = createResource(() => props.conversation?.id, loadConversationDetail)
  const [reply, setReply] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ kind: "ok" | "err"; text: string } | null>(null)

  const fresh = createMemo<ConversationRow | null>(
    () => detail()?.conversation ?? props.conversation ?? null,
  )
  const messages = createMemo<MessageRow[]>(() => detail()?.messages ?? [])
  const win = createMemo(() =>
    windowPillState(fresh()?.last_inbound_at ?? null, new Date(), fresh()?.reply_window?.tag),
  )

  const send = async () => {
    const conversationId = props.conversation?.id
    const body = reply().trim()
    if (!conversationId || !body || busy()) return
    setBusy(true)
    setNote(null)
    try {
      const res = await app.invokeTool("send_dm", { conversation_id: conversationId, body })
      setReply("")
      setNote({ kind: "ok", text: gatedResultNote(res, "Message sent.", "Waiting for approval.") })
      await refetch()
    } catch (e) {
      setNote({ kind: "err", text: e instanceof Error ? e.message : "Sending failed" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show
      when={props.conversation}
      fallback={<EmptyState title="No conversation selected">Pick a conversation.</EmptyState>}
    >
      <div data-testid="social-conversation-detail" class="flex h-full min-h-0 flex-col gap-3 p-4">
        <div class="flex items-center gap-2">
          <span class="text-[13px] font-medium text-text">
            {fresh()?.participant_handle ?? "Conversation"}
          </span>
          <Badge tone={win().tone} testid="social-dm-window-pill">
            {win().label}
          </Badge>
        </div>

        <div
          data-testid="social-dm-thread"
          class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
        >
          <Show
            when={messages().length > 0}
            fallback={<p class="text-[12px] text-text-tertiary">No messages yet.</p>}
          >
            <For each={messages()}>
              {(m) => {
                const bubble = messageBubbleText(m.body)
                return (
                  <div
                    data-testid={`social-dm-message-${m.id}`}
                    class={cx(
                      "flex flex-col gap-0.5",
                      m.direction === "outbound" ? "items-end" : "items-start",
                    )}
                  >
                    <div
                      class={cx(
                        "max-w-[80%] rounded-md px-2.5 py-1.5 text-[12.5px] leading-snug",
                        m.direction === "outbound"
                          ? "bg-accent-tint text-text border border-accent-border"
                          : "bg-surface text-text border border-border-subtle",
                        bubble.muted && "italic text-text-tertiary",
                      )}
                    >
                      {bubble.muted ? bubble.text : stripExternalFence(bubble.text) || "(no text)"}
                    </div>
                    <span class="text-[10.5px] text-text-tertiary">
                      {messageTime(m.occurred_at)}
                    </span>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>

        <Show
          when={win().composeEnabled}
          fallback={
            <div
              data-testid="social-dm-fallback"
              class="rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12.5px] text-text-secondary"
            >
              The reply window has closed. Reply directly in the app:{" "}
              <a
                href={`https://www.${fresh()?.platform === "instagram" ? "instagram" : "facebook"}.com/`}
                target="_blank"
                rel="noreferrer"
                class="text-accent"
                data-testid="social-dm-open-native"
              >
                Open in {nativeAppName(fresh()!.platform)} ↗
              </a>
            </div>
          }
        >
          <div
            data-testid="social-dm-compose"
            class="flex flex-col gap-2 border-t border-border-subtle pt-3"
          >
            <textarea
              data-testid="social-dm-compose-box"
              class="min-h-[64px] w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[12.5px] text-text"
              placeholder="Write a reply…"
              value={reply()}
              disabled={busy()}
              onInput={(e) => setReply(e.currentTarget.value)}
            />
            <Show when={note()}>
              {(n) => (
                <p
                  data-testid="social-dm-note"
                  class={cx("text-[12px]", n().kind === "ok" ? "text-success" : "text-error")}
                >
                  {n().text}
                </p>
              )}
            </Show>
            <Button
              variant="primary"
              testid="social-dm-send"
              disabled={busy() || !reply().trim()}
              onClick={() => void send()}
            >
              {win().tag === "human_agent" ? "Approve & send (human agent)" : "Approve & send"}
            </Button>
          </div>
        </Show>
      </div>
    </Show>
  )
}

// ── Master/detail surface ─────────────────────────────────────────────────────
interface DmListNotice {
  code: string
  accountExternalId: string
  message: string
}

interface DmListView {
  conversations: ConversationRow[]
  notices: DmListNotice[]
}

async function loadConversations(): Promise<DmListView> {
  try {
    const res = await app.invokeTool<{
      conversations?: ConversationRow[]
      notices?: DmListNotice[]
    }>("dm_list", {})
    return { conversations: res?.conversations ?? [], notices: res?.notices ?? [] }
  } catch {
    return { conversations: [], notices: [] }
  }
}

export const Messages: Component = () => {
  const [rows] = app.createResource(loadConversations)
  const [selected, setSelected] = createSignal<string | null>(null)
  const visible = createMemo<ConversationRow[]>(() => rows()?.conversations ?? [])
  const notices = createMemo<DmListNotice[]>(() => rows()?.notices ?? [])
  const selectedId = createMemo(() => {
    const s = selected()
    if (s && visible().some((r) => r.id === s)) return s
    return visible()[0]?.id ?? null
  })
  const selectedRow = createMemo(() => visible().find((r) => r.id === selectedId()) ?? null)
  // What the agent is told is open: the row the person picked, still listed. The
  // first row filling the pane by itself is not one.
  app.trackOpenRecord("dm_conversation", () => (selected() === selectedId() ? selected() : null))

  return (
    <div class="flex h-full min-h-0 flex-col">
      <PageHeader title="Messages" subtitle="Direct messages across Facebook and Instagram" />
      <For each={notices()}>
        {(n) => (
          <div
            data-testid={`social-dm-notice-${n.code}`}
            class="border-b border-border-subtle bg-surface-hover px-4 py-2 text-[12.5px] text-text"
          >
            {n.message}
          </div>
        )}
      </For>
      <div class="flex min-h-0 flex-1">
        <div
          class="w-80 shrink-0 overflow-y-auto border-r border-border-subtle"
          data-testid="social-messages-list"
        >
          <Show
            when={visible().length > 0}
            fallback={
              <EmptyState title="No conversations">DMs appear here once received.</EmptyState>
            }
          >
            <For each={visible()}>
              {(r) => {
                const win = windowPillState(
                  r.last_inbound_at ?? null,
                  new Date(),
                  r.reply_window?.tag,
                )
                return (
                  <button
                    type="button"
                    data-testid={`social-conversation-row-${r.id}`}
                    onClick={() => setSelected(r.id)}
                    class={cx(
                      "flex w-full items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-left",
                      selectedId() === r.id ? "bg-surface-hover" : "hover:bg-surface-hover",
                    )}
                  >
                    <span class="truncate text-[12.5px] text-text">
                      {r.participant_handle ?? r.platform}
                    </span>
                    <Badge tone={win.tone}>{win.label}</Badge>
                  </button>
                )
              }}
            </For>
          </Show>
        </div>
        <div class="min-w-0 flex-1 overflow-y-auto">
          <ConversationDetailPanel conversation={selectedRow()} />
        </div>
      </div>
    </div>
  )
}
