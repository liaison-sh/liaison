// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION COMPOSER (P3-T15; charter "The composer", S8, S9). P2 places it
// under every session view with fixed props (P2-D2: `session`,
// `pendingRequests`, `nodeOnline`, `confirmLevel`); P3 owns the body:
//
// - the owner's held messages as dashed bubbles saying their true phase (D22):
//   "Starting the session…" while a run starts for it, "Waiting for the
//   current step" while a turn runs; and those a Stop cancelled ("Not
//   delivered");
// - a placeholder that says what a message does in the session's state;
// - Send (Enter; Shift+Enter breaks the line), Stop while the session can
//   still be stopped;
// - the model (the node's offered models) and the level: a lower level is sent
//   at once, a higher one goes through `confirmLevel`, the one in-app
//   confirmation (D24), and nothing changes when it is cancelled;
// - the reasoning (S23-S25): "Default" plus the levels the session's
//   model publishes, hidden when it publishes none or the API predates
//   `effort` on the row (D14). A computer too old to change it mid-run, or a
//   change that only reaches the next run, is said under the bar.
//
// S51 (D28): while another Claude Code (VS Code, a terminal) drives the
// session, the first Send keeps the text and says that sending resumes it
// here as well; the second sends it with `confirmDrivenElsewhere`. A message
// of this composer's the node refused `driven_elsewhere` (sent before the web
// knew) re-arms it: the reason shows, the text comes back, and the next Send
// is the confirmed one. A refused message sent from anywhere else (the agent,
// another device) re-arms nothing: the first Send here still asks (D31c). The
// next run's start clears it.
//
// W3 (S41, A54): a follow-mode import is a read-only mirror: no field, a line
// saying to take it over. During a Take over's history replay a message is
// queued and its bubble says it is sent when the import finishes. An in-place
// session Liaison follows while VS Code drives it asks the second click like
// S51 (a `driven_elsewhere_confirm` 409, from a client that did not know yet,
// asks it too).
//
// With exactly one single-question AskUserQuestion waiting, a sent message is
// its answer (the node does that); with several questions open, a line says
// to answer them in their cards. Importing this module registers the steering
// actions P2's cards and header call (session-steering.ts).
//
// D27: it is the threads chat field (ui/Composer.tsx `chat`): one card, the
// text growing to its cap, the settings as pills (a sheet on a phone), Stop
// and Send at the right of the control line.

import {
  DRIVEN_ELSEWHERE_CODE,
  type EffortLevel,
  isLevelRaise,
  NODE_LEVELS,
  type NodeLevel,
} from "@liaison/shared"
import { Gauge, Shield, Sparkles, Square } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { cn } from "~/lib/cn"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderFold, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { useI18n } from "~/modules/i18n/i18n-context"
import { effortsFor, modelsFor, nodeById } from "~/modules/nodes/nodes-store"
import { Composer, type ComposerSetting } from "~/ui/Composer"
import { DockedComposer } from "~/ui/DockedComposer"
import {
  autoFollowed,
  followingVia,
  followReadOnly,
  isEnded,
  sessionState,
  takeOverReplay,
} from "./display"
import { type DriverState, drivenElsewhere, driverKey } from "./header-info"
import { type LevelRequest, levelNoteState } from "./level-note"
import type { NodeSessionRow } from "./session-api"
import {
  queuedMessages,
  sendCommand,
  sendMessage,
  startsForMessage,
  stopSession,
  unwatchSessionCommands,
  watchSessionCommands,
} from "./session-commands"
import "./session-steering"
import { sessionStore } from "./session-store"
import type { PendingRequest } from "./transcript"

export interface SessionComposerProps {
  session: NodeSessionRow
  pendingRequests: PendingRequest[]
  nodeOnline: boolean
  confirmLevel(level: NodeLevel): Promise<string | null>
  /** P4: the phone shows Stop in its top bar instead. */
  hideStop?: boolean
  /** P4: phone width (16 px text, 40 px targets, settings in a sheet, no note under the bar). */
  compact?: boolean
  /** A message is being sent: the view goes back to the newest line and follows. */
  onSend?: () => void
}

/** The statuses a Stop still acts on (D36: queued, live, or paused until the node is back). */
const STOPPABLE: ReadonlySet<string> = new Set(["queued", "running", "waiting", "paused"])

type Placeholder =
  | "running"
  | "waiting"
  | "waitingPermission"
  | "waitingPlan"
  | "queued"
  | "paused"
  | "ended"

/**
 * Walk D13: a waiting session says what it waits for, from its oldest open
 * request: a permission or a plan is decided in its card (a message is read
 * after), a single question can be answered here.
 */
function placeholderOf(status: string, pending: PendingRequest[]): Placeholder {
  if (status === "waiting") {
    const first = pending[0]?.type
    if (first === "permission_request") return "waitingPermission"
    if (first === "plan_request") return "waitingPlan"
    return "waiting"
  }
  if (status === "running" || status === "queued" || status === "paused") return status
  // needs_you reads like the other ended statuses; an unknown one like running.
  return isEnded(status) ? "ended" : "running"
}

export default function SessionComposer(props: SessionComposerProps) {
  const { t } = useI18n()
  const [text, setText] = createSignal("")
  let field: HTMLTextAreaElement | undefined
  const dictation = useDictation({ target: () => field })
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [stopping, setStopping] = createSignal(false)
  const [note, setNote] = createSignal<string | null>(null)
  // S46: the level note comes from the last level asked for and the session's
  // events, so it goes once a run reports the level (or the session ends).
  const [levelAsk, setLevelAsk] = createSignal<(LevelRequest & { raised: boolean }) | null>(null)
  const levelNote = () => {
    const ask = levelAsk()
    if (!ask || levelNoteState(sessionStore.events(sessionId()), ask, status()) === "none") {
      return null
    }
    const key = ask.raised ? "levelRaised" : "levelLowered"
    return t(`kernel.nodeSessions.steer.composer.${key}`, {
      level: levelLabel(ask.level as NodeLevel),
    })
  }

  const sessionId = () => props.session.id
  // S51: the other driver, and whether the owner already pressed Send once.
  // A54: the server asked for the owner's confirmation (409 driven_elsewhere_confirm).
  const [serverAsks, setServerAsks] = createSignal(false)
  // A54: an auto-followed in-place session is driven elsewhere even before its driver event.
  const driven = createMemo((): DriverState | null => {
    const events = sessionStore.events(sessionId())
    const d = drivenElsewhere(props.session, events)
    if (d) return d
    if (!autoFollowed(props.session) && !serverAsks()) return null
    const via = followingVia(props.session, events)
    return { via: via === "other" ? null : via, refused: false, orphan: null }
  })
  const [asked, setAsked] = createSignal(false)
  // D31c: our own last send came back refused, so the owner's next click here
  // is their second one.
  const [refusedOwn, setRefusedOwn] = createSignal(false)
  createEffect(
    on(driven, (d, prev) => {
      if (d) return
      // D33: the owner stopped the orphan that refused our message: it resumes
      // the session now, plain (the node checks the driver again).
      const resume = !!prev?.orphan && untrack(refusedOwn) && !!untrack(text).trim()
      setAsked(false)
      setRefusedOwn(false)
      if (resume) void send()
    }),
  )
  const drivenNote = () => {
    const d = driven()
    // A message on its way says its own phase (the bubble).
    if (!d || queued().some((m) => m.state !== "cancelled")) return null
    const pid = { pid: d.orphan?.pid ?? 0 }
    if (refusedOwn()) return t(`kernel.nodeSessions.header.driverReason.${driverKey(d)}`, pid)
    return asked() ? t(`kernel.nodeSessions.steer.composer.drivenAsk.${driverKey(d)}`, pid) : null
  }
  // A message of ours the node refused comes back into an empty field.
  const [lastSent, setLastSent] = createSignal<{ commandId: string; text: string } | null>(null)
  createEffect(() => {
    const sent = lastSent()
    if (!sent) return
    const refused = sessionStore
      .events(sessionId())
      .some(
        (e) =>
          e.type === "command_applied" &&
          e.payload?.commandId === sent.commandId &&
          e.payload.outcome === "failed" &&
          e.payload.error === DRIVEN_ELSEWHERE_CODE,
      )
    if (!refused) return
    setLastSent(null)
    setRefusedOwn(true)
    if (!untrack(text).trim()) setText(sent.text)
  })
  // The session's open commands, seeded now and on every reconnect (a reload
  // keeps the queued bubbles).
  createEffect(
    on(sessionId, (id) => {
      void watchSessionCommands(id)
      onCleanup(() => unwatchSessionCommands(id))
    }),
  )
  const status = () => sessionState(props.session)
  const queued = createMemo(() => queuedMessages(sessionId()))
  const openQuestions = () => props.pendingRequests.filter((r) => r.type === "question").length
  const canStop = () => STOPPABLE.has(status())
  const showStopping = () => stopping() && canStop()
  // A session that left the stoppable states clears "Stopping…" (a later
  // message may make it stoppable again).
  createEffect(() => {
    if (!canStop()) setStopping(false)
  })
  const nodeName = () => nodeById(props.session.nodeId)?.name ?? ""

  const placeholder = () => {
    const which = placeholderOf(status(), props.pendingRequests)
    return t(`kernel.nodeSessions.steer.composer.placeholder.${which}`, { node: nodeName() })
  }

  const models = createMemo(() => {
    const offered = modelsFor(props.session.nodeId)
    const current = props.session.model
    return offered.some((m) => m.id === current)
      ? offered
      : [{ id: current, label: current }, ...offered]
  })

  const failed = (err: unknown) =>
    t("kernel.nodeSessions.steer.composer.sendFailed", {
      error: err instanceof Error ? err.message : String(err),
    })

  const send = async () => {
    const value = text().trim()
    if (!value || sending()) return
    const d = driven()
    if (d && !refusedOwn() && !asked()) {
      setAsked(true)
      return
    }
    props.onSend?.()
    setSending(true)
    setError(null)
    try {
      const sent = await sendMessage(sessionId(), value, {
        resuming: startsForMessage(status()),
        confirmDrivenElsewhere: !!d,
      })
      setAsked(false)
      setRefusedOwn(false)
      setServerAsks(false)
      setText("")
      // After clearing: a refusal that is already here puts the text back.
      setLastSent({ commandId: sent.commandId, text: value })
    } catch (err) {
      // A54: the server wants the owner's second click (an auto-follow this
      // client did not know of yet): ask it, keep the text.
      if (err instanceof ApiError && err.code === "driven_elsewhere_confirm") {
        setServerAsks(true)
        setAsked(true)
      } else if (err instanceof ApiError && err.code === "follow_read_only") {
        setError(t("kernel.nodeSessions.importActions.readOnly"))
      } else setError(failed(err))
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await stopSession(sessionId())
    } catch (err) {
      setStopping(false)
      setError(failed(err))
    }
  }

  // Walk D7: a pick shows at once and stays until the session answers; a
  // change it refused goes back to what the session runs, and says so.
  type Pick = "model" | "level" | "effort"
  const [picked, setPicked] = createSignal<Partial<Record<Pick, string>>>({})
  const pick = (key: Pick, value: string | undefined) => setPicked((p) => ({ ...p, [key]: value }))
  const [awaited, setAwaited] = createSignal<{
    commandId: string
    type: "set_model" | "set_level"
    value: string
  } | null>(null)
  createEffect(() => {
    const w = awaited()
    if (!w) return
    const done = sessionStore
      .events(sessionId())
      .find((e) => e.type === "command_applied" && e.payload?.commandId === w.commandId)
    if (!done) return
    setAwaited(null)
    pick(w.type === "set_model" ? "model" : "level", undefined)
    if (done.payload.outcome !== "failed") return
    setNote(null)
    setLevelAsk(null)
    setError(
      w.type === "set_model"
        ? t("kernel.nodeSessions.steer.composer.modelRefused", {
            model: models().find((m) => m.id === w.value)?.label || w.value,
            node: nodeName(),
          })
        : t("kernel.nodeSessions.steer.composer.levelRefused", {
            level: levelLabel(props.session.level),
          }),
    )
  })

  const changeModel = async (model: string) => {
    if (model === (picked().model ?? props.session.model)) return
    setError(null)
    pick("model", model)
    try {
      const sent = await sendCommand(sessionId(), { type: "set_model", payload: { model } })
      setAwaited({ commandId: sent.commandId, type: "set_model", value: model })
    } catch (err) {
      pick("model", undefined)
      setError(failed(err))
    }
  }

  const levelLabel = (level: NodeLevel) => t(`kernel.nodeSessions.level.${level}`)

  // A raise goes through the in-app confirmation; a cancelled one changes nothing.
  const changeLevel = async (level: NodeLevel) => {
    const from = props.session.level
    if (level === (picked().level ?? from)) return
    setError(null)
    setNote(null)
    setLevelAsk(null)
    const afterSeq = sessionStore.lastSeq(sessionId())
    try {
      const raised = isLevelRaise(from, level)
      const confirmationId = raised ? await props.confirmLevel(level) : undefined
      if (raised && !confirmationId) return
      pick("level", level)
      const sent = await sendCommand(sessionId(), {
        type: "set_level",
        payload: confirmationId ? { level, confirmationId } : { level },
      })
      setAwaited({ commandId: sent.commandId, type: "set_level", value: level })
      setLevelAsk({ level, afterSeq, raised })
    } catch (err) {
      pick("level", undefined)
      setError(failed(err))
    }
  }

  // S25: the levels the session's model publishes; a value it does not offer
  // (after a model change) reads as Default (the SDK clamps it, spec §5 #12).
  const efforts = createMemo(() =>
    effortsFor(props.session.nodeId, picked().model ?? props.session.model),
  )
  const showEffort = () => props.session.effort !== undefined && efforts().length > 0
  const effortValue = () => {
    const current = picked().effort ?? props.session.effort
    return current && efforts().includes(current as EffortLevel) ? current : ""
  }
  const changeEffort = async (value: string) => {
    const effort = value === "" ? null : (value as EffortLevel)
    if (value === effortValue()) return
    setError(null)
    setNote(null)
    pick("effort", value)
    try {
      const sent = await sendCommand(sessionId(), { type: "set_effort", payload: { effort } })
      if (sent.applied === "row_only") setNote(t("kernel.nodeSessions.reasoning.nextRun"))
    } catch (err) {
      pick("effort", undefined)
      // The API's 409 text is English only: the sentence is ours.
      setError(
        err instanceof ApiError && err.code === "node_outdated"
          ? t("kernel.nodeSessions.reasoning.outdated")
          : failed(err),
      )
    }
  }

  // Model, level and reasoning: pills on a desktop, one summary and a sheet
  // on a phone (ui/Composer.tsx Settings).
  const settings = (): ComposerSetting[] => [
    {
      label: t("kernel.nodeSessions.steer.composer.model"),
      icon: <Sparkles size={13} aria-hidden="true" />,
      value: picked().model ?? props.session.model,
      options: models().map((m) => ({ value: m.id, label: m.label || m.id })),
      onSelect: (v) => void changeModel(v),
    },
    {
      label: t("kernel.nodeSessions.steer.composer.level"),
      icon: <Shield size={13} aria-hidden="true" />,
      value: picked().level ?? props.session.level,
      options: NODE_LEVELS.map((level) => ({
        value: level,
        label: levelLabel(level),
        description: t(`kernel.nodeSessions.levelAllows.${level}`),
      })),
      onSelect: (v) => void changeLevel(v as NodeLevel),
    },
    ...(showEffort()
      ? [
          {
            label: t("kernel.nodeSessions.reasoning.label"),
            icon: <Gauge size={13} aria-hidden="true" />,
            value: effortValue(),
            options: [
              {
                value: "",
                label: t("kernel.nodeSessions.reasoning.default"),
                description: t("kernel.nodeSessions.reasoning.defaultHint"),
              },
              ...efforts().map((level) => ({
                value: level,
                label: t(`kernel.nodeSessions.effort.${level}`),
              })),
            ],
            onSelect: (v: string) => void changeEffort(v),
          },
        ]
      : []),
  ]

  const phone = () => !!props.compact

  return (
    <Show
      when={!followReadOnly(props.session)}
      fallback={
        <div class={phone() ? "px-2 pb-2 pt-1" : "px-4 pb-3 pt-1"} data-testid="session-composer">
          <p
            data-testid="session-follow-readonly"
            class="rounded-xl border border-dashed border-border px-3 py-2 text-[12.5px] text-text-secondary"
          >
            {t("kernel.nodeSessions.importActions.readOnly")}
          </p>
        </div>
      }
    >
      <DockedComposer
        // As the thread bar: clear of the dock's floating pills on a desktop.
        class={
          phone()
            ? "px-2 pb-2 pt-1"
            : "px-4 pb-[max(0.875rem,var(--shell-dock-clearance,0px))] pt-1"
        }
        data-testid="session-composer"
      >
        <Show when={queued().length > 0}>
          <ul class="mb-2 flex flex-col items-end gap-1" aria-live="polite">
            <For each={queued()}>
              {(m) => (
                <li
                  class={cn(
                    "max-w-[80%] rounded-xl border border-dashed px-3 py-1.5 text-[13px]",
                    m.state === "cancelled"
                      ? "border-border text-text-tertiary line-through"
                      : "border-border-strong text-text-secondary",
                  )}
                  data-command-id={m.commandId}
                  data-state={m.state}
                >
                  <p class="whitespace-pre-wrap break-words">{m.text}</p>
                  <p class="mt-0.5 text-[11px] text-text-tertiary no-underline">
                    {m.state === "cancelled"
                      ? t("kernel.nodeSessions.steer.composer.cancelled")
                      : takeOverReplay(props.session)
                        ? t("kernel.nodeSessions.importActions.afterReplay")
                        : m.state === "starting"
                          ? t("kernel.nodeSessions.steer.composer.starting")
                          : t("kernel.nodeSessions.steer.composer.waitingStep")}
                  </p>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={openQuestions() > 1}>
          <p class="mb-1 text-[12px] text-warning">
            {t("kernel.nodeSessions.steer.composer.answerInCard")}
          </p>
        </Show>
        <Composer variant="chat">
          <div data-testid="session-composer-field">
            {/* On a phone the input line itself becomes the recorder (D20). */}
            <RecorderFold dictation={dictation} when={phone()}>
              <div class={phone() ? "px-3.5 pt-3 pb-1" : "px-4 pt-3.5 pb-1"}>
                <Composer.TextArea
                  phone={phone()}
                  placeholder={placeholder()}
                  aria-label={placeholder()}
                  value={text()}
                  ref={(el) => {
                    field = el
                  }}
                  onInput={(e) => setText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
              </div>
            </RecorderFold>
            <Composer.Controls class="flex-nowrap" testId="session-composer-controls">
              <RecorderRow dictation={dictation} variant={phone() ? "phone" : "row"}>
                <Composer.Settings
                  settings={settings()}
                  phone={phone()}
                  title={t("kernel.nodeSessions.steer.composer.settings")}
                  closeLabel={t("kernel.close")}
                  note={t("kernel.nodeSessions.steer.composer.applyNote")}
                />
                <ComposerAssist target={() => field} disabled={sending()} />
                <div class="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
                  <Show when={!props.hideStop && canStop()}>
                    <button
                      type="button"
                      class="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-2.5 text-[12.5px] text-text hover:border-error hover:text-error disabled:opacity-60"
                      disabled={showStopping()}
                      onClick={() => void stop()}
                    >
                      <Square size={10} class="fill-current" aria-hidden="true" />
                      {showStopping()
                        ? t("kernel.nodeSessions.steer.composer.stopping")
                        : t("kernel.nodeSessions.steer.composer.stop")}
                    </button>
                  </Show>
                  <DictationMic
                    dictation={dictation}
                    disabled={sending()}
                    class="h-9 w-9 rounded-xl"
                    iconSize={18}
                  />
                  <Composer.Send
                    label={t("kernel.nodeSessions.steer.composer.send")}
                    phone={phone()}
                    disabled={!text().trim() || sending()}
                    onClick={() => void send()}
                  />
                </div>
              </RecorderRow>
            </Composer.Controls>
          </div>
        </Composer>
        <Show when={drivenNote()}>
          <p
            data-testid="session-driven-note"
            class="mt-1 px-1 text-[12px] text-warning"
            role="status"
          >
            {drivenNote()}
          </p>
        </Show>
        <Show when={error()}>
          <p class="mt-1 px-1 text-[12px] text-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={levelNote() ?? note()}>
          <p class="mt-1 px-1 text-[12px] text-text-tertiary">{levelNote() ?? note()}</p>
        </Show>
        <Show when={!phone()}>
          <p class="mt-1 px-1 text-[11.5px] text-text-tertiary">
            {t("kernel.nodeSessions.steer.composer.applyNote")}
          </p>
        </Show>
      </DockedComposer>
    </Show>
  )
}
