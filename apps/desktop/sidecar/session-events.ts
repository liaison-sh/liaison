// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE SESSION EVENT NORMALISER AND BATCHER (P1-T35; spec-protocol.md
// §Events, S5, S7, C6, A43).
//
// `normalize` turns one SDK message into zero or more protocol events
// (packages/shared node-session-protocol): assistant content blocks become
// `assistant_text`, `thinking` and `tool_call`; a TodoWrite tool_call also
// rebuilds the todo list, and so does a TaskCreate/TaskUpdate pair, tracked
// in `NormalizeState`; a user message's tool_result blocks become
// `tool_result`; usage becomes one `usage` event for a `message.id`'s first
// chunk (same figures as `UsageCounter`, unattended.ts:176-220), carrying the
// cache split (`cacheRead`, `cacheWrite5m`, `cacheWrite1h`) and, on the main
// thread only, `contextTokens` (input + cache read + cache write, S21); a
// later chunk adds one more `usage` event for what grew (walk D19); a result
// message becomes `result`, with the main model's `contextWindow` from
// `modelUsage` (S21; branch/pushed/prUrl are T36's, added once the run path
// knows them); a compact boundary, an API retry and a rate-limit event all
// become `system`, and so do the task events `task_started`,
// `task_progress`, `task_updated` and `task_notification` (S19): subagents
// and background shells alike, top level (no `parentToolUseId`), their
// `data` a fixed allowlist (`taskData`) that never carries the prompt, the
// output file or resource links. Every other SDK message type is dropped and counted in
// `state.dropped` — this module never emits a raw SDK message. Every event
// goes through `capEvent` before it leaves `normalize`.
//
// `EventBatcher` collects normalised events and flushes a `session_events`
// line at 250 ms, at 64 events, or when the batch would cross the server's
// byte limit minus its margin (`NODE_EVENT_LIMITS.batchBytes -
// nodeBatchMargin`, K4) — checked before an event is added, so a flushed
// batch never itself crosses that line (mirrors `splitIntoBatches`, T02).

import { closeSync, fsyncSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs"
import path from "node:path"
import {
  batchBytes,
  capEvent,
  NODE_EVENT_LIMITS,
  type NodeSessionEventIn,
  type NodeSessionEventType,
  type NodeSessionTodoItem,
  TOOL_USE_ID_RE,
} from "../../../packages/shared/src/node-session-protocol"
import { readRegularFileNoFollow } from "./safe-read"

// ---- normalize ----

interface TaskEntry {
  content: string
  status: string
  activeForm?: string
}

/** Carried across calls to `normalize` for one session's whole run. */
export interface NormalizeState {
  /** The emitter's clock; overridable in tests. */
  now: () => string
  /** How many whole SDK messages were of a type `normalize` does not handle. */
  dropped: number
  /** The usage event already returned for a given `message.id`, mutated in place on repeat. */
  /** Walk D19: per message, the usage totals already sent (never the sent event itself). */
  usageByMessageId: Map<string, NodeSessionEventIn>
  /** Walk D19: what this process's usage events added up to, for the result's reconciliation. */
  usageSent?: { tokensIn: number; tokensOut: number }
  /** Final walk F6b: the model of the main thread's latest message (the one in use). */
  mainModel?: string
  /** The live task list, rebuilt by TaskCreate/TaskUpdate, keyed by the real `taskId`. */
  tasks: Map<string, TaskEntry>
  /**
   * A TaskCreate call waiting for its `taskId`: TaskCreateInput names no id
   * (only TaskCreateOutput mints one), so the entry is provisional, keyed by
   * the tool_use id, until the matching tool_result's `tool_use_result`
   * resolves it into `tasks`.
   */
  pendingTaskCreates: Map<string, TaskEntry>
  /**
   * P3-T19 (S7, D3): keeps the whole output of a tool_result the event cuts
   * (over `NODE_EVENT_LIMITS.fieldBytes`) on this computer, before capping.
   */
  spill?: (toolUseId: string, output: string) => void
  /**
   * Walk D8: the folder Claude Code persists large outputs under (the
   * session's config dir). A `<persisted-output>` result's file is read only
   * from inside it.
   */
  persistedRoot?: string
  /**
   * W3 (S43, A59): applied to every event BEFORE its cap, so a redactor sees
   * each field whole (a key cut at the 64 KiB edge would leave a prefix no
   * pattern recognises). The follow host sets the import redaction here.
   */
  redact?: (e: NodeSessionEventIn) => NodeSessionEventIn
}

/** The most of one tool output a spill file keeps. */
export const SPILL_MAX_BYTES = 20 * 1024 * 1024
export const SPILL_CUT_LINE = "\n… cut at 20 MiB"

/**
 * Writes a cut output whole to `<sessionDir>/spill/<toolUseId>.txt` (dir
 * 0700, file 0600), 20 MiB at most then a last line saying so. A tool use id
 * that is not `toolu_…` writes nothing (it names the file).
 */
export function spillWriter(sessionDir: string): (toolUseId: string, output: string) => void {
  return (toolUseId, output) => {
    if (!TOOL_USE_ID_RE.test(toolUseId)) return
    const dir = path.join(sessionDir, "spill")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let bytes = Buffer.from(output, "utf8")
    if (bytes.length > SPILL_MAX_BYTES) {
      // Cut on a character boundary: back off continuation bytes (10xxxxxx).
      let end = SPILL_MAX_BYTES
      while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--
      bytes = Buffer.concat([bytes.subarray(0, end), Buffer.from(SPILL_CUT_LINE, "utf8")])
    }
    const fd = openSync(path.join(dir, `${toolUseId}.txt`), "w", 0o600)
    try {
      writeSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

export function createNormalizeState(
  now: () => string = () => new Date().toISOString(),
): NormalizeState {
  return {
    now,
    dropped: 0,
    usageByMessageId: new Map(),
    tasks: new Map(),
    pendingTaskCreates: new Map(),
  }
}

// Loosely typed, like UsageCounter.add (unattended.ts): fixtures and real SDK
// messages are read through the same narrow shape, not the SDK's full union.
interface LooseContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

interface LooseMessage {
  type?: string
  subtype?: string
  parent_tool_use_id?: string | null
  message?: {
    id?: string
    model?: string
    content?: LooseContentBlock[] | string
    usage?: Record<string, unknown>
  }
  /** SDKUserMessage's structured tool output, sibling to `message` (sdk.d.ts). */
  tool_use_result?: unknown
  result?: string
  is_error?: boolean
  // compact_boundary (system)
  compact_metadata?: unknown
  // api_retry (system)
  attempt?: number
  max_retries?: number
  // rate_limit_event
  rate_limit_info?: unknown
}

function makeEvent(
  state: NormalizeState,
  type: NodeSessionEventType,
  payload: Record<string, unknown>,
  parentToolUseId?: string | null,
): NodeSessionEventIn {
  const event: NodeSessionEventIn = {
    at: state.now(),
    type,
    payload,
    ...(parentToolUseId ? { parentToolUseId } : {}),
  }
  return capEvent(state.redact ? state.redact(event) : event)
}

function toolResultOutput(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && (block as LooseContentBlock).type === "text") {
          return (block as LooseContentBlock).text ?? ""
        }
        return JSON.stringify(block)
      })
      .join("\n")
  }
  if (content == null) return ""
  return JSON.stringify(content)
}

function todoItemsFromInput(input: unknown): NodeSessionTodoItem[] {
  const rec = input as { todos?: unknown }
  const todos = Array.isArray(rec?.todos) ? rec.todos : []
  return todos.map((t) => {
    const item = t as { content?: unknown; status?: unknown; activeForm?: unknown }
    return {
      content: typeof item.content === "string" ? item.content : "",
      status: typeof item.status === "string" ? item.status : "pending",
      ...(typeof item.activeForm === "string" ? { activeForm: item.activeForm } : {}),
    }
  })
}

function taskListItems(state: NormalizeState): NodeSessionTodoItem[] {
  return [...state.tasks.values()].map((t) => ({
    content: t.content,
    status: t.status,
    ...(t.activeForm ? { activeForm: t.activeForm } : {}),
  }))
}

/** Stash a TaskCreate call by its tool_use id, until its tool_result mints the real id. */
function stashTaskCreate(state: NormalizeState, toolUseId: string, input: unknown): void {
  const rec = input as { subject?: unknown; activeForm?: unknown }
  state.pendingTaskCreates.set(toolUseId, {
    content: typeof rec.subject === "string" ? rec.subject : "",
    status: "pending",
    ...(typeof rec.activeForm === "string" ? { activeForm: rec.activeForm } : {}),
  })
}

/** Resolve a stashed TaskCreate once its tool_result's structured output names the real id. */
function resolveTaskCreate(
  state: NormalizeState,
  toolUseId: string,
  toolUseResult: unknown,
): boolean {
  const pending = state.pendingTaskCreates.get(toolUseId)
  if (!pending) return false
  const task = (toolUseResult as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
  const taskId = typeof task?.id === "string" ? task.id : undefined
  if (!taskId) return false
  state.pendingTaskCreates.delete(toolUseId)
  state.tasks.set(taskId, {
    ...pending,
    content: typeof task?.subject === "string" ? task.subject : pending.content,
  })
  return true
}

function applyTaskUpdate(state: NormalizeState, input: unknown): void {
  const rec = input as {
    taskId?: unknown
    subject?: unknown
    activeForm?: unknown
    status?: unknown
  }
  const taskId = typeof rec.taskId === "string" ? rec.taskId : undefined
  if (!taskId) return
  if (rec.status === "deleted") {
    state.tasks.delete(taskId)
    return
  }
  const existing = state.tasks.get(taskId) ?? { content: "", status: "pending" }
  state.tasks.set(taskId, {
    content: typeof rec.subject === "string" ? rec.subject : existing.content,
    status: typeof rec.status === "string" ? rec.status : existing.status,
    activeForm: typeof rec.activeForm === "string" ? rec.activeForm : existing.activeForm,
  })
}

/** A finite number, else 0: usage fields may be absent or null. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

/** The S17 usage figures (A34): input tokens, cached ones included, plus output tokens. */
function usagePayload(usage: Record<string, unknown>, model: string): Record<string, unknown> {
  const cached = num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens)
  const tokensIn = num(usage.input_tokens) + cached
  const tokensOut = num(usage.output_tokens)
  return { tokensIn, tokensOut, model }
}

/**
 * S21: the first chunk's cache split (GF-14). `cache_creation` holds the 5 min
 * and 1 h writes; absent, both are 0. `contextTokens` (what the prompt held)
 * only for the main thread: a subagent's context is not the session's.
 */
function cacheFields(usage: Record<string, unknown>, mainThread: boolean): Record<string, number> {
  const split = (usage.cache_creation ?? {}) as Record<string, unknown>
  const cacheRead = num(usage.cache_read_input_tokens)
  return {
    cacheRead,
    cacheWrite5m: num(split.ephemeral_5m_input_tokens),
    cacheWrite1h: num(split.ephemeral_1h_input_tokens),
    ...(mainThread
      ? {
          contextTokens:
            num(usage.input_tokens) + cacheRead + num(usage.cache_creation_input_tokens),
        }
      : {}),
  }
}

/**
 * Walk D19: the CLI repeats a streamed message's usage on every chunk, its
 * output count growing (the first chunk's is message_start's, a handful of
 * tokens). The first chunk's event is sent at once, so a later figure never
 * reaches the server by changing it: each later chunk adds an event for what
 * grew since, and a message's events add up to its latest figures.
 */
function handleUsage(state: NormalizeState, m: LooseMessage, events: NodeSessionEventIn[]): void {
  const msg = m.message
  if (!msg?.usage || !msg.id) return
  const payload = usagePayload(msg.usage, msg.model ?? "")
  if (!m.parent_tool_use_id && msg.model) state.mainModel = msg.model
  const tokensIn = payload.tokensIn as number
  const tokensOut = payload.tokensOut as number
  const sent = state.usageByMessageId.get(msg.id)
  if (sent) {
    const moreIn = Math.max(0, tokensIn - (sent.payload.tokensIn as number))
    const moreOut = Math.max(0, tokensOut - (sent.payload.tokensOut as number))
    if (moreIn === 0 && moreOut === 0) return
    addSent(state, moreIn, moreOut)
    sent.payload = {
      ...sent.payload,
      tokensIn: Math.max(tokensIn, sent.payload.tokensIn as number),
      tokensOut: Math.max(tokensOut, sent.payload.tokensOut as number),
    }
    events.push(
      makeEvent(
        state,
        "usage",
        { tokensIn: moreIn, tokensOut: moreOut, model: payload.model },
        m.parent_tool_use_id,
      ),
    )
    return
  }
  // The running totals of the message, apart from the event that was sent.
  state.usageByMessageId.set(msg.id, { ...makeEvent(state, "usage", payload) })
  addSent(state, tokensIn, tokensOut)
  events.push(
    makeEvent(
      state,
      "usage",
      { ...payload, ...cacheFields(msg.usage, !m.parent_tool_use_id) },
      m.parent_tool_use_id,
    ),
  )
}

function addSent(state: NormalizeState, tokensIn: number, tokensOut: number): void {
  const sent = state.usageSent ?? { tokensIn: 0, tokensOut: 0 }
  state.usageSent = { tokensIn: sent.tokensIn + tokensIn, tokensOut: sent.tokensOut + tokensOut }
}

/**
 * Walk D19: the CLI's streamed messages carry only their start's output count
 * (a handful of tokens each); the real counts come with each result, in
 * `modelUsage`, cumulative over the process and every model it called. What
 * those totals hold beyond what the usage events already said goes in one
 * more usage event, so the session's sum is the CLI's own.
 */
function reconcileUsage(state: NormalizeState, m: LooseMessage): NodeSessionEventIn[] {
  const byModel = (m as { modelUsage?: Record<string, Record<string, unknown>> }).modelUsage
  if (!byModel || typeof byModel !== "object") return []
  const n = num
  let tokensIn = 0
  let tokensOut = 0
  let main = ""
  let mainOut = -1
  for (const [model, u] of Object.entries(byModel)) {
    if (!u || typeof u !== "object") continue
    const out = n(u.outputTokens)
    tokensIn += n(u.inputTokens) + n(u.cacheReadInputTokens) + n(u.cacheCreationInputTokens)
    tokensOut += out
    if (out > mainOut) {
      main = model
      mainOut = out
    }
  }
  // F6b: modelUsage is cumulative over the process, so after a switch the old
  // model still has the most tokens; the model in use is the main thread's.
  if (state.mainModel) main = state.mainModel
  const sent = state.usageSent ?? { tokensIn: 0, tokensOut: 0 }
  const moreIn = Math.max(0, tokensIn - sent.tokensIn)
  const moreOut = Math.max(0, tokensOut - sent.tokensOut)
  if (moreIn === 0 && moreOut === 0) return []
  addSent(state, moreIn, moreOut)
  return [makeEvent(state, "usage", { tokensIn: moreIn, tokensOut: moreOut, model: main })]
}

function handleAssistant(state: NormalizeState, m: LooseMessage): NodeSessionEventIn[] {
  const events: NodeSessionEventIn[] = []
  const parent = m.parent_tool_use_id
  const content = m.message?.content
  const blocks = Array.isArray(content) ? content : []
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        events.push(makeEvent(state, "assistant_text", { text: block.text ?? "" }, parent))
        break
      case "thinking":
        events.push(makeEvent(state, "thinking", { text: block.thinking ?? "" }, parent))
        break
      case "tool_use": {
        const id = block.id ?? ""
        const name = block.name ?? ""
        events.push(makeEvent(state, "tool_call", { id, name, input: block.input }, parent))
        if (name === "TodoWrite") {
          events.push(
            makeEvent(
              state,
              "todo",
              { items: todoItemsFromInput(block.input), from: "TodoWrite" },
              parent,
            ),
          )
        } else if (name === "TaskCreate") {
          // No todo event yet: TaskCreateInput names no id, so the list has
          // nothing new to show until the matching tool_result resolves it
          // (handleUser, resolveTaskCreate).
          stashTaskCreate(state, id, block.input)
        } else if (name === "TaskUpdate") {
          applyTaskUpdate(state, block.input)
          events.push(
            makeEvent(state, "todo", { items: taskListItems(state), from: "Task" }, parent),
          )
        }
        break
      }
      default:
        break
    }
  }
  handleUsage(state, m, events)
  return events
}

/**
 * Walk D8: Claude Code (2.1.29x) cuts a large tool output itself and answers
 * with its own markup instead: `<persisted-output>`, the size, the file it
 * saved the whole output to and a 2 KB preview; or `<truncated-output>` and a
 * notice when it could not save it. The parts, or null for anything else.
 */
export function parseCliCutOutput(
  output: string,
): { kind: "persisted"; path: string; preview: string } | { kind: "dropped"; text: string } | null {
  const persisted =
    /^<persisted-output>\n(?:Output too large \([^)\n]*\)\. Full output saved to: |Output exceeded the [^\n]* persist limit; only the first [^\n]* were saved to: )([^\n]+)\nPreview \(first [^)\n]*\):\n([\s\S]*?)\n?<\/persisted-output>\s*$/.exec(
      output,
    )
  if (persisted) {
    return { kind: "persisted", path: persisted[1] as string, preview: persisted[2] as string }
  }
  const dropped = /^<truncated-output>\n([\s\S]*?)\n?<\/truncated-output>\s*$/.exec(output)
  return dropped ? { kind: "dropped", text: dropped[1] as string } : null
}

/** Walk D8: the file a `<persisted-output>` names, when it lies under the root; else null. */
function readPersisted(file: string, root: string | undefined): string | null {
  if (!root || !path.isAbsolute(file) || !file.endsWith(".txt")) return null
  try {
    const real = realpathSync(file)
    const base = realpathSync(root)
    if (!real.startsWith(`${base}${path.sep}`)) return null
    if (path.basename(path.dirname(real)) !== "tool-results") return null
    // Opened once, no symlink followed, checked through the open descriptor.
    return readRegularFileNoFollow(real, SPILL_MAX_BYTES * 2)
  } catch {
    return null
  }
}

function handleUser(state: NormalizeState, m: LooseMessage): NodeSessionEventIn[] {
  const events: NodeSessionEventIn[] = []
  const parent = m.parent_tool_use_id
  const content = m.message?.content
  const blocks = Array.isArray(content) ? content : []
  for (const block of blocks) {
    if (block.type !== "tool_result") continue
    let output = toolResultOutput(block.content)
    // Walk D8: never the CLI's markup; its saved file is this run's full output.
    let persistedBytes: number | null = null
    const cut = parseCliCutOutput(output)
    if (cut?.kind === "dropped") output = cut.text
    else if (cut?.kind === "persisted") {
      const whole = readPersisted(cut.path, state.persistedRoot)
      output = cut.preview
      if (whole !== null && state.spill) {
        try {
          state.spill(block.tool_use_id ?? "", whole)
          persistedBytes = Buffer.byteLength(whole, "utf8")
        } catch {
          // No spill file: the preview alone.
        }
      }
    }
    if (state.spill && Buffer.byteLength(output, "utf8") > NODE_EVENT_LIMITS.fieldBytes) {
      try {
        state.spill(block.tool_use_id ?? "", output)
      } catch {
        // No spill file: the cut event alone, as before.
      }
    }
    const result = makeEvent(
      state,
      "tool_result",
      {
        id: block.tool_use_id ?? "",
        isError: block.is_error ?? false,
        output,
      },
      parent,
    )
    events.push(
      persistedBytes === null ? result : { ...result, truncated: true, fullBytes: persistedBytes },
    )
    if (resolveTaskCreate(state, block.tool_use_id ?? "", m.tool_use_result)) {
      events.push(makeEvent(state, "todo", { items: taskListItems(state), from: "Task" }, parent))
    }
  }
  return events
}

function handleResult(state: NormalizeState, m: LooseMessage): NodeSessionEventIn[] {
  // S21: the size of the main model's window (sdk.d.ts ModelUsage.contextWindow).
  const byModel = (m as { modelUsage?: Record<string, { contextWindow?: unknown } | null> })
    .modelUsage
  const window = state.mainModel ? byModel?.[state.mainModel]?.contextWindow : undefined
  return [
    ...reconcileUsage(state, m),
    makeEvent(state, "result", {
      text: m.result ?? "",
      isError: m.is_error ?? false,
      subtype: m.subtype ?? "",
      ...(typeof window === "number" && Number.isFinite(window) ? { contextWindow: window } : {}),
    }),
  ]
}

/** S19: the task event subtypes forwarded as `system` events. */
const TASK_SUBTYPES = new Set([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
])

/** The most of a task's description (or summary) a `system` event's text carries. */
const TASK_TEXT_MAX = 200

/**
 * S19 (D6, D20, D21): the fields of a task_* message a subagent panel needs,
 * renamed to the protocol's camelCase. An allowlist: the prompt, the output
 * file and resource links never leave the computer. `task_updated` carries
 * its changes in `patch`. Read loosely, the SDK's types are not imported.
 */
function taskData(m: Record<string, unknown>): Record<string, unknown> {
  const patch = (m.patch && typeof m.patch === "object" ? m.patch : {}) as Record<string, unknown>
  const usage = (m.usage && typeof m.usage === "object" ? m.usage : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" ? v : undefined)
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined)
  const cut = (v: string | undefined) => v?.slice(0, TASK_TEXT_MAX)
  const fields: Record<string, unknown> = {
    taskId: str(m.task_id) ?? "",
    runId: str(m.run_id),
    toolUseId: str(m.tool_use_id),
    parentTaskId: str(m.parent_task_id),
    taskType: str(m.task_type),
    subagentType: str(m.subagent_type),
    workflowName: str(m.workflow_name),
    description: cut(str(m.description) ?? str(patch.description)),
    status: str(m.status) ?? str(patch.status),
    reason: str(m.reason),
    summary: cut(str(m.summary)),
    error: cut(str(patch.error)),
    endTime: n(patch.end_time),
    totalTokens: n(usage.total_tokens),
    toolUses: n(usage.tool_uses),
    durationMs: n(usage.duration_ms),
    lastToolName: str(m.last_tool_name),
    isBackgrounded: bool(m.is_backgrounded) ?? bool(patch.is_backgrounded),
    spawnDepth: n(m.spawn_depth),
    skipTranscript: bool(m.skip_transcript),
    ambient: bool(m.ambient),
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
}

function handleTask(state: NormalizeState, m: LooseMessage): NodeSessionEventIn[] {
  const data = taskData(m as Record<string, unknown>)
  const text = (data.description as string | undefined) ?? (data.status as string | undefined) ?? ""
  return [makeEvent(state, "system", { subtype: m.subtype, text, data })]
}

function handleSystem(state: NormalizeState, m: LooseMessage): NodeSessionEventIn[] | null {
  if (m.subtype === "compact_boundary") {
    return [
      makeEvent(state, "system", {
        subtype: "compact_boundary",
        text: "Context compacted",
        data: m.compact_metadata,
      }),
    ]
  }
  if (m.subtype && TASK_SUBTYPES.has(m.subtype)) return handleTask(state, m)
  if (m.subtype === "api_retry") {
    return [
      makeEvent(state, "system", {
        subtype: "api_retry",
        text: `API retry ${m.attempt ?? "?"}/${m.max_retries ?? "?"}`,
        data: m,
      }),
    ]
  }
  return null
}

function handleRateLimit(state: NormalizeState, m: LooseMessage): NodeSessionEventIn[] {
  return [
    makeEvent(state, "system", {
      subtype: "rate_limit",
      text: "Rate limit status changed",
      data: m.rate_limit_info,
    }),
  ]
}

/** One SDK message in, zero or more capped protocol events out (spec-protocol.md §Events). */
export function normalize(message: unknown, state: NormalizeState): NodeSessionEventIn[] {
  const m = message as LooseMessage
  switch (m.type) {
    case "assistant":
      return handleAssistant(state, m)
    case "user":
      return handleUser(state, m)
    case "result":
      return handleResult(state, m)
    case "system": {
      // Walk D19: a new process (a restart) counts its usage from zero.
      if (m.subtype === "init") state.usageSent = { tokensIn: 0, tokensOut: 0 }
      const out = handleSystem(state, m)
      if (out) return out
      state.dropped++
      return []
    }
    case "rate_limit_event":
      return handleRateLimit(state, m)
    default:
      state.dropped++
      return []
  }
}

// ---- batcher ----

/** A line the sidecar writes to stdout: one flushed batch of events for one session. */
export interface SessionEventsLine {
  type: "session_events"
  sessionId: string
  events: NodeSessionEventIn[]
}

/** The timer primitives `EventBatcher` needs; overridable so tests never wait on a real 250 ms clock. */
export interface BatchClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemBatchClock: BatchClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface EventBatcherOptions {
  sessionId: string
  /** Called with a flushed batch; never called with an empty one. */
  flush: (line: SessionEventsLine) => void
  clock?: BatchClock
  /** Default 250 ms (S5, S7, C6). */
  flushMs?: number
  /** Default 64 (C6). */
  maxEvents?: number
  /** Default `NODE_EVENT_LIMITS.batchBytes - NODE_EVENT_LIMITS.nodeBatchMargin` (K4). */
  maxBytes?: number
}

const DEFAULT_FLUSH_MS = 250
const DEFAULT_MAX_EVENTS = 64

/**
 * Batches normalised events for one session: flushes on a 250 ms timer, at
 * 64 events, or just before a batch would cross the server's byte limit
 * (checked before the event that would cross it is added, so a flushed
 * batch's own bytes never cross that line — mirrors `splitIntoBatches`, T02).
 */
export class EventBatcher {
  private readonly sessionId: string
  private readonly onFlush: (line: SessionEventsLine) => void
  private readonly clock: BatchClock
  private readonly flushMs: number
  private readonly maxEvents: number
  private readonly maxBytes: number
  private pending: NodeSessionEventIn[] = []
  private timer: unknown = null

  constructor(options: EventBatcherOptions) {
    this.sessionId = options.sessionId
    this.onFlush = options.flush
    this.clock = options.clock ?? systemBatchClock
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.maxBytes =
      options.maxBytes ?? NODE_EVENT_LIMITS.batchBytes - NODE_EVENT_LIMITS.nodeBatchMargin
  }

  /** The events waiting to be flushed, read-only. */
  get pendingCount(): number {
    return this.pending.length
  }

  push(event: NodeSessionEventIn): void {
    if (this.pending.length > 0 && batchBytes([...this.pending, event]) > this.maxBytes) {
      this.flushNow()
    }
    this.pending.push(event)
    if (this.pending.length >= this.maxEvents || batchBytes(this.pending) > this.maxBytes) {
      this.flushNow()
      return
    }
    this.scheduleFlush()
  }

  pushAll(events: readonly NodeSessionEventIn[]): void {
    for (const e of events) this.push(e)
  }

  /** Flushes whatever is pending right now, timer included. A no-op when nothing is pending. */
  flushNow(): void {
    this.cancelTimer()
    if (this.pending.length === 0) return
    const events = this.pending
    this.pending = []
    this.onFlush({ type: "session_events", sessionId: this.sessionId, events })
  }

  /** Flushes and stops the timer: call when the run ends. */
  stop(): void {
    this.flushNow()
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      this.flushNow()
    }, this.flushMs)
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    this.clock.clearTimeout(this.timer)
    this.timer = null
  }
}
