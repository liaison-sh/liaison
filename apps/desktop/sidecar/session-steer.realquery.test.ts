// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REAL QUERIES: steering a running session (P3-T05, P3-T08; D36, S9, S12).
// Claude Code on this Mac (signed in), claude-haiku-5-5, Strict, through
// runUnattended with the owner's commands on its control lines, as the shell
// writes them:
//
// - an answer resolves a waiting AskUserQuestion, and a message sent while
//   the turn runs is read by the CLI (user_message with its commandId, then
//   command_applied), and the run ends done only after it was handled;
// - a Stop while a question waits denies it (decision by stop) and ends the
//   run stopped.
//
// Skipped unless macOS with the CLI signed in. Evidence goes to stderr.
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import {
  commandLine,
  type NodeSessionCommand,
} from "../../../packages/shared/src/node-session-protocol"
import { AsyncQueue } from "./index"
import { runUnattended, type UnattendedJob } from "./unattended"

function signedIn(): boolean {
  if (process.platform !== "darwin") return false
  const status = Bun.spawnSync(["claude", "auth", "status"], { stdout: "pipe", stderr: "pipe" })
  try {
    return (JSON.parse(status.stdout.toString()) as { loggedIn?: boolean }).loggedIn === true
  } catch {
    return false
  }
}

const READY = signedIn()
if (!READY) {
  process.stderr.write(
    "session-steer.realquery: SKIPPED - not macOS, or the CLI is not signed in\n",
  )
}
const MODEL = "claude-haiku-5-5"
const RUN_MS = 180_000
const base = READY ? realpathSync(mkdtempSync(path.join(homedir(), ".liaison-steer-rq-"))) : ""
const tmpBase = READY ? realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-steer-rq-"))) : ""
afterAll(() => {
  if (!READY) return
  rmSync(base, { recursive: true, force: true })
  rmSync(tmpBase, { recursive: true, force: true })
})

const CMD = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const line = (n: number, command: NodeSessionCommand) =>
  commandLine({ type: "command", commandId: CMD(n), seq: n, command })

type Ev = { type: string; payload: Record<string, unknown> }

function job(id: string, prompt: string): UnattendedJob {
  const nodeRoot = path.join(base, "Liaison Node")
  mkdirSync(nodeRoot, { recursive: true })
  return {
    jobId: `${id.slice(0, 8)}-2222-4333-8444-${id.slice(-12)}`,
    server: "https://liaison.example",
    agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    agentName: "Personal",
    model: MODEL,
    profile: { level: "strict", liaisonTools: false },
    session: {
      id,
      source: "app",
      model: MODEL,
      level: "strict",
      profileLevel: "strict",
      configKind: "isolated",
      liaisonTools: false,
    },
    prompt,
    hardTokenLimit: null,
    nodeRoot,
  }
}

function start(j: UnattendedJob) {
  const lines: Array<Record<string, unknown>> = []
  const control = new AsyncQueue<string>()
  const running = runUnattended({
    job: j,
    emit: (l) => lines.push(l),
    control,
    dataDir: path.join(tmpBase, "data"),
    stopGraceMs: 10_000,
  })
  const events = () =>
    lines.filter((l) => l.type === "session_events").flatMap((l) => l.events as Ev[])
  return { lines, control, running, events }
}

async function until(check: () => boolean, ms = 120_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(100)
  }
}

const QUESTION_PROMPT =
  "Your first action must be a call to the AskUserQuestion tool, asking me one question: pick A or B " +
  "(two options, A and B). Do not write any text before that call. After I answer, reply with only " +
  "the letter I picked. Do not use any other tool."

/**
 * A session waiting on its question. The model sometimes answers in text
 * instead of calling the tool: that run is discarded and a fresh session
 * tried, three times at most (the steering is under test, not the model).
 */
async function waitingOnQuestion(idBase: string): Promise<ReturnType<typeof start>> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Distinct first 12 characters: each session has its own dir (applied log).
    const s = start(job(`${idBase}${attempt}-1111-4222-8333-444444444444`, QUESTION_PROMPT))
    let ended = false
    void s.running.then(() => {
      ended = true
    })
    await until(() => ended || s.events().some((e) => e.type === "question"))
    if (s.events().some((e) => e.type === "question")) return s
    process.stderr.write(`session-steer.realquery: attempt ${attempt} asked no question\n`)
  }
  throw new Error("the model never called AskUserQuestion")
}

describe.if(READY)("session steering, real query (D36, S9, S12)", () => {
  it(
    "an answer resolves the waiting question; a message sent mid-turn is read, applied, and the run ends done after it",
    async () => {
      const s = await waitingOnQuestion("5e5e5e1")
      const q = s.events().find((e) => e.type === "question") as Ev
      const text = (q.payload.questions as Array<{ question: string }>)[0]?.question as string
      // No timeout: still waiting a while later.
      await Bun.sleep(3_000)
      expect(s.events().some((e) => e.type === "decision")).toBe(false)
      s.control.push(
        line(1, {
          type: "answer",
          payload: { requestId: q.payload.requestId as string, answers: { [text]: "B" } },
        }),
      )
      s.control.push(
        line(2, {
          type: "message",
          payload: { text: "Also end your reply with the word KIWI." },
        }),
      )
      const outcome = await s.running
      const events = s.events()
      const evidence = {
        status: outcome.status,
        text: outcome.text,
        applied: events.filter((e) => e.type === "command_applied").map((e) => e.payload),
        decisions: events.filter((e) => e.type === "decision").map((e) => e.payload),
        userMessages: events.filter((e) => e.type === "user_message").map((e) => e.payload),
        results: events.filter((e) => e.type === "result").map((e) => e.payload.text),
      }
      process.stderr.write(
        `session-steer.realquery answer+message: ${JSON.stringify(evidence, null, 2)}\n`,
      )
      expect(outcome.status).toBe("done")
      expect(evidence.decisions).toEqual([
        { requestId: q.payload.requestId, outcome: "answered", by: "owner" },
      ])
      expect(evidence.applied).toEqual([
        { commandId: CMD(1), type: "answer", outcome: "applied" },
        { commandId: CMD(2), type: "message", outcome: "applied" },
      ])
      expect(evidence.userMessages).toContainEqual({
        text: "Also end your reply with the word KIWI.",
        commandId: CMD(2),
      })
      expect(evidence.results.join("\n")).toContain("B")
      expect(outcome.text.toUpperCase()).toContain("KIWI")
    },
    RUN_MS,
  )

  it(
    "a Stop while a question waits denies it by stop and ends the run stopped",
    async () => {
      const s = await waitingOnQuestion("5e5e5e2")
      const t0 = Date.now()
      s.control.push(line(1, { type: "stop", payload: {} }))
      const outcome = await s.running
      const events = s.events()
      process.stderr.write(
        `session-steer.realquery stop: ${JSON.stringify({ status: outcome.status, ms: Date.now() - t0, decisions: events.filter((e) => e.type === "decision").map((e) => e.payload), applied: events.filter((e) => e.type === "command_applied").map((e) => e.payload) }, null, 2)}\n`,
      )
      expect(outcome.status).toBe("stopped")
      expect(events.find((e) => e.type === "decision")?.payload).toMatchObject({
        outcome: "deny",
        by: "stop",
      })
      expect(events.filter((e) => e.type === "command_applied").map((e) => e.payload)).toEqual([
        { commandId: CMD(1), type: "stop", outcome: "applied" },
      ])
      expect(s.lines.at(-1)?.type).toBe("job_done")
    },
    RUN_MS,
  )
})
