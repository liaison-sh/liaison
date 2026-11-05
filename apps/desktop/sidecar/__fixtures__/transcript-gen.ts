// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A DETERMINISTIC CLAUDE CODE TRANSCRIPT GENERATOR (W3 T04; the fixtures of
// the import listing, the follow host and their memory measurements).
//
// Writes a `<id>.jsonl` with the line shapes a VS Code session of this CLI
// generation writes (user text, assistant thinking/tool_use/text with usage,
// tool results, system stop-hook summaries, and the bookkeeping lines the
// follow drops: attachment, queue-operation, file-history-snapshot,
// last-prompt, ai-title), all with fake text from a fixed vocabulary and a
// seeded PRNG, so the same options give the same bytes. Optionally every
// `agentEvery`-th turn is an `Agent` call with its subagent transcript and
// meta under `<dir>/<id>/subagents/` (isSidechain lines carrying agentId, as
// the CLI writes them), and its tool_result in the main transcript later.
//
// Streams to disk in chunks: a 200 MB transcript never sits in memory.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs"
import path from "node:path"

export interface TranscriptGenOptions {
  /** The main transcript, `<dir>/<sessionId>.jsonl`. */
  file: string
  sessionId: string
  cwd: string
  /** Stop once at least this many bytes are written (whole turns only). */
  bytes: number
  seed?: number
  entrypoint?: string
  gitBranch?: string
  model?: string
  /** Every n-th turn is an Agent call with a subagent transcript (0: never). */
  agentEvery?: number
  /** Bytes of each subagent transcript (default 16 KiB). */
  subagentBytes?: number
  /** Stop adding subagents after this many (default unbounded). */
  maxSubagents?: number
}

export interface GeneratedAgent {
  toolUseId: string
  agentId: string
  description: string
  agentType: string
  file: string
  metaFile: string
}

export interface GeneratedTranscript {
  bytes: number
  lines: number
  turns: number
  agents: GeneratedAgent[]
}

const WORDS =
  "the a of to and in is it for on that with as this be by are from at or an was not but can we will which all one has have if more when there so out up use into what about would their how its make time just then them these than some only new also other like".split(
    " ",
  )
const TOOLS = ["Read", "Bash", "Grep", "Edit", "Glob"] as const

/** mulberry32: a small, fast, seeded PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Gen {
  private readonly rand: () => number
  private n = 0
  constructor(seed: number) {
    this.rand = prng(seed)
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.rand() * (max - min + 1))
  }
  hex(len: number): string {
    let s = ""
    for (let i = 0; i < len; i++) s += Math.floor(this.rand() * 16).toString(16)
    return s
  }
  uuid(): string {
    const h = this.hex(32)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`
  }
  toolId(): string {
    return `toolu_01${this.hex(22)}`
  }
  text(chars: number): string {
    const out: string[] = []
    let len = 0
    while (len < chars) {
      const w = WORDS[this.int(0, WORDS.length - 1)] as string
      out.push(w)
      len += w.length + 1
    }
    return out.join(" ").slice(0, chars)
  }
  /** A monotonically increasing fake timestamp. */
  at(): string {
    this.n += this.int(50, 4000)
    return new Date(Date.UTC(2026, 0, 1) + this.n).toISOString()
  }
}

class Sink {
  bytes = 0
  lines = 0
  private parts: string[] = []
  private pending = 0
  constructor(private readonly fd: number) {}
  line(o: unknown): void {
    const s = `${JSON.stringify(o)}\n`
    this.parts.push(s)
    const b = Buffer.byteLength(s)
    this.pending += b
    this.bytes += b
    this.lines++
    if (this.pending >= 1 << 20) this.flush()
  }
  flush(): void {
    if (!this.parts.length) return
    writeSync(this.fd, this.parts.join(""))
    this.parts = []
    this.pending = 0
  }
}

/** Writes the transcript (and its subagents) and says what it wrote. */
export function generateTranscript(o: TranscriptGenOptions): GeneratedTranscript {
  const g = new Gen(o.seed ?? 1)
  const entrypoint = o.entrypoint ?? "claude-vscode"
  const gitBranch = o.gitBranch ?? "main"
  const model = o.model ?? "claude-haiku-5-5"
  const common = {
    userType: "external",
    entrypoint,
    cwd: o.cwd,
    sessionId: o.sessionId,
    version: "2.1.296",
    gitBranch,
  }
  const usage = () => ({
    input_tokens: g.int(1, 20),
    cache_creation_input_tokens: g.int(0, 20_000),
    cache_read_input_tokens: g.int(0, 200_000),
    output_tokens: g.int(10, 2000),
    service_tier: "standard",
  })
  const dir = path.dirname(o.file)
  mkdirSync(dir, { recursive: true })
  const fd = openSync(o.file, "w", 0o600)
  const out = new Sink(fd)
  const agents: GeneratedAgent[] = []
  let parent: string | null = null
  let turns = 0
  const entry = (body: Record<string, unknown>): string => {
    const uuid = g.uuid()
    out.line({
      parentUuid: parent,
      isSidechain: false,
      ...body,
      uuid,
      timestamp: g.at(),
      ...common,
    })
    parent = uuid
    return uuid
  }
  const assistant = (content: unknown[]): string =>
    entry({
      type: "assistant",
      message: {
        model,
        id: `msg_01${g.hex(22)}`,
        type: "message",
        role: "assistant",
        content,
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: usage(),
      },
      requestId: `req_01${g.hex(22)}`,
    })
  try {
    out.line({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: g.at(),
      sessionId: o.sessionId,
    })
    while (out.bytes < o.bytes) {
      turns++
      const prompt = g.text(g.int(20, 400))
      const promptId = g.uuid()
      entry({
        type: "user",
        promptId,
        message: { role: "user", content: prompt },
        permissionMode: "default",
      })
      out.line({
        type: "file-history-snapshot",
        messageId: g.uuid(),
        snapshot: { messageId: g.uuid(), trackedFileBackups: {}, timestamp: g.at() },
        isSnapshotUpdate: false,
      })
      out.line({
        parentUuid: parent,
        isSidechain: false,
        attachment: {
          type: "hook_success",
          hookName: "UserPromptSubmit",
          content: "",
          exitCode: 0,
        },
        type: "attachment",
        uuid: g.uuid(),
        timestamp: g.at(),
        ...common,
      })
      assistant([{ type: "thinking", thinking: "", signature: g.hex(g.int(200, 1200)) }])
      const calls = g.int(1, 4)
      let pendingAgent: GeneratedAgent | null = null
      for (let c = 0; c < calls; c++) {
        const id = g.toolId()
        const agentTurn =
          !pendingAgent &&
          c === 0 &&
          (o.agentEvery ?? 0) > 0 &&
          turns % (o.agentEvery as number) === 0 &&
          agents.length < (o.maxSubagents ?? Number.POSITIVE_INFINITY)
        if (agentTurn) {
          const agentId = g.hex(17)
          const description = g.text(g.int(10, 60))
          const agentType = "general-purpose"
          assistant([
            {
              type: "tool_use",
              id,
              name: "Agent",
              input: { description, prompt: g.text(g.int(100, 600)), subagent_type: agentType },
            },
          ])
          pendingAgent = writeSubagent(g, {
            dir,
            sessionId: o.sessionId,
            agentId,
            toolUseId: id,
            description,
            agentType,
            bytes: o.subagentBytes ?? 16 * 1024,
            common,
            model,
          })
          agents.push(pendingAgent)
          continue
        }
        const name = TOOLS[g.int(0, TOOLS.length - 1)] as string
        assistant([
          { type: "tool_use", id, name, input: { file_path: `/${g.text(30).replace(/ /g, "/")}` } },
        ])
        const result = g.text(g.int(200, 12_000))
        entry({
          type: "user",
          promptId,
          message: {
            role: "user",
            content: [{ tool_use_id: id, type: "tool_result", content: result }],
          },
          toolUseResult: { type: "text", file: { content: result, numLines: g.int(1, 400) } },
        })
      }
      if (pendingAgent) {
        entry({
          type: "user",
          promptId,
          message: {
            role: "user",
            content: [
              {
                tool_use_id: pendingAgent.toolUseId,
                type: "tool_result",
                content: [{ type: "text", text: g.text(g.int(100, 2000)) }],
              },
            ],
          },
        })
      }
      assistant([{ type: "text", text: g.text(g.int(40, 2500)) }])
      entry({
        type: "system",
        subtype: "stop_hook_summary",
        hookCount: 1,
        hookInfos: [{ command: "true", durationMs: g.int(1, 200) }],
        hookErrors: [],
        preventedContinuation: false,
        stopReason: "",
        hasOutput: false,
        level: "suggestion",
      })
      out.line({
        type: "last-prompt",
        lastPrompt: prompt.slice(0, 200),
        leafUuid: parent,
        sessionId: o.sessionId,
      })
      if (turns % 7 === 1)
        out.line({ type: "ai-title", aiTitle: g.text(30), sessionId: o.sessionId })
    }
    out.flush()
  } finally {
    closeSync(fd)
  }
  return { bytes: out.bytes, lines: out.lines, turns, agents }
}

function writeSubagent(
  g: Gen,
  a: {
    dir: string
    sessionId: string
    agentId: string
    toolUseId: string
    description: string
    agentType: string
    bytes: number
    common: Record<string, unknown>
    model: string
  },
): GeneratedAgent {
  const sub = path.join(a.dir, a.sessionId, "subagents")
  mkdirSync(sub, { recursive: true })
  const file = path.join(sub, `agent-${a.agentId}.jsonl`)
  const metaFile = path.join(sub, `agent-${a.agentId}.meta.json`)
  const metaFd = openSync(metaFile, "w", 0o600)
  try {
    writeSync(
      metaFd,
      JSON.stringify({
        agentType: a.agentType,
        description: a.description,
        toolUseId: a.toolUseId,
        spawnDepth: 1,
        model: a.model,
      }),
    )
  } finally {
    closeSync(metaFd)
  }
  const fd = openSync(file, "w", 0o600)
  const out = new Sink(fd)
  let parent: string | null = null
  try {
    while (out.bytes < a.bytes) {
      const uuid = g.uuid()
      const assistantTurn = out.lines % 2 === 1
      out.line({
        parentUuid: parent,
        isSidechain: true,
        agentId: a.agentId,
        type: assistantTurn ? "assistant" : "user",
        message: assistantTurn
          ? {
              model: a.model,
              id: `msg_01${g.hex(22)}`,
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: g.text(g.int(40, 1500)) }],
              stop_reason: "end_turn",
              usage: { input_tokens: 3, output_tokens: g.int(10, 500) },
            }
          : { role: "user", content: g.text(g.int(40, 1500)) },
        uuid,
        timestamp: g.at(),
        ...a.common,
      })
      parent = uuid
    }
    out.flush()
  } finally {
    closeSync(fd)
  }
  return {
    toolUseId: a.toolUseId,
    agentId: a.agentId,
    description: a.description,
    agentType: a.agentType,
    file,
    metaFile,
  }
}
