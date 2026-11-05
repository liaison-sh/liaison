// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION TRANSCRIPT (P2-T08; S8, charter). Renders `buildTranscript`'s
// items in event order, read-only, with P3's actions plugged in through
// session-actions (P2-D1):
//
// - every top-level item is a `session-event` row carrying `data-seq`,
//   `data-at` (the event's own time, ms) and `data-received-at` (when this
//   client received it, ms): the walk reads S5's latency from the page (K22);
// - more than 2,000 items: the last 2,000 and a button that reveals the rest
//   (edge case "Event storm"); S56: the store holds a recent window only, and
//   when older events exist above it the button loads them (`loadEarlier`);
// - S56: the items come from one TranscriptModel, updated per event (an item
//   appended or replaced) rather than rebuilt from every event;
// - "Working · <latest activity>" with a spinner while the session runs on an
//   online node, nothing otherwise; a followed session (mirrored from a
//   transcript, which has no turn end) only while it is mid-turn
//   (`followMidTurn`: an assistant or tool line in its last turn, under a
//   minute old), re-checked as the clock moves;
// - `focusRequestId` (the chat card's Review, a push's `?request=`) scrolls to
//   that request card and highlights it.
// - S58 (batch-5 F6, F11): a released window whose read back failed or came
//   back short says so above its rows, with a Retry, never a silent hole.

import type { NodeSessionEvent } from "@liaison/shared"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  autoFollowed,
  countText,
  followMidTurn,
  followReadOnly,
  relativizePaths,
  sessionState,
} from "./display"
import { subagents } from "./header-info"
import type { NodeSessionRow } from "./session-api"
import { loadEarlier, retryReadBack, sessionStore } from "./session-store"
import { type ItemContext, Spinner, TranscriptItemView } from "./TranscriptItem"
import { latestActivity, sessionPathContext, TranscriptModel } from "./transcript"

export const TRANSCRIPT_WINDOW = 2000
/** How often a followed session's mid-turn spinner is re-checked. */
const FOLLOW_TICK_MS = 5_000

type HeldEvent = NodeSessionEvent & { clientReceivedAt?: number }

export interface SessionTranscriptProps {
  session: NodeSessionRow
  events: readonly HeldEvent[]
  /** The session's working directory, when known (else read from its start event). */
  cwd?: string | null
  focusRequestId?: string
  /** Changes on every focus: the card scrolls again even when the id is the same. */
  focusKey?: number
  /** False while the session's node is offline: no spinner (P2-D3). Default true. */
  nodeOnline?: boolean
  /** The originating agent's name, for the first prompt's label. */
  agentName?: string
  /** The focused request card is scrolled into place. */
  onFocusShown?: () => void
  /** The owner answered a request card. */
  onAnswer?: () => void
  /** S54: a subagent reference opens that subagent's drawer. */
  onOpenSubagent?: (toolUseId: string) => void
}

export default function SessionTranscript(props: SessionTranscriptProps) {
  const t = useI18n().t
  const [showAll, setShowAll] = createSignal(false)

  const pathContext = createMemo(() => sessionPathContext(props.session, props.events, props.cwd))
  const model = new TranscriptModel()
  // The model's array moves in place: every sync is a change.
  const items = createMemo(
    () =>
      model.sync(props.events, {
        sessionStatus: sessionState(props.session),
        pathContext: pathContext(),
      }),
    undefined,
    { equals: false },
  )
  const hidden = () => (showAll() ? 0 : Math.max(0, items().length - TRANSCRIPT_WINDOW))
  const visible = createMemo(() => items().slice(hidden()))
  // S56: each row is keyed by its item's seq, never its position: trimming the
  // window or replacing an item keeps an expanded row's state on that row.
  const bySeq = createMemo(() => new Map(visible().map((it) => [it.seq, it])))
  const seqs = createMemo(() => visible().map((it) => it.seq))
  const firstUserSeq = () => {
    items()
    return model.firstUserSeq
  }
  const earlier = () => hidden() === 0 && sessionStore.hasEarlier(props.session.id)
  const [loadingEarlier, setLoadingEarlier] = createSignal(false)
  const onLoadEarlier = () => {
    setLoadingEarlier(true)
    void loadEarlier(props.session.id).finally(() => setLoadingEarlier(false))
  }

  // A follow's "running" holds between turns: it is live only mid-turn, and
  // the clock ticks so the spinner leaves once its last line grows old.
  const follow = () => followReadOnly(props.session) || autoFollowed(props.session)
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!follow()) return
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), FOLLOW_TICK_MS)
    onCleanup(() => clearInterval(tick))
  })
  const turnLive = () => !follow() || followMidTurn(props.events, now())
  const live = () =>
    props.nodeOnline !== false &&
    (sessionState(props.session) === "running" || sessionState(props.session) === "waiting") &&
    turnLive()
  // A subagent line's dot reads the Subagents panel's derivation; the clock
  // ticks only while one is active (stuck is time alone), like the panel's.
  const [subNow, setSubNow] = createSignal(Date.now())
  const subs = createMemo(() => subagents(props.events, subNow()))
  createEffect(() => {
    if (subs().running + subs().stuck === 0) return
    const tick = setInterval(() => setSubNow(Date.now()), 1000)
    onCleanup(() => clearInterval(tick))
  })
  const subagentState = (toolUseId: string) =>
    subs().list.find((s) => s.toolUseId === toolUseId)?.state
  const ctx = (): ItemContext => ({
    session: props.session,
    pathContext: pathContext(),
    live: live(),
    agentName: props.agentName,
    focusRequestId: props.focusRequestId,
    focusKey: props.focusKey,
    onFocusShown: props.onFocusShown,
    onAnswer: props.onAnswer,
    onOpenSubagent: props.onOpenSubagent,
    subagentState,
  })
  const working = () =>
    sessionState(props.session) === "running" && props.nodeOnline !== false && turnLive()
      ? relativizePaths(
          latestActivity(items()) ?? props.session.latestActivity ?? "",
          pathContext(),
        )
      : null

  return (
    <div data-testid="session-transcript" class="flex flex-col gap-2.5">
      <Show when={hidden() > 0}>
        <button
          type="button"
          class="self-center rounded-md border border-border px-2.5 py-1 text-[12.5px] text-text-secondary hover:bg-surface-hover"
          onClick={() => setShowAll(true)}
        >
          {countText(t, "kernel.nodeSessions.transcript.earlier", hidden())}
        </button>
      </Show>
      <Show when={earlier()}>
        <button
          type="button"
          data-testid="load-earlier"
          disabled={loadingEarlier()}
          class="self-center rounded-md border border-border px-2.5 py-1 text-[12.5px] text-text-secondary hover:bg-surface-hover disabled:opacity-60"
          onClick={onLoadEarlier}
        >
          {t("kernel.nodeSessions.transcript.loadEarlier")}
        </button>
      </Show>
      <Show when={sessionStore.readBackFailed(props.session.id)}>
        <ReadBackFailed onRetry={() => retryReadBack(props.session.id)} />
      </Show>
      <For each={seqs()}>
        {(key) => (
          // A row whose item just left the window renders nothing until For drops it.
          <Show when={bySeq().get(key)}>
            {(item) => (
              <div
                data-testid="session-event"
                data-kind={item().kind}
                data-seq={item().seq}
                data-at={Date.parse(item().at)}
                data-received-at={item().clientReceivedAt ?? ""}
              >
                <TranscriptItemView
                  item={item()}
                  ctx={ctx()}
                  first={item().seq === firstUserSeq()}
                />
              </div>
            )}
          </Show>
        )}
      </For>
      <Show when={working() !== null}>
        <p
          data-testid="working-line"
          class="flex items-center gap-2 text-[12.5px] text-text-secondary"
        >
          <Spinner />
          {working()
            ? t("kernel.nodeSessions.transcript.working", { activity: working() ?? "" })
            : t("kernel.nodeSessions.status.running")}
        </p>
      </Show>
    </div>
  )
}

/**
 * S58 (batch-5 F6, F11): part of a released window could not be read back
 * (offline, a server error): the rows held still show, this line says the
 * rest is missing, and Retry reads it again.
 */
export function ReadBackFailed(props: { onRetry: () => Promise<void> }) {
  const t = useI18n().t
  const [retrying, setRetrying] = createSignal(false)
  const retry = () => {
    setRetrying(true)
    void props.onRetry().finally(() => setRetrying(false))
  }
  return (
    <p
      data-testid="read-back-failed"
      role="status"
      class="self-center text-[12.5px] text-text-secondary"
    >
      {t("kernel.nodeSessions.transcript.readBackFailed")} ·{" "}
      <button
        type="button"
        data-testid="read-back-retry"
        disabled={retrying()}
        class="underline underline-offset-2 hover:text-text disabled:opacity-60"
        onClick={retry}
      >
        {t("kernel.nodeSessions.transcript.readBackRetry")}
      </button>
    </p>
  )
}
