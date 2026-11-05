// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE TRANSCRIPT MODEL (P2-T07; S8 transcript and plan, D13). The one place in
// the web client that knows the node session event vocabulary
// (spec-protocol.md, Events). Events in seq order become the items the
// Sessions view renders:
//
//   user_message                   -> user
//   assistant_text, thinking       -> text, thinking
//   tool_call (+ its tool_result)  -> tool; a Task or Agent call -> subagent,
//                                     one item: its own events (those whose
//                                     parentToolUseId is a call of this list)
//                                     never render here (S53, D20); its drawer
//                                     builds them from its own read, where
//                                     they all carry its id and sit on top
//   permission_request, question,
//   plan_request (+ decision)      -> request, pending until decided
//   system, status, model_changed,
//   level_changed, resumed         -> dim (a task_* system event: nothing,
//                                     the Subagents panel shows it, S54)
//   result                         -> result
//   usage, command_applied, todo, decision, tool_result -> no item of their own
//
// An unknown event type produces nothing; an unknown tool is a generic tool row
// with its name. No item carries a JSON rendering of anything: a tool's input
// stays structured (`input`) and its one line is `toolArgument`.
//
// THE PATH CHOKE POINT (charter: no absolute local path outside the folder
// chip's tooltip). Every string an item carries for display has gone through
// `relativizePaths` here, so no component has to remember it. The only raw
// strings left are the ones sent back to the node: a question's `question`
// and an option's `label` (the answer keys), and a tool's structured `input`
// (diffs render it through files-changed, which relativizes each line).

import type { NodeSessionEvent, NodeSessionTodoItem } from "@liaison/shared"
import { displayPath, type PathContext, relativizePaths } from "./display"
import { foldOf, TASK_SUBTYPES } from "./session-fold"

type HeldEvent = NodeSessionEvent & { clientReceivedAt?: number }

interface ItemBase {
  /** The first event's seq, time and arrival here (S5's data attributes). */
  seq: number
  at: string
  clientReceivedAt?: number
}

export interface ToolResult {
  isError: boolean
  output: string
  truncated: boolean
  /** S56: the output was elided from this client's memory; read it again to show it. */
  elided?: ElidedOutput
}

export interface UserItem extends ItemBase {
  kind: "user"
  text: string
  commandId?: string
  /** S58: a long message held as its start only; the row reads the rest on screen. */
  textElided?: ElidedText
}
export interface TextItem extends ItemBase {
  kind: "text"
  text: string
  /** S58: as UserItem's. */
  textElided?: ElidedText
}
export interface ThinkingItem extends ItemBase {
  kind: "thinking"
  text: string
  /** S58: as UserItem's. */
  textElided?: ElidedText
}
export interface ToolItem extends ItemBase {
  kind: "tool"
  id: string
  name: string
  input: unknown
  /** The one-line argument (a command, a relative path, a pattern…). */
  argument: string
  result?: ToolResult
  durationMs?: number
  /** No result yet while the session still runs: the row spins. */
  running: boolean
  /** The call's own input was cut at 64 KB. */
  truncated: boolean
  /** S56: the input was elided from this client's memory (short fields kept); read it again to show it. */
  inputElided?: ElidedInput
}
export interface SubagentItem extends Omit<ToolItem, "kind"> {
  kind: "subagent"
  title: string
  description: string
  model: string | null
}
export type RequestType = "permission_request" | "question" | "plan_request"
export interface QuestionOption {
  /** The answer value sent back to the node, as the SDK asked it (raw). */
  label: string
  /** The label as shown. */
  text: string
  description?: string
}
export interface QuestionPrompt {
  /** The answer key sent back to the node, as the SDK asked it (raw). */
  question: string
  /** The question as shown. */
  text: string
  header?: string
  multiSelect: boolean
  options: QuestionOption[]
}
export interface RequestItem extends ItemBase {
  kind: "request"
  requestType: RequestType
  requestId: string
  /** permission_request: the tool, its input and the one-line argument. */
  tool: string
  input: unknown
  argument: string
  reason: string
  /**
   * D56 F3: a browser test runner's card: the files of the kind the test
   * loads (config, tests, package scripts) changed in the session's folder.
   */
  browserTest?: { files: string[]; more: number }
  /** question: the questions, each with its options. */
  questions: QuestionPrompt[]
  /** plan_request: the plan text. */
  plan: string
  decision?: { outcome: string; by: string }
  pending: boolean
}
export type DimItem = ItemBase & { kind: "dim" } & (
    | { type: "system"; subtype: string; text: string; facts?: Record<string, unknown> }
    | {
        type: "status"
        status: string
        reason: string
        /** A node fail code (jobs.ts NODE_FAIL_CODES) the web says in words, "" when none. */
        code?: string
      }
    | { type: "model_changed" | "level_changed"; from: string; to: string }
    | { type: "resumed"; after: string }
  )
export interface ResultItem extends ItemBase {
  kind: "result"
  /** From its run's start to this result (walk D15); absent when unknown. */
  elapsedMs?: number
  text: string
  isError: boolean
  subtype: string
  branch?: string
  pushed?: boolean
  prUrl?: string
  /** W1-D10: how its run ended (the status event after it), when it has. */
  endStatus?: string
}

export type TranscriptItem =
  | UserItem
  | TextItem
  | ThinkingItem
  | ToolItem
  | SubagentItem
  | RequestItem
  | DimItem
  | ResultItem

export interface TranscriptOptions {
  /** The session's true status (`state ?? status`, D14). */
  sessionStatus: string
  pathContext: PathContext
}

const SUBAGENT_TOOLS = new Set(["Task", "Agent"])
const LIVE: ReadonlySet<string> = new Set(["running", "waiting", "queued"])

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t.length > 200 ? `${t.slice(0, 199)}…` : t
  }
  return ""
}

const PATH_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"])
const FIRST_KEY: Record<string, string> = {
  Bash: "command",
  Grep: "pattern",
  Glob: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Task: "description",
  Agent: "description",
  Skill: "skill",
}

/** The one line a tool row shows for its input; never a JSON rendering. */
export function toolArgument(name: string, input: unknown, ctx: PathContext): string {
  const i = rec(input)
  if (PATH_TOOLS.has(name)) {
    const p = str(i.file_path) || str(i.notebook_path)
    return p ? displayPath(p, ctx) : ""
  }
  if (name === "TodoWrite") {
    return Array.isArray(i.todos) ? String(i.todos.length) : ""
  }
  const key = FIRST_KEY[name]
  if (key && typeof i[key] === "string") return firstLine(relativizePaths(i[key] as string, ctx))
  for (const v of Object.values(i)) {
    if (typeof v === "string" && v.trim()) {
      return v.startsWith("/") ? displayPath(v, ctx) : firstLine(relativizePaths(v, ctx))
    }
  }
  return ""
}

export interface ToolMeta {
  durationMs?: number
  lines?: number
  matches?: number
}

/** The non-empty lines of an output (a tool row's meta; the store keeps it for an elided one). */
export function countLines(output: string): number {
  return output.split(/\r?\n/).filter((l) => l.trim() !== "").length
}

/** A tool row's meta line: duration, output line count, Grep matches. */
export function toolMeta(item: ToolItem | SubagentItem): ToolMeta {
  const meta: ToolMeta = {}
  if (item.durationMs !== undefined) meta.durationMs = item.durationMs
  const out = item.result?.output
  const elided = item.result?.elided
  if ((out || elided) && !item.result?.isError) {
    const n = elided ? elided.lines : countLines(out ?? "")
    if (item.name === "Grep") meta.matches = n
    else if (n > 0 && item.kind === "tool") meta.lines = n
  }
  return meta
}

function base(e: HeldEvent): ItemBase {
  return e.clientReceivedAt === undefined
    ? { seq: e.seq, at: e.at }
    : { seq: e.seq, at: e.at, clientReceivedAt: e.clientReceivedAt }
}

/** D56 F3: the card's file list as the node sent it (bounded there; clipped here too). */
function browserTestOf(v: unknown): { browserTest?: { files: string[]; more: number } } {
  if (!v || typeof v !== "object") return {}
  const o = v as { files?: unknown; more?: unknown }
  if (!Array.isArray(o.files)) return {}
  const files = o.files.filter((f): f is string => typeof f === "string").slice(0, 50)
  const more = typeof o.more === "number" && o.more > 0 ? Math.floor(o.more) : 0
  return { browserTest: { files, more } }
}

function parseQuestions(v: unknown, shown: (s: string) => string): QuestionPrompt[] {
  if (!Array.isArray(v)) return []
  return v.map((q) => {
    const r = rec(q)
    const options = Array.isArray(r.options)
      ? r.options.map((o) => {
          const or = rec(o)
          const label = str(or.label) || str(o)
          const opt: QuestionOption = { label, text: shown(label) }
          if (str(or.description)) opt.description = shown(str(or.description))
          return opt
        })
      : []
    const prompt: QuestionPrompt = {
      question: str(r.question),
      text: shown(str(r.question)),
      multiSelect: r.multiSelect === true,
      options,
    }
    if (str(r.header)) prompt.header = shown(str(r.header))
    return prompt
  })
}

function durationBetween(a: string, b: string): number | undefined {
  const d = Date.parse(b) - Date.parse(a)
  return Number.isFinite(d) && d >= 0 ? d : undefined
}

/** The model's event journal: events the store replaced in place since a version (S56). */
export interface EventJournal {
  readonly version: number
  /** The events replaced after `version`, oldest first; null when it no longer reaches back. */
  since(version: number): readonly HeldEvent[] | null
}

const journals = new WeakMap<readonly HeldEvent[], EventJournal>()

/** The store's window announces the events it replaces in place (an elided output). */
export function attachJournal(events: readonly HeldEvent[], journal: EventJournal): void {
  journals.set(events, journal)
}

function sameContext(a: PathContext | undefined, b: PathContext): boolean {
  return (
    !!a &&
    a.cwd === b.cwd &&
    a.folderName === b.folderName &&
    a.sessionId === b.sessionId &&
    a.repo === b.repo
  )
}

function lowerBound(items: readonly { seq: number }[], seq: number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].seq < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * THE INCREMENTAL TRANSCRIPT (S56, owner D30). The items of a list of events
 * in seq order, kept up to date as the list moves on instead of rebuilt per
 * event: a new event appends its item (a tool result or a decision updates
 * its call's or request's item in place, as a new object), events dropped
 * from the front of the list drop their items, and a replaced event (the
 * store eliding an old output) updates its item. Items that did not change
 * keep their identity, so the view re-renders only what moved.
 *
 * A full rebuild happens only when the list is not the one synced last (a
 * different array), grows at the front (older history loaded), the path
 * context changes, or a subagent's event arrived before its Agent call; the
 * session's status only flips the running flags. `rebuilds` and `processed`
 * count them (tests).
 */
export class TranscriptModel {
  rebuilds = 0
  processed = 0
  private items: TranscriptItem[] = []
  private list: readonly HeldEvent[] | null = null
  private ctx: PathContext | undefined
  private live = false
  private lastSeq = Number.NEGATIVE_INFINITY
  private firstSeq = Number.NEGATIVE_INFINITY
  private journalVersion = 0
  // Items by their call or request id, as the seq of the item.
  private readonly toolSeq = new Map<string, number>()
  private readonly requestSeq = new Map<string, number>()
  private readonly callSeq = new Map<string, number>()
  // A result or decision that came before its call or request.
  private readonly earlyResults = new Map<string, HeldEvent>()
  private readonly earlyDecisions = new Map<string, HeldEvent>()
  // Subagent events shown on top because their call was not (yet) seen.
  private readonly orphanParents = new Set<string>()
  // One result card per run (walk D15).
  private runStart: string | undefined
  private newRun = true
  private lastResultSeq: number | undefined
  private needRebuild = false
  firstUserSeq: number | undefined

  /** The items of `events` (seq order), updated from the last sync. Mutated in place. */
  sync(events: readonly HeldEvent[], opts: TranscriptOptions): TranscriptItem[] {
    const live = LIVE.has(opts.sessionStatus)
    const journal = journals.get(events)
    if (events !== this.list || !sameContext(this.ctx, opts.pathContext)) {
      this.rebuild(events, opts.pathContext, live, journal)
      return this.items
    }
    if (live !== this.live) this.setLive(live)
    const first = events[0]?.seq ?? Number.POSITIVE_INFINITY
    if (events.length > 0 && first < this.firstSeq) {
      this.rebuild(events, opts.pathContext, live, journal)
      return this.items
    }
    if (journal && journal.version !== this.journalVersion) {
      const replaced = journal.since(this.journalVersion)
      if (!replaced) {
        this.rebuild(events, opts.pathContext, live, journal)
        return this.items
      }
      for (const e of replaced) if (e.seq >= first) this.replace(e)
      this.journalVersion = journal.version
    }
    if (first > this.firstSeq) this.trim(first)
    // The new events: those after the last seq processed.
    let i = events.length
    while (i > 0 && events[i - 1].seq > this.lastSeq) i--
    for (; i < events.length; i++) this.add(events[i])
    if (this.needRebuild) this.rebuild(events, opts.pathContext, live, journal)
    return this.items
  }

  private reset(): void {
    this.items = []
    this.lastSeq = Number.NEGATIVE_INFINITY
    this.firstSeq = Number.NEGATIVE_INFINITY
    this.toolSeq.clear()
    this.requestSeq.clear()
    this.callSeq.clear()
    this.earlyResults.clear()
    this.earlyDecisions.clear()
    this.orphanParents.clear()
    this.runStart = undefined
    this.newRun = true
    this.lastResultSeq = undefined
    this.needRebuild = false
    this.firstUserSeq = undefined
  }

  private rebuild(
    events: readonly HeldEvent[],
    ctx: PathContext,
    live: boolean,
    journal: EventJournal | undefined,
  ): void {
    this.rebuilds++
    this.reset()
    this.list = events
    this.ctx = ctx
    this.live = live
    this.journalVersion = journal?.version ?? 0
    // A subagent's own events belong to its drawer (S53); an orphan stays on top.
    for (const e of events) {
      if (e.type === "tool_call") this.callSeq.set(str(e.payload.id), e.seq)
    }
    for (const e of events) this.add(e)
    this.needRebuild = false
  }

  private shown = (text: string) => relativizePaths(text, this.ctx as PathContext)

  private at(seq: number): number {
    const i = lowerBound(this.items, seq)
    return this.items[i]?.seq === seq ? i : -1
  }

  private setLive(live: boolean): void {
    this.live = live
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]
      if ((it.kind === "tool" || it.kind === "subagent") && !it.result && it.running !== live) {
        this.items[i] = { ...it, running: live }
      }
    }
  }

  private trim(first: number): void {
    this.firstSeq = first
    const n = lowerBound(this.items, first)
    if (n > 0) this.items.splice(0, n)
    for (const m of [this.toolSeq, this.requestSeq, this.callSeq]) {
      for (const [k, seq] of m) if (seq < first) m.delete(k)
    }
    for (const m of [this.earlyResults, this.earlyDecisions]) {
      for (const [k, e] of m) if (e.seq < first) m.delete(k)
    }
    if (this.firstUserSeq !== undefined && this.firstUserSeq < first) {
      this.firstUserSeq = this.items.find((i) => i.kind === "user")?.seq
    }
    if (this.lastResultSeq !== undefined && this.lastResultSeq < first) {
      this.lastResultSeq = undefined
    }
  }

  private withResult<T extends Omit<ToolItem, "kind">>(item: T, r: HeldEvent): T {
    const result: ToolResult = {
      isError: r.payload.isError === true,
      output: this.shown(str(r.payload.output)),
      truncated: r.truncated === true,
    }
    const elided = elidedOf(r)
    if (elided) result.elided = elided
    const next = { ...item, result, running: false }
    const d = durationBetween(item.at, r.at)
    if (d !== undefined) next.durationMs = d
    return next
  }

  /** An event the store replaced in place (an elided output, input or message): its item follows. */
  private replace(e: HeldEvent): void {
    if (e.type === "assistant_text" || e.type === "thinking" || e.type === "user_message") {
      const i = this.at(e.seq)
      const it = i >= 0 ? this.items[i] : undefined
      const next = it ? this.itemOf(e) : null
      if (it && next && next.kind === it.kind) this.items[i] = next
      return
    }
    if (e.type === "tool_call") {
      const i = this.at(e.seq)
      const it = i >= 0 ? this.items[i] : undefined
      if (!it || (it.kind !== "tool" && it.kind !== "subagent")) return
      const next = { ...it, input: e.payload.input }
      const elided = inputElidedOf(e)
      if (elided) next.inputElided = elided
      this.items[i] = next
      return
    }
    if (e.type !== "tool_result") return
    const seq = this.toolSeq.get(str(e.payload.id))
    if (seq === undefined) return
    const i = this.at(seq)
    const it = i >= 0 ? this.items[i] : undefined
    if (!it || (it.kind !== "tool" && it.kind !== "subagent") || !it.result) return
    this.items[i] = this.withResult(it, e)
  }

  private add(e: HeldEvent): void {
    this.processed++
    if (e.seq > this.lastSeq) this.lastSeq = e.seq
    if (this.firstSeq === Number.NEGATIVE_INFINITY) this.firstSeq = e.seq
    const p = e.payload
    const parent = e.parentToolUseId
    if (parent) {
      if (this.callSeq.has(parent)) return
      this.orphanParents.add(parent)
    }
    switch (e.type) {
      case "tool_result": {
        const id = str(p.id)
        const seq = this.toolSeq.get(id)
        const i = seq === undefined ? -1 : this.at(seq)
        const it = i >= 0 ? this.items[i] : undefined
        if (it && (it.kind === "tool" || it.kind === "subagent"))
          this.items[i] = this.withResult(it, e)
        else this.earlyResults.set(id, e)
        return
      }
      case "decision": {
        const id = str(p.requestId)
        const seq = this.requestSeq.get(id)
        const i = seq === undefined ? -1 : this.at(seq)
        const it = i >= 0 ? this.items[i] : undefined
        if (it && it.kind === "request") {
          this.items[i] = {
            ...it,
            pending: false,
            decision: { outcome: str(p.outcome), by: str(p.by) },
          }
        } else this.earlyDecisions.set(id, e)
        return
      }
      case "tool_call": {
        const id = str(p.id)
        this.callSeq.set(id, e.seq)
        // Its subagent's events were already shown on top: they belong to its drawer.
        if (this.orphanParents.has(id)) this.needRebuild = true
        break
      }
      default:
        break
    }
    const item = this.itemOf(e)
    if (!item) return
    this.push(item)
  }

  private push(item: TranscriptItem): void {
    if (this.runStart === undefined && this.items.length === 0) this.runStart = item.at
    if (item.kind === "dim" && item.type === "status") {
      if (item.status === "queued") {
        this.newRun = true
        this.lastResultSeq = undefined
      } else if (item.status === "running" && this.newRun) {
        this.runStart = item.at
        this.newRun = false
      } else if (RUN_END_STATUSES.has(item.status) && this.lastResultSeq !== undefined) {
        // W1-D10: the run's card says how the run ended, as the status line does.
        const i = this.at(this.lastResultSeq)
        const card = i >= 0 ? this.items[i] : undefined
        if (card?.kind === "result") this.items[i] = { ...card, endStatus: item.status }
      }
    } else if (item.kind === "result") {
      // Walk D15: only the run's last result is a card, timed from its run's start.
      if (this.lastResultSeq !== undefined) {
        const i = this.at(this.lastResultSeq)
        if (i >= 0) this.items.splice(i, 1)
      }
      this.lastResultSeq = item.seq
      const elapsed = this.runStart ? durationBetween(this.runStart, item.at) : undefined
      if (elapsed !== undefined) item.elapsedMs = elapsed
    } else if (item.kind === "user" && this.firstUserSeq === undefined) {
      this.firstUserSeq = item.seq
    }
    const last = this.items.at(-1)
    if (!last || last.seq < item.seq) this.items.push(item)
    else this.items.splice(lowerBound(this.items, item.seq), 0, item)
    if (item.kind === "tool" || item.kind === "subagent") this.toolSeq.set(item.id, item.seq)
    else if (item.kind === "request") this.requestSeq.set(item.requestId, item.seq)
  }

  private itemOf(e: HeldEvent): TranscriptItem | null {
    const p = e.payload
    const ctx = this.ctx as PathContext
    const shown = this.shown
    switch (e.type) {
      case "user_message": {
        // Final walk F5b: the node's own "continue" after an offline resume
        // is not the owner's words; it is a dim system line.
        if (p.synthetic === true) {
          return {
            ...base(e),
            kind: "dim",
            type: "system",
            subtype: "auto_continue",
            text: shown(str(p.text)),
          }
        }
        const item: UserItem = { ...base(e), kind: "user", text: shown(str(p.text)) }
        if (str(p.commandId)) item.commandId = str(p.commandId)
        const elided = textElidedOf(e)
        if (elided) item.textElided = elided
        return item
      }
      case "assistant_text":
      case "thinking": {
        const item: TextItem | ThinkingItem = {
          ...base(e),
          kind: e.type === "thinking" ? "thinking" : "text",
          text: shown(str(p.text)),
        }
        const elided = textElidedOf(e)
        if (elided) item.textElided = elided
        return item
      }
      case "tool_call": {
        const id = str(p.id)
        // No name: the row names it from the catalogue (kernel.nodeSessions.transcript.tool).
        const name = str(p.name)
        let tool: Omit<ToolItem, "kind"> = {
          ...base(e),
          id,
          name,
          input: p.input,
          argument: toolArgument(name, p.input, ctx),
          running: this.live,
          truncated: e.truncated === true,
        }
        const inputElided = inputElidedOf(e)
        if (inputElided) tool.inputElided = inputElided
        const r = this.earlyResults.get(id)
        if (r) {
          this.earlyResults.delete(id)
          tool = this.withResult(tool, r)
        }
        if (SUBAGENT_TOOLS.has(name)) {
          const input = rec(p.input)
          return {
            ...tool,
            kind: "subagent",
            // No type: the reference names it from the catalogue (transcript.subagent).
            title: str(input.subagent_type),
            description: shown(str(input.description)),
            model: str(input.model) || null,
          }
        }
        return { ...tool, kind: "tool" }
      }
      case "permission_request":
      case "question":
      case "plan_request": {
        const requestId = str(p.requestId)
        const d = this.earlyDecisions.get(requestId)
        if (d) this.earlyDecisions.delete(requestId)
        const tool =
          e.type === "permission_request"
            ? str(p.tool)
            : e.type === "question"
              ? "AskUserQuestion"
              : "ExitPlanMode"
        const item: RequestItem = {
          ...base(e),
          kind: "request",
          requestType: e.type,
          requestId,
          tool,
          input: p.input,
          argument: e.type === "permission_request" ? toolArgument(tool, p.input, ctx) : "",
          reason: shown(str(p.reason)),
          ...(e.type === "permission_request" ? browserTestOf(p.browserTest) : {}),
          questions: e.type === "question" ? parseQuestions(p.questions, shown) : [],
          plan: e.type === "plan_request" ? shown(str(p.plan)) : "",
          pending: !d,
        }
        if (d) item.decision = { outcome: str(d.payload.outcome), by: str(d.payload.by) }
        return item
      }
      case "system": {
        // S54: a subagent's task events feed the Subagents panel, never a line here.
        if (TASK_SUBTYPES.has(str(p.subtype))) return null
        const facts = systemFacts(p.data)
        return {
          ...base(e),
          kind: "dim",
          type: "system",
          subtype: str(p.subtype),
          text: firstLine(shown(str(p.text))),
          ...(facts ? { facts } : {}),
        }
      }
      case "status":
        return {
          ...base(e),
          kind: "dim",
          type: "status",
          status: str(p.status),
          reason: shown(str(p.reason)),
          ...(str(p.code) ? { code: str(p.code) } : {}),
        }
      case "model_changed":
      case "level_changed":
        return { ...base(e), kind: "dim", type: e.type, from: str(p.from), to: str(p.to) }
      case "resumed":
        return { ...base(e), kind: "dim", type: "resumed", after: str(p.after) }
      case "result": {
        const item: ResultItem = {
          ...base(e),
          kind: "result",
          text: shown(str(p.text)),
          isError: p.isError === true,
          subtype: str(p.subtype),
        }
        if (str(p.branch)) item.branch = str(p.branch)
        if (typeof p.pushed === "boolean") item.pushed = p.pushed
        if (str(p.prUrl)) item.prUrl = str(p.prUrl)
        return item
      }
      default:
        return null
    }
  }
}

/** The statuses a run ends in; its result card takes the one that follows it. */
const RUN_END_STATUSES = new Set(["done", "needs_you", "failed", "stopped"])

function isSorted(events: readonly HeldEvent[]): boolean {
  for (let i = 1; i < events.length; i++) if (events[i].seq < events[i - 1].seq) return false
  return true
}

/** Build the items of a session's events (already in seq order, or sorted here). */
export function buildTranscript(
  events: readonly HeldEvent[],
  opts: TranscriptOptions,
): TranscriptItem[] {
  const sorted = isSorted(events) ? [...events] : [...events].sort((a, b) => a.seq - b.seq)
  return new TranscriptModel().sync(sorted, opts)
}

/** S56: an elided output's stub (the store dropped a large old output; refetched on demand). */
export interface ElidedOutput {
  /** The tool result event's seq, to read it again. */
  seq: number
  lines: number
  chars: number
}

/** S56: an elided input's stub (the store dropped a large old input; refetched on demand). */
export interface ElidedInput {
  /** The tool call event's seq, to read it again. */
  seq: number
  chars: number
}

/** S58: a long message's stub (its start kept; the whole read again on screen). */
export interface ElidedText {
  /** The message event's seq, to read it again. */
  seq: number
  chars: number
}

function textElidedOf(e: HeldEvent): ElidedText | undefined {
  const el = rec(e.payload.textElided)
  return typeof el.chars === "number" ? { seq: e.seq, chars: el.chars } : undefined
}

function inputElidedOf(e: HeldEvent): ElidedInput | undefined {
  const el = rec(e.payload.inputElided)
  return typeof el.chars === "number" ? { seq: e.seq, chars: el.chars } : undefined
}

function elidedOf(e: HeldEvent): ElidedOutput | undefined {
  const el = rec(e.payload.elided)
  if (typeof el.chars !== "number") return undefined
  return { seq: e.seq, lines: typeof el.lines === "number" ? el.lines : 0, chars: el.chars }
}

export interface SessionPlan {
  items: NodeSessionTodoItem[]
  done: number
  total: number
  /** The in_progress item's active form (else its content), or null. */
  current: string | null
}

/** The pinned plan: the last `todo` event (TodoWrite or the Task* list), or null. */
export function latestPlan(
  events: readonly NodeSessionEvent[],
  ctx: PathContext,
): SessionPlan | null {
  const shown = (text: string) => relativizePaths(text, ctx)
  const e = foldOf(events).lastTodo
  if (!e) return null
  const raw = Array.isArray(e.payload.items) ? e.payload.items : []
  const items = raw
    .map((x) => rec(x))
    .map((x) => {
      const item: NodeSessionTodoItem = {
        content: shown(str(x.content)),
        status: str(x.status),
      }
      if (str(x.activeForm)) item.activeForm = shown(str(x.activeForm))
      return item
    })
  const inProgress = items.find((it) => it.status === "in_progress")
  return {
    items,
    done: items.filter((it) => it.status === "completed").length,
    total: items.length,
    current: inProgress ? (inProgress.activeForm ?? inProgress.content) : null,
  }
}

export interface PendingRequest {
  requestId: string
  type: RequestType
  /** The tool a permission asks for; AskUserQuestion or ExitPlanMode otherwise. */
  tool: string
  seq: number
}

/** Requests with no decision yet, in seq order (folded as they arrive, S56). */
export function pendingRequests(events: readonly NodeSessionEvent[]): PendingRequest[] {
  return foldOf(events).pending()
}

export function oldestPending(events: readonly NodeSessionEvent[]): PendingRequest | null {
  return pendingRequests(events)[0] ?? null
}

/** The path context of a session: its row and the start event's cwd. */
export function sessionPathContext(
  row: { id: string; folderName?: string | null; repo?: string | null },
  events: readonly NodeSessionEvent[],
  cwd?: string | null,
): PathContext {
  return {
    cwd: cwd ?? startCwd(events),
    folderName: row.folderName ?? null,
    sessionId: row.id,
    repo: row.repo ?? null,
  }
}

/** The session's working directory, when the start `system` event names it (P3 seam). */
export function startCwd(events: readonly NodeSessionEvent[]): string | null {
  return foldOf(events).startCwd
}

/** S52: the first start event's cwd below its shared folder, as the node matched it (null: unknown). */
export function startFolderRel(events: readonly NodeSessionEvent[]): string | null {
  return foldOf(events).startFolderRel
}

/** The latest activity line while the session runs: the last tool's name and argument. */
export function latestActivity(items: readonly TranscriptItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === "tool" || it.kind === "subagent") {
      const parts = [it.name, it.argument].filter(Boolean)
      if (parts.length > 0) return parts.join(" · ")
      continue
    }
    if (it.kind === "text") return firstLine(it.text) || null
  }
  return null
}

/** The facts a system line is said from (D15): codes and names only, never a path. */
const SYSTEM_FACTS = [
  // A rate limit notice's state (walk D12).
  "status",
  "claudeCodeVersion",
  "claudeCodeSource",
  "level",
  "hooksOff",
  "userKeysNotMirrored",
  "mcpSkipped",
  "tool",
  "count",
  // S32: an auto-continue's consecutive count; S33: the autonomy switched to.
  "n",
  "to",
  // A43: an import's replay start and its Claude Code; A45, A60: the follow's notes.
  "historyFrom",
  "from",
  "state",
  "why",
  "skippedLine",
  "subagentsOmitted",
  // D49 F5: the lines a Take over's catch-up left on the computer.
  "olderLinesOmitted",
] as const

function systemFacts(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of SYSTEM_FACTS) {
    if (d[k] === undefined) continue
    out[k] =
      k === "mcpSkipped" && Array.isArray(d[k])
        ? (d[k] as unknown[]).map((m) => ({ name: (m as { name?: unknown } | null)?.name }))
        : d[k]
  }
  return Object.keys(out).length > 0 ? out : undefined
}
