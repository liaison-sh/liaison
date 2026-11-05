// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CHAT CARD (S11, D8, L28; charter "Chat card"; P1-T25). One live card per
// dispatch, where the agent's `metadata.kind: "node_session"` message would
// have shown its text. It never shows the transcript: title, status, folder,
// model and node, elapsed time, the latest activity (or why it waits), Open
// session, Review while waiting (at the oldest open request), and the result
// summary once done (a needs_you session's reason, in the session's own words).
// The status read is the row's true one, `state ?? status` (D14); an unknown
// status keeps its label key and no colour, never a throw.
//
// The row comes from the session store, which `node_session` socket frames
// keep live; the card loads it once, and again after a reconnect or a resume.
// A 403 or 404 means the session is someone else's: the card shows a static
// line naming the owner, or the message's own text when no name is known.
// A demo's recorded session (its node is simulated) carries a "Recorded
// session" badge.

import {
  isEndedSessionStatus,
  type NodeSessionStatus,
  relativizePaths,
  rowState,
} from "@liaison/shared"
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { subscribeResync } from "~/framework/resync"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { isRecordedNode, RecordedSessionBadge } from "~/modules/nodes/RecordedNode"
import { isComputerWordsCode, plainInline, reasonCodeText } from "~/modules/sessions/display"
import { getSession, getSessionEvents } from "~/modules/sessions/session-api"
import { applyRow, sessionStore } from "~/modules/sessions/session-store"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"

const SUMMARY_MAX = 300
const REQUESTS = new Set(["permission_request", "question", "plan_request"])

const STATUS_CLASS: Record<NodeSessionStatus, string> = {
  queued: "bg-surface-hover text-text-tertiary",
  running: "bg-accent-glow text-accent",
  waiting: "bg-warning-glow text-warning",
  needs_you: "bg-warning-glow text-warning",
  paused: "bg-surface-hover text-text-tertiary",
  done: "bg-surface-hover text-success",
  stopped: "bg-surface-hover text-text-secondary",
  failed: "bg-surface-hover text-error",
}

/** Seconds as m:ss, or h:mm:ss from an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join("")
}

export interface NodeSessionCardProps {
  sessionId: string
  /** The computer the session runs on, from the card message. */
  nodeName?: string | null
  /** The session owner's name, when the row the card sits in knows it. */
  ownerName?: string | null
  /** The card message's own text: the static line when no owner name is known. */
  fallbackText?: string | null
}

export default function NodeSessionCard(props: NodeSessionCardProps) {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [denied, setDenied] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [oldestRequest, setOldestRequest] = createSignal<string | null>(null)

  const row = () => sessionStore.row(props.sessionId)
  /** The row's true status (`state ?? status`, D14). */
  const state = () => {
    const r = row()
    return r ? rowState(r) : undefined
  }

  async function load(): Promise<void> {
    if (!api) return
    try {
      applyRow(await getSession(api, props.sessionId))
      setDenied(false)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) setDenied(true)
    }
  }

  onMount(() => {
    void load()
    onCleanup(subscribeResync(() => void load()))
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(tick))
  })

  // While waiting, find the oldest request no decision has answered yet:
  // Review opens the session at it. Requests and decisions are the main
  // thread's, so only its events are read (D31f, scope=top); `through` moves
  // past the subagents' tail. An older API ignores the scope: every event.
  createEffect(
    on(
      () => {
        const r = row()
        return r && rowState(r) === "waiting" ? r.lastSeq : null
      },
      (lastSeq) => {
        if (lastSeq === null || !api) {
          setOldestRequest(null)
          return
        }
        void (async () => {
          const open: string[] = []
          let after = 0
          for (let page = 0; page < 1000; page++) {
            const page = await getSessionEvents(api, props.sessionId, after, { top: true })
            const { events } = page
            if (events.length === 0) break
            for (const e of events) {
              const id = e.payload.requestId
              if (typeof id !== "string" || e.parentToolUseId) continue
              if (REQUESTS.has(e.type) && !open.includes(id)) open.push(id)
              else if (e.type === "decision" && open.includes(id)) open.splice(open.indexOf(id), 1)
            }
            after = Math.max(events[events.length - 1].seq, page.through ?? 0)
          }
          setOldestRequest(open[0] ?? null)
        })().catch(() => setOldestRequest(null))
      },
    ),
  )

  const elapsed = () => {
    const r = row()
    if (!r) return ""
    const start = Date.parse(r.startedAt ?? r.createdAt)
    const end = r.endedAt && isEndedSessionStatus(rowState(r)) ? Date.parse(r.endedAt) : now()
    return formatElapsed(end - start)
  }

  const waitingLine = (reason: string | null): string => {
    if (!reason) return i18n.t("kernel.nodeSessions.card.waitingQuestion")
    const sep = reason.indexOf(":")
    const kind = sep > 0 ? reason.slice(0, sep) : reason
    const rest = sep > 0 ? reason.slice(sep + 1).trim() : ""
    if (kind === "permission")
      return i18n.t("kernel.nodeSessions.card.waitingPermission", { tool: rest })
    if (kind === "question") return i18n.t("kernel.nodeSessions.card.waitingQuestion")
    if (kind === "plan") return i18n.t("kernel.nodeSessions.card.waitingPlan")
    return reason
  }

  /** Walk D16: no absolute local path on the card (the shared relativizer). */
  const shown = (text: string): string => {
    const r = row()
    return r
      ? relativizePaths(text, { sessionId: r.id, folderName: r.folderName, repo: r.repo })
      : text
  }

  const activity = () => {
    const r = row()
    if (!r) return null
    const state = rowState(r)
    if (state === "waiting") return waitingLine(r.waitingReason)
    // S51: a reason the node or server wrote is said from its code; an unknown
    // code (a newer server) falls through to the session's own words (D14).
    // The node's own park reason (its words in the summary) is the computer's.
    const words = () =>
      clip(
        plainInline(shown(r.resultSummary ?? ""))
          .replace(/\s+/g, " ")
          .trim(),
        SUMMARY_MAX,
      )
    if (state === "needs_you" && isComputerWordsCode(r.reasonCode) && words()) {
      return i18n.t("kernel.nodeSessions.notice.computerSays", { text: words() })
    }
    const coded = state === "needs_you" ? reasonCodeText(r.reasonCode, i18n.t) : null
    if (coded) return coded
    if (state === "needs_you" && r.resultSummary) {
      return i18n.t("kernel.nodeSessions.notice.sessionSays", { text: words() })
    }
    if (state === "failed" && r.error) return shown(r.error)
    // W2-D9: an ended session waits for nothing; its last "Waiting: …" line
    // (a prompt the Stop expired) is stale and never shown.
    if (isEndedSessionStatus(state) && r.latestActivity?.startsWith("Waiting:")) return null
    return r.latestActivity ? shown(r.latestActivity) : r.latestActivity
  }

  const openSession = (request?: string | null) => {
    const r = row()
    openTab({
      type: "kernel:session",
      entityId: props.sessionId,
      label: r ? shown(r.title) : i18n.t("kernel.nodeSessions.view.title"),
      routePath: request
        ? `/sessions/${encodeURIComponent(props.sessionId)}?request=${encodeURIComponent(request)}`
        : `/sessions/${encodeURIComponent(props.sessionId)}`,
    })
  }

  const chip = "rounded bg-surface-hover px-1.5 py-0.5 text-[11.5px] text-text-secondary"

  return (
    <Show
      when={!denied()}
      fallback={
        <p data-testid="node-session-card-static" class="text-[13px] text-text-secondary">
          {props.ownerName
            ? i18n.t("kernel.nodeSessions.card.notYours", { owner: props.ownerName })
            : (props.fallbackText ?? "")}
        </p>
      }
    >
      <div
        data-testid="node-session-card"
        data-session-id={props.sessionId}
        data-status={state()}
        class="mt-1 flex max-w-xl flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5"
      >
        <Show
          when={row()}
          fallback={<p class="text-[13px] text-text-secondary">{props.fallbackText ?? ""}</p>}
        >
          {(r) => (
            <>
              <div class="flex items-baseline gap-2">
                <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text">
                  {shown(r().title)}
                </span>
                <span
                  data-testid="node-session-card-status"
                  class={`shrink-0 rounded px-1.5 py-0.5 text-[11.5px] font-medium ${STATUS_CLASS[state() as NodeSessionStatus] ?? ""}`}
                >
                  {i18n.t(`kernel.nodeSessions.status.${state()}`)}
                </span>
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <Show when={r().folderName}>
                  <span class={chip}>{r().folderName}</span>
                </Show>
                <span class={chip}>{r().model}</span>
                <Show when={props.nodeName}>
                  <span class={chip}>{props.nodeName}</span>
                </Show>
                <Show when={isRecordedNode(r().nodeId)}>
                  <RecordedSessionBadge testId="node-session-card-recorded" />
                </Show>
                <span
                  data-testid="node-session-card-elapsed"
                  class="ml-auto text-[11.5px] tabular-nums text-text-tertiary"
                >
                  {elapsed()}
                </span>
              </div>
              <Show when={state() === "done" && r().resultSummary}>
                {(summary) => (
                  <p
                    data-testid="node-session-card-result"
                    class="whitespace-pre-wrap text-[12.5px] text-text"
                  >
                    {clip(shown(summary()), SUMMARY_MAX)}
                  </p>
                )}
              </Show>
              <Show when={state() !== "done" && activity()}>
                {(line) => (
                  <p
                    data-testid="node-session-card-activity"
                    class="truncate text-[12.5px]"
                    classList={{
                      "text-warning": state() === "waiting" || state() === "needs_you",
                      "text-error": state() === "failed",
                      "text-text-secondary":
                        state() !== "waiting" && state() !== "needs_you" && state() !== "failed",
                    }}
                  >
                    {line()}
                  </p>
                )}
              </Show>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-md border border-border px-2.5 py-1 text-[12.5px] text-text-secondary hover:bg-surface-hover"
                  onClick={() => openSession()}
                >
                  {i18n.t("kernel.nodeSessions.card.openSession")}
                </button>
                <Show when={state() === "waiting"}>
                  <button
                    type="button"
                    data-request-id={oldestRequest() ?? undefined}
                    class="rounded-md bg-warning-glow px-2.5 py-1 text-[12.5px] font-medium text-warning hover:opacity-90"
                    onClick={() => openSession(oldestRequest())}
                  >
                    {i18n.t("kernel.nodeSessions.card.review")}
                  </button>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}
