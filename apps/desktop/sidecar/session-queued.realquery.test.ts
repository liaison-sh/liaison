// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REAL QUERIES: the queued bubble (P1-T07; S18, OPEN-1).
// Claude Code INSTALLED on this Mac (signed in, forced as the session's
// binary), claude-haiku-5-5, Standard, through runUnattended:
//
// - mid-turn: the prompt runs a 20-second Bash sleep, the owner's message is
//   written on the control lines 5 s in; the sidecar must emit
//   user_message{commandId} and command_applied for it (the web clears the
//   bubble on either);
// - after a result: the message is written 0.2 s after the turn's result
//   (the race with the run's end): it is either delivered in this run, or
//   left unsettled (no command_applied, no cancelled) so the API resumes
//   the session with it.
//
// Every SDK message type/subtype, every command_lifecycle {uuid, state}, every
// user message's isReplay/uuid, every input uuid the SDK pulled and the
// sidecar's user_message/command_applied go to stderr (the discriminator).
//
// Skipped unless macOS with the CLI signed in.
import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import {
  commandLine,
  type NodeSessionCommand,
} from "../../../packages/shared/src/node-session-protocol"
import { AsyncQueue } from "./index"
import { type QueryFn, runUnattended, type UnattendedJob } from "./unattended"

function signedIn(): boolean {
  if (process.platform !== "darwin") return false
  try {
    // No claude on PATH throws here: skipped, never failed.
    const status = Bun.spawnSync(["claude", "auth", "status"], { stdout: "pipe", stderr: "pipe" })
    return (JSON.parse(status.stdout.toString()) as { loggedIn?: boolean }).loggedIn === true
  } catch {
    return false
  }
}

/** This Mac's installed Claude Code: the `claude` on PATH, its link resolved. */
const onPath = Bun.which("claude")
const INSTALLED = process.env.LIAISON_RQ_INSTALLED_CLAUDE ?? (onPath ? realpathSync(onPath) : "")

const READY = signedIn() && existsSync(INSTALLED)
if (!READY) {
  process.stderr.write(
    "session-queued.realquery: SKIPPED - not macOS, no installed Claude CLI, or it is not signed in\n",
  )
}
const MODEL = "claude-haiku-5-5"
const RUN_MS = 240_000
const base = READY ? realpathSync(mkdtempSync(path.join(homedir(), ".liaison-queued-rq-"))) : ""
const tmpBase = READY ? realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-queued-rq-"))) : ""
afterAll(() => {
  if (!READY) return
  rmSync(base, { recursive: true, force: true })
  rmSync(tmpBase, { recursive: true, force: true })
})

const CMD = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const line = (n: number, command: NodeSessionCommand) =>
  commandLine({ type: "command", commandId: CMD(n), seq: n, command })

type Ev = { type: string; payload: Record<string, unknown> }

function versionOf(binary: string): string | null {
  const r = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
  return /(\d+\.\d+\.\d+)/.exec(r.stdout.toString())?.[1] ?? null
}

function job(id: string, prompt: string): UnattendedJob {
  const nodeRoot = path.join(base, "Liaison Node")
  mkdirSync(nodeRoot, { recursive: true })
  return {
    jobId: `${id.slice(0, 8)}-2222-4333-8444-${id.slice(-12)}`,
    server: "https://liaison.example",
    agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    agentName: "Personal",
    model: MODEL,
    profile: { level: "standard", liaisonTools: false },
    session: {
      id,
      source: "app",
      model: MODEL,
      level: "standard",
      profileLevel: "standard",
      configKind: "isolated",
      liaisonTools: false,
    },
    prompt,
    hardTokenLimit: null,
    nodeRoot,
  }
}

/** The SDK query, teed: every message out and every input pulled goes to the trace. */
function teeQuery(trace: string[], onMessage: (m: Record<string, unknown>) => void): QueryFn {
  const t0 = Date.now()
  const log = (s: string) => trace.push(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`)
  return ({ prompt, options }) => {
    const input: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        const it = prompt[Symbol.asyncIterator]()
        return {
          async next() {
            const r = await it.next()
            if (r.done) log("input: closed")
            else log(`input: pulled uuid=${r.value.uuid}`)
            return r
          },
        }
      },
    }
    const q = sdkQuery({ prompt: input, options })
    async function* messages() {
      for await (const message of q) {
        const m = message as unknown as Record<string, unknown>
        const parts = [`sdk: ${String(m.type)}/${String(m.subtype ?? "")}`]
        if (m.type === "command_lifecycle") parts.push(`uuid=${m.command_uuid} state=${m.state}`)
        if (m.type === "user") parts.push(`uuid=${m.uuid} isReplay=${m.isReplay ?? false}`)
        if (m.user_message_uuids)
          parts.push(`user_message_uuids=${JSON.stringify(m.user_message_uuids)}`)
        if (m.type === "user") {
          const content = (m.message as { content?: unknown })?.content
          parts.push(`content=${JSON.stringify(content).slice(0, 160)}`)
        }
        if (m.type === "system" && m.subtype === "init")
          parts.push(`version=${m.claude_code_version}`)
        log(parts.join(" "))
        onMessage(m)
        yield message
      }
    }
    const gen = messages()
    return new Proxy(q, {
      get(target, prop) {
        if (prop === Symbol.asyncIterator) return () => gen
        if (prop === "next") return gen.next.bind(gen)
        const v = Reflect.get(target, prop, target)
        return typeof v === "function" ? v.bind(target) : v
      },
    }) as Query
  }
}

async function runCase(
  id: string,
  prompt: string,
  when: (m: Record<string, unknown>, elapsedMs: number) => number | null,
) {
  const version = versionOf(INSTALLED) as string
  const lines: Array<Record<string, unknown>> = []
  const trace: string[] = []
  const control = new AsyncQueue<string>()
  let sent = false
  const t0 = Date.now()
  const send = () => {
    if (sent) return
    sent = true
    trace.push(`+${((Date.now() - t0) / 1000).toFixed(1)}s control: message ${CMD(1)}`)
    control.push(
      line(1, { type: "message", payload: { text: "Also end your reply with the word KIWI." } }),
    )
  }
  const queryFn = teeQuery(trace, (m) => {
    const delay = when(m, Date.now() - t0)
    if (delay !== null && !sent) setTimeout(send, delay)
  })
  const outcome = await runUnattended({
    job: job(id, prompt),
    emit: (l) => {
      lines.push(l)
      if (l.type === "session_events") {
        for (const e of l.events as Ev[]) {
          if (e.type === "user_message" || e.type === "command_applied") {
            trace.push(
              `+${((Date.now() - t0) / 1000).toFixed(1)}s sidecar: ${e.type} ${JSON.stringify(e.payload)}`,
            )
          }
        }
      }
    },
    control,
    cliPath: INSTALLED,
    npmPrefix: null,
    claudeBinary: { bundledVersion: version, run: async () => null },
    dataDir: path.join(tmpBase, "data"),
    stopGraceMs: 10_000,
    queryFn,
  })
  const events = lines.filter((l) => l.type === "session_events").flatMap((l) => l.events as Ev[])
  const start = events.find((e) => e.type === "system" && e.payload.subtype === "start")
  const data = (start?.payload.data ?? {}) as Record<string, unknown>
  return { outcome, events, trace, claudeCodeVersion: data.claudeCodeVersion, version, lines }
}

const SLEEP_PROMPT =
  "Run exactly this with the Bash tool, once: sleep 20 && echo slept. Then reply with one short sentence."

describe.if(READY)("queued bubble, real query, installed CLI (S18, OPEN-1)", () => {
  it(
    "S18: a message sent 5 s into a 20 s Bash sleep is delivered (user_message with its commandId, command_applied)",
    async () => {
      // 5 s after the Bash call starts (the first tool_use in an assistant message).
      const r = await runCase("6a6a6a11-1111-4222-8333-444444444444", SLEEP_PROMPT, (m) => {
        const content = (m.message as { content?: Array<{ type?: string }> } | undefined)?.content
        return m.type === "assistant" && content?.some((b) => b.type === "tool_use") ? 5_000 : null
      })
      process.stderr.write(
        `session-queued.realquery mid-turn: claudeCode=${String(r.claudeCodeVersion)} status=${r.outcome.status}\n${r.trace.join("\n")}\n`,
      )
      expect(r.claudeCodeVersion).toBe(r.version)
      const userMessages = r.events.filter((e) => e.type === "user_message").map((e) => e.payload)
      const applied = r.events.filter((e) => e.type === "command_applied").map((e) => e.payload)
      expect(userMessages).toContainEqual({
        text: "Also end your reply with the word KIWI.",
        commandId: CMD(1),
      })
      expect(applied).toContainEqual({ commandId: CMD(1), type: "message", outcome: "applied" })
    },
    RUN_MS,
  )

  it(
    "S18: a message sent while a subagent runs a 20 s sleep is delivered",
    async () => {
      const r = await runCase(
        "6c6c6c11-1111-4222-8333-444444444444",
        "Use the Agent tool once (subagent_type general-purpose) with this task for the subagent: " +
          "'Run exactly this with the Bash tool, once: sleep 20 && echo slept. Then reply slept.' " +
          "When it returns, reply with one short sentence.",
        (m) => (m.type === "system" && m.subtype === "task_started" ? 5_000 : null),
      )
      process.stderr.write(
        `session-queued.realquery subagent: claudeCode=${String(r.claudeCodeVersion)} status=${r.outcome.status}\n${r.trace.join("\n")}\n`,
      )
      const userMessages = r.events.filter((e) => e.type === "user_message").map((e) => e.payload)
      expect(userMessages).toContainEqual({
        text: "Also end your reply with the word KIWI.",
        commandId: CMD(1),
      })
    },
    RUN_MS,
  )

  it(
    "S18: a message sent after the turn ended while a background task is open is delivered",
    async () => {
      const r = await runCase(
        "6d6d6d11-1111-4222-8333-444444444444",
        "Run exactly this with the Bash tool, once, with run_in_background set to true: sleep 20 && echo slept. " +
          "Then end your turn at once with the single word STARTED. When the background command finishes, reply with one short sentence.",
        (m) => (m.type === "result" ? 3_000 : null),
      )
      process.stderr.write(
        `session-queued.realquery background: claudeCode=${String(r.claudeCodeVersion)} status=${r.outcome.status}\n${r.trace.join("\n")}\n`,
      )
      const userMessages = r.events.filter((e) => e.type === "user_message").map((e) => e.payload)
      expect(userMessages).toContainEqual({
        text: "Also end your reply with the word KIWI.",
        commandId: CMD(1),
      })
    },
    RUN_MS,
  )

  it(
    "S18: a message sent 0.2 s after a result is delivered in this run or left unsettled for the resume",
    async () => {
      const r = await runCase(
        "6b6b6b11-1111-4222-8333-444444444444",
        "Reply with the single word READY.",
        (m) => (m.type === "result" ? 200 : null),
      )
      // Let a late settle, if any, reach the lines.
      await Bun.sleep(1_000)
      process.stderr.write(
        `session-queued.realquery after-result: claudeCode=${String(r.claudeCodeVersion)} status=${r.outcome.status}\n${r.trace.join("\n")}\n`,
      )
      const userMessages = r.events.filter((e) => e.type === "user_message").map((e) => e.payload)
      const applied = r.events.filter((e) => e.type === "command_applied").map((e) => e.payload)
      const delivered = userMessages.some((p) => p.commandId === CMD(1))
      if (delivered) {
        expect(applied).toContainEqual({ commandId: CMD(1), type: "message", outcome: "applied" })
      } else {
        // Never settled: the API sees it unacked and resumes the session with it.
        expect(applied.filter((p) => p.commandId === CMD(1))).toEqual([])
      }
    },
    RUN_MS,
  )
})
