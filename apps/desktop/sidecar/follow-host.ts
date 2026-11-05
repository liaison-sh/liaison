// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE FOLLOW HOST (W3 T06; S41, S43, S44, D28 b, A43, A45, A50, A53, A56,
// A57, A60, A62).
//
// One long-lived `liaison-sidecar --follow` per node, started by the shell,
// holds every follow of the node: an imported Claude Code session (Follow, or
// Take over's one-shot replay) and the read-only follow of an in-place owner
// session while VS Code or a terminal drives it (D28 b). It never writes a
// transcript, never resumes a session and never trusts a path it did not
// resolve itself.
//
// - Control lines on stdin, one JSON each (`nodeFollowControlSchema`):
//   `follow_add` re-validates the session exactly as the import check does
//   (session-import.ts `resolveImportTarget`) from the shell's own folder
//   path, then follows it; `follow_remove` ends one (`owner`); `shutdown`, or
//   stdin EOF (parent death), flushes and exits 0. A bad line is logged as a
//   code only and ignored.
// - Output on stdout: `{type:"session_events", sessionId, jobId, events}`
//   lines (the run's line shape plus the job), at most a batch's events and
//   bytes each, and `{type:"follow_done", sessionId, jobId, why, endOffset?}`.
//   A follow refused at `follow_add` ends `not_found` or `already_liaison`.
// - Every event of every transcript the host reads (main, subagent, in
//   place) goes through the import redaction (S43, A59), then the cap.
// - Backpressure (A57): one write in flight at most. No follow is polled
//   while a write is pending, so a burst (8 follows x 8 MiB replays) is never
//   buffered in the process.
// - Subagents (S44, W3-D1): a foreground `Agent` call ends at its
//   tool_result; a background one (Claude Code 2.1.286+, the meta's
//   `requestShape: "background"`, or a tool_result that only says it was
//   launched) is read until the CLI's task notification for that call, with
//   the notification's status, or until it sat idle 30 minutes.
// - Memory (A50): a transcript is read from an offset in bounded chunks,
//   never whole; one line over `lineBytes` is skipped with one note.
//
// Logging: codes and counts to stderr only, never transcript text, a title
// or a path.

import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs"
import path from "node:path"
import {
  NODE_IMPORT_LIMITS,
  type NodeFollowWhy,
  nodeFollowControlSchema,
} from "../../../packages/shared/src/node-import"
import {
  capEvent,
  NODE_EVENT_LIMITS,
  type NodeSessionEventIn,
  splitIntoBatches,
} from "../../../packages/shared/src/node-session-protocol"
import { redactImportEvent, redactImportText } from "../../../packages/shared/src/secret-redaction"
import { appDataDir, realClaudeConfigDir } from "./config-isolation"
import { ranForServer } from "./session-config"
import { type DriverProbe, drivenElsewhere, systemDriverProbe } from "./session-driver"
import { createNormalizeState, type NormalizeState } from "./session-events"
import { resolveImportTarget } from "./session-import"
import { lineStart, TranscriptFollow } from "./transcript-follow"

/** A follow whose file grew in this window is polled every second, else every five. */
const ACTIVE_WINDOW_MS = 60_000
const ACTIVE_POLL_MS = 1_000
const IDLE_POLL_MS = 5_000
/** In-place follows (D28 b): the driver check's period, and the idle time before `driver_left`. */
const DRIVER_CHECK_MS = 10_000
const DRIVER_IDLE_MS = 60_000
/** One subagent poll reads at most this much, so its replay cap is overshot by one read at most. */
const SUBAGENT_READ_BYTES = 256 * 1024
/** Two missing (or non-regular) sightings in a row end a follow `transcript_gone`. */
const GONE_AFTER = 2
/** The `Agent` tool (and its older name) starts a subagent. */
const AGENT_TOOLS = new Set(["Agent", "Task"])
/**
 * W3-D1: a background subagent that neither grew nor was notified in this
 * long is closed (not completed), so a session that died mid-task never holds
 * a host slot for the rest of the follow.
 */
const BACKGROUND_IDLE_MS = 30 * 60_000
/** W3-D1: the `Agent` tool_result of a background launch (Claude Code 2.1.286+). */
const ASYNC_LAUNCH_PREFIX = "Async agent launched"

export type FollowHostLimits = typeof NODE_IMPORT_LIMITS & { batchBytes: number }

export interface FollowHostOptions {
  /** `realClaudeConfigDir()` of this process (the SDK's own root); never a control field. */
  configDir: string
  /** Where the node's session config dirs live (D49 F6: who ran a liaison-node session). */
  dataDir?: string
  /** Writes one line (with its newline); resolves when the sink took it. */
  write: (line: string) => Promise<void>
  /** A code or a count, never text from a transcript. */
  log?: (code: string) => void
  probe?: DriverProbe
  /** The clock in ms (tests: a fake one). */
  now?: () => number
  /** Tests: smaller windows. */
  limits?: Partial<FollowHostLimits>
}

/** Every `follow_done.why` is one the job result accepts (`NODE_FOLLOW_WHY`, minus the shell's `host_exit`). */
type Why = Exclude<NodeFollowWhy, "host_exit">

interface SubagentMeta {
  agentId: string
  /** The id as the events carry it (redacted alike, so it matches the tool_call's). */
  toolUseId: string
  description: string
  agentType: string
  file: string
  size: number
  /** W3-D1: `requestShape: "background"`: its tool_result is the launch, not the end. */
  background: boolean
}

interface Subagent {
  meta: SubagentMeta
  owner: Follow
  /** Replayed from the window (counted against the follow's totals) or started live. */
  replay: boolean
  follow: TranscriptFollow | null
  misses: number
  /** Jumped to its end once (its first `subagentBytes` read, or the follow's total spent). */
  capped: boolean
  /** The host clock when its file last grew (W3-D1: a background subagent's idle bound). */
  lastGrowthAt: number
}

interface Follow {
  sessionId: string
  jobId: string
  sdkSessionId: string
  file: string
  inPlace: boolean
  once: boolean
  tf: TranscriptFollow
  pending: NodeSessionEventIn[]
  /** The offset the window replay ends at (the size at `follow_add`); null once replayed. */
  replayEnd: number | null
  lastGrowthAt: number
  nextPollAt: number
  nextDriverAt: number
  misses: number
  skipNoted: boolean
  /** Agent calls seen, in order, with whether they came in the replay. */
  agentCalls: Map<string, { position: number; replay: boolean }>
  results: Set<string>
  /** W3-D1: Agent calls whose tool_result only said the subagent was launched in the background. */
  launched: Set<string>
  /** W3-D1: the CLI's task notification for an Agent call (its real end), with its status. */
  notified: Map<string, string>
  /** Subagents already decided on (started, queued, omitted or refused), by agent id. */
  decided: Set<string>
  subagents: Set<Subagent>
  subagentReplayBytes: number
}

const transform = (e: NodeSessionEventIn): NodeSessionEventIn => capEvent(redactImportEvent(e))

/**
 * Redaction before the cap (S43): `normalize` caps each field at 64 KiB, so
 * the redactor runs on the whole field first; `transform` then runs again on
 * the capped event (idempotent) as the last guard.
 */
const redactingState = (): NormalizeState => ({
  ...createNormalizeState(),
  redact: redactImportEvent,
})

export class FollowHost {
  private readonly follows_ = new Map<string, Follow>()
  private readonly queue: Subagent[] = []
  private open = 0
  private chain: Promise<void> = Promise.resolve()
  private stopping = false
  private readonly limits: FollowHostLimits
  private readonly now: () => number
  private readonly probe: DriverProbe
  private readonly log: (code: string) => void

  constructor(private readonly o: FollowHostOptions) {
    this.limits = {
      ...NODE_IMPORT_LIMITS,
      batchBytes: NODE_EVENT_LIMITS.batchBytes - NODE_EVENT_LIMITS.nodeBatchMargin,
      ...o.limits,
    }
    this.now = o.now ?? Date.now
    this.probe = o.probe ?? systemDriverProbe()
    this.log = o.log ?? ((code) => process.stderr.write(`follow ${code}\n`))
  }

  /** How many follows are live. */
  get follows(): number {
    return this.follows_.size
  }

  /** Set by `shutdown`: nothing more is polled or written. */
  get stopped(): boolean {
    return this.stopping
  }

  /** How many subagent transcripts are open in the whole host (at most `subagentsOpenPerHost`). */
  get openSubagents(): number {
    return this.open
  }

  /** One stdin line. Serialised with the polls: never runs while a write is pending. */
  control(text: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    const line = nodeFollowControlSchema.safeParse(parsed)
    if (!line.success) {
      this.log("invalid_control_line")
      return this.chain
    }
    const c = line.data
    if (c.type === "shutdown") return this.shutdown()
    return this.serial(async () => {
      if (this.stopping) return
      if (c.type === "follow_remove") {
        const f = this.follows_.get(c.jobId)
        if (f && f.sessionId === c.sessionId) await this.end(f, "owner", f.tf.offset)
        return
      }
      await this.add(c)
    })
  }

  /** One pass over the follows that are due. */
  tick(): Promise<void> {
    return this.serial(async () => {
      for (const f of [...this.follows_.values()]) {
        if (this.stopping) return
        if (!this.follows_.has(f.jobId)) continue
        const now = this.now()
        if (f.inPlace && now >= f.nextDriverAt) await this.checkDriver(f, now)
        if (!this.follows_.has(f.jobId)) continue
        if (now >= f.nextPollAt) await this.pollFollow(f)
      }
    })
  }

  /** Flushes what is in flight and emits nothing more (A57). */
  shutdown(): Promise<void> {
    this.stopping = true
    return this.chain
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {
      this.log("follow_failed")
    })
    return this.chain
  }

  private async write(line: Record<string, unknown>): Promise<void> {
    await this.o.write(`${JSON.stringify(line)}\n`)
  }

  private async flush(f: Follow): Promise<void> {
    if (f.pending.length === 0) return
    const events = f.pending
    f.pending = []
    for (const batch of splitIntoBatches(events, this.limits.batchBytes)) {
      await this.write({
        type: "session_events",
        sessionId: f.sessionId,
        jobId: f.jobId,
        events: batch,
      })
    }
  }

  private system(subtype: string, text: string, data: Record<string, unknown>): NodeSessionEventIn {
    return transform({
      at: new Date().toISOString(),
      type: "system",
      payload: { subtype, text, data },
    })
  }

  private async add(c: {
    sessionId: string
    jobId: string
    folderPath: string
    worktreePath?: string
    cwdSubdir: string
    sdkSessionId: string
    startAt: "window" | "end"
    once: boolean
    inPlace: boolean
    server: string
  }): Promise<void> {
    if (this.follows_.has(c.jobId)) {
      this.log("duplicate_follow")
      return
    }
    let target: Awaited<ReturnType<typeof resolveImportTarget>>
    try {
      target = await resolveImportTarget({
        configDir: this.o.configDir,
        folderPath: c.folderPath,
        // D53: re-checked against the folder's own worktrees, never trusted.
        ...(c.worktreePath !== undefined ? { worktreePath: c.worktreePath } : {}),
        cwdSubdir: c.cwdSubdir,
        sdkSessionId: c.sdkSessionId,
        // D49 F6: a liaison-node transcript is followed only in place, and
        // only for the server this node recorded running it for; the claim's
        // inPlace alone never lifts A56's refusal.
        allowLiaison:
          c.inPlace &&
          ranForServer(c.sessionId, c.sdkSessionId, c.server, this.o.dataDir ?? appDataDir()),
      })
    } catch {
      target = { ok: false, code: "not_found" }
    }
    if (!target.ok) {
      this.log(`follow_refused ${target.code}`)
      // Refused: nothing to follow, so the job ends `transcript_gone` (a
      // `why` the result schema accepts); `code` says why for the shell's log.
      const code = target.code === "already_liaison" ? "already_liaison" : "not_found"
      const why: Why = "transcript_gone"
      await this.write({ type: "follow_done", sessionId: c.sessionId, jobId: c.jobId, why, code })
      return
    }
    const size = sizeOf(target.file) ?? 0
    const start =
      c.startAt === "end"
        ? size
        : lineStart(target.file, Math.max(0, size - this.limits.historyBytes))
    const now = this.now()
    const tf = new TranscriptFollow({
      file: target.file,
      offset: start,
      emit: (events) => f.pending.push(...events),
      state: redactingState(),
      transform,
      noFollowOpen: true,
      onShrink: "end",
      maxLineBytes: this.limits.lineBytes,
    })
    const f: Follow = {
      sessionId: c.sessionId,
      jobId: c.jobId,
      sdkSessionId: c.sdkSessionId,
      file: target.file,
      inPlace: c.inPlace,
      once: c.once,
      tf,
      pending: [],
      replayEnd: start < size ? size : null,
      lastGrowthAt: now,
      nextPollAt: now,
      nextDriverAt: now,
      misses: 0,
      skipNoted: false,
      agentCalls: new Map(),
      results: new Set(),
      launched: new Set(),
      notified: new Map(),
      decided: new Set(),
      subagents: new Set(),
      subagentReplayBytes: 0,
    }
    this.follows_.set(c.jobId, f)
    if (!c.inPlace) {
      f.pending.push(
        this.system("imported", "Imported from this computer", {
          historyFrom: start === 0 ? "start" : "window",
          from: target.from,
        }),
      )
    }
    f.pending.push(this.system("follow", "Following", { state: "started" }))
    await this.flush(f)
  }

  /** D28 b: who drives an in-place session; it ends once nobody does and the file is idle. */
  private async checkDriver(f: Follow, now: number): Promise<void> {
    f.nextDriverAt = now + DRIVER_CHECK_MS
    const verdict = drivenElsewhere(
      {
        jsonl: f.file,
        sessionId: f.sdkSessionId,
        configDir: this.o.configDir,
        ownPids: new Set(),
        ownLastWriteMs: null,
        now,
      },
      this.probe,
    )
    f.tf.driver({ elsewhere: verdict.elsewhere, via: verdict.via })
    await this.flush(f)
    if (!verdict.elsewhere && now - f.lastGrowthAt >= DRIVER_IDLE_MS)
      await this.end(f, "driver_left")
  }

  private async pollFollow(f: Follow): Promise<void> {
    const now = this.now()
    if (!regularFile(f.file)) {
      f.misses++
      if (f.misses >= GONE_AFTER) await this.end(f, "transcript_gone")
      else f.nextPollAt = now + ACTIVE_POLL_MS
      return
    }
    f.misses = 0
    let grew = false
    for (;;) {
      const before = f.tf.offset
      const emitted = f.tf.poll()
      if (f.tf.shrunk) {
        await this.end(f, "transcript_gone")
        return
      }
      const advanced = f.tf.offset - before
      if (advanced <= 0) break
      grew = true
      if (emitted === 0 && advanced >= this.limits.lineBytes) this.noteSkip(f)
      this.track(f, f.pending)
      await this.flush(f)
      if (this.stopping) return
    }
    if (grew) f.lastGrowthAt = now
    if (f.replayEnd !== null) {
      f.replayEnd = null
      this.planReplaySubagents(f)
    } else if (grew) this.scanSubagents(f)
    this.fillSlots()
    await this.pollSubagents(f)
    this.fillSlots()
    for (const other of this.follows_.values()) await this.flush(other)
    if (this.stopping) return
    // A once follow (Take over's replay) ends when the window and its subagents are read.
    if (f.once && f.subagents.size === 0) {
      await this.end(f, "replayed", f.tf.offset)
      return
    }
    f.nextPollAt = f.once
      ? now
      : now + (now - f.lastGrowthAt < ACTIVE_WINDOW_MS ? ACTIVE_POLL_MS : IDLE_POLL_MS)
  }

  private noteSkip(f: Follow): void {
    this.log("skipped_line")
    if (f.skipNoted) return
    f.skipNoted = true
    f.pending.push(
      this.system("follow", "A transcript line over the size limit was skipped", {
        state: "started",
        skippedLine: true,
      }),
    )
  }

  /**
   * The Agent calls, their tool results and their task notifications in the
   * main transcript (S44). W3-D1: a background subagent's tool_result only
   * says it was launched; its end is the CLI's `<task-notification>` for that
   * call (transcript-follow's `system notification`).
   */
  private track(f: Follow, events: readonly NodeSessionEventIn[]): void {
    for (const e of events) {
      if (e.parentToolUseId) continue
      if (e.type === "system") {
        const p = e.payload as {
          subtype?: unknown
          data?: { toolUseId?: unknown; status?: unknown }
        }
        const id = p.data?.toolUseId
        if (p.subtype === "notification" && typeof id === "string" && f.agentCalls.has(id))
          f.notified.set(id, endStatus(p.data?.status))
        continue
      }
      const p = e.payload as { id?: unknown; name?: unknown; output?: unknown }
      if (typeof p.id !== "string") continue
      if (e.type === "tool_call" && typeof p.name === "string" && AGENT_TOOLS.has(p.name)) {
        if (!f.agentCalls.has(p.id))
          f.agentCalls.set(p.id, { position: f.agentCalls.size, replay: f.replayEnd !== null })
      } else if (e.type === "tool_result" && f.agentCalls.has(p.id)) {
        if (typeof p.output === "string" && p.output.startsWith(ASYNC_LAUNCH_PREFIX))
          f.launched.add(p.id)
        else f.results.add(p.id)
      }
    }
  }

  /** W3-D1: whether a subagent has ended, and how: its notification, else (foreground only) its tool_result. */
  private ended(f: Follow, meta: SubagentMeta): string | null {
    const notified = f.notified.get(meta.toolUseId)
    if (notified !== undefined) return notified
    const background = meta.background || f.launched.has(meta.toolUseId)
    return !background && f.results.has(meta.toolUseId) ? "completed" : null
  }

  /**
   * A60: of the window's subagents, the newest (by their Agent call's
   * position) up to `subagentReplayCount` and `subagentReplayBytes`; the
   * older ones get one note.
   */
  private planReplaySubagents(f: Follow): void {
    const metas = this.readMetas(f).filter((m) => f.agentCalls.get(m.toolUseId)?.replay)
    metas.sort(
      (a, b) =>
        (f.agentCalls.get(b.toolUseId)?.position ?? 0) -
        (f.agentCalls.get(a.toolUseId)?.position ?? 0),
    )
    const chosen: SubagentMeta[] = []
    let bytes = 0
    let omitted = 0
    for (const m of metas) {
      f.decided.add(m.agentId)
      const cost = Math.min(m.size, this.limits.subagentBytes)
      if (
        chosen.length < this.limits.subagentReplayCount &&
        bytes + cost <= this.limits.subagentReplayBytes
      ) {
        chosen.push(m)
        bytes += cost
      } else omitted++
    }
    if (omitted > 0) {
      this.log(`subagents_omitted ${omitted}`)
      f.pending.push(
        this.system("follow", `Older subagent history not imported (${omitted})`, {
          state: "started",
          subagentsOmitted: omitted,
        }),
      )
    }
    chosen.reverse()
    for (const m of chosen) this.enqueue(f, m, true)
  }

  /** Live subagents: any whose Agent call this follow has seen and that is not decided yet. */
  private scanSubagents(f: Follow): void {
    if (f.agentCalls.size === 0) return
    for (const m of this.readMetas(f)) {
      if (!f.agentCalls.has(m.toolUseId)) continue
      f.decided.add(m.agentId)
      this.enqueue(f, m, false)
    }
  }

  private enqueue(f: Follow, meta: SubagentMeta, replay: boolean): void {
    const s: Subagent = {
      meta,
      owner: f,
      replay,
      follow: null,
      misses: 0,
      capped: false,
      lastGrowthAt: this.now(),
    }
    f.subagents.add(s)
    this.queue.push(s)
  }

  /** Starts queued subagents, first in first out, while the host has a slot (A60). */
  private fillSlots(): void {
    while (this.open < this.limits.subagentsOpenPerHost && this.queue.length > 0) {
      const s = this.queue.shift() as Subagent
      if (!this.follows_.has(s.owner.jobId)) continue
      this.open++
      s.follow = new TranscriptFollow({
        file: s.meta.file,
        offset: 0,
        emit: (events) => s.owner.pending.push(...events),
        state: redactingState(),
        transform,
        parentToolUseId: s.meta.toolUseId,
        noFollowOpen: true,
        onShrink: "end",
        maxReadBytes: SUBAGENT_READ_BYTES,
        maxLineBytes: this.limits.subagentLineBytes,
      })
      s.owner.pending.push(
        this.system("task_started", s.meta.description, {
          taskId: s.meta.agentId,
          toolUseId: s.meta.toolUseId,
          description: s.meta.description,
          subagentType: s.meta.agentType,
          taskType: "local_agent",
        }),
      )
    }
  }

  private async pollSubagents(f: Follow): Promise<void> {
    for (const s of [...f.subagents]) {
      const tf = s.follow
      if (!tf) continue
      if (subagentsDir(f.file, f.sdkSessionId) === null || !regularFile(s.meta.file)) {
        s.misses++
        if (s.misses >= GONE_AFTER) this.closeSubagent(s, null)
        continue
      }
      s.misses = 0
      let drained = false
      for (;;) {
        const before = tf.offset
        tf.poll()
        if (tf.shrunk) break
        const advanced = tf.offset - before
        if (advanced > 0) s.lastGrowthAt = this.now()
        if (s.replay) f.subagentReplayBytes += Math.max(0, advanced)
        // At most `subagentBytes` from the start, then from its end (and none
        // once the follow's replay total is spent).
        if (
          !s.capped &&
          (tf.offset >= this.limits.subagentBytes ||
            (s.replay && f.subagentReplayBytes >= this.limits.subagentReplayBytes))
        ) {
          s.capped = true
          const size = sizeOf(s.meta.file)
          if (size !== null && size > tf.offset) tf.offset = size
        }
        await this.flush(f)
        if (this.stopping) return
        if (advanced <= 0) {
          drained = true
          break
        }
      }
      if (tf.shrunk) {
        this.closeSubagent(s, null)
        continue
      }
      if (!drained) continue
      const ended = this.ended(f, s.meta)
      if (ended !== null || f.once) this.closeSubagent(s, ended)
      else if (this.now() - s.lastGrowthAt >= BACKGROUND_IDLE_MS) {
        this.log("subagent_idle")
        this.closeSubagent(s, null)
      }
    }
    await this.flush(f)
  }

  /** `status`: how it ended (its task_notification), or null when the follow just stops reading it. */
  private closeSubagent(s: Subagent, status: string | null): void {
    if (s.follow) this.open--
    s.follow = null
    s.owner.subagents.delete(s)
    if (status !== null) {
      s.owner.pending.push(
        this.system("task_notification", status, {
          taskId: s.meta.agentId,
          toolUseId: s.meta.toolUseId,
          status,
        }),
      )
    }
  }

  /** The `agent-*.meta.json` of the follow's session: regular files only, each at most `metaBytes`. */
  private readMetas(f: Follow): SubagentMeta[] {
    const dir = subagentsDir(f.file, f.sdkSessionId)
    if (dir === null) return []
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out: SubagentMeta[] = []
    for (const name of names) {
      const m = /^agent-([A-Za-z0-9_-]{1,128})\.meta\.json$/.exec(name)
      if (!m) continue
      const agentId = m[1] as string
      if (f.decided.has(agentId)) continue
      const metaText = readSmall(path.join(dir, name), this.limits.metaBytes)
      if (metaText === null) continue
      let meta: {
        toolUseId?: unknown
        agentType?: unknown
        description?: unknown
        requestShape?: unknown
      }
      try {
        meta = JSON.parse(metaText) as typeof meta
      } catch {
        continue
      }
      if (typeof meta.toolUseId !== "string") continue
      const file = path.join(dir, `agent-${agentId}.jsonl`)
      const size = regularSize(file)
      if (size === null) continue
      out.push({
        agentId,
        toolUseId: redactImportText(meta.toolUseId),
        description: redactImportText(
          typeof meta.description === "string" ? meta.description : "",
        ).slice(0, 200),
        agentType: typeof meta.agentType === "string" ? meta.agentType.slice(0, 100) : "",
        file,
        size,
        background: meta.requestShape === "background",
      })
    }
    return out
  }

  private async end(f: Follow, why: Why, endOffset?: number): Promise<void> {
    if (!this.follows_.has(f.jobId)) return
    this.follows_.delete(f.jobId)
    for (const s of [...f.subagents]) this.closeSubagent(s, null)
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.queue[i]?.owner === f) this.queue.splice(i, 1)
    await this.flush(f)
    await this.write({
      type: "follow_done",
      sessionId: f.sessionId,
      jobId: f.jobId,
      why,
      ...(endOffset !== undefined ? { endOffset } : {}),
    })
    this.fillSlots()
  }
}

/** A notification's status as the task fold knows it; anything else reads as completed. */
function endStatus(status: unknown): string {
  return status === "failed" || status === "stopped" || status === "killed" ? status : "completed"
}

/**
 * D49 F7: `<project>/<id>/subagents`, when every component under the
 * transcript's own dir is a real directory (lstat: no symlink anywhere) and
 * its realpath is under the project dir's; otherwise null. Checked on every
 * read, so a component swapped for a link later stops the reads too.
 */
function subagentsDir(transcript: string, sdkSessionId: string): string | null {
  const project = path.dirname(transcript)
  const idDir = path.join(project, sdkSessionId)
  const dir = path.join(idDir, "subagents")
  try {
    for (const p of [idDir, dir]) {
      const st = lstatSync(p)
      if (!st.isDirectory() || st.isSymbolicLink()) return null
    }
    const root = realpathSync(project)
    return realpathSync(dir) === path.join(root, sdkSessionId, "subagents") ? dir : null
  } catch {
    return null
  }
}

function sizeOf(file: string): number | null {
  try {
    return lstatSync(file).size
  } catch {
    return null
  }
}

/** A regular file, not a symlink. */
function regularFile(file: string): boolean {
  return regularSize(file) !== null
}

function regularSize(file: string): number | null {
  try {
    const st = lstatSync(file)
    return st.isFile() && !st.isSymbolicLink() ? st.size : null
  } catch {
    return null
  }
}

/** A small regular file's text, through no symlink; null when larger than `max`. */
function readSmall(file: string, max: number): string | null {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(max + 1)
    const got = readSync(fd, buf, 0, buf.length, 0)
    return got > max ? null : buf.toString("utf8", 0, got)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

export interface FollowMainIo {
  lines: AsyncIterable<string>
  write?: (line: string) => Promise<void>
  log?: (code: string) => void
  configDir?: string
  probe?: DriverProbe
  /** How often the host looks for due follows (default 250 ms). */
  intervalMs?: number
}

/** `liaison-sidecar --follow`: the host's process loop. Exits 0 on `shutdown` or stdin EOF. */
export async function followMain(io: FollowMainIo): Promise<number> {
  const write =
    io.write ??
    ((line: string) =>
      new Promise<void>((resolve) => {
        process.stdout.write(line, () => resolve())
      }))
  const host = new FollowHost({
    configDir: io.configDir ?? realClaudeConfigDir(),
    write,
    log: io.log,
    probe: io.probe,
  })
  let ticking = false
  const timer = setInterval(() => {
    if (ticking) return
    ticking = true
    void host.tick().finally(() => {
      ticking = false
    })
  }, io.intervalMs ?? 250)
  try {
    for await (const line of io.lines) {
      if (!line.trim()) continue
      await host.control(line)
      if (host.stopped) break
    }
  } finally {
    clearInterval(timer)
    await host.shutdown()
  }
  return 0
}
