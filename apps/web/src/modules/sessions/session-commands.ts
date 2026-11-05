// SPDX-License-Identifier: FSL-1.1-ALv2
//
// STEERING A SESSION, the web side (P3-T11; spec-protocol.md §Commands). One
// client for the composer, the request cards, the session header's Stop and
// the phone's top bar:
//
//   POST /api/me/node-sessions/:id/commands  {type, payload} -> {commandId, seq}
//   GET  /api/me/node-sessions/:id/commands?open=1  the unacked ones, in seq order
//   PATCH /api/me/node-sessions/:id  {muted}  the session's bell (S14)
//
// A command is validated against the shared schema before any request. Once
// sent it is pending until the session's own events show it landed (derived
// from the session store, never written there): a `user_message` or a
// `command_applied` carrying its id. A message cancelled by a Stop stays as
// "not delivered" until the owner's next command on that session. After a
// reload or a reconnect, `openCommands` seeds the pending list from the server.
//
// D22: a held message says its true phase, never a bare "Queued". The node
// delivers every message (it is acked only once the CLI has it), so a message
// is held while either (a) the session is starting for it: it was sent to, or
// found on, a session that had ended, was queued or paused, so a run must
// start before anything reads it (5 to 25 s of node start-up); or (b) a turn
// runs and the message waits for the current step (a running tool) to finish.
// Phase (a) sticks until the message lands: the resumed run shows `running`
// while the CLI is still starting.

import {
  type Autonomy,
  isEndedSessionStatus,
  type NodeSessionCommand,
  type NodeSessionCommandType,
  nodeSessionCommandSchema,
} from "@liaison/shared"
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { log } from "~/lib/logger"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { getAttentionApi } from "~/modules/shell/attention-store"
import { sessionState } from "./display"
import { foldOf } from "./session-fold"
import { applyRow, sessionStore } from "./session-store"

export interface PendingCommand {
  commandId: string
  seq: number
  type: NodeSessionCommandType
  payload: Record<string, unknown>
  /** D22: no run was taking messages when it was sent or found (a run must start for it). */
  resuming?: boolean
}

/**
 * A held message (D22): `starting` while a run starts for it, `waiting` while
 * the current step runs, `cancelled` once a Stop cancelled it.
 */
export interface QueuedMessage {
  commandId: string
  text: string
  state: "starting" | "waiting" | "cancelled"
}

type Api = Pick<ApiClient, "get" | "post" | "patch">
let apiOf: () => Api | null = getAttentionApi

/** Where commands go (the kernel API client by default; tests set their own). */
export function setSessionCommandsApi(getter: () => Api | null): void {
  apiOf = getter
}

const [state, setState] = createStore<{ sent: Record<string, PendingCommand[]> }>({ sent: {} })

export const COMMAND_ROUTES = {
  commands: (id: string) => `/me/node-sessions/${encodeURIComponent(id)}/commands`,
  open: (id: string) => `/me/node-sessions/${encodeURIComponent(id)}/commands?open=1`,
  session: (id: string) => `/me/node-sessions/${encodeURIComponent(id)}`,
} as const

/**
 * What the session's events say about each command id: landed, or cancelled.
 * Folded as the events arrive (S56), so a command whose event left the held
 * window still reads landed.
 */
function landed(sessionId: string): ReadonlyMap<string, "landed" | "cancelled"> {
  return foldOf(sessionStore.events(sessionId)).commands
}

/** The session's commands not yet landed (cancelled messages included), in seq order. */
function held(sessionId: string): Array<PendingCommand & { cancelled: boolean }> {
  const seen = landed(sessionId)
  return (state.sent[sessionId] ?? [])
    .filter((c) => seen.get(c.commandId) !== "landed")
    .map((c) => ({ ...c, cancelled: seen.get(c.commandId) === "cancelled" }))
}

/** The commands still on their way: sent, neither landed nor cancelled. */
export function pendingCommands(sessionId: string): PendingCommand[] {
  return held(sessionId)
    .filter((c) => !c.cancelled)
    .map(({ cancelled: _c, ...c }) => c)
}

/** Whether no run takes messages now: ended, queued, or paused (D22). */
export function startsForMessage(status: string): boolean {
  return isEndedSessionStatus(status) || status === "queued" || status === "paused"
}

function sessionStarting(sessionId: string): boolean {
  const row = sessionStore.row(sessionId)
  return !!row && startsForMessage(sessionState(row))
}

/** The composer's queue: messages not yet read, and those a Stop cancelled. */
export function queuedMessages(sessionId: string): QueuedMessage[] {
  const starting = sessionStarting(sessionId)
  return held(sessionId)
    .filter((c) => c.type === "message")
    .map((c) => ({
      commandId: c.commandId,
      text: String(c.payload.text ?? ""),
      state: c.cancelled ? "cancelled" : c.resuming || starting ? "starting" : "waiting",
    }))
}

/** Whether a decision or answer for this request is on its way (cards disable their buttons). */
export function isRequestPending(sessionId: string, requestId: string): boolean {
  return pendingCommands(sessionId).some(
    (c) =>
      (c.type === "permission_decision" || c.type === "answer") &&
      c.payload.requestId === requestId,
  )
}

function remember(sessionId: string, cmd: PendingCommand): void {
  const cancelled = new Set(
    held(sessionId)
      .filter((c) => c.cancelled)
      .map((c) => c.commandId),
  )
  setState(
    produce((s) => {
      // A new command clears the "not delivered" lines of earlier ones.
      const kept = (s.sent[sessionId] ?? []).filter((c) => !cancelled.has(c.commandId))
      if (!kept.some((c) => c.commandId === cmd.commandId)) kept.push(cmd)
      kept.sort((a, b) => a.seq - b.seq)
      s.sent[sessionId] = kept
    }),
  )
}

/**
 * Send one command. Throws `ApiError` (400 before any request when the payload
 * is invalid). `resuming`: the session the caller shows takes no message now
 * (D22); without it, the session store's row says.
 */
export async function sendCommand(
  sessionId: string,
  command: NodeSessionCommand,
  opts: { resuming?: boolean } = {},
): Promise<{ commandId: string; seq: number; applied?: "row_only" }> {
  const parsed = nodeSessionCommandSchema.safeParse(command)
  if (!parsed.success) {
    throw new ApiError(
      parsed.error.issues[0]?.message ?? "Invalid command.",
      400,
      "VALIDATION_ERROR",
    )
  }
  const api = apiOf()
  if (!api) throw new ApiError("Not signed in.", 401, "UNAUTHORIZED")
  const res = await api.post<{ commandId: string; seq: number; applied?: "row_only" }>(
    COMMAND_ROUTES.commands(sessionId),
    parsed.data,
  )
  const resuming = opts.resuming ?? sessionStarting(sessionId)
  remember(sessionId, {
    commandId: res.commandId,
    seq: res.seq,
    type: parsed.data.type,
    payload: parsed.data.payload as Record<string, unknown>,
    ...(resuming ? { resuming } : {}),
  })
  return {
    commandId: res.commandId,
    seq: res.seq,
    // S24: the row changed but the live process keeps its value until its next run.
    ...(res.applied === "row_only" ? { applied: "row_only" as const } : {}),
  }
}

export const stopSession = (sessionId: string) =>
  sendCommand(sessionId, { type: "stop", payload: {} })

/** `confirmDrivenElsewhere` (S51): the owner's second send to a session another Claude Code drives. */
export const sendMessage = (
  sessionId: string,
  text: string,
  opts: { resuming?: boolean; confirmDrivenElsewhere?: boolean } = {},
) =>
  sendCommand(
    sessionId,
    {
      type: "message",
      payload: opts.confirmDrivenElsewhere ? { text, confirmDrivenElsewhere: true } : { text },
    },
    { resuming: opts.resuming },
  )

/** The owner marks the session Done (S7). */
export const markDone = (sessionId: string, summary?: string) =>
  sendCommand(sessionId, { type: "mark_done", payload: summary ? { summary } : {} })

/** S33: switch the session's autonomy; `row_only` when the live process keeps its mode until its next run. */
export const setAutonomy = (sessionId: string, autonomy: Autonomy) =>
  sendCommand(sessionId, { type: "set_autonomy", payload: { autonomy } })

/** The session's bell (S14): the answer is the row, kept like a `node_session` frame. */
export async function setMuted(sessionId: string, muted: boolean): Promise<void> {
  const api = apiOf()
  if (!api) throw new ApiError("Not signed in.", 401, "UNAUTHORIZED")
  const res = await api.patch<unknown>(COMMAND_ROUTES.session(sessionId), { muted })
  if ((res as { id?: unknown } | null)?.id === sessionId) applyRow(res)
}

export const decide = (
  sessionId: string,
  requestId: string,
  allow: boolean,
  scope: "once" | "session" = "once",
) => sendCommand(sessionId, { type: "permission_decision", payload: { requestId, allow, scope } })

export const answer = (sessionId: string, requestId: string, answers: Record<string, string>) =>
  sendCommand(sessionId, { type: "answer", payload: { requestId, answers } })

export const approvePlan = (sessionId: string, requestId: string) =>
  decide(sessionId, requestId, true)

export const keepPlanning = (sessionId: string, requestId: string) =>
  decide(sessionId, requestId, false)

interface OpenCommandRow {
  commandId: string
  seq: number
  type: NodeSessionCommandType
  payload: Record<string, unknown>
}

/** The server's unacked commands of a session: the pending list after a reload. */
export async function openCommands(sessionId: string): Promise<PendingCommand[]> {
  const api = apiOf()
  if (!api) return []
  const res = await api.get<{ commands: OpenCommandRow[] }>(COMMAND_ROUTES.open(sessionId))
  // A message held while no run takes messages is held for the run that starts for it (D22).
  const resuming = sessionStarting(sessionId)
  const open = (Array.isArray(res?.commands) ? res.commands : []).map((c) => ({
    commandId: c.commandId,
    seq: c.seq,
    type: c.type,
    payload: c.payload ?? {},
    ...(resuming ? { resuming } : {}),
  }))
  setState(
    produce((s) => {
      // A message this page sent to a starting session stays starting (D22).
      for (const c of open) {
        if (s.sent[sessionId]?.some((k) => k.commandId === c.commandId && k.resuming)) {
          Object.assign(c, { resuming: true })
        }
      }
      const ids = new Set(open.map((c) => c.commandId))
      // Keep what this page sent since (not yet on the server's list), drop the rest.
      const newer = (s.sent[sessionId] ?? []).filter(
        (c) => !ids.has(c.commandId) && c.seq > Math.max(0, ...open.map((o) => o.seq)),
      )
      s.sent[sessionId] = [...open, ...newer].sort((a, b) => a.seq - b.seq)
    }),
  )
  return open
}

const watched = new Set<string>()
let unsubscribe: (() => void) | null = null

/** Seed a session's pending commands now and again on every reconnect or resume. */
export async function watchSessionCommands(sessionId: string): Promise<void> {
  watched.add(sessionId)
  if (!unsubscribe) {
    unsubscribe = subscribeResync(() => {
      for (const id of watched) {
        void openCommands(id).catch((err) =>
          log.warn({ err, sessionId: id }, "reloading open session commands failed"),
        )
      }
    })
  }
  try {
    await openCommands(sessionId)
  } catch (err) {
    log.warn({ err, sessionId }, "loading open session commands failed")
  }
}

export function unwatchSessionCommands(sessionId: string): void {
  watched.delete(sessionId)
}

/** Sign-out, and tests: forget every command. */
export function resetSessionCommands(): void {
  watched.clear()
  unsubscribe?.()
  unsubscribe = null
  setState({ sent: {} })
}

onSessionTeardown(resetSessionCommands)
