// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION'S FOLDED FIGURES (S56, owner D30). Everything the view derives
// from the whole main thread rather than from the events on screen, folded
// once per event as it arrives, so nothing rescans the event list:
//
//   subagents      per task: the latest of its task_* events (a task_progress
//                  supersedes the one before), the Agent calls' models
//   cache          the last model call's time and the cache TTL it implies
//   context        the latest context size and the model's window
//   driver         the other driver and whether a send was refused (S51)
//   plan           the latest `todo`
//   startCwd       the first start event's cwd
//   startFolderRel the first start event's cwd below its shared folder, as
//                  the node matched it by real path (S52, batch-4 F5)
//   requests       the requests still waiting for a decision
//   agentCalls     each Agent/Task call's description, type and model
//   commands       which command ids landed or were cancelled
//   atelier        the latest valid `atelier` system event's state (S35), for
//                  a row from an API that does not carry `atelier`
//
// The store (session-store.ts) folds every main-thread event it receives,
// including those it does not hold (usage, task_*, todo; a command_applied
// is held, and folded too, so its ack outlives the window), and attaches the fold to its event window. `foldOf(events)` answers that
// fold for the store's window, and folds any other list (a test's, a drawer's)
// once, incrementally while it only grows. header-info.ts and transcript.ts
// read their figures from here, with the same meaning as when they scanned.

import {
  DRIVEN_ELSEWHERE_CODE,
  driverData,
  type NodeSessionAtelierState,
  type NodeSessionDriver,
  type NodeSessionEvent,
  type NodeSessionOrphan,
  nodeSessionAtelierStateSchema,
} from "@liaison/shared"

type Data = Record<string, unknown>

export const TASK_SUBTYPES: ReadonlySet<string> = new Set([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
])

const ENDED_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
])

const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"])

export type FoldedSubagentEnd = "done" | "failed" | "stopped"

export interface FoldedTask {
  taskId: string
  toolUseId: string | null
  description: string
  subagentType: string | null
  startedAt: number
  endedAt: number | null
  toolUses: number | null
  lastToolName: string | null
  resumed: boolean
  ended: FoldedSubagentEnd | null
  lastEventAt: number
  /** The last task event was a progress naming a tool still running. */
  progressTool: boolean
}

export type FoldedRequestType = "permission_request" | "question" | "plan_request"

export interface FoldedRequest {
  requestId: string
  type: FoldedRequestType
  tool: string
  seq: number
}

export interface AgentCall {
  description: string
  type: string
  model: string | null
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
const rec = (v: unknown): Data =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Data) : {}
export const atMs = (e: Pick<NodeSessionEvent, "at">) => {
  const ms = Date.parse(e.at)
  return Number.isFinite(ms) ? ms : 0
}

const isHttps = (u: unknown): u is string => {
  if (typeof u !== "string" || !URL.canParse(u)) return false
  return new URL(u).protocol === "https:"
}

/**
 * S35: an Atelier state as the client trusts it, from an event's data or a
 * row: the shared schema (enums, clipped lengths), with every board link that
 * is not `https:` dropped here again (the node and the API drop them first;
 * a link is the one thing on screen that acts). Anything else: null.
 */
export function atelierStateOf(v: unknown): NodeSessionAtelierState | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const { boards, ...rest } = v as Data
  const parsed = nodeSessionAtelierStateSchema.safeParse(rest)
  if (!parsed.success) return null
  const links = (Array.isArray(boards) ? boards : [])
    .map(rec)
    .filter((b) => typeof b.title === "string" && isHttps(b.url))
    .map((b) => ({ title: b.title as string, url: b.url as string }))
  return links.length > 0 ? { ...parsed.data, boards: links } : parsed.data
}

function isSubagentTask(d: Data): boolean {
  if (d.skipTranscript === true || d.ambient === true) return false
  if (d.taskType === "local_bash") return false
  return d.taskType === "local_agent" || str(d.subagentType) !== null
}

function endedState(status: string | null): FoldedSubagentEnd {
  if (status === "failed") return "failed"
  if (status === "stopped" || status === "killed") return "stopped"
  return "done"
}

export class EventFold {
  /** Events folded (tests read it: each event is folded once). */
  folded = 0
  readonly tasks = new Map<string, FoldedTask>()
  /** Held subagent events (a drawer's list): the last time and open calls by subagent. */
  readonly lastAtByParent = new Map<string, number>()
  readonly openCalls = new Map<string, Set<string>>()
  readonly agentCalls = new Map<string, AgentCall>()
  /** The models the main agent's tool calls asked for, by tool use id. */
  readonly models = new Map<string, string>()

  // cache (S22)
  lastMainUsageAt: number | null = null
  lastSplitUsageAt: number | null = null
  cacheTtl: "5m" | "1h" = "5m"
  // context (S22, D23)
  contextTokens: number | null = null
  contextWindow: number | null = null
  // driver (S51)
  driverVia: NodeSessionDriver | null | undefined = undefined
  /** D33: the other driver is an orphaned Claude process (its pid, the CLI's id). */
  driverOrphan: NodeSessionOrphan | null = null
  driverRefused = false
  // plan
  lastTodo: NodeSessionEvent | null = null
  startCwd: string | null = null
  /** S52: null when no start event said it (an older node): the folder itself. */
  startFolderRel: string | null = null
  // requests
  private readonly requests = new Map<string, FoldedRequest>()
  private readonly decided = new Set<string>()
  private requestsSorted = true
  private lastRequestSeq = Number.NEGATIVE_INFINITY
  // commands
  readonly commands = new Map<string, "landed" | "cancelled">()
  // Atelier (S35): the latest valid state the node emitted
  atelier: NodeSessionAtelierState | null = null

  ingest(e: NodeSessionEvent): void {
    this.folded++
    const p = rec(e.payload)
    const parent = e.parentToolUseId
    if (parent) {
      this.lastAtByParent.set(parent, Math.max(this.lastAtByParent.get(parent) ?? 0, atMs(e)))
      const id = str(p.id)
      if (id && e.type === "tool_call") {
        const open = this.openCalls.get(parent) ?? new Set<string>()
        open.add(id)
        this.openCalls.set(parent, open)
      } else if (id && e.type === "tool_result") {
        this.openCalls.get(parent)?.delete(id)
      }
    }
    this.foldCommand(e, p)
    this.foldRequest(e, p)
    if (e.type === "todo") this.lastTodo = e
    if (e.type === "result") {
      const w = num(p.contextWindow)
      if (w !== null && w > 0) this.contextWindow = w
    }
    if (parent) return
    switch (e.type) {
      case "tool_call": {
        const input = rec(p.input)
        const id = str(p.id)
        const model = str(input.model)
        if (id && model) this.models.set(id, model)
        if (id && SUBAGENT_TOOLS.has(str(p.name) ?? "") && !this.agentCalls.has(id)) {
          this.agentCalls.set(id, {
            description: typeof input.description === "string" ? input.description : "",
            type: typeof input.subagent_type === "string" ? input.subagent_type : "",
            model,
          })
        }
        return
      }
      case "usage": {
        const at = atMs(e)
        this.lastMainUsageAt = at
        const tokens = num(p.contextTokens)
        if (tokens !== null) this.contextTokens = tokens
        if (num(p.cacheRead) !== null) {
          this.lastSplitUsageAt = at
          if ((num(p.cacheWrite1h) ?? 0) > 0) this.cacheTtl = "1h"
          else if ((num(p.cacheWrite5m) ?? 0) > 0) this.cacheTtl = "5m"
        }
        return
      }
      case "command_applied":
        if (p.outcome === "failed" && p.error === DRIVEN_ELSEWHERE_CODE) this.driverRefused = true
        return
      case "system":
        this.foldSystem(e, p)
        return
      default:
        return
    }
  }

  private foldSystem(e: NodeSessionEvent, p: Data): void {
    const subtype = str(p.subtype)
    if (subtype === "start") {
      this.driverVia = undefined
      this.driverOrphan = null
      this.driverRefused = false
      const cwd = rec(p.data).cwd
      if (this.startCwd === null && typeof cwd === "string" && cwd) {
        this.startCwd = cwd
        const rel = rec(p.data).folderRelPath
        if (typeof rel === "string") this.startFolderRel = rel
      }
      return
    }
    if (subtype === "atelier") {
      const state = atelierStateOf(p.data)
      if (state) this.atelier = state
      return
    }
    if (subtype === "driver") {
      const d = driverData(p.data)
      if (d) {
        this.driverVia = d.elsewhere ? d.via : undefined
        this.driverOrphan = d.elsewhere ? (d.orphan ?? null) : null
      }
      return
    }
    if (!subtype || !TASK_SUBTYPES.has(subtype)) return
    const d = rec(p.data)
    const taskId = str(d.taskId)
    if (!taskId) return
    const at = atMs(e)
    let acc = this.tasks.get(taskId)
    if (subtype === "task_started") {
      if (!isSubagentTask(d)) return
      if (acc) {
        // Started again: the main agent resumed it.
        acc.resumed = true
        acc.ended = null
        acc.endedAt = null
        acc.progressTool = false
        acc.lastEventAt = Math.max(acc.lastEventAt, at)
      } else {
        acc = {
          taskId,
          toolUseId: str(d.toolUseId),
          description: str(d.description) ?? "",
          subagentType: str(d.subagentType),
          startedAt: at,
          endedAt: null,
          toolUses: null,
          lastToolName: null,
          resumed: false,
          ended: null,
          lastEventAt: at,
          progressTool: false,
        }
        this.tasks.set(taskId, acc)
      }
      return
    }
    // Progress, update or notification of a task never seen starting: ignored
    // (a background shell, or a start outside the held window).
    if (!acc) return
    acc.lastEventAt = Math.max(acc.lastEventAt, at)
    if (!acc.toolUseId) acc.toolUseId = str(d.toolUseId)
    if (!acc.description) acc.description = str(d.description) ?? ""
    const toolUses = num(d.toolUses)
    if (toolUses !== null) acc.toolUses = toolUses
    const lastTool = str(d.lastToolName)
    if (lastTool) acc.lastToolName = lastTool
    acc.progressTool = subtype === "task_progress" && lastTool !== null
    const status = str(d.status)
    const endTime = num(d.endTime)
    if (subtype === "task_notification") {
      acc.ended = endedState(status)
      acc.endedAt = endTime ?? at
    } else if (endTime !== null || (status && ENDED_TASK_STATUSES.has(status))) {
      acc.ended = endedState(status)
      acc.endedAt = endTime ?? at
    }
  }

  private foldRequest(e: NodeSessionEvent, p: Data): void {
    if (e.type === "decision") {
      const id = typeof p.requestId === "string" ? p.requestId : ""
      this.decided.add(id)
      for (const [key, r] of this.requests) if (r.requestId === id) this.requests.delete(key)
      return
    }
    if (e.type !== "permission_request" && e.type !== "question" && e.type !== "plan_request") {
      return
    }
    const requestId = typeof p.requestId === "string" ? p.requestId : ""
    if (this.decided.has(requestId)) return
    if (e.seq < this.lastRequestSeq) this.requestsSorted = false
    this.lastRequestSeq = Math.max(this.lastRequestSeq, e.seq)
    // A second request with the same id stays listed twice, as the scan listed it.
    const key = this.requests.has(requestId) ? `${requestId}\u0000${e.seq}` : requestId
    this.requests.set(key, {
      requestId,
      type: e.type,
      tool:
        e.type === "permission_request"
          ? typeof p.tool === "string"
            ? p.tool
            : ""
          : e.type === "question"
            ? "AskUserQuestion"
            : "ExitPlanMode",
      seq: e.seq,
    })
  }

  private foldCommand(e: NodeSessionEvent, p: Data): void {
    const id = p.commandId
    if (typeof id !== "string") return
    if (e.type === "command_applied") {
      this.commands.set(id, p.outcome === "cancelled" ? "cancelled" : "landed")
    } else if (e.type === "user_message" && !this.commands.has(id)) {
      this.commands.set(id, "landed")
    }
  }

  /** Requests with no decision yet, in seq order. */
  pending(): FoldedRequest[] {
    const out = [...this.requests.values()]
    return this.requestsSorted ? out : out.sort((a, b) => a.seq - b.seq)
  }
}

interface Cached {
  fold: EventFold
  /** -1: attached by the store, which folds as it receives. */
  n: number
  first: NodeSessionEvent | undefined
}

const folds = new WeakMap<readonly NodeSessionEvent[], Cached>()

/** The store's window: its fold, fed at ingest with every main-thread event. */
export function attachFold(events: readonly NodeSessionEvent[], fold: EventFold): void {
  folds.set(events, { fold, n: -1, first: undefined })
}

/** The fold of a list: the store's own, or this list's, folded once while it only grows. */
export function foldOf(events: readonly NodeSessionEvent[]): EventFold {
  let c = folds.get(events)
  if (c && c.n < 0) return c.fold
  if (!c || events.length < c.n || (c.n > 0 && events[0] !== c.first)) {
    c = { fold: new EventFold(), n: 0, first: events[0] }
    folds.set(events, c)
  }
  for (let i = c.n; i < events.length; i++) c.fold.ingest(events[i])
  if (c.n === 0) c.first = events[0]
  c.n = events.length
  return c.fold
}
