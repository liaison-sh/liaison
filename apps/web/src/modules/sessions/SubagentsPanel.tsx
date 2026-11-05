// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SUBAGENTS PANEL (S53, S54; owner D20, D21, approved prototype). A
// session's subagents, each one row read from the main thread's task events
// (header-info.ts `subagents`): status dot, title, type · model, elapsed, tool
// count, last action and its age, badges Resumed / No activity / Failed;
// grouped Active then Finished, stuck rows first.
//
// - Web and desktop: a right rail beside the transcript, collapsible to a
//   slim strip that keeps the counts. The choice is remembered on this device
//   (localStorage, best effort: a blocked storage only forgets it).
// - Phone: a bottom sheet, opened from the header's subagent chip.
// - A row (or an inline "Agent: … Open ›" reference in the transcript) opens
//   the drawer: the subagent's own events, fetched only then with
//   `parent=<toolUseId>`, streamed while it stays open and released when it
//   closes (session-store `openSubagent` / `closeSubagent`). Nothing of a
//   subagent's own is held otherwise (D20: ten live subagents once took the
//   Mac's memory).
// - Stop subagent: the SDK's `stopTask` stops one task (command `stop_task`),
//   offered while the subagent runs in a live session.

import type { NodeSessionEvent } from "@liaison/shared"
import { Bot, ChevronLeft, ChevronRight, X } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { countText, formatDuration, isEnded, sessionState } from "./display"
import { SUBAGENT_DOT, type SubagentInfo, type SubagentState, subagents } from "./header-info"
import { ReadBackFailed } from "./SessionTranscript"
import type { NodeSessionRow } from "./session-api"
import { sendCommand } from "./session-commands"
import { foldOf } from "./session-fold"
import {
  closeSubagent,
  loadEarlierSubagent,
  openSubagent,
  retryReadBack,
  sessionStore,
} from "./session-store"
import { TranscriptItemView } from "./TranscriptItem"
import { sessionPathContext, TranscriptModel } from "./transcript"

/** Where this device remembers a collapsed rail. */
export const RAIL_COLLAPSED_KEY = "liaison.sessions.subagentsRail.collapsed"

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(RAIL_COLLAPSED_KEY, "1")
    else localStorage.removeItem(RAIL_COLLAPSED_KEY)
  } catch {
    // Storage blocked: the rail just forgets.
  }
}

const DOT = SUBAGENT_DOT

const isActive = (s: SubagentInfo) => s.state === "running" || s.state === "stuck"

export interface SubagentsPanelProps {
  session: NodeSessionRow
  /** The main thread's events (the store holds nothing else, S53). */
  events: readonly NodeSessionEvent[]
  /** Phone: a bottom sheet instead of the rail. */
  sheet: boolean
  sheetOpen: boolean
  onCloseSheet: () => void
  /** The subagent whose drawer is open (its Agent call's tool use id). */
  openToolUseId: string | null
  onOpen: (toolUseId: string) => void
  onCloseDrawer: () => void
  /** Bumped by the header chip: the rail shows itself again. */
  revealKey?: number
}

export default function SubagentsPanel(props: SubagentsPanelProps) {
  const t = useI18n().t
  const [now, setNow] = createSignal(Date.now())
  const summary = createMemo(() => subagents(props.events, now()))
  // The clock ticks only while a subagent is active (elapsed, ages, stuck):
  // a finished list is not re-derived every second (D30).
  const timer = setInterval(() => {
    if (summary().running + summary().stuck > 0) setNow(Date.now())
  }, 1000)
  onCleanup(() => clearInterval(timer))
  const [collapsed, setCollapsed] = createSignal(readCollapsed())
  const collapse = (value: boolean) => {
    setCollapsed(value)
    writeCollapsed(value)
  }
  // The header chip asks for the panel: a collapsed rail opens again.
  createEffect(
    on(
      () => props.revealKey,
      () => {
        if (collapsed()) collapse(false)
      },
      { defer: true },
    ),
  )

  const live = () => !isEnded(sessionState(props.session))
  const countsLabel = () =>
    t("kernel.nodeSessions.header.subagents", {
      running: summary().running,
      stuck: summary().stuck,
      done: summary().done,
    })
  const info = (toolUseId: string) => summary().list.find((s) => s.toolUseId === toolUseId)

  const list = () => (
    <SubagentList
      list={summary().list}
      now={now()}
      current={props.openToolUseId}
      onOpen={(id) => props.onOpen(id)}
    />
  )

  return (
    <>
      <Show when={summary().list.length > 0}>
        <Show
          when={props.sheet}
          fallback={
            <Show
              when={!collapsed()}
              fallback={
                <aside
                  data-testid="subagents-strip"
                  aria-label={countsLabel()}
                  class="flex w-11 shrink-0 flex-col items-center gap-2 border-l border-border bg-surface py-2"
                >
                  <button
                    type="button"
                    aria-label={t("kernel.nodeSessions.subagents.expand")}
                    title={t("kernel.nodeSessions.subagents.expand")}
                    class="rounded-md p-1 text-text-tertiary hover:bg-surface-hover"
                    onClick={() => collapse(false)}
                  >
                    <ChevronLeft class="h-4 w-4" />
                  </button>
                  <Bot class="h-4 w-4 text-text-tertiary" />
                  <StripCount kind="running" n={summary().running} dot={DOT.running} />
                  <StripCount kind="stuck" n={summary().stuck} dot={DOT.stuck} />
                  <StripCount kind="done" n={summary().done} dot={DOT.done} />
                </aside>
              }
            >
              <aside
                data-testid="subagents-rail"
                aria-label={t("kernel.nodeSessions.subagents.title")}
                class="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface"
              >
                <PanelHead
                  title={t("kernel.nodeSessions.subagents.title")}
                  action={
                    <button
                      type="button"
                      aria-label={t("kernel.nodeSessions.subagents.collapse")}
                      title={t("kernel.nodeSessions.subagents.collapse")}
                      class="rounded-md p-1 text-text-tertiary hover:bg-surface-hover"
                      onClick={() => collapse(true)}
                    >
                      <ChevronRight class="h-4 w-4" />
                    </button>
                  }
                />
                {list()}
              </aside>
            </Show>
          }
        >
          <Show when={props.sheetOpen}>
            <aside
              data-testid="subagents-sheet"
              aria-label={t("kernel.nodeSessions.subagents.title")}
              class="fixed inset-x-0 bottom-0 z-30 flex max-h-[70%] flex-col rounded-t-2xl border-t border-border bg-surface shadow-popover"
            >
              <PanelHead
                title={t("kernel.nodeSessions.subagents.title")}
                action={
                  <button
                    type="button"
                    class="min-h-11 rounded-md px-3 text-[13px] text-text-secondary hover:bg-surface-hover"
                    onClick={() => props.onCloseSheet()}
                  >
                    {t("kernel.close")}
                  </button>
                }
              />
              {list()}
            </aside>
          </Show>
        </Show>
      </Show>
      <Show when={props.openToolUseId} keyed>
        {(toolUseId) => (
          <SubagentDrawer
            session={props.session}
            events={props.events}
            toolUseId={toolUseId}
            info={info(toolUseId)}
            now={now()}
            live={live()}
            onClose={() => props.onCloseDrawer()}
          />
        )}
      </Show>
    </>
  )
}

function PanelHead(props: { title: string; action: JSX.Element }) {
  return (
    <div class="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
      <h2 class="font-semibold text-[12px] text-text-secondary uppercase tracking-wide">
        {props.title}
      </h2>
      {props.action}
    </div>
  )
}

function StripCount(props: { kind: "running" | "stuck" | "done"; n: number; dot: string }) {
  return (
    <span class="flex flex-col items-center gap-0.5 text-[11px] text-text-secondary">
      <span class={cn("h-2 w-2 rounded-full", props.dot)} />
      <span data-count={props.kind} class="tabular-nums">
        {props.n}
      </span>
    </span>
  )
}

function SubagentList(props: {
  list: SubagentInfo[]
  now: number
  current: string | null
  onOpen: (toolUseId: string) => void
}) {
  const t = useI18n().t
  const active = () => props.list.filter(isActive)
  const finished = () => props.list.filter((s) => !isActive(s))
  const group = (label: string, items: SubagentInfo[]) => (
    <Show when={items.length > 0}>
      <p class="px-3.5 pt-2.5 pb-1 text-[11px] text-text-tertiary uppercase tracking-wide">
        {label}
      </p>
      <Index each={items}>
        {(s) => (
          <SubagentRow
            info={s()}
            now={props.now}
            current={!!s().toolUseId && s().toolUseId === props.current}
            onOpen={props.onOpen}
          />
        )}
      </Index>
    </Show>
  )
  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      {group(t("kernel.nodeSessions.subagents.active", { count: active().length }), active())}
      {group(t("kernel.nodeSessions.subagents.finished", { count: finished().length }), finished())}
    </div>
  )
}

/** Its type and model, as one line ("general-purpose · sonnet"). */
function typeLine(info: SubagentInfo, fallback: string): string {
  return [info.subagentType || fallback, info.model].filter(Boolean).join(" · ")
}

function SubagentRow(props: {
  info: SubagentInfo
  now: number
  current: boolean
  onOpen: (toolUseId: string) => void
}) {
  const t = useI18n().t
  const elapsed = () => formatDuration((props.info.endedAt ?? props.now) - props.info.startedAt)
  const age = () => formatDuration(props.now - props.info.lastEventAt)
  return (
    <button
      type="button"
      data-testid="subagent-row"
      data-state={props.info.state}
      aria-current={props.current}
      disabled={!props.info.toolUseId}
      class={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 border-b border-l-[3px] border-b-border border-l-transparent px-3.5 py-2.5 text-left hover:bg-surface-hover",
        props.info.state === "stuck" && "border-l-warning",
        props.current && "border-l-accent bg-accent/10",
      )}
      onClick={() => props.info.toolUseId && props.onOpen(props.info.toolUseId)}
    >
      <span class={cn("mt-1.5 h-2 w-2 rounded-full", DOT[props.info.state])} />
      <span class="truncate font-medium text-[13px] text-text">
        {props.info.description || t("kernel.nodeSessions.transcript.subagent")}
      </span>
      <span class="text-[12px] text-text-secondary tabular-nums">{elapsed()}</span>
      <span class="col-span-2 col-start-2 flex flex-wrap gap-2 text-[12px] text-text-secondary">
        <span>{typeLine(props.info, t("kernel.nodeSessions.transcript.subagent"))}</span>
        <Show when={props.info.toolUses !== null}>
          <span>
            {countText(t, "kernel.nodeSessions.subagents.toolCalls", props.info.toolUses ?? 0)}
          </span>
        </Show>
        <Badges info={props.info} now={props.now} />
      </span>
      <Show when={props.info.lastToolName}>
        <span class="col-span-2 col-start-2 truncate font-mono text-[12px] text-text-tertiary">
          {props.info.lastToolName} · {t("kernel.nodeSessions.subagents.ago", { time: age() })}
        </span>
      </Show>
    </button>
  )
}

function Badges(props: { info: SubagentInfo; now: number }) {
  const t = useI18n().t
  const badge = "rounded px-1.5 text-[11px] font-semibold"
  return (
    <>
      <Show when={props.info.resumed}>
        <span class={cn(badge, "bg-accent/10 text-accent")}>
          {t("kernel.nodeSessions.subagents.resumed")}
        </span>
      </Show>
      <Show when={props.info.state === "stuck"}>
        <span class={cn(badge, "bg-warning/10 text-warning")}>
          {props.info.lastToolName
            ? t("kernel.nodeSessions.subagents.noActivityLast", {
                time: formatDuration(props.now - props.info.lastEventAt),
                tool: props.info.lastToolName,
              })
            : t("kernel.nodeSessions.subagents.noActivity", {
                time: formatDuration(props.now - props.info.lastEventAt),
              })}
        </span>
      </Show>
      <Show when={props.info.state === "failed"}>
        <span class={cn(badge, "bg-error/10 text-error")}>
          {t("kernel.nodeSessions.subagents.failed")}
        </span>
      </Show>
    </>
  )
}

/** The Agent call that started a subagent: its description and type when no task event names them. */
/** The Agent call that started a subagent (folded, S56: it may be above the held window). */
function agentCall(events: readonly NodeSessionEvent[], toolUseId: string) {
  const call = foldOf(events).agentCalls.get(toolUseId)
  return call ? { description: call.description, type: call.type } : null
}

function SubagentDrawer(props: {
  session: NodeSessionRow
  events: readonly NodeSessionEvent[]
  toolUseId: string
  info: SubagentInfo | undefined
  now: number
  live: boolean
  onClose: () => void
}) {
  const t = useI18n().t
  const [loaded, setLoaded] = createSignal(false)
  const [stopError, setStopError] = createSignal<string | null>(null)
  const [stopping, setStopping] = createSignal(false)
  const sessionId = props.session.id
  const toolUseId = props.toolUseId
  onMount(() => {
    void openSubagent(sessionId, toolUseId).finally(() => setLoaded(true))
  })
  onCleanup(() => closeSubagent(sessionId, toolUseId))
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose()
  }
  onMount(() => document.addEventListener("keydown", onKey))
  onCleanup(() => document.removeEventListener("keydown", onKey))

  const own = () => sessionStore.subagentEvents(sessionId, toolUseId)
  // batch-4 F6: a long subagent's earliest events, trimmed from the window.
  const earlier = () => sessionStore.subagentHasEarlier(sessionId, toolUseId)
  const [loadingEarlier, setLoadingEarlier] = createSignal(false)
  const onLoadEarlier = () => {
    setLoadingEarlier(true)
    void loadEarlierSubagent(sessionId, toolUseId).finally(() => setLoadingEarlier(false))
  }
  const pathContext = createMemo(() => sessionPathContext(props.session, props.events))
  // S56: the drawer's window moves in place: an incremental model, never a
  // rebuild per batch (every sync is a change).
  const model = new TranscriptModel()
  const items = createMemo(
    () =>
      model.sync(own(), {
        sessionStatus: props.info && isActive(props.info) ? "running" : "done",
        pathContext: pathContext(),
      }),
    undefined,
    { equals: false },
  )
  const bySeq = createMemo(() => new Map(items().map((it) => [it.seq, it])))
  const seqs = createMemo(() => items().map((it) => it.seq))
  const call = createMemo(() => agentCall(props.events, toolUseId))
  const title = () =>
    props.info?.description || call()?.description || t("kernel.nodeSessions.transcript.subagent")
  const state = (): SubagentState => props.info?.state ?? "done"
  const canStop = () => props.live && !!props.info && isActive(props.info)

  async function stop(): Promise<void> {
    const taskId = props.info?.taskId
    if (!taskId) return
    setStopError(null)
    setStopping(true)
    try {
      await sendCommand(sessionId, { type: "stop_task", payload: { taskId } })
    } catch (err) {
      setStopError(
        err instanceof ApiError && err.code === "node_outdated"
          ? t("kernel.nodeSessions.subagents.stopOutdated")
          : t("kernel.nodeSessions.subagents.stopFailed"),
      )
    } finally {
      setStopping(false)
    }
  }

  return (
    <section
      data-testid="subagent-drawer"
      aria-label={title()}
      class="fixed inset-0 z-40 flex flex-col bg-surface md:absolute md:inset-y-0 md:right-0 md:left-auto md:w-[min(560px,100%)] md:border-l md:border-border md:shadow-popover"
    >
      <header class="flex flex-col gap-1.5 border-b border-border px-4 py-3">
        <div class="flex items-center gap-2">
          <span class={cn("h-2 w-2 shrink-0 rounded-full", DOT[state()])} />
          <h3 class="min-w-0 flex-1 truncate font-semibold text-[14px] text-text">{title()}</h3>
          <button
            type="button"
            class="inline-flex min-h-8 items-center gap-1 rounded-md border border-border px-2.5 text-[12px] text-text hover:border-accent"
            onClick={() => props.onClose()}
          >
            <X class="h-3.5 w-3.5" aria-hidden="true" />
            {t("kernel.close")}
          </button>
        </div>
        <Show when={props.info}>
          {(info) => (
            <div class="flex flex-wrap gap-1.5 text-[12px] text-text-secondary">
              <span class="rounded-full border border-border px-2">
                {typeLine(info(), call()?.type || t("kernel.nodeSessions.transcript.subagent"))}
              </span>
              <span class="rounded-full border border-border px-2 tabular-nums">
                {formatDuration((info().endedAt ?? props.now) - info().startedAt)}
              </span>
              <Show when={info().toolUses !== null}>
                <span class="rounded-full border border-border px-2">
                  {countText(t, "kernel.nodeSessions.subagents.toolCalls", info().toolUses ?? 0)}
                </span>
              </Show>
              <Badges info={info()} now={props.now} />
            </div>
          )}
        </Show>
      </header>
      <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        <Show when={state() === "stuck"}>
          <p class="rounded-lg bg-warning/10 px-3 py-2 text-[13px] text-warning">
            {t("kernel.nodeSessions.subagents.stuckWhy", {
              time: formatDuration(props.now - (props.info?.lastEventAt ?? props.now)),
            })}
          </p>
        </Show>
        {/* S58 (batch-5 F6, F11): this drawer's read back failed or came back short. */}
        <Show when={sessionStore.subagentReadBackFailed(sessionId, toolUseId)}>
          <ReadBackFailed onRetry={() => retryReadBack(sessionId)} />
        </Show>
        <Show
          when={items().length > 0}
          fallback={
            <p class="font-mono text-[12px] text-text-tertiary">
              {loaded()
                ? t("kernel.nodeSessions.subagents.empty")
                : t("kernel.nodeSessions.subagents.loading")}
            </p>
          }
        >
          <Show when={earlier()}>
            <button
              type="button"
              data-testid="subagent-load-earlier"
              disabled={loadingEarlier()}
              class="self-center rounded-md border border-border px-2.5 py-1 text-[12.5px] text-text-secondary hover:bg-surface-hover disabled:opacity-60"
              onClick={onLoadEarlier}
            >
              {t("kernel.nodeSessions.transcript.loadEarlier")}
            </button>
          </Show>
          {/* S56: rows keyed by their item's seq, so an expanded row stays so
          when its item is replaced (a result arrives) or the window trims. */}
          <For each={seqs()}>
            {(key) => (
              <Show when={bySeq().get(key)}>
                {(item) => (
                  <TranscriptItemView
                    item={item()}
                    ctx={{
                      session: props.session,
                      pathContext: pathContext(),
                      live: props.live,
                      parentToolUseId: toolUseId,
                    }}
                  />
                )}
              </Show>
            )}
          </For>
        </Show>
      </div>
      <Show when={canStop()}>
        <footer class="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <Show when={stopError()}>
            <p class="min-w-0 flex-1 text-[12px] text-error">{stopError()}</p>
          </Show>
          <button
            type="button"
            disabled={stopping()}
            class="ml-auto rounded-md border border-border px-2.5 py-1 text-[12px] text-error hover:border-error disabled:opacity-50"
            onClick={() => void stop()}
          >
            {t("kernel.nodeSessions.subagents.stop")}
          </button>
        </footer>
      </Show>
    </section>
  )
}
