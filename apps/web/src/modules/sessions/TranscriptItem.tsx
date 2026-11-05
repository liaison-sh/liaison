// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE TRANSCRIPT ITEM (P2-T08; spec-charter.md, Sessions app, transcript). The
// rendering of each item kind `buildTranscript` produces:
//
// - user: a right-aligned bubble, "You · time" (the first prompt names its
//   origin); assistant text as prose; thinking collapsed; system and state
//   lines dim;
// - tool rows: icon, name, one-line argument, meta; collapsed except Edit,
//   MultiEdit and Write (open on their diff); a spinner only while the session
//   runs; "No result" once it ended;
// - subagents: one line, "Agent: … Open ›", opening the subagent's drawer
//   (S53, S54: its own events never render here);
// - permission, question and plan cards inline in the warning colour. Their
//   buttons render only when P3 registered the action (P2-D1, session-actions);
//   without, the card says it waits for an answer;
// - the result card in the success colour (error colour when it failed).
//
// Read-only. Never a JSON rendering, never an absolute local path (paths go
// through displayPath / relativizePaths), every time tooltip names its zone.

import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  GitBranch,
  GitPullRequest,
  Globe,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  Search,
  ShieldAlert,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { cn } from "~/lib/cn"
import { diffStats } from "~/lib/line-diff"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { MarkdownContent } from "~/modules/shell/markdown-content"
import {
  countText,
  elapsedMs,
  formatDuration,
  formatTimeWithZone,
  isEnded,
  type PathContext,
  relativizePaths,
  sessionState,
  statusReasonText,
  systemText,
} from "./display"
import { callHunks } from "./files-changed"
import { SUBAGENT_DOT, type SubagentState } from "./header-info"
import { createStubRow, type StubRow } from "./in-view"
import { isPhone, phoneTap } from "./phone"
import { sessionActions } from "./session-actions"
import type { NodeSessionRow } from "./session-api"
import { isRequestPending } from "./session-commands"
import { fetchEventInput, fetchEventOutput, fetchEventText } from "./session-store"
import {
  type DimItem,
  type ElidedText,
  type RequestItem,
  type ResultItem,
  type SubagentItem,
  type TextItem,
  type ThinkingItem,
  type ToolItem,
  type TranscriptItem,
  toolMeta,
  type UserItem,
} from "./transcript"

export interface ItemContext {
  session: NodeSessionRow
  pathContext: PathContext
  /** The session runs on an online node: spinners may show. */
  live: boolean
  /** The originating agent's name, for the first prompt's label. */
  agentName?: string
  focusRequestId?: string
  /** Changes on every focus (SessionView): the same card scrolls again. */
  focusKey?: number
  /** The focused card is scrolled into place (SessionView re-checks its follow). */
  onFocusShown?: () => void
  /** The owner answered a request card (SessionView follows the session again). */
  onAnswer?: () => void
  /** S54: a subagent reference opens that subagent's drawer (its Agent call's id). */
  onOpenSubagent?: (toolUseId: string) => void
  /** S56: in a subagent's drawer, that subagent's Agent call id (an elided event is read with it). */
  parentToolUseId?: string
  /**
   * A subagent's state as the Subagents panel derives it (its task events), by
   * its Agent call id; undefined when no task event names it.
   */
  subagentState?: (toolUseId: string) => SubagentState | undefined
}

const OPEN_TOOLS = new Set(["Edit", "MultiEdit", "Write"])
const DECISIONS = new Set(["allow", "allow_session", "deny", "answered", "expired"])
const LEVELS = new Set(["strict", "standard", "open"])

function ToolIcon(props: { name: string; class?: string }) {
  const cls = () => props.class ?? "h-3.5 w-3.5 shrink-0 text-text-tertiary"
  return (
    <Switch fallback={<Wrench class={cls()} />}>
      <Match when={props.name === "Bash"}>
        <Terminal class={cls()} />
      </Match>
      <Match when={props.name === "Read"}>
        <FileText class={cls()} />
      </Match>
      <Match when={OPEN_TOOLS.has(props.name) || props.name === "NotebookEdit"}>
        <FilePen class={cls()} />
      </Match>
      <Match when={props.name === "Grep" || props.name === "Glob"}>
        <Search class={cls()} />
      </Match>
      <Match when={props.name === "WebFetch" || props.name === "WebSearch"}>
        <Globe class={cls()} />
      </Match>
      <Match when={props.name === "Task" || props.name === "Agent"}>
        <Bot class={cls()} />
      </Match>
      <Match when={props.name === "TodoWrite"}>
        <ListChecks class={cls()} />
      </Match>
      <Match when={props.name === "Skill"}>
        <Sparkles class={cls()} />
      </Match>
    </Switch>
  )
}

export function Spinner(props: { class?: string }) {
  return (
    <span data-spinner="true" class="inline-flex shrink-0">
      <LoaderCircle class={props.class ?? "h-3.5 w-3.5 animate-spin text-accent"} />
    </span>
  )
}

/** A short time with its zone in the tooltip (charter). */
export function TimeLabel(props: { at: string }) {
  const i18n = useI18n()
  const ms = () => Date.parse(props.at)
  return (
    <time
      datetime={props.at}
      title={formatTimeWithZone(props.at, i18n.locale())}
      class="tabular-nums"
    >
      {Number.isFinite(ms()) ? i18n.fmtDate(ms(), { hour: "2-digit", minute: "2-digit" }) : ""}
    </time>
  )
}

function Prose(props: { text: string; ctx: ItemContext; class?: string }) {
  const api = useOptionalApi()
  const text = () => relativizePaths(props.text, props.ctx.pathContext)
  return (
    <Show
      when={api}
      fallback={<p class={`whitespace-pre-wrap break-words ${props.class ?? ""}`}>{text()}</p>}
    >
      {(a) => <MarkdownContent api={a()} content={text()} class={props.class} />}
    </Show>
  )
}

function DiffView(props: { name: string; input: unknown; ctx: PathContext }) {
  const hunks = () => callHunks(props.name, props.input, props.ctx)
  return (
    <div class="overflow-x-auto font-mono text-[12px] leading-[1.5]">
      <For each={hunks()}>
        {(hunk) => (
          <div class="border-b border-border-subtle py-1 last:border-b-0">
            <For each={hunk}>
              {(line) => (
                <div
                  class="whitespace-pre px-2"
                  classList={{
                    "bg-success-glow text-success": line.type === "add",
                    "bg-error-glow text-error": line.type === "del",
                    "text-text-secondary": line.type === "same",
                  }}
                >
                  {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                  {line.text}
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  )
}

function ToolRow(props: { item: ToolItem | SubagentItem; ctx: ItemContext }) {
  const i18n = useI18n()
  const t = i18n.t
  const [open, setOpen] = createSignal(OPEN_TOOLS.has(props.item.name) && !props.item.inputElided)
  // S56: a row open by default (an edit) closes once its input is elided, so
  // old rows never read their inputs back; one the owner opened stays open.
  let ownerToggled = false
  createEffect(() => {
    if (props.item.inputElided && !ownerToggled) setOpen(false)
  })
  const [full, setFull] = createSignal<string | null | undefined>(undefined)
  // S58: an elided content is read back only while the row is on screen;
  // F4: turning whole or back into a stub never moves what the reader sees.
  const view = createStubRow()
  const inView = view.inView
  const spinning = () => props.item.running && props.ctx.live
  const ended = () => isEnded(sessionState(props.ctx.session))
  const isEdit = () => OPEN_TOOLS.has(props.item.name)
  // S56: an input the store elided is read again while the row is open, and let go on close.
  // S58: and only while the row is on screen; let go when it scrolls away.
  const [restoredInput, setRestoredInput] = createSignal<unknown>(undefined)
  createEffect(() => {
    const elided = props.item.inputElided
    if (!open()) view.unreserve()
    if (!open() || !elided || !inView()) {
      if (untrack(restoredInput) !== undefined) view.swap(false, () => setRestoredInput(undefined))
      return
    }
    const seq = elided.seq
    void fetchEventInput(props.ctx.session.id, seq, props.ctx.parentToolUseId).then((input) => {
      if (open() && inView() && props.item.inputElided?.seq === seq && input !== null)
        view.swap(true, () => setRestoredInput(input))
    })
  })
  const input = () => restoredInput() ?? props.item.input
  const meta = () => {
    const parts: string[] = []
    // An elided input's stats wait for the input (its row is closed).
    if (isEdit() && (!props.item.inputElided || restoredInput() !== undefined)) {
      let added = 0
      let removed = 0
      for (const h of callHunks(props.item.name, input(), props.ctx.pathContext)) {
        const s = diffStats(h)
        added += s.added
        removed += s.removed
      }
      parts.push(removed > 0 ? `+${added} −${removed}` : `+${added}`)
    }
    const m = toolMeta(props.item)
    if (m.durationMs !== undefined) {
      parts.push(
        m.durationMs < 60_000
          ? t("kernel.nodeSessions.transcript.seconds", {
              value: i18n.fmtNumber(m.durationMs / 1000, { maximumFractionDigits: 1 }),
            })
          : formatDuration(m.durationMs),
      )
    }
    if (m.matches !== undefined)
      parts.push(countText(t, "kernel.nodeSessions.transcript.matches", m.matches))
    if (m.lines !== undefined && !isEdit())
      parts.push(countText(t, "kernel.nodeSessions.transcript.lines", m.lines))
    if (!props.item.result && ended()) parts.push(t("kernel.nodeSessions.transcript.noResult"))
    return parts.join(" · ")
  }
  // S56: an output the store elided is read again while the row is open, and let go on close.
  // S58: and only while the row is on screen; let go when it scrolls away.
  const [restored, setRestored] = createSignal<string | null | undefined>(undefined)
  createEffect(() => {
    const elided = props.item.result?.elided
    if (!open() || !elided || !inView()) {
      if (untrack(restored) !== undefined) view.swap(false, () => setRestored(undefined))
      return
    }
    const seq = elided.seq
    void fetchEventOutput(props.ctx.session.id, seq, props.ctx.parentToolUseId).then((text) => {
      if (open() && inView() && props.item.result?.elided?.seq === seq)
        view.swap(true, () => setRestored(text))
    })
  })
  const output = () =>
    relativizePaths(full() ?? restored() ?? props.item.result?.output ?? "", props.ctx.pathContext)
  const loadFull = async () => {
    const fn = sessionActions().fullOutput
    if (!fn) return
    setFull(await fn(props.ctx.session.id, props.item.id))
  }
  return (
    <div
      ref={view.ref}
      data-testid="tool-row"
      data-tool={props.item.name}
      data-open={String(open())}
      class="rounded-md border border-border bg-surface"
    >
      <button
        type="button"
        aria-expanded={open()}
        class="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-surface-hover"
        onClick={() => {
          ownerToggled = true
          setOpen(!open())
        }}
      >
        <ChevronRight
          class="h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform"
          classList={{ "rotate-90": open() }}
        />
        <Switch fallback={<ToolIcon name={props.item.name} />}>
          <Match when={spinning()}>
            <Spinner />
          </Match>
          <Match when={props.item.result?.isError}>
            <CircleAlert class="h-3.5 w-3.5 shrink-0 text-error" />
          </Match>
        </Switch>
        <span class="shrink-0 font-medium text-text">
          {props.item.name || t("kernel.nodeSessions.transcript.tool")}
        </span>
        <span class="min-w-0 flex-1 truncate text-text-secondary">{props.item.argument}</span>
        <span class="shrink-0 tabular-nums text-text-tertiary">{meta()}</span>
      </button>
      <Show when={open()}>
        <div class="border-t border-border-subtle px-2.5 py-2 text-[12.5px]">
          <Show when={isEdit()}>
            <DiffView name={props.item.name} input={input()} ctx={props.ctx.pathContext} />
          </Show>
          <Show when={props.item.result && (!isEdit() || props.item.result?.isError)}>
            <pre
              class="max-h-80 overflow-auto whitespace-pre-wrap break-words"
              classList={{
                "font-mono text-[12px]": props.item.name === "Bash",
                "text-error": props.item.result?.isError === true,
                "text-text-secondary": props.item.result?.isError !== true,
              }}
            >
              {output()}
            </pre>
          </Show>
          <Show when={!props.item.result && ended()}>
            <p class="text-text-tertiary">{t("kernel.nodeSessions.transcript.noResult")}</p>
          </Show>
          <Show
            when={props.item.result?.elided && full() === undefined && restored() === undefined}
          >
            <p data-testid="output-loading" class="text-text-tertiary">
              {t("kernel.nodeSessions.transcript.outputLoading")}
            </p>
          </Show>
          <Show when={props.item.result?.elided && full() === undefined && restored() === null}>
            <p class="text-text-tertiary">
              {t("kernel.nodeSessions.transcript.outputUnavailable")}
            </p>
          </Show>
          <Show when={props.item.result?.truncated && full() === undefined}>
            <p class="mt-1 flex flex-wrap items-center gap-2 text-text-tertiary">
              {t("kernel.nodeSessions.view.truncated")}
              <Show when={sessionActions().fullOutput}>
                <button
                  type="button"
                  class="text-accent hover:underline"
                  onClick={() => void loadFull()}
                >
                  {t("kernel.nodeSessions.view.showMore")}
                </button>
              </Show>
            </p>
          </Show>
          <Show when={full() === null}>
            <p class="mt-1 text-text-tertiary">
              {t("kernel.nodeSessions.transcript.fullOutputOnComputer")}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}

/**
 * S54 (D21): a subagent is one line in the transcript, "Agent: … Open ›". Its
 * own events are never here (S53): the line opens its drawer in the
 * Subagents panel, which loads them then.
 */
function SubagentRef(props: { item: SubagentItem; ctx: ItemContext }) {
  const t = useI18n().t
  // Final recheck: the dot reads the panel's state (a background subagent's
  // Agent call returns at once; its task events say when it ended).
  const state = () => props.ctx.subagentState?.(props.item.id)
  const tone = () => {
    const s = state()
    if (s) return SUBAGENT_DOT[s]
    return props.item.running && props.ctx.live
      ? "bg-success"
      : props.item.result?.isError
        ? "bg-error"
        : "bg-text-tertiary"
  }
  return (
    <button
      type="button"
      data-testid="subagent-ref"
      data-tool-use-id={props.item.id}
      data-state={state()}
      class="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-[12.5px] hover:border-accent"
      onClick={() => props.ctx.onOpenSubagent?.(props.item.id)}
    >
      <span class={cn("h-2 w-2 shrink-0 rounded-full", tone())} />
      <Bot class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      <span class="shrink-0 font-medium text-text">
        {props.item.title || t("kernel.nodeSessions.transcript.subagent")}
      </span>
      <span class="min-w-0 flex-1 truncate text-text-secondary">{props.item.description}</span>
      <span class="shrink-0 text-[12px] text-accent">
        {t("kernel.nodeSessions.subagents.open")}
      </span>
    </button>
  )
}

/** Frames to wait for a card to get a layout box before scrolling anyway. */
const SHOW_WAIT_FRAMES = 60

/**
 * Scroll a focused request card to the centre once it is actually laid out
 * (final walk F5). The focus is taken as the session's tab re-activates, in
 * the same tick its pane switches from `display: none`: a `scrollIntoView`
 * then is a no-op (and the pane's scroll offset was lost while hidden), so the
 * owner landed at the top with the ring set off screen. Wait for a box, scroll
 * instantly (a smooth scroll is cut short by the reflow that follows), then
 * once more on the next frame for any layout shift.
 */
export function scrollWhenShown(el: HTMLElement, done?: () => void): void {
  const shown = () => el.isConnected && el.getClientRects().length > 0
  const scroll = () => el.scrollIntoView?.({ block: "center", behavior: "auto" })
  let frames = 0
  const tick = () => {
    if (!el.isConnected) return
    if (!shown() && frames++ < SHOW_WAIT_FRAMES) {
      requestAnimationFrame(tick)
      return
    }
    scroll()
    requestAnimationFrame(() => {
      if (!el.isConnected) return
      scroll()
      done?.()
    })
  }
  requestAnimationFrame(tick)
}

function RequestCard(props: { item: RequestItem; ctx: ItemContext }) {
  const t = useI18n().t
  let ref: HTMLDivElement | undefined
  const focused = () => props.ctx.focusRequestId === props.item.requestId
  const [picked, setPicked] = createSignal<Record<string, string[]>>({})
  // P3-fix m4: an "Other" answer per question, typed by the owner.
  const [other, setOther] = createSignal<Record<string, string>>({})
  // P3-fix m4: one decision at a time; a refused one is told in the card.
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const inFlight = () => sending() || isRequestPending(sid(), rid())
  const send = (act: (() => Promise<unknown>) | undefined) => {
    if (!act || inFlight()) return
    props.ctx.onAnswer?.()
    setError(null)
    setSending(true)
    act()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setSending(false))
  }
  createEffect(() => {
    void props.ctx.focusKey
    if (focused() && ref) scrollWhenShown(ref, props.ctx.onFocusShown)
  })
  const sid = () => props.ctx.session.id
  const rid = () => props.item.requestId
  const title = () =>
    props.item.requestType === "permission_request"
      ? t("kernel.nodeSessions.request.permission")
      : props.item.requestType === "question"
        ? t("kernel.nodeSessions.request.question")
        : t("kernel.nodeSessions.request.plan")
  const decisionLine = () => {
    const d = props.item.decision
    if (!d || !DECISIONS.has(d.outcome)) return ""
    const q = props.item.questions[0]
    const tool =
      props.item.requestType === "question"
        ? (q?.header ?? q?.text ?? "")
        : props.item.requestType === "plan_request"
          ? t("kernel.nodeSessions.request.plan")
          : [props.item.tool, props.item.argument].filter(Boolean).join(" · ")
    return t(`kernel.nodeSessions.view.decision.${d.outcome}`, { tool })
  }
  const answerOne = (question: string, label: string) => {
    const act = sessionActions().answerQuestion
    send(act && (() => act(sid(), rid(), { [question]: label })))
  }
  const otherText = (question: string) => (other()[question] ?? "").trim()
  const single = () => props.item.questions.length === 1 && !props.item.questions[0]?.multiSelect
  const toggle = (question: string, label: string, multi: boolean) => {
    const cur = picked()[question] ?? []
    const next = multi
      ? cur.includes(label)
        ? cur.filter((l) => l !== label)
        : [...cur, label]
      : [label]
    setPicked({ ...picked(), [question]: next })
  }
  const allPicked = () =>
    props.item.questions.every(
      (q) => (picked()[q.question] ?? []).length > 0 || otherText(q.question).length > 0,
    )
  const sendPicked = () => {
    const answers: Record<string, string> = {}
    for (const q of props.item.questions) {
      const typed = otherText(q.question)
      answers[q.question] = [...(picked()[q.question] ?? []), ...(typed ? [typed] : [])].join(", ")
    }
    const act = sessionActions().answerQuestion
    send(act && (() => act(sid(), rid(), answers)))
  }
  const decidePermission = (allow: boolean, scope: "once" | "session") => {
    const act = sessionActions().decidePermission
    send(act && (() => act(sid(), rid(), allow, scope)))
  }
  const decidePlan = (approve: boolean) => {
    const act = sessionActions().decidePlan
    send(act && (() => act(sid(), rid(), approve)))
  }
  const hasAction = () => {
    const a = sessionActions()
    return props.item.requestType === "permission_request"
      ? !!a.decidePermission
      : props.item.requestType === "question"
        ? !!a.answerQuestion
        : !!a.decidePlan
  }
  // On the phone every action is a 44 px target (P4-T11); the rows wrap.
  const btn = () =>
    cn(
      "rounded-md border border-border bg-surface px-2.5 py-1 text-[12.5px] hover:bg-surface-hover",
      phoneTap(),
    )
  const pri = () =>
    cn(
      "rounded-md bg-accent px-2.5 py-1 text-[12.5px] font-medium text-accent-foreground hover:bg-accent-hover",
      phoneTap(),
    )
  return (
    <div
      ref={ref}
      data-testid="request-card"
      data-request-id={props.item.requestId}
      data-focused={String(focused())}
      class="flex flex-col gap-2 rounded-lg border p-3 text-[13px] transition-shadow duration-700"
      classList={{
        "border-warning-border bg-warning-glow": props.item.pending,
        "border-border bg-surface": !props.item.pending,
        "ring-2 ring-warning": focused(),
      }}
    >
      <Show
        when={props.item.pending}
        fallback={
          <p class="flex items-center gap-2 text-text-secondary">
            <Show
              when={
                props.item.decision?.outcome === "deny" ||
                props.item.decision?.outcome === "expired"
              }
              fallback={<Check class="h-3.5 w-3.5 text-success" />}
            >
              <X class="h-3.5 w-3.5 text-text-tertiary" />
            </Show>
            {decisionLine()}
          </p>
        }
      >
        <p class="flex items-center gap-2 font-medium text-warning">
          <Switch fallback={<ShieldAlert class="h-4 w-4" />}>
            <Match when={props.item.requestType === "question"}>
              <MessageCircleQuestion class="h-4 w-4" />
            </Match>
            <Match when={props.item.requestType === "plan_request"}>
              <ListChecks class="h-4 w-4" />
            </Match>
          </Switch>
          {title()}
        </p>
        <Switch>
          <Match when={props.item.requestType === "permission_request"}>
            <p class="flex min-w-0 items-center gap-2">
              <ToolIcon name={props.item.tool} />
              <span class="font-medium">
                {props.item.tool || t("kernel.nodeSessions.transcript.tool")}
              </span>
              <code class="min-w-0 truncate font-mono text-[12px] text-text-secondary">
                {props.item.argument}
              </code>
            </p>
            <Show
              when={props.item.browserTest}
              fallback={
                <Show when={props.item.reason}>
                  <p class="text-text-secondary">
                    {relativizePaths(props.item.reason, props.ctx.pathContext)}
                  </p>
                </Show>
              }
            >
              {(bt) => (
                <div
                  data-testid="browser-test-note"
                  class="flex flex-col gap-1 text-text-secondary"
                >
                  <p>{t("kernel.nodeSessions.request.browserTest.rights")}</p>
                  <Show
                    when={bt().files.length > 0}
                    fallback={<p>{t("kernel.nodeSessions.request.browserTest.none")}</p>}
                  >
                    <p>{t("kernel.nodeSessions.request.browserTest.changed")}</p>
                    <ul class="list-disc pl-5 font-mono text-[12px]">
                      <For each={bt().files}>{(f) => <li class="break-all">{f}</li>}</For>
                    </ul>
                    <Show when={bt().more > 0}>
                      <p>
                        {t("kernel.nodeSessions.request.browserTest.more", { count: bt().more })}
                      </p>
                    </Show>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={hasAction()}>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="node-permission-allow"
                  class={pri()}
                  disabled={inFlight()}
                  onClick={() => decidePermission(true, "once")}
                >
                  {t("kernel.nodeSessions.request.allowOnce")}
                </button>
                <button
                  type="button"
                  class={btn()}
                  disabled={inFlight()}
                  onClick={() => decidePermission(true, "session")}
                >
                  {t("kernel.nodeSessions.request.allowSession")}
                </button>
                <button
                  type="button"
                  data-testid="node-permission-deny"
                  class={btn()}
                  disabled={inFlight()}
                  onClick={() => decidePermission(false, "once")}
                >
                  {t("kernel.nodeSessions.request.deny")}
                </button>
              </div>
            </Show>
          </Match>
          <Match when={props.item.requestType === "question"}>
            <For each={props.item.questions}>
              {(q) => (
                <div class="flex flex-col gap-1.5">
                  <p>{q.text}</p>
                  <div class="flex flex-col gap-1">
                    <For each={q.options}>
                      {(o) => (
                        <Show
                          when={hasAction()}
                          fallback={
                            <div class="rounded-md border border-border px-2.5 py-1.5">
                              <span class="font-medium">{o.text}</span>
                              <Show when={o.description}>
                                <span class="block text-[12px] text-text-secondary">
                                  {o.description}
                                </span>
                              </Show>
                            </div>
                          }
                        >
                          <button
                            type="button"
                            disabled={inFlight()}
                            aria-pressed={(picked()[q.question] ?? []).includes(o.label)}
                            class={cn(
                              "rounded-md border border-border bg-surface px-2.5 py-1.5 text-left hover:bg-surface-hover",
                              phoneTap(),
                            )}
                            classList={{
                              "border-accent": (picked()[q.question] ?? []).includes(o.label),
                            }}
                            onClick={() =>
                              single()
                                ? answerOne(q.question, o.label)
                                : toggle(q.question, o.label, q.multiSelect)
                            }
                          >
                            <span class="font-medium">{o.text}</span>
                            <Show when={o.description}>
                              <span class="block text-[12px] text-text-secondary">
                                {o.description}
                              </span>
                            </Show>
                          </button>
                        </Show>
                      )}
                    </For>
                    <Show when={hasAction()}>
                      <div class="flex gap-2">
                        <input
                          type="text"
                          class="min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12.5px]"
                          aria-label={`${t("kernel.nodeSessions.steer.question.other")}: ${q.text}`}
                          placeholder={t("kernel.nodeSessions.steer.question.otherPlaceholder")}
                          value={other()[q.question] ?? ""}
                          disabled={inFlight()}
                          onInput={(e) =>
                            setOther({ ...other(), [q.question]: e.currentTarget.value })
                          }
                        />
                        <Show when={single()}>
                          <button
                            type="button"
                            class={pri()}
                            disabled={inFlight() || otherText(q.question).length === 0}
                            onClick={() => answerOne(q.question, otherText(q.question))}
                          >
                            {t("kernel.nodeSessions.steer.question.submit")}
                          </button>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </For>
            <Show when={hasAction() && !single()}>
              <div>
                <button
                  type="button"
                  class={pri()}
                  disabled={!allPicked() || inFlight()}
                  onClick={sendPicked}
                >
                  {t("kernel.done")}
                </button>
              </div>
            </Show>
          </Match>
          <Match when={props.item.requestType === "plan_request"}>
            <Prose text={props.item.plan} ctx={props.ctx} class="text-text" />
            <Show when={hasAction()}>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class={pri()}
                  disabled={inFlight()}
                  onClick={() => decidePlan(true)}
                >
                  {t("kernel.nodeSessions.request.approvePlan")}
                </button>
                <button
                  type="button"
                  class={btn()}
                  disabled={inFlight()}
                  onClick={() => decidePlan(false)}
                >
                  {t("kernel.nodeSessions.request.keepPlanning")}
                </button>
              </div>
            </Show>
          </Match>
        </Switch>
        <Show when={error()}>
          {(message) => (
            <p role="alert" class="text-[12.5px] text-error">
              {t("kernel.nodeSessions.steer.composer.sendFailed", { error: message() })}
            </p>
          )}
        </Show>
        <Show
          when={!hasAction()}
          fallback={
            <p class="text-[12.5px] text-text-tertiary">
              {t("kernel.nodeSessions.steer.permission.waits")}
            </p>
          }
        >
          <p class="text-[12.5px] text-text-tertiary">
            {t("kernel.nodeSessions.request.pendingNoActions")}
          </p>
        </Show>
      </Show>
    </div>
  )
}

/**
 * S58: a long message the store holds as its start (`textElided`): its whole
 * text is read back (disk cache, then server) while `enabled` (the row on
 * screen, and open for a thinking block) and let go when not. Until then the
 * start shows, followed by an ellipsis.
 */
function useWholeText(
  item: () => { text: string; textElided?: ElidedText },
  ctx: () => ItemContext,
  row: StubRow,
  open: () => boolean = () => true,
): () => string {
  const [restored, setRestored] = createSignal<string | undefined>(undefined)
  const enabled = () => open() && row.inView()
  createEffect(() => {
    const elided = item().textElided
    if (!open()) row.unreserve()
    if (!elided || !enabled()) {
      // F4: back to the stub; scrolled away, the row keeps its height.
      if (untrack(restored) !== undefined) row.swap(false, () => setRestored(undefined))
      return
    }
    const seq = elided.seq
    void fetchEventText(ctx().session.id, seq, ctx().parentToolUseId).then((text) => {
      if (text !== null && enabled() && item().textElided?.seq === seq)
        row.swap(true, () => setRestored(text))
    })
  })
  return () => restored() ?? (item().textElided ? `${item().text}…` : item().text)
}

/** The model's text; a stub of a long one reads its whole text while on screen (S58). */
function TextBody(props: { item: TextItem; ctx: ItemContext }) {
  const row = createStubRow()
  const text = useWholeText(
    () => props.item,
    () => props.ctx,
    row,
  )
  return (
    <div
      ref={row.ref}
      data-testid="text-row"
      data-elided={props.item.textElided ? "true" : undefined}
    >
      <Prose text={text()} ctx={props.ctx} class="text-[13.5px] leading-relaxed text-text" />
    </div>
  )
}

function ThinkingBody(props: { item: ThinkingItem; ctx: ItemContext }) {
  const t = useI18n().t
  const row = createStubRow()
  const [open, setOpen] = createSignal(false)
  const text = useWholeText(
    () => props.item,
    () => props.ctx,
    row,
    open,
  )
  return (
    <details
      ref={row.ref}
      class="text-[12.5px] text-text-tertiary"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary
        data-testid="thinking-toggle"
        class={cn("cursor-pointer select-none", isPhone() && "min-h-11 py-3")}
      >
        {t("kernel.nodeSessions.transcript.thinking")}
      </summary>
      <p class="mt-1 whitespace-pre-wrap break-words">
        {relativizePaths(text(), props.ctx.pathContext)}
      </p>
    </details>
  )
}

function UserBubble(props: { item: UserItem; ctx: ItemContext; first: boolean }) {
  const i18n = useI18n()
  const t = i18n.t
  const who = () => {
    // Final recheck F-D1: in a subagent's drawer, the prompt is the main
    // agent's (it spawned the subagent), never the person's, in any session.
    if (props.ctx.parentToolUseId) return t("kernel.nodeSessions.origin.mainAgent")
    // W3-D3: an import has no agent's prompt. One that did not come through
    // Liaison (no commandId) was typed in the session's own Claude Code, the
    // first one included; one sent through Liaison is the person's here.
    if (props.ctx.session.source === "import") {
      if (props.item.commandId) return t("kernel.nodeSessions.origin.app")
      const from = props.ctx.session.importFrom
      return t(
        `kernel.nodeSessions.origin.importedYou.${from === "vscode" || from === "cli" ? from : "other"}`,
      )
    }
    if (!props.first || props.ctx.session.source === "app")
      return t("kernel.nodeSessions.origin.app")
    if (props.ctx.session.source === "routine") return t("kernel.nodeSessions.origin.routine")
    return props.ctx.agentName ?? t("kernel.nodeSessions.newDialog.agent")
  }
  const row = createStubRow()
  const text = useWholeText(
    () => props.item,
    () => props.ctx,
    row,
  )
  return (
    <div ref={row.ref} class="flex justify-end">
      <div class="max-w-[85%] rounded-lg bg-surface-hover px-3 py-2 text-[13px]">
        <p class="mb-0.5 text-[11.5px] text-text-tertiary">
          {who()} · <TimeLabel at={props.item.at} />
        </p>
        <p class="whitespace-pre-wrap break-words text-text">
          {relativizePaths(text(), props.ctx.pathContext)}
        </p>
      </div>
    </div>
  )
}

/** The node fail codes a status line says in words (kernel.nodeSessions.failCode.*). */
const FAIL_CODES: ReadonlySet<string> = new Set(["unsafe_subdir", "already_liaison"])

function DimLine(props: { item: DimItem; ctx: ItemContext }) {
  const t = useI18n().t
  const level = (l: string) => (LEVELS.has(l) ? t(`kernel.nodeSessions.level.${l}`) : l)
  const text = () => {
    const it = props.item
    switch (it.type) {
      case "system":
        // D15: said in the viewer's language from the node's facts.
        return relativizePaths(systemText(it.subtype, it.text, it.facts, t), props.ctx.pathContext)
      case "status": {
        const label = it.status ? t(`kernel.nodeSessions.status.${it.status}`) : ""
        // A44: a fail code this client words (an unknown one shows nothing, never itself).
        const failure =
          it.code && FAIL_CODES.has(it.code) ? t(`kernel.nodeSessions.failCode.${it.code}`) : ""
        return [label, statusReasonText(it.reason, t), failure].filter(Boolean).join(" · ")
      }
      case "model_changed":
        return `${t("kernel.nodeSessions.view.type.model_changed")} · ${it.from} → ${it.to}`
      case "level_changed":
        return `${t("kernel.nodeSessions.view.type.level_changed")} · ${level(it.from)} → ${level(it.to)}`
      case "resumed":
        return t("kernel.nodeSessions.view.type.resumed")
    }
    return ""
  }
  return (
    <p class="flex items-baseline gap-2 text-[12px] text-text-tertiary">
      <TimeLabel at={props.item.at} />
      <span class="min-w-0 break-words">{text()}</span>
    </p>
  )
}

function ResultCard(props: { item: ResultItem; ctx: ItemContext }) {
  const t = useI18n().t
  // W1-D10: the run's own end (the status after this result), else the
  // session's state for a run that has not reported it; matches the status line.
  const end = () => props.item.endStatus ?? sessionState(props.ctx.session)
  const tone = (): "success" | "warning" | "error" | "neutral" =>
    end() === "stopped"
      ? "neutral"
      : end() === "needs_you"
        ? "warning"
        : props.item.isError || end() === "failed"
          ? "error"
          : "success"
  const duration = () =>
    formatDuration(props.item.elapsedMs ?? elapsedMs(props.ctx.session, Date.now()))
  const heading = () => {
    switch (tone()) {
      case "neutral":
        return t("kernel.nodeSessions.result.stopped")
      case "warning":
        return t("kernel.nodeSessions.result.needsYou", { duration: duration() })
      case "error":
        return t("kernel.nodeSessions.result.failed")
      default:
        return t("kernel.nodeSessions.result.done", { duration: duration() })
    }
  }
  return (
    <div
      data-testid="result-card"
      class="flex flex-col gap-2 rounded-lg border p-3 text-[13px]"
      classList={{
        "border-success-border bg-success-glow": tone() === "success",
        "border-warning-border bg-warning-glow": tone() === "warning",
        "border-error-border bg-error-glow": tone() === "error",
        "border-border bg-surface-hover": tone() === "neutral",
      }}
    >
      <p
        class="flex items-center gap-2 font-medium"
        classList={{
          "text-success": tone() === "success",
          "text-warning": tone() === "warning",
          "text-error": tone() === "error",
          "text-text-secondary": tone() === "neutral",
        }}
      >
        <Show when={tone() !== "success"} fallback={<Check class="h-4 w-4" />}>
          <CircleAlert class="h-4 w-4" />
        </Show>
        {heading()}
      </p>
      <Show when={props.item.text}>
        <Prose text={props.item.text} ctx={props.ctx} class="text-text" />
      </Show>
      <Show when={props.item.branch || props.item.prUrl}>
        <p class="flex flex-wrap items-center gap-3 text-[12.5px] text-text-secondary">
          <Show when={props.item.branch}>
            <span class="inline-flex items-center gap-1">
              <GitBranch class="h-3.5 w-3.5" />
              {props.item.branch}
              <Show when={props.item.pushed}>
                <span>· {t("kernel.nodeSessions.header.pushed")}</span>
              </Show>
            </span>
          </Show>
          <Show when={props.item.prUrl}>
            {(url) => (
              <a
                href={url()}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 text-accent hover:underline"
              >
                <GitPullRequest class="h-3.5 w-3.5" />
                {t("kernel.nodeSessions.header.pr")}
              </a>
            )}
          </Show>
        </p>
      </Show>
    </div>
  )
}

/** One item, any kind. `first` marks the session's first prompt (its origin). */
export const TranscriptItemView: Component<{
  item: TranscriptItem
  ctx: ItemContext
  first?: boolean
}> = (props) => {
  return (
    <Switch>
      <Match when={props.item.kind === "user"}>
        <UserBubble item={props.item as UserItem} ctx={props.ctx} first={props.first === true} />
      </Match>
      <Match when={props.item.kind === "text"}>
        <Show
          when={(props.item as TextItem).textElided}
          fallback={
            <Prose
              text={(props.item as { text: string }).text}
              ctx={props.ctx}
              class="text-[13.5px] leading-relaxed text-text"
            />
          }
        >
          <TextBody item={props.item as TextItem} ctx={props.ctx} />
        </Show>
      </Match>
      <Match when={props.item.kind === "thinking"}>
        <ThinkingBody item={props.item as ThinkingItem} ctx={props.ctx} />
      </Match>
      <Match when={props.item.kind === "tool"}>
        <ToolRow item={props.item as ToolItem} ctx={props.ctx} />
      </Match>
      <Match when={props.item.kind === "subagent"}>
        <SubagentRef item={props.item as SubagentItem} ctx={props.ctx} />
      </Match>
      <Match when={props.item.kind === "request"}>
        <RequestCard item={props.item as RequestItem} ctx={props.ctx} />
      </Match>
      <Match when={props.item.kind === "dim"}>
        <DimLine item={props.item as DimItem} ctx={props.ctx} />
      </Match>
      <Match when={props.item.kind === "result"}>
        <ResultCard item={props.item as ResultItem} ctx={props.ctx} />
      </Match>
    </Switch>
  )
}
