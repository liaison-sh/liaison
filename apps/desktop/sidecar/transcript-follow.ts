// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE READ-ONLY FOLLOW OF A TRANSCRIPT (P1-T22; S51, owner D13; reused by
// W3's import Follow, which adds redaction). It is polled by the shell's one
// long-lived follow host (follow-host.ts, D28 b, A45), for every import follow
// and every in-place session another Claude Code drives, and by a Take over's
// catch-up (A62) once.
//
// While VS Code or a terminal drives an in-place owner session (session-
// driver.ts), Liaison does not run it: it tails the transcript the other
// Claude Code appends to, `<owner config>/projects/<slug>/<sdkSessionId>.jsonl`,
// from a byte offset, and turns each new whole line into protocol events
// through the same `normalize` the live run uses. Reads only: the file is
// opened read-only and never written, truncated or locked.
//
// A transcript line is not an SDK stream message: it is `{type, message,
// isSidechain, isMeta, ...}`. An assistant line is normalised as the SDK's
// assistant message; a user line gives its tool results through `normalize`
// and the text the person typed as `user_message` (no `commandId`: it did not
// come through Liaison); a `system` line goes through `normalize`, which keeps
// the subtypes it knows. Meta lines (slash-command echoes, injected context),
// sidechains (subagents, D20) and the CLI's bookkeeping lines
// (queue-operation, attachment, file-history-*, ai-title...) become nothing.
// A user line the CLI wrote itself (W3-D2: `origin.kind` other than human,
// `promptSource: "system"`, or one of its wrappers such as
// `<task-notification>`) is never the person: a task notification becomes a
// quiet `system notification` line, the rest nothing. A message the person
// sent during a turn, which 2.1.29x records only as a `queued_command`
// attachment, is their `user_message`.
// A partial last line waits for its newline; bytes are cut only at a newline,
// so a multi-byte character is never split.
//
// `driver()` emits the `system {subtype: "driver"}` event (S51) on each change
// of who drives, for the web's badge and its guarded send.

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import path from "node:path"
import {
  capEvent,
  type NodeSessionDriverData,
  type NodeSessionEventIn,
} from "../../../packages/shared/src/node-session-protocol"
import { createNormalizeState, type NormalizeState, normalize } from "./session-events"
import { findTranscript } from "./session-import"

/** What one poll reads at first; the rest comes on the next poll. */
export const FOLLOW_MAX_READ_BYTES = 1024 * 1024
/**
 * One line may be longer than a read (a large tool result): the read grows to
 * this before the line is given up (skipped to its end, its tail dropped as
 * bad JSON), so one huge line never stalls the follow.
 */
export const FOLLOW_MAX_LINE_BYTES = 64 * 1024 * 1024
/** How many Agent call ids a follow remembers (bounded memory on a huge session). */
const AGENT_CALLS_MAX = 4096

/**
 * The transcript of a session the CLI ran in `cwd`: the CLI names the project
 * folder after the cwd with every non-alphanumeric made `-`, and a slug over
 * 200 characters becomes `slice(0,200)-<hash>` (GF-68), found by the dir that
 * holds the id (session-import.ts `findTranscript`). Null for an id that is
 * not a UUID (it names the file), and for a long cwd with no single such dir.
 */
export function transcriptFile(
  configDir: string,
  cwd: string,
  sdkSessionId: string,
): string | null {
  const found = findTranscript(path.join(configDir, "projects"), cwd, sdkSessionId)
  return "file" in found ? found.file : null
}

/** The first line start at or after `from` (A43: the window starts at a line boundary). */
export function lineStart(file: string, from: number): number {
  if (from === 0) return 0
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return from
  }
  try {
    const buf = Buffer.alloc(64 * 1024)
    let at = from - 1
    for (;;) {
      const got = readSync(fd, buf, 0, buf.length, at)
      if (got <= 0) return at
      const nl = buf.subarray(0, got).indexOf(0x0a)
      if (nl >= 0) return at + nl + 1
      at += got
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * D49 F5: how many lines end in `[from, to)`, counted in 1 MiB reads (never
 * the whole range in memory); 0 when the file cannot be opened.
 */
export function countLines(file: string, from: number, to: number): number {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return 0
  }
  try {
    const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, to - from)))
    let n = 0
    for (let at = from; at < to; ) {
      const got = readSync(fd, buf, 0, Math.min(buf.length, to - at), at)
      if (got <= 0) break
      const view = buf.subarray(0, got)
      for (let i = view.indexOf(0x0a); i !== -1; i = view.indexOf(0x0a, i + 1)) n++
      at += got
    }
    return n
  } finally {
    closeSync(fd)
  }
}

export interface TranscriptFollowOptions {
  file: string
  /** Where to start: 0 replays the history, the file's size follows only what comes next. */
  offset?: number
  /** Every poll's events, in file order (the caller posts them through the batch ingest). */
  emit: (events: NodeSessionEventIn[]) => void
  now?: () => string
  state?: NormalizeState
  /** Tests: a smaller first read and line cap. */
  maxReadBytes?: number
  maxLineBytes?: number
  /**
   * W3 (A57): applied to every event before `emit` (the follow host passes
   * the import redaction, S43).
   */
  transform?: (e: NodeSessionEventIn) => NodeSessionEventIn
  /**
   * W3 (S44, A57): a subagent's own transcript. Every event carries this
   * `parentToolUseId`, and the file's `isSidechain` lines (all of them, the
   * CLI marks every subagent line so) are read; `isMeta` lines stay dropped.
   */
  parentToolUseId?: string
  /** W3 (A57): open with O_NOFOLLOW on every poll, so a swapped-in symlink is never read. */
  noFollowOpen?: boolean
  /**
   * What a file shorter than the offset does: `"restart"` (W1, the default)
   * reads it again from 0; `"end"` (W3, A57) reads nothing more and sets
   * `shrunk`, so the follow host ends it `transcript_gone`.
   */
  onShrink?: "restart" | "end"
}

interface TranscriptLine {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  origin?: unknown
  promptSource?: unknown
  attachment?: unknown
  message?: { content?: unknown }
  [key: string]: unknown
}

export class TranscriptFollow {
  /** The byte offset of the first line not yet read whole. */
  offset: number
  private readonly state: NormalizeState
  private readonly now: () => string
  private driven: NodeSessionDriverData | null = null
  /** Set once the file was found shorter than the offset under `onShrink: "end"`. */
  shrunk = false
  private readonly agentCalls = new Set<string>()

  constructor(private readonly o: TranscriptFollowOptions) {
    this.offset = o.offset ?? 0
    this.now = o.now ?? (() => new Date().toISOString())
    this.state = o.state ?? createNormalizeState(this.now)
  }

  /** Reads what was appended since the last poll; returns how many events it emitted. */
  poll(): number {
    const first = this.o.maxReadBytes ?? FOLLOW_MAX_READ_BYTES
    const cap = this.o.maxLineBytes ?? FOLLOW_MAX_LINE_BYTES
    let want = first
    let chunk = this.read(want)
    while (chunk && chunk.length === want && chunk.indexOf(0x0a) < 0 && want < cap) {
      want = Math.min(want * 2, cap)
      chunk = this.read(want)
    }
    if (!chunk) return 0
    const end = chunk.lastIndexOf(0x0a)
    if (end < 0) {
      // A line over the cap: skip what was read; its tail is dropped as bad JSON.
      if (chunk.length >= cap) this.offset += chunk.length
      return 0
    }
    this.offset += end + 1
    const events: NodeSessionEventIn[] = []
    for (const text of chunk.subarray(0, end).toString("utf8").split("\n")) {
      if (!text.trim()) continue
      let entry: TranscriptLine
      try {
        entry = JSON.parse(text) as TranscriptLine
      } catch {
        continue
      }
      events.push(...this.eventsOf(entry))
    }
    if (events.length) this.o.emit(this.o.transform ? events.map(this.o.transform) : events)
    return events.length
  }

  /** Says who drives, once per change (S51). */
  driver(next: NodeSessionDriverData): void {
    if (this.driven?.elsewhere === next.elsewhere && this.driven.via === next.via) return
    this.driven = { elsewhere: next.elsewhere, via: next.via }
    const event = capEvent({
      at: this.now(),
      type: "system",
      payload: {
        subtype: "driver",
        text: next.elsewhere
          ? `Driven from ${next.via === "vscode" ? "VS Code" : "another Claude Code"}`
          : "No longer driven elsewhere",
        data: { ...this.driven },
      },
    })
    this.o.emit([this.o.transform ? this.o.transform(event) : event])
  }

  private read(max: number): Buffer | null {
    let fd: number
    try {
      fd = openSync(
        this.o.file,
        this.o.noFollowOpen ? constants.O_RDONLY | constants.O_NOFOLLOW : "r",
      )
    } catch {
      return null
    }
    try {
      const size = fstatSync(fd).size
      // Rewritten shorter (never by Claude Code's append): start over, or end.
      if (size < this.offset) {
        if (this.o.onShrink === "end") {
          this.shrunk = true
          return null
        }
        this.offset = 0
      }
      if (this.shrunk) return null
      const length = Math.min(size - this.offset, max)
      if (length <= 0) return null
      const buf = Buffer.alloc(length)
      const got = readSync(fd, buf, 0, length, this.offset)
      return buf.subarray(0, got)
    } finally {
      closeSync(fd)
    }
  }

  /** The `Agent`/`Task` tool_use ids seen, so a notification can say it was a subagent's. */
  private noteAgentCalls(content: unknown): void {
    if (!Array.isArray(content)) return
    for (const b of content as { type?: unknown; id?: unknown; name?: unknown }[]) {
      if (
        b?.type === "tool_use" &&
        typeof b.id === "string" &&
        (b.name === "Agent" || b.name === "Task")
      ) {
        if (this.agentCalls.size >= AGENT_CALLS_MAX) this.agentCalls.clear()
        this.agentCalls.add(b.id)
      }
    }
  }

  /** The cap, after the state's redactor when it has one (it must see the whole field). */
  private capped(e: NodeSessionEventIn): NodeSessionEventIn {
    return capEvent(this.state.redact ? this.state.redact(e) : e)
  }

  private eventsOf(entry: TranscriptLine): NodeSessionEventIn[] {
    const parent = this.o.parentToolUseId ?? null
    if (entry.isMeta || (entry.isSidechain && parent === null)) return []
    switch (entry.type) {
      case "assistant":
        this.noteAgentCalls(entry.message?.content)
        return normalize({ ...entry, parent_tool_use_id: parent }, this.state)
      case "user": {
        const typed = typedText(entry.message?.content)
        const injected = typed ? this.injected(entry, typed, parent) : null
        if (injected) return injected
        const out = typed
          ? [
              this.capped({
                at: this.now(),
                type: "user_message",
                payload: { text: typed },
                ...(parent ? { parentToolUseId: parent } : {}),
              }),
            ]
          : []
        return [...out, ...normalize({ ...entry, parent_tool_use_id: parent }, this.state)]
      }
      case "system":
        return normalize(parent ? { ...entry, parent_tool_use_id: parent } : entry, this.state)
      case "attachment":
        return this.queuedCommand(entry.attachment, parent)
      default:
        return []
    }
  }

  /**
   * W3-D2: a line the CLI wrote into the conversation as a user turn, not the
   * person: its `origin.kind` is set and not `human`, its `promptSource` is
   * `system`, or (older CLIs, no origin) its text is one of the CLI's own
   * wrappers. A task notification becomes one quiet `system notification`
   * line (and the follow host's end signal for a background subagent, S44);
   * anything else the CLI injected becomes nothing. A line whose origin is
   * `human` is always the person's, whatever its text starts with: the
   * wrapper test only applies to a line with no origin.
   */
  private injected(
    entry: TranscriptLine,
    text: string,
    parent: string | null,
  ): NodeSessionEventIn[] | null {
    const origin = originKind(entry.origin)
    if (origin === "human") return null
    const system =
      origin !== null ||
      entry.promptSource === "system" ||
      CLI_WRAPPERS.some((w) => text.trimStart().startsWith(w))
    if (!system) return null
    return text.trimStart().startsWith("<task-notification>")
      ? [this.notification(text, parent)]
      : []
  }

  /**
   * W3-D2: Claude Code (2.1.29x) records a message that arrived during a
   * turn only as a `queued_command` attachment, never as a user line: the
   * person's own (`origin.kind` human, or no origin on a `prompt`) is what
   * they typed; a task notification is the CLI's; a peer's is dropped.
   */
  private queuedCommand(attachment: unknown, parent: string | null): NodeSessionEventIn[] {
    const a = (attachment && typeof attachment === "object" ? attachment : {}) as {
      type?: unknown
      prompt?: unknown
      commandMode?: unknown
      origin?: unknown
    }
    if (a.type !== "queued_command") return []
    const text = typedText(a.prompt)
    if (!text) return []
    const origin = originKind(a.origin)
    if (
      origin !== "human" &&
      (a.commandMode === "task-notification" || origin === "task-notification")
    ) {
      return text.trimStart().startsWith("<task-notification>")
        ? [this.notification(text, parent)]
        : []
    }
    if (a.commandMode !== "prompt" || (origin !== null && origin !== "human")) return []
    if (origin === null && CLI_WRAPPERS.some((w) => text.trimStart().startsWith(w))) return []
    return [
      this.capped({
        at: this.now(),
        type: "user_message",
        payload: { text },
        ...(parent ? { parentToolUseId: parent } : {}),
      }),
    ]
  }

  /** One `system notification` from a `<task-notification>`: its ids, status and summary only (never its output file). */
  private notification(text: string, parent: string | null): NodeSessionEventIn {
    const toolUseId = tagText(text, "tool-use-id")
    const status = tagText(text, "status")
    const summary = tagText(text, "summary").slice(0, NOTIFICATION_TEXT_MAX)
    const n = (name: string) => {
      const v = Number(tagText(text, name))
      return tagText(text, name) !== "" && Number.isFinite(v) ? v : undefined
    }
    const data: Record<string, unknown> = {
      kind: "task",
      taskId: tagText(text, "task-id"),
      ...(toolUseId ? { toolUseId } : {}),
      status: status || "completed",
      agent: toolUseId !== "" && this.agentCalls.has(toolUseId),
      ...(summary ? { summary } : {}),
    }
    const durationMs = n("duration_ms")
    const toolUses = n("tool_uses")
    if (durationMs !== undefined) data.durationMs = durationMs
    if (toolUses !== undefined) data.toolUses = toolUses
    return this.capped({
      at: this.now(),
      type: "system",
      payload: { subtype: "notification", text: summary || `Background task ${data.status}`, data },
      ...(parent ? { parentToolUseId: parent } : {}),
    })
  }
}

/** The CLI's own wrappers around a user turn it writes (older CLIs carry no `origin`). */
const CLI_WRAPPERS = [
  "<task-notification>",
  "<system-reminder>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<agent-message",
  "<bash-stdout>",
  "<bash-stderr>",
] as const

/** The most of a notification's summary a `system` event carries. */
const NOTIFICATION_TEXT_MAX = 200

function originKind(origin: unknown): string | null {
  const kind = origin && typeof origin === "object" ? (origin as { kind?: unknown }).kind : null
  return typeof kind === "string" ? kind : null
}

/** The text of the first `<name>…</name>` (indexOf, linear time); "" when absent. */
function tagText(text: string, name: string): string {
  const open = `<${name}>`
  const at = text.indexOf(open)
  if (at < 0) return ""
  const from = at + open.length
  const end = text.indexOf(`</${name}>`, from)
  return end < 0 ? "" : text.slice(from, end).trim()
}

/** What the person typed: a string, or the text blocks of a content array (never tool results). */
function typedText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n")
}
