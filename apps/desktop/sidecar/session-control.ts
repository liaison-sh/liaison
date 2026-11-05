// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A LONG-LIVED SESSION'S CONTROL (P3-T05; D36, C5, C6, L20).
//
// The shell writes one JSON line per owner command on the session process's
// stdin (`{type:"command", commandId, seq, command}`, T01). This module:
//
// - records each command in `<sessionDir>/applied.jsonl` (0600, fsynced)
//   BEFORE it is applied, then its outcome once known, so a command the shell
//   writes twice (a page reload, a lost batch) is never applied twice: its
//   recorded `command_applied` is emitted again instead, and the server acks
//   it from that;
// - applies commands strictly in seq order, one at a time, dropping a line
//   whose seq is at or below the highest one already taken;
// - dispatches each to a handler the run fills; a type with no handler is
//   settled `failed` ("not supported by this computer yet").
//
// It also holds the session's input stream (`SessionInput`): the messages
// yielded to the SDK, stamped with a uuid so the CLI's `command_lifecycle`
// messages say when a message was really read (state `started`), which is
// when the owner sees it delivered. Grounded on a real query (Claude Code
// with the 0.3.286 SDK): the SDK pulls the input eagerly, a message sent
// mid-turn is folded into that turn at its next step (`started` before the
// turn's result), one sent after a result starts a new turn.
//
// Today's control lines (`abort`, `shutdown`, `set_permission_mode`) are
// passed to `onOther` unchanged.

import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs"
import path from "node:path"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type NodeSessionCommand,
  type NodeSessionCommandLine,
  type NodeSessionCommandType,
  parseCommandLine,
} from "../../../packages/shared/src/node-session-protocol"

export type CommandOutcome = "applied" | "noop" | "cancelled" | "failed"

export interface CommandResult {
  outcome: CommandOutcome
  error?: string
}

/** One line of applied.jsonl: a command taken (no outcome yet) or settled. */
interface AppliedRecord {
  commandId: string
  seq: number
  type: string
  jobId: string
  outcome?: CommandOutcome
  error?: string
  /** Taken but handed back unapplied (a restart): the next process takes it again. */
  released?: true
}

/**
 * A handler applies one command. It returns the outcome, or null when the
 * outcome comes later (a message settles when the CLI reads it, or when a
 * Stop cancels it) through `SessionControl.settle`.
 */
export type CommandHandler<T extends NodeSessionCommandType = NodeSessionCommandType> = (
  command: Extract<NodeSessionCommand, { type: T }>,
  line: NodeSessionCommandLine,
) => Promise<CommandResult | null> | CommandResult | null

export type CommandHandlers = { [T in NodeSessionCommandType]?: CommandHandler<T> }

export const NOT_SUPPORTED = "not supported by this computer yet"

export interface SessionControlArgs {
  /** `<nodeRoot>/.sessions/<short>`; no dir: the log lives in memory only (tests, My node chat). */
  sessionDir?: string
  jobId: string
  /** Emits a `command_applied` session event. */
  emitApplied: (payload: {
    commandId: string
    type: string
    outcome: CommandOutcome
    error?: string
  }) => void
  /** Any other control line, parsed (abort, shutdown, set_permission_mode). */
  onOther?: (parsed: Record<string, unknown>) => void
}

export class SessionControl {
  readonly handlers: CommandHandlers = {}
  private readonly file: string | null
  private readonly records = new Map<string, AppliedRecord>()
  private highestSeq = 0
  /** Commands an earlier process released: taken again even below the highest seq. */
  private readonly released = new Set<string>()

  constructor(private readonly args: SessionControlArgs) {
    this.file = args.sessionDir ? path.join(args.sessionDir, "applied.jsonl") : null
    this.load()
  }

  /** The log as earlier runs of this session left it. */
  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue
      let r: AppliedRecord
      try {
        r = JSON.parse(line) as AppliedRecord
      } catch {
        continue
      }
      if (typeof r.commandId !== "string" || typeof r.seq !== "number") continue
      if (r.released) {
        if (!this.records.get(r.commandId)?.outcome) {
          this.records.delete(r.commandId)
          this.released.add(r.commandId)
        }
        continue
      }
      // A command taken by another run that never settled died with that
      // run's process: it was not applied (the server requeues it, G4).
      if (!r.outcome && r.jobId !== this.args.jobId) {
        if (!this.records.get(r.commandId)?.outcome) this.records.delete(r.commandId)
        continue
      }
      const before = this.records.get(r.commandId)
      this.records.set(r.commandId, { ...before, ...r })
    }
    for (const r of this.records.values()) this.highestSeq = Math.max(this.highestSeq, r.seq)
  }

  private append(record: AppliedRecord): void {
    this.records.set(record.commandId, { ...this.records.get(record.commandId), ...record })
    if (!this.file) return
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const fd = openSync(this.file, "a", 0o600)
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  /** The outcome a command settled with, if it did. */
  outcomeOf(commandId: string): CommandOutcome | undefined {
    return this.records.get(commandId)?.outcome
  }

  /** True once the command is in the log (taken, settled or not). */
  has(commandId: string): boolean {
    return this.records.has(commandId)
  }

  /**
   * Settles a taken command: its outcome goes to the log (fsynced) and a
   * `command_applied` event out. A command already settled is not settled
   * again.
   */
  settle(commandId: string, outcome: CommandOutcome, error?: string): void {
    const r = this.records.get(commandId)
    if (!r || r.outcome) return
    this.append({ ...r, jobId: this.args.jobId, outcome, ...(error ? { error } : {}) })
    this.args.emitApplied({ commandId, type: r.type, outcome, ...(error ? { error } : {}) })
  }

  /**
   * Records a command this run applies without a stdin line (the message a
   * resume-by-message job starts with), settled at once.
   */
  recordApplied(commandId: string, seq: number, type: string, outcome: CommandOutcome): void {
    if (this.records.get(commandId)?.outcome) return
    this.append({ commandId, seq, type, jobId: this.args.jobId })
    this.highestSeq = Math.max(this.highestSeq, seq)
    this.settle(commandId, outcome)
  }

  /**
   * Takes a command this run applies without a stdin line (the message a
   * resume-by-message job starts with) before it is settled, so the same
   * command written again on stdin meanwhile is never applied a second time.
   */
  take(commandId: string, seq: number, type: string): void {
    if (this.records.has(commandId)) return
    this.released.delete(commandId)
    this.append({ commandId, seq, type, jobId: this.args.jobId })
  }

  /**
   * Hands a taken, unsettled command back (a restart, D34): the log says so,
   * and the next process of this session applies it when it is written again.
   */
  release(commandId: string): void {
    const r = this.records.get(commandId)
    if (!r || r.outcome) return
    this.records.delete(commandId)
    this.released.add(commandId)
    if (!this.file) return
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const fd = openSync(this.file, "a", 0o600)
    try {
      writeSync(fd, `${JSON.stringify({ ...r, jobId: this.args.jobId, released: true })}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  /** One stdin line. Commands are awaited one at a time by `run`. */
  async feed(line: string): Promise<void> {
    if (!line.trim()) return
    const cmd = parseCommandLine(line)
    if (!cmd) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // A `command` line that failed its schema is dropped, never passed on.
        if ((parsed as { type?: unknown }).type === "command") return
        this.args.onOther?.(parsed as Record<string, unknown>)
      }
      return
    }
    const known = this.records.get(cmd.commandId)
    if (known) {
      // Written again (a reload, a lost batch): re-emit what it settled with.
      if (known.outcome) {
        this.args.emitApplied({
          commandId: known.commandId,
          type: known.type,
          outcome: known.outcome,
          ...(known.error ? { error: known.error } : {}),
        })
      }
      return
    }
    if (cmd.seq <= this.highestSeq && !this.released.has(cmd.commandId)) return
    this.released.delete(cmd.commandId)
    this.highestSeq = Math.max(this.highestSeq, cmd.seq)
    this.append({
      commandId: cmd.commandId,
      seq: cmd.seq,
      type: cmd.command.type,
      jobId: this.args.jobId,
    })
    const handler = this.handlers[cmd.command.type] as CommandHandler | undefined
    if (!handler) {
      this.settle(cmd.commandId, "failed", NOT_SUPPORTED)
      return
    }
    let result: CommandResult | null
    try {
      result = await handler(cmd.command, cmd)
    } catch (error) {
      result = { outcome: "failed", error: (error as Error).message || String(error) }
    }
    if (result) this.settle(cmd.commandId, result.outcome, result.error)
  }

  /** Reads the control lines until they end, applying commands in order. */
  async run(lines: AsyncIterable<string>): Promise<void> {
    for await (const line of lines) await this.feed(line)
  }
}

/** One message on the session's input. */
export interface InputMessage {
  uuid: string
  text: string
  /** The owner's message command it carries; none for the job's own prompt. */
  commandId?: string
  /** pending: not yet pulled; yielded: the SDK took it; queued/started: the CLI said so. */
  state: "pending" | "yielded" | "queued" | "started" | "completed" | "cancelled"
}

export interface SessionInputArgs {
  /** The CLI read a message (lifecycle `started`), or, with a CLI that sends no lifecycle, the SDK pulled it. */
  onDelivered?: (message: InputMessage) => void
}

/**
 * The session's streaming input: the SDK pulls from it, the CLI's
 * `command_lifecycle` messages track each message by its uuid.
 */
export class SessionInput implements AsyncIterable<SDKUserMessage> {
  private readonly messages: InputMessage[] = []
  private readonly waiting: Array<(r: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false
  /** True once the CLI sent any lifecycle message: delivery then waits for `started`. */
  private lifecycle = false

  constructor(private readonly args: SessionInputArgs = {}) {}

  push(text: string, commandId?: string): InputMessage {
    const message: InputMessage = {
      uuid: randomUUID(),
      text,
      ...(commandId ? { commandId } : {}),
      state: "pending",
    }
    if (this.closed) {
      message.state = "cancelled"
      return message
    }
    this.messages.push(message)
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value: this.take(message), done: false })
    return message
  }

  private take(message: InputMessage): SDKUserMessage {
    message.state = "yielded"
    // A CLI that sends no lifecycle (none seen so far): delivered when pulled.
    if (!this.lifecycle) this.deliver(message)
    return {
      type: "user",
      message: { role: "user", content: message.text },
      parent_tool_use_id: null,
      uuid: message.uuid,
    } as SDKUserMessage
  }

  private delivered = new Set<string>()
  private deliver(message: InputMessage): void {
    if (this.delivered.has(message.uuid)) return
    this.delivered.add(message.uuid)
    this.args.onDelivered?.(message)
  }

  /** A `command_lifecycle` message from the CLI. */
  lifecycleEvent(commandUuid: string, state: string): void {
    this.lifecycle = true
    const message = this.messages.find((m) => m.uuid === commandUuid)
    if (!message || message.state === "cancelled") return
    if (state === "queued" && message.state === "yielded") message.state = "queued"
    else if (state === "started") {
      message.state = "started"
      this.deliver(message)
    } else if (state === "completed") {
      message.state = "completed"
      this.deliver(message)
    } else if (state === "cancelled") message.state = "cancelled"
  }

  /** Owner messages the CLI has not read yet (none of the job's own prompt). */
  outstanding(): InputMessage[] {
    return this.messages.filter(
      (m) =>
        m.commandId !== undefined &&
        !this.delivered.has(m.uuid) &&
        m.state !== "cancelled" &&
        m.state !== "completed",
    )
  }

  /** Stop (D36): every owner message not read yet is cancelled and never yielded. */
  cancelOutstanding(): InputMessage[] {
    const out = this.outstanding()
    for (const m of out) m.state = "cancelled"
    return out
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiting.length > 0)
      this.waiting.shift()?.({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const next = this.messages.find((m) => m.state === "pending")
        if (next && !this.closed) return Promise.resolve({ value: this.take(next), done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      },
    }
  }
}
