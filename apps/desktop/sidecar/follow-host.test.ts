// SPDX-License-Identifier: FSL-1.1-ALv2
//
// W3 T06: the follow host (S41, S43, S44, D28 b, A43, A45, A50, A57, A60,
// A62). Every fixture is a scratch owner config dir under the temp dir, with
// CLAUDE_CONFIG_DIR pointed at it around each case (the SDK reads it at call
// time); the real ~/.claude is never touched. Keys are assembled at runtime.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  NODE_IMPORT_LIMITS,
  nodeFollowResultSchema,
} from "../../../packages/shared/src/node-import"
import {
  NODE_EVENT_LIMITS,
  type NodeSessionEventIn,
} from "../../../packages/shared/src/node-session-protocol"
import { redactImportEvent } from "../../../packages/shared/src/secret-redaction"
import {
  B2_2_FORMS,
  B2_6_FORMS,
  FIXTURE_PW,
  FIXTURE_PW2,
} from "../../../packages/shared/src/secret-redaction.fixtures"
import { generateTranscript } from "./__fixtures__/transcript-gen"
import { FollowHost, type FollowHostOptions, followMain } from "./follow-host"
import { recordOwnerRun, sessionConfigDir } from "./session-config"
import type { DriverProbe } from "./session-driver"
import { slugOf } from "./session-import"
import { TranscriptFollow } from "./transcript-follow"

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-follow-host-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const savedEnv = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedEnv
})

let n = 0
const uuid = (i: number) => `0000bbbb-0000-4000-8000-${i.toString(16).padStart(12, "0")}`
const nextId = () => uuid(++n)

/** A key a scanner recognises, built at runtime (never a literal in the repo). */
const runtimeKey = () => `${["sk", "ant", "api03"].join("-")}-${"Q7x".repeat(30)}`

const quietProbe: DriverProbe = {
  platform: "test",
  mtimeMs: () => null,
  registry: () => [],
  processes: () => null,
}

interface Fixture {
  root: string
  configDir: string
  shared: string
  /** The node's app data dir (its session config dirs, D49 F6). */
  dataDir: string
}

/** The server the shell names in its follow_add lines, and another one. */
const SERVER = "https://liaison.example"
const OTHER_SERVER = "https://other.example"

function setup(): Fixture {
  const root = path.join(base, `c${++n}`)
  const configDir = path.join(root, "owner-config")
  mkdirSync(path.join(configDir, "projects"), { recursive: true })
  const shared = path.join(root, "work", "repo")
  mkdirSync(shared, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir
  return { root, configDir, shared, dataDir: path.join(root, "app-data") }
}

/** D49 F6: this node ran `sdkId` as the Liaison session `sessionId` for `server`. */
function ranHere(fx: Fixture, sessionId: string, sdkId: string, server = SERVER) {
  const dir = sessionConfigDir(sessionId, fx.dataDir)
  mkdirSync(dir, { recursive: true })
  recordOwnerRun(dir, server, sdkId)
}

const transcriptPath = (fx: Fixture, sdkId: string, cwd = fx.shared) =>
  path.join(fx.configDir, "projects", slugOf(cwd), `${sdkId}.jsonl`)

const line = (o: unknown) => `${JSON.stringify(o)}\n`

function common(fx: Fixture, sdkId: string, entrypoint = "claude-vscode", cwd = fx.shared) {
  return { cwd, sessionId: sdkId, version: "2.1.296", gitBranch: "main", entrypoint }
}
const userLine = (c: object, text: string) => ({
  type: "user",
  isSidechain: false,
  message: { role: "user", content: text },
  ...c,
})
const assistantLine = (c: object, content: unknown[]) => ({
  type: "assistant",
  isSidechain: false,
  message: {
    id: "msg_x",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    usage: { input_tokens: 3, output_tokens: 2 },
  },
  ...c,
})
const toolResultLine = (c: object, id: string, content: string) => ({
  type: "user",
  isSidechain: false,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ...c,
})

/** A small hand-written session (user + assistant) the SDK and the head check accept. */
function writeSession(
  fx: Fixture,
  sdkId: string,
  o: { entrypoint?: string; cwd?: string; extra?: unknown[] } = {},
): string {
  const cwd = o.cwd ?? fx.shared
  const file = transcriptPath(fx, sdkId, cwd)
  mkdirSync(path.dirname(file), { recursive: true })
  const c = common(fx, sdkId, o.entrypoint, cwd)
  writeFileSync(
    file,
    line(userLine(c, "please fix the tests")) +
      line(assistantLine(c, [{ type: "text", text: "on it" }])) +
      (o.extra ?? []).map(line).join(""),
  )
  return file
}

interface Out {
  lines: Record<string, unknown>[]
  logs: string[]
  /** Unacknowledged bytes at most, over the whole run. */
  maxPending: number
}

function harness(
  fx: Fixture,
  extra: Partial<FollowHostOptions> & { ackMs?: number; keep?: boolean } = {},
) {
  let clock = 1_000_000
  const out: Out = { lines: [], logs: [], maxPending: 0 }
  let pending = 0
  const keep = extra.keep ?? true
  const host = new FollowHost({
    configDir: fx.configDir,
    dataDir: fx.dataDir,
    probe: quietProbe,
    now: () => clock,
    log: (code) => out.logs.push(code),
    write: (text) => {
      const bytes = Buffer.byteLength(text)
      pending += bytes
      out.maxPending = Math.max(out.maxPending, pending)
      if (keep) out.lines.push(JSON.parse(text) as Record<string, unknown>)
      else {
        const parsed = JSON.parse(text) as { type: string; events?: NodeSessionEventIn[] }
        if (parsed.type !== "session_events") out.lines.push(parsed)
        else
          out.lines.push({
            type: "session_events",
            sessionId: (parsed as unknown as { sessionId: string }).sessionId,
            count: parsed.events?.length ?? 0,
            subagentBytes: (parsed.events ?? [])
              .filter((e) => e.parentToolUseId)
              .reduce((a, e) => a + Buffer.byteLength(JSON.stringify(e)), 0),
            taskStarted: (parsed.events ?? [])
              .filter((e) => (e.payload as { subtype?: string }).subtype === "task_started")
              .map((e) => (e.payload as { data: { toolUseId: string } }).data.toolUseId),
          })
      }
      if (!extra.ackMs) {
        pending -= bytes
        return Promise.resolve()
      }
      return new Promise((resolve) =>
        setTimeout(() => {
          pending -= bytes
          resolve()
        }, extra.ackMs),
      )
    },
    ...extra,
  })
  const events = (sessionId?: string) =>
    out.lines
      .filter((l) => l.type === "session_events" && (!sessionId || l.sessionId === sessionId))
      .flatMap((l) => l.events as NodeSessionEventIn[])
  const done = () => out.lines.filter((l) => l.type === "follow_done")
  const system = (subtype: string, sessionId?: string) =>
    events(sessionId).filter(
      (e) => e.type === "system" && (e.payload as { subtype: string }).subtype === subtype,
    )
  return {
    host,
    out,
    events,
    done,
    system,
    advance: (ms: number) => {
      clock += ms
    },
    add: async (o: {
      sdkSessionId: string
      sessionId?: string
      jobId?: string
      cwdSubdir?: string
      startAt?: "window" | "end"
      once?: boolean
      inPlace?: boolean
      folderPath?: string
      worktreePath?: string
      server?: string
    }) => {
      const ids = { sessionId: o.sessionId ?? nextId(), jobId: o.jobId ?? nextId() }
      await host.control(
        JSON.stringify({
          type: "follow_add",
          ...ids,
          folderPath: o.folderPath ?? fx.shared,
          ...(o.worktreePath !== undefined ? { worktreePath: o.worktreePath } : {}),
          cwdSubdir: o.cwdSubdir ?? "",
          sdkSessionId: o.sdkSessionId,
          startAt: o.startAt ?? "window",
          once: o.once ?? false,
          inPlace: o.inPlace ?? false,
          server: o.server ?? SERVER,
        }),
      )
      return ids
    },
  }
}

const textOf = (e: NodeSessionEventIn) => JSON.stringify(e.payload)
const rssMb = () => {
  Bun.gc(true)
  return process.memoryUsage().rss / (1024 * 1024)
}

describe("follow host: replay and stream (S41, A43, A62)", () => {
  it("S41: a follow at window replays only the last historyBytes, starts at a line boundary, and its first event is system imported {historyFrom: window}", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = transcriptPath(fx, sdkId)
    generateTranscript({ file, sessionId: sdkId, cwd: fx.shared, bytes: 1024 * 1024, seed: 3 })
    const historyBytes = 256 * 1024
    const h = harness(fx, { limits: { historyBytes } })
    const { sessionId } = await h.add({ sdkSessionId: sdkId, once: true })
    for (let i = 0; i < 5; i++) await h.host.tick()
    const ev = h.events(sessionId)
    expect(ev[0]?.type).toBe("system")
    expect(ev[0]?.payload).toMatchObject({
      subtype: "imported",
      data: { historyFrom: "window", from: "vscode" },
    })
    expect(ev[1]?.payload).toMatchObject({ subtype: "follow", data: { state: "started" } })
    // The same file followed from the first whole line of the window, redacted alike.
    const size = statSync(file).size
    const buf = Buffer.alloc(historyBytes)
    const fd = openSync(file, "r")
    readSync(fd, buf, 0, historyBytes, size - historyBytes - 1)
    closeSync(fd)
    const aligned = size - historyBytes - 1 + buf.indexOf(0x0a) + 1
    expect(aligned).toBeGreaterThanOrEqual(size - historyBytes)
    const reference: NodeSessionEventIn[] = []
    const ref = new TranscriptFollow({
      file,
      offset: aligned,
      emit: (e) => reference.push(...e),
      transform: redactImportEvent,
    })
    while (ref.poll() > 0) {}
    const replayed = ev.slice(2)
    expect(replayed.map((e) => e.type)).toEqual(reference.map((e) => e.type))
    expect(replayed.length).toBeGreaterThan(0)
    expect(h.done()).toEqual([
      {
        type: "follow_done",
        sessionId,
        jobId: expect.any(String),
        why: "replayed",
        endOffset: size,
      },
    ])
  })

  it("S41: a line appended after the replay is emitted within one poll; a partial line waits for its newline", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = writeSession(fx, sdkId)
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    const before = h.events(sessionId).length
    const c = common(fx, sdkId)
    const next = line(userLine(c, "and now the docs"))
    appendFileSync(file, next.slice(0, 30))
    h.advance(1_000)
    await h.host.tick()
    expect(h.events(sessionId).length).toBe(before)
    appendFileSync(file, next.slice(30))
    h.advance(1_000)
    await h.host.tick()
    expect(
      h
        .events(sessionId)
        .slice(before)
        .map((e) => e.payload),
    ).toEqual([{ text: "and now the docs" }])
    const tagged = h.out.lines.filter((l) => l.type === "session_events")
    expect(tagged.every((l) => l.sessionId === sessionId && typeof l.jobId === "string")).toBe(true)
  })

  it("A62: a once follow's follow_done replayed carries endOffset = the size read; A45: once:true ends with follow_done replayed after the window", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = writeSession(fx, sdkId)
    const h = harness(fx)
    const { sessionId, jobId } = await h.add({ sdkSessionId: sdkId, once: true })
    await h.host.tick()
    expect(h.done()).toEqual([
      { type: "follow_done", sessionId, jobId, why: "replayed", endOffset: statSync(file).size },
    ])
    expect(h.system("imported", sessionId)[0]?.payload).toMatchObject({
      data: { historyFrom: "start", from: "vscode" },
    })
    expect(h.host.follows).toBe(0)
  })

  it("A45: follow_remove ends owner with the offset reached; a deleted transcript ends with transcript_gone", async () => {
    const fx = setup()
    const a = nextId()
    const b = nextId()
    const fileA = writeSession(fx, a)
    const fileB = writeSession(fx, b)
    const h = harness(fx)
    const ra = await h.add({ sdkSessionId: a })
    const rb = await h.add({ sdkSessionId: b })
    await h.host.tick()
    await h.host.control(JSON.stringify({ type: "follow_remove", ...ra }))
    unlinkSync(fileB)
    for (let i = 0; i < 3; i++) {
      h.advance(5_000)
      await h.host.tick()
    }
    expect(h.done()).toEqual([
      { type: "follow_done", ...ra, why: "owner", endOffset: statSync(fileA).size },
      { type: "follow_done", ...rb, why: "transcript_gone" },
    ])
  })

  it("A45: three follows in one host interleave their lines, each tagged with its own sessionId and jobId", async () => {
    const fx = setup()
    const h = harness(fx)
    const follows = []
    for (let i = 0; i < 3; i++) {
      const sdkId = nextId()
      const file = writeSession(fx, sdkId)
      follows.push({ file, sdkId, ...(await h.add({ sdkSessionId: sdkId })) })
    }
    await h.host.tick()
    for (let round = 0; round < 2; round++) {
      for (const f of follows)
        appendFileSync(f.file, line(userLine(common(fx, f.sdkId), `${f.sessionId} ${round}`)))
      h.advance(1_000)
      await h.host.tick()
    }
    for (const f of follows) {
      const mine = h.out.lines.filter(
        (l) => l.type === "session_events" && l.sessionId === f.sessionId,
      )
      expect(mine.every((l) => l.jobId === f.jobId)).toBe(true)
      const typed = h
        .events(f.sessionId)
        .filter((e) => e.type === "user_message")
        .map((e) => (e.payload as { text: string }).text)
      expect(typed).toEqual(["please fix the tests", `${f.sessionId} 0`, `${f.sessionId} 1`])
    }
    const order = h.out.lines.filter((l) => l.type === "session_events").map((l) => l.sessionId)
    expect(new Set(order.slice(-3)).size).toBe(3)
  })
})

describe("follow host: redaction on every byte path (S43, A59, M7)", () => {
  it("S43: a key in an assistant text, a tool_call input and a tool_result of the replay and of a streamed line is redacted in the emitted line", async () => {
    const fx = setup()
    const sdkId = nextId()
    const key = runtimeKey()
    const c = common(fx, sdkId)
    const keyed = () => [
      assistantLine(c, [{ type: "text", text: `the key is ${key}` }]),
      assistantLine(c, [
        { type: "tool_use", id: "toolu_k1", name: "Bash", input: { command: `export K=${key}` } },
      ]),
      toolResultLine(c, "toolu_k1", `printed ${key}`),
    ]
    const file = writeSession(fx, sdkId, { extra: keyed() })
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    appendFileSync(file, keyed().map(line).join(""))
    h.advance(1_000)
    await h.host.tick()
    const ev = h.events(sessionId)
    expect(ev.filter((e) => textOf(e).includes("[redacted")).length).toBeGreaterThanOrEqual(6)
    expect(JSON.stringify(h.out.lines)).not.toContain(key.slice(0, 24))
  })

  it('S43: a key used as a tool_call input key, and a \'"DB_PASSWORD": "x"\' JSON config in a tool_result', async () => {
    const fx = setup()
    const sdkId = nextId()
    const key = runtimeKey()
    const c = common(fx, sdkId)
    const pw = `hunter${"9".repeat(6)}`
    writeSession(fx, sdkId, {
      extra: [
        assistantLine(c, [
          { type: "tool_use", id: "toolu_k2", name: "Write", input: { [key]: 1 } },
        ]),
        toolResultLine(c, "toolu_k2", `{"DB_PASSWORD": "${pw}", "port": 5432}`),
      ],
    })
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    const all = JSON.stringify(h.events(sessionId))
    expect(all).not.toContain(key.slice(0, 24))
    expect(all).not.toContain(pw)
    expect(all).toContain("port")
  })

  it("S43: a key in a subagent line and in a subagent meta description", async () => {
    const fx = setup()
    const sdkId = nextId()
    const key = runtimeKey()
    const c = common(fx, sdkId)
    const file = writeSession(fx, sdkId, {
      extra: [
        assistantLine(c, [
          {
            type: "tool_use",
            id: "toolu_ag1",
            name: "Agent",
            input: { description: "look", prompt: "p" },
          },
        ]),
      ],
    })
    writeSubagent(file, sdkId, "a1", "toolu_ag1", {
      description: `use ${key}`,
      text: `found ${key}`,
    })
    appendFileSync(file, line(toolResultLine(c, "toolu_ag1", "done")))
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    for (let i = 0; i < 3; i++) {
      await h.host.tick()
      h.advance(1_000)
    }
    expect(h.system("task_started", sessionId).length).toBe(1)
    expect(h.events(sessionId).some((e) => e.parentToolUseId === "toolu_ag1")).toBe(true)
    expect(JSON.stringify(h.out.lines)).not.toContain(key.slice(0, 24))
  })

  it("S43: an in-place (D28 b) follow's streamed line is redacted too", async () => {
    const fx = setup()
    const sdkId = nextId()
    const key = runtimeKey()
    const file = writeSession(fx, sdkId, { entrypoint: "liaison-node" })
    const h = harness(fx)
    const ran = nextId()
    ranHere(fx, ran, sdkId)
    const { sessionId } = await h.add({
      sessionId: ran,
      sdkSessionId: sdkId,
      inPlace: true,
      startAt: "end",
    })
    await h.host.tick()
    appendFileSync(file, line(userLine(common(fx, sdkId, "claude-vscode"), `my key ${key}`)))
    h.advance(1_000)
    await h.host.tick()
    const typed = h.events(sessionId).filter((e) => e.type === "user_message")
    expect(typed.length).toBe(1)
    expect(textOf(typed[0] as NodeSessionEventIn)).toContain("[redacted")
    expect(JSON.stringify(h.out.lines)).not.toContain(key.slice(0, 24))
  })

  it("S43: a key straddling a field's 64 KiB cap is redacted before the cut: no part of it is uploaded", async () => {
    const fx = setup()
    const sdkId = nextId()
    const key = runtimeKey()
    const c = common(fx, sdkId)
    const kept = 14 // "sk-ant-api03-Q": too short alone for any pattern once cut
    const unit = "lorem ipsum "
    let filler = unit.repeat(Math.ceil(NODE_EVENT_LIMITS.fieldBytes / unit.length))
    filler = filler.slice(0, NODE_EVENT_LIMITS.fieldBytes - kept - 1)
    filler = `${filler} `
    const file = writeSession(fx, sdkId, {
      extra: [
        assistantLine(c, [
          { type: "tool_use", id: "toolu_cap", name: "Bash", input: { command: "env" } },
        ]),
        toolResultLine(c, "toolu_cap", `${filler}${key} and more after it`),
      ],
    })
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    appendFileSync(file, line(userLine(c, `${filler}${key}`)))
    h.advance(1_000)
    await h.host.tick()
    const capped = h
      .events(sessionId)
      .filter((e) => e.type === "tool_result" || e.type === "user_message")
    expect(capped.length).toBe(3)
    const all = JSON.stringify(h.out.lines)
    expect(all).not.toContain(key.slice(0, 6))
    expect(all).not.toContain("Q7xQ7x")
  })

  it("D49 F1: a .env file as the Read tool returns it (1\\tNAME=value) and a Grep path:N: line are redacted, in the replay and in a streamed line", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const pw = ["hun", "ter", "2Zq"].join("")
    // A payment processor's key name, from fragments so the repo-wide no-processor grep stays clean.
    const pspKey = `${["STR", "IPE"].join("")}_SECRET_KEY`
    const toolLines = (n: number) => [
      assistantLine(c, [
        { type: "tool_use", id: `toolu_r${n}`, name: "Read", input: { file_path: ".env" } },
      ]),
      toolResultLine(c, `toolu_r${n}`, `1\tDB_PASSWORD=${pw}\n2\t${pspKey}=${pw}\n3\tPORT=5432\n`),
      assistantLine(c, [
        { type: "tool_use", id: `toolu_g${n}`, name: "Grep", input: { pattern: "TOKEN" } },
      ]),
      toolResultLine(
        c,
        `toolu_g${n}`,
        `config/.env:4:API_TOKEN=${pw}\nconfig/.env-5-DB_PASS=${pw}`,
      ),
    ]
    const file = writeSession(fx, sdkId, { extra: toolLines(1) })
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    appendFileSync(file, toolLines(2).map(line).join(""))
    h.advance(1_000)
    await h.host.tick()
    const results = h.events(sessionId).filter((e) => e.type === "tool_result")
    expect(results.length).toBe(4)
    expect(JSON.stringify(h.out.lines)).not.toContain(pw)
    expect(JSON.stringify(results)).toContain("3\\tPORT=5432")
  })

  it("B2-2: every listed assignment form, in a Read, a Grep and a Bash tool_result, uploads no value, in the replay and in a streamed line", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const text = B2_2_FORMS.map((f) => f.line).join("\n")
    const toolLines = (n: number) =>
      ["Read", "Grep", "Bash"].flatMap((name) => [
        assistantLine(c, [
          { type: "tool_use", id: `toolu_${name}${n}`, name, input: { file_path: ".env" } },
        ]),
        toolResultLine(c, `toolu_${name}${n}`, text),
      ])
    const file = writeSession(fx, sdkId, { extra: toolLines(1) })
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    appendFileSync(file, toolLines(2).map(line).join(""))
    h.advance(1_000)
    await h.host.tick()
    const results = h.events(sessionId).filter((e) => e.type === "tool_result")
    expect(results.length).toBe(6)
    for (const r of results) {
      const output = (r.payload as { output: string }).output
      for (const { form, kept } of B2_2_FORMS) {
        expect({ form, kept: output.includes(kept) }).toEqual({ form, kept: true })
      }
    }
    expect(JSON.stringify(h.out.lines)).not.toContain(FIXTURE_PW)
  })

  it("B2-6: multi-line quoted values, YAML block scalars, netrc and pgpass lines in a Read tool_result upload no value, in the replay and streamed", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const toolLines = (n: number) =>
      B2_6_FORMS.flatMap((f, k) => [
        assistantLine(c, [
          { type: "tool_use", id: `toolu_b${n}_${k}`, name: "Read", input: { file_path: "f" } },
        ]),
        toolResultLine(c, `toolu_b${n}_${k}`, f.text),
      ])
    const file = writeSession(fx, sdkId, { extra: toolLines(1) })
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    appendFileSync(file, toolLines(2).map(line).join(""))
    h.advance(1_000)
    await h.host.tick()
    const outputs = h
      .events(sessionId)
      .filter((e) => e.type === "tool_result")
      .map((e) => (e.payload as { output: string }).output)
    expect(outputs.length).toBe(B2_6_FORMS.length * 2)
    outputs.forEach((output, k) => {
      const { form, kept } = B2_6_FORMS[k % B2_6_FORMS.length] as (typeof B2_6_FORMS)[number]
      for (const part of kept) {
        expect({ form, kept: output.includes(part) }).toEqual({ form, kept: true })
      }
    })
    const wire = JSON.stringify(h.out.lines)
    expect(wire).not.toContain(FIXTURE_PW)
    expect(wire).not.toContain(FIXTURE_PW2)
  })

  it("D49 F2: a tool_call input {password, api_key, env: {DB_PASSWORD}} uploads no value of a secret-named key, in the replay and streamed", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const pw = ["hun", "ter", "2Zq"].join("")
    const call = (n: number) =>
      assistantLine(c, [
        {
          type: "tool_use",
          id: `toolu_m${n}`,
          name: "mcp__deploy__connect",
          input: { host: "db", password: pw, api_key: pw, env: { DB_PASSWORD: pw, PORT: "5432" } },
        },
      ])
    const file = writeSession(fx, sdkId, { extra: [call(1)] })
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    appendFileSync(file, line(call(2)))
    h.advance(1_000)
    await h.host.tick()
    const calls = h.events(sessionId).filter((e) => e.type === "tool_call")
    expect(calls.map((e) => (e.payload as { input: unknown }).input)).toEqual([
      {
        host: "db",
        password: "[redacted]",
        api_key: "[redacted]",
        env: { DB_PASSWORD: "[redacted]", PORT: "5432" },
      },
      {
        host: "db",
        password: "[redacted]",
        api_key: "[redacted]",
        env: { DB_PASSWORD: "[redacted]", PORT: "5432" },
      },
    ])
    expect(JSON.stringify(h.out.lines)).not.toContain(pw)
  })

  it("D49 F3: an MCP tool_result whose text is JSON nested in a JSON string uploads no secret-named value", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const pw = ["hun", "ter", "2Zq"].join("")
    const nested = JSON.stringify({ result: JSON.stringify({ password: pw, rows: 3 }) })
    writeSession(fx, sdkId, {
      extra: [
        assistantLine(c, [
          { type: "tool_use", id: "toolu_j1", name: "mcp__db__query", input: { sql: "select 1" } },
        ]),
        toolResultLine(c, "toolu_j1", nested),
      ],
    })
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    const result = h.events(sessionId).find((e) => e.type === "tool_result")
    const output = ((result as NodeSessionEventIn).payload as { output: string }).output
    expect(JSON.parse(JSON.parse(output).result)).toEqual({ password: "[redacted]", rows: 3 })
    expect(JSON.stringify(h.out.lines)).not.toContain(pw)
  })

  it("D49 F4: a PGP private key block in a Read tool_result uploads none of its body", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const body = Array.from({ length: 6 }, (_, i) => `${i + 3}\t${"Zq9Xw".repeat(12)}${i}`)
    const block = [
      `1\t${["-----BEGIN", "PGP", "PRIVATE", "KEY", "BLOCK-----"].join(" ")}`,
      "2\t",
      ...body,
      `9\t${["-----END", "PGP", "PRIVATE", "KEY", "BLOCK-----"].join(" ")}`,
    ].join("\n")
    writeSession(fx, sdkId, {
      extra: [
        assistantLine(c, [
          { type: "tool_use", id: "toolu_p1", name: "Read", input: { file_path: "key.asc" } },
        ]),
        toolResultLine(c, "toolu_p1", block),
      ],
    })
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    const result = h.events(sessionId).find((e) => e.type === "tool_result")
    expect(((result as NodeSessionEventIn).payload as { output: string }).output).toBe(
      "1\t[redacted private key]",
    )
    expect(JSON.stringify(h.out.lines)).not.toContain("Zq9Xw")
  })

  it("M7.5: an invalid control line holding a runtime-built key logs invalid_control_line and no part of the key", async () => {
    const fx = setup()
    const key = runtimeKey()
    const h = harness(fx)
    await h.host.control(`{"type":"follow_add","token":"${key}"}`)
    await h.host.control(`not json ${key}`)
    expect(h.out.logs).toEqual(["invalid_control_line", "invalid_control_line"])
    expect(h.out.lines).toEqual([])
    expect(h.out.logs.join(" ")).not.toContain(key.slice(0, 10))
  })
})

function writeSubagent(
  mainFile: string,
  sdkId: string,
  agentId: string,
  toolUseId: string,
  o: { description?: string; text?: string; meta?: string; agentType?: string } = {},
): string {
  const dir = path.join(path.dirname(mainFile), sdkId, "subagents")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `agent-${agentId}.meta.json`),
    o.meta ??
      JSON.stringify({
        agentType: o.agentType ?? "Explore",
        description: o.description ?? "look around",
        toolUseId,
        spawnDepth: 1,
      }),
  )
  const file = path.join(dir, `agent-${agentId}.jsonl`)
  const sc = {
    isSidechain: true,
    agentId,
    sessionId: sdkId,
    cwd: "/x",
    entrypoint: "claude-vscode",
  }
  writeFileSync(
    file,
    line({ ...userLine({}, "sub prompt"), ...sc }) +
      line({ ...assistantLine({}, [{ type: "text", text: o.text ?? "sub answer" }]), ...sc }),
  )
  return file
}

describe("follow host: subagents (S44, A52, A60)", () => {
  it("S44: an Agent call with a subagents/agent-x.jsonl and meta.json gives task_started with toolUseId and subagentType, its lines carry parentToolUseId, and the tool_result gives task_notification", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const file = writeSession(fx, sdkId)
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    appendFileSync(
      file,
      line(
        assistantLine(c, [
          {
            type: "tool_use",
            id: "toolu_ag2",
            name: "Agent",
            input: { description: "d", prompt: "p" },
          },
        ]),
      ),
    )
    writeSubagent(file, sdkId, "abc", "toolu_ag2", { agentType: "Explore" })
    h.advance(1_000)
    await h.host.tick()
    const started = h.system("task_started", sessionId)
    expect(started.map((e) => (e.payload as { data: unknown }).data)).toEqual([
      {
        taskId: "abc",
        toolUseId: "toolu_ag2",
        description: "look around",
        subagentType: "Explore",
        taskType: "local_agent",
      },
    ])
    const sub = h.events(sessionId).filter((e) => e.parentToolUseId === "toolu_ag2")
    expect(sub.map((e) => e.type)).toEqual(["user_message", "assistant_text", "usage"])
    expect(h.system("task_notification", sessionId)).toEqual([])
    appendFileSync(file, line(toolResultLine(c, "toolu_ag2", "agent said")))
    h.advance(1_000)
    await h.host.tick()
    expect(
      h.system("task_notification", sessionId).map((e) => (e.payload as { data: unknown }).data),
    ).toEqual([{ taskId: "abc", toolUseId: "toolu_ag2", status: "completed" }])
    expect(h.host.openSubagents).toBe(0)
  })

  it("S44: a meta.json over 16 KiB, a symlinked subagent file, and a subagent of an unseen toolUseId emit nothing", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const calls = ["toolu_big", "toolu_sym"].map((id) =>
      assistantLine(c, [{ type: "tool_use", id, name: "Agent", input: { description: "d" } }]),
    )
    const file = writeSession(fx, sdkId, { extra: calls })
    writeSubagent(file, sdkId, "big", "toolu_big", {
      meta: JSON.stringify({
        toolUseId: "toolu_big",
        agentType: "x",
        description: "y".repeat(17 * 1024),
      }),
    })
    const real = writeSubagent(file, sdkId, "sym", "toolu_sym")
    const outside = path.join(fx.root, "outside.jsonl")
    renameSync(real, outside)
    symlinkSync(outside, real)
    writeSubagent(file, sdkId, "unseen", "toolu_never")
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    for (let i = 0; i < 3; i++) {
      await h.host.tick()
      h.advance(1_000)
    }
    expect(h.system("task_started", sessionId)).toEqual([])
    expect(h.events(sessionId).filter((e) => e.parentToolUseId)).toEqual([])
  })

  it("D49 F7: a symlinked <id> directory or subagents directory under the project dir is never read: no task_started, no subagent line", async () => {
    for (const swap of ["id", "subagents"] as const) {
      const fx = setup()
      const sdkId = nextId()
      const c = common(fx, sdkId)
      const file = writeSession(fx, sdkId, {
        extra: [
          assistantLine(c, [
            { type: "tool_use", id: "toolu_ln", name: "Agent", input: { description: "d" } },
          ]),
        ],
      })
      writeSubagent(file, sdkId, "ln", "toolu_ln", { text: "planted subagent line" })
      const idDir = path.join(path.dirname(file), sdkId)
      const real = swap === "id" ? idDir : path.join(idDir, "subagents")
      const outside = path.join(fx.root, `outside-${swap}`)
      renameSync(real, outside)
      symlinkSync(outside, real)
      const h = harness(fx)
      const { sessionId } = await h.add({ sdkSessionId: sdkId })
      for (let i = 0; i < 3; i++) {
        await h.host.tick()
        h.advance(1_000)
      }
      expect({ swap, started: h.system("task_started", sessionId) }).toEqual({ swap, started: [] })
      expect(JSON.stringify(h.out.lines)).not.toContain("planted subagent line")
    }
  })

  it("D49 F8: 32 subagents of 1 MiB with the replay total at 8 MiB: only the newest that fit are replayed, the rest get one note", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = transcriptPath(fx, sdkId)
    const gen = generateTranscript({
      file,
      sessionId: sdkId,
      cwd: fx.shared,
      bytes: 2 * 1024 * 1024,
      agentEvery: 1,
      maxSubagents: 32,
      subagentBytes: 1024 * 1024,
      seed: 11,
    })
    expect(gen.agents.length).toBe(32)
    const cap = 8 * 1024 * 1024
    // A60's choice, newest first: whole subagents while their total fits the cap.
    let total = 0
    const fit: string[] = []
    for (const a of [...gen.agents].reverse()) {
      const size = statSync(a.file).size
      if (total + size > cap) break
      total += size
      fit.push(a.toolUseId)
    }
    expect(fit.length).toBeGreaterThan(0)
    expect(fit.length).toBeLessThan(32)
    const h = harness(fx, {
      keep: false,
      limits: { historyBytes: 16 * 1024 * 1024, subagentReplayBytes: cap },
    })
    const { sessionId } = await h.add({ sdkSessionId: sdkId, once: true })
    for (let i = 0; i < 60 && h.done().length === 0; i++) {
      await h.host.tick()
      h.advance(1_000)
    }
    const lines = h.out.lines.filter((l) => l.type === "session_events")
    expect(lines.flatMap((l) => l.taskStarted as string[]).sort()).toEqual(fit.sort())
    expect(lines.reduce((a, l) => a + (l.subagentBytes as number), 0)).toBeLessThanOrEqual(cap)
    expect(h.done().map((d) => d.why)).toEqual(["replayed"])
    const h2 = harness(fx, { limits: { historyBytes: 16 * 1024 * 1024, subagentReplayBytes: cap } })
    const r2 = await h2.add({ sdkSessionId: sdkId, once: true })
    for (let i = 0; i < 60 && h2.done().length === 0; i++) {
      await h2.host.tick()
      h2.advance(1_000)
    }
    expect(
      h2
        .system("follow", r2.sessionId)
        .map((e) => (e.payload as { data: Record<string, unknown> }).data)
        .filter((d) => d.subagentsOmitted !== undefined),
    ).toEqual([{ state: "started", subagentsOmitted: 32 - fit.length }])
    expect(sessionId).not.toBe(r2.sessionId)
  }, 60_000)

  it("A60: a window with 300 subagents (fixtures) replays the newest 32 within 16 MiB and emits one subagentsOmitted 268 note", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = transcriptPath(fx, sdkId)
    const gen = generateTranscript({
      file,
      sessionId: sdkId,
      cwd: fx.shared,
      bytes: 12 * 1024 * 1024,
      agentEvery: 1,
      maxSubagents: 300,
      subagentBytes: 8 * 1024,
      seed: 7,
    })
    expect(gen.agents.length).toBe(300)
    const h = harness(fx, { keep: false, limits: { historyBytes: 16 * 1024 * 1024 } })
    const { sessionId } = await h.add({ sdkSessionId: sdkId, once: true })
    for (let i = 0; i < 60 && h.done().length === 0; i++) {
      await h.host.tick()
      h.advance(1_000)
    }
    const lines = h.out.lines.filter((l) => l.type === "session_events")
    const started = lines.flatMap((l) => l.taskStarted as string[])
    expect(started.sort()).toEqual(
      gen.agents
        .slice(-32)
        .map((a) => a.toolUseId)
        .sort(),
    )
    const bytes = lines.reduce((a, l) => a + (l.subagentBytes as number), 0)
    expect(bytes).toBeGreaterThan(0)
    expect(bytes).toBeLessThanOrEqual(NODE_IMPORT_LIMITS.subagentReplayBytes)
    expect(h.out.lines.filter((l) => l.type === "follow_done")).toEqual([
      {
        type: "follow_done",
        sessionId,
        jobId: expect.any(String),
        why: "replayed",
        endOffset: statSync(file).size,
      },
    ])
    // The note is in the kept lines' counts only; re-run with full lines for its payload.
    const h2 = harness(fx, { limits: { historyBytes: 16 * 1024 * 1024 } })
    const r2 = await h2.add({ sdkSessionId: sdkId, once: true })
    for (let i = 0; i < 60 && h2.done().length === 0; i++) {
      await h2.host.tick()
      h2.advance(1_000)
    }
    const notes = h2
      .system("follow", r2.sessionId)
      .map((e) => (e.payload as { data: Record<string, unknown> }).data)
      .filter((d) => d.subagentsOmitted !== undefined)
    expect(notes).toEqual([{ state: "started", subagentsOmitted: 268 }])
  }, 60_000)

  it("A60: with 8 subagent follows open in the host, a 9th waits and starts when one finishes", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const ids = Array.from({ length: 9 }, (_, i) => `toolu_s${i}`)
    const file = writeSession(fx, sdkId, {
      extra: ids.map((id) =>
        assistantLine(c, [{ type: "tool_use", id, name: "Agent", input: { description: "d" } }]),
      ),
    })
    for (const [i, id] of ids.entries()) writeSubagent(file, sdkId, `ag${i}`, id)
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    h.advance(1_000)
    await h.host.tick()
    expect(h.system("task_started", sessionId).length).toBe(8)
    expect(h.host.openSubagents).toBe(8)
    const first = h.system("task_started", sessionId)[0] as NodeSessionEventIn
    const firstStarted = (first.payload as { data: { toolUseId: string } }).data.toolUseId
    appendFileSync(file, line(toolResultLine(c, firstStarted, "ok")))
    h.advance(1_000)
    await h.host.tick()
    h.advance(1_000)
    await h.host.tick()
    expect(h.system("task_notification", sessionId).length).toBe(1)
    expect(h.system("task_started", sessionId).length).toBe(9)
    expect(h.host.openSubagents).toBe(8)
  })
})

// W3-D1: Claude Code 2.1.286+ runs `Agent` in the background by default. The
// fixtures follow the shape of its transcripts (placeholder content only): the
// meta's `requestShape: "background"`, a tool_result that only says the agent
// was launched, the subagent's own lines (a Bash call, then SubagentHandback),
// the peer hand-back (isMeta) and the `<task-notification>` user line (2.1.286)
// or `queued_command` attachment (2.1.296) that is its real end.
const bgSidechain = (sdkId: string, agentId: string) => ({
  isSidechain: true,
  agentId,
  sessionId: sdkId,
  cwd: "/x",
  entrypoint: "cli",
  version: "2.1.286",
})
function writeBackgroundSubagent(
  mainFile: string,
  sdkId: string,
  agentId: string,
  toolUseId: string,
) {
  const dir = path.join(path.dirname(mainFile), sdkId, "subagents")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `agent-${agentId}.meta.json`),
    JSON.stringify({
      agentType: "Explore",
      description: "List files in sub/",
      toolUseId,
      spawnDepth: 1,
      requestShape: "background",
      requestNonInteractive: true,
    }),
  )
  const file = path.join(dir, `agent-${agentId}.jsonl`)
  writeFileSync(
    file,
    line({ ...userLine({}, "list the files in sub/"), ...bgSidechain(sdkId, agentId) }),
  )
  return file
}
const bgSubagentWork = (sdkId: string, agentId: string) => {
  const sc = bgSidechain(sdkId, agentId)
  return [
    {
      ...userLine({}, "<system-reminder>\nreport through SubagentHandback\n</system-reminder>"),
      isMeta: true,
      ...sc,
    },
    { type: "attachment", attachment: { type: "date", date: "2026-10-16" }, ...sc },
    {
      ...assistantLine({}, [
        {
          type: "tool_use",
          id: "toolu_bgsub_bash",
          name: "Bash",
          input: { command: "find sub -type f" },
        },
      ]),
      ...sc,
    },
    { ...toolResultLine({}, "toolu_bgsub_bash", "a.txt\nb.txt"), ...sc },
    {
      ...assistantLine({}, [
        {
          type: "tool_use",
          id: "toolu_bgsub_hand",
          name: "SubagentHandback",
          input: { message: "sub/a.txt" },
        },
      ]),
      ...sc,
    },
    { ...toolResultLine({}, "toolu_bgsub_hand", "Report delivered to your caller."), ...sc },
  ]
}
const launchedResult = (c: object, toolUseId: string, agentId: string) => ({
  ...toolResultLine(c, toolUseId, ""),
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: [
          {
            type: "text",
            text: `Async agent launched successfully.\nagentId: ${agentId}\nThe agent is working in the background. You will be notified automatically when it completes.`,
          },
        ],
      },
    ],
  },
  toolUseResult: { isAsync: true, status: "async_launched", agentId },
})
const notification = (toolUseId: string, agentId: string, status = "completed") =>
  [
    "<task-notification>",
    `<task-id>${agentId}</task-id>`,
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    `<output-file>/tmp/claude-501/-x/s/tasks/${agentId}.output</output-file>`,
    `<status>${status}</status>`,
    '<summary>Agent "List files in sub/" finished</summary>',
    "<usage><subagent_tokens>14613</subagent_tokens><tool_uses>2</tool_uses><duration_ms>6128</duration_ms></usage>",
    "</task-notification>",
  ].join("\n")
const handbackLine = (c: object, agentId: string) => ({
  ...userLine(
    c,
    `Another Claude session sent a message:\n<agent-message from="${agentId}">\n  sub/a.txt\n</agent-message>`,
  ),
  isMeta: true,
  origin: { kind: "peer", from: agentId, handback: true },
  promptSource: "system",
})
const notificationLine = (c: object, toolUseId: string, agentId: string, status?: string) => ({
  ...userLine(c, notification(toolUseId, agentId, status)),
  origin: { kind: "task-notification", producer: "session-task" },
  promptSource: "system",
})

describe("follow host: background subagents (W3-D1, S44)", () => {
  it("W3-D1: a background Agent's launch result does not end it; its own lines all arrive and the task notification ends it completed", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const file = writeSession(fx, sdkId)
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    const agentId = "a8487b94a983f1f5d"
    const use = "toolu_017bgAgentFixture000001"
    appendFileSync(
      file,
      line(
        assistantLine(c, [
          {
            type: "tool_use",
            id: use,
            name: "Agent",
            input: { description: "List files in sub/", run_in_background: true },
          },
        ]),
      ) +
        line(launchedResult(c, use, agentId)) +
        line(
          assistantLine(c, [
            { type: "text", text: "The subagent is listing sub/ in the background." },
          ]),
        ),
    )
    const sub = writeBackgroundSubagent(file, sdkId, agentId, use)
    h.advance(1_000)
    await h.host.tick()
    h.advance(1_000)
    await h.host.tick()
    expect(h.system("task_started", sessionId).length).toBe(1)
    expect(h.system("task_notification", sessionId)).toEqual([])
    expect(h.host.openSubagents).toBe(1)
    // The subagent works after its launch result.
    appendFileSync(sub, bgSubagentWork(sdkId, agentId).map(line).join(""))
    h.advance(1_000)
    await h.host.tick()
    expect(h.system("task_notification", sessionId)).toEqual([])
    const subEvents = h.events(sessionId).filter((e) => e.parentToolUseId === use)
    expect(
      subEvents
        .filter((e) => e.type === "tool_call")
        .map((e) => (e.payload as { name: string }).name),
    ).toEqual(["Bash", "SubagentHandback"])
    expect(subEvents.filter((e) => e.type === "tool_result").length).toBe(2)
    // Its real end: the hand-back (meta, nothing) and the CLI's notification.
    appendFileSync(file, line(handbackLine(c, agentId)) + line(notificationLine(c, use, agentId)))
    h.advance(1_000)
    await h.host.tick()
    expect(
      h.system("task_notification", sessionId).map((e) => (e.payload as { data: unknown }).data),
    ).toEqual([{ taskId: agentId, toolUseId: use, status: "completed" }])
    expect(h.host.openSubagents).toBe(0)
    // Never the person: no user_message for the hand-back or the notification.
    const mainUser = h
      .events(sessionId)
      .filter((e) => e.type === "user_message" && !e.parentToolUseId)
    expect(mainUser.map((e) => (e.payload as { text: string }).text)).toEqual([
      "please fix the tests",
    ])
    expect(h.system("notification", sessionId).length).toBe(1)
  })

  it("W3-D2 review: a <task-notification> the person typed, naming a real tool-use-id, does not end the background subagent", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const use = "toolu_017bgAgentFixtureTyped1"
    const file = writeSession(fx, sdkId, {
      extra: [
        assistantLine(c, [
          { type: "tool_use", id: use, name: "Agent", input: { description: "d" } },
        ]),
        launchedResult(c, use, "agt"),
      ],
    })
    writeBackgroundSubagent(file, sdkId, "agt", use)
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    h.advance(1_000)
    await h.host.tick()
    expect(h.host.openSubagents).toBe(1)
    appendFileSync(
      file,
      line({
        ...userLine(c, notification(use, "agt")),
        origin: { kind: "human" },
        promptSource: "typed",
      }),
    )
    h.advance(1_000)
    await h.host.tick()
    expect(h.system("task_notification", sessionId)).toEqual([])
    expect(h.host.openSubagents).toBe(1)
  })

  it("W3-D1: replayed from the window, a finished background subagent replays whole and ends with its notification's status; one still running stays open", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const done = "toolu_017bgAgentFixtureDone1"
    const running = "toolu_017bgAgentFixtureRun01"
    const file = writeSession(fx, sdkId, {
      extra: [
        assistantLine(c, [
          { type: "tool_use", id: done, name: "Agent", input: { description: "d" } },
        ]),
        launchedResult(c, done, "agdone"),
        assistantLine(c, [
          { type: "tool_use", id: running, name: "Agent", input: { description: "r" } },
        ]),
        launchedResult(c, running, "agrun"),
        notificationLine(c, done, "agdone", "failed"),
      ],
    })
    const doneFile = writeBackgroundSubagent(file, sdkId, "agdone", done)
    appendFileSync(doneFile, bgSubagentWork(sdkId, "agdone").map(line).join(""))
    writeBackgroundSubagent(file, sdkId, "agrun", running)
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    h.advance(1_000)
    await h.host.tick()
    expect(
      h.system("task_notification", sessionId).map((e) => (e.payload as { data: unknown }).data),
    ).toEqual([{ taskId: "agdone", toolUseId: done, status: "failed" }])
    expect(
      h.events(sessionId).filter((e) => e.parentToolUseId === done && e.type === "tool_call")
        .length,
    ).toBe(2)
    expect(h.host.openSubagents).toBe(1)
  })

  it("W3-D1: 2.1.296 records a mid-turn notification only as a queued_command attachment: it ends the subagent too", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const use = "toolu_017bgAgentFixtureQueue1"
    const file = writeSession(fx, sdkId, {
      extra: [
        assistantLine(c, [
          { type: "tool_use", id: use, name: "Agent", input: { description: "d" } },
        ]),
        launchedResult(c, use, "agq"),
      ],
    })
    writeBackgroundSubagent(file, sdkId, "agq", use)
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    h.advance(1_000)
    await h.host.tick()
    expect(h.host.openSubagents).toBe(1)
    appendFileSync(
      file,
      line({
        ...c,
        type: "attachment",
        isSidechain: false,
        attachment: {
          type: "queued_command",
          prompt: notification(use, "agq"),
          commandMode: "task-notification",
          origin: { kind: "task-notification", producer: "session-task" },
        },
      }),
    )
    h.advance(1_000)
    await h.host.tick()
    expect(h.system("task_notification", sessionId).length).toBe(1)
    expect(h.host.openSubagents).toBe(0)
  })

  it("W3-D1: a background subagent never notified frees its slot after 30 idle minutes, without a completed notification", async () => {
    const fx = setup()
    const sdkId = nextId()
    const c = common(fx, sdkId)
    const use = "toolu_017bgAgentFixtureIdle01"
    const file = writeSession(fx, sdkId, {
      extra: [
        assistantLine(c, [
          { type: "tool_use", id: use, name: "Agent", input: { description: "d" } },
        ]),
        launchedResult(c, use, "agidle"),
      ],
    })
    writeBackgroundSubagent(file, sdkId, "agidle", use)
    const h = harness(fx)
    await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    h.advance(29 * 60_000)
    await h.host.tick()
    expect(h.host.openSubagents).toBe(1)
    h.advance(2 * 60_000)
    await h.host.tick()
    expect(h.host.openSubagents).toBe(0)
    expect(h.system("task_notification")).toEqual([])
    expect(h.out.logs).toContain("subagent_idle")
  })
})

describe("follow host: what it refuses and when it ends (S41, A56, m5, D28 b)", () => {
  it("S41: follow_add with a folderPath/cwdSubdir whose transcript is a symlink, or whose recorded cwd differs, adds nothing and emits follow_done transcript_gone with code not_found", async () => {
    const fx = setup()
    const h = harness(fx)
    const linked = nextId()
    const file = writeSession(fx, linked)
    const elsewhere = path.join(fx.root, "elsewhere.jsonl")
    renameSync(file, elsewhere)
    symlinkSync(elsewhere, file)
    const r1 = await h.add({ sdkSessionId: linked })
    const moved = nextId()
    const other = path.join(fx.root, "work", "other")
    mkdirSync(other, { recursive: true })
    // Recorded in another folder, stored under this folder's slug dir.
    const wrong = writeSession(fx, moved, { cwd: other })
    const target = transcriptPath(fx, moved)
    mkdirSync(path.dirname(target), { recursive: true })
    renameSync(wrong, target)
    const r2 = await h.add({ sdkSessionId: moved })
    const r3 = await h.add({ sdkSessionId: nextId() })
    await h.host.tick()
    expect(h.done()).toEqual([
      { type: "follow_done", ...r1, why: "transcript_gone", code: "not_found" },
      { type: "follow_done", ...r2, why: "transcript_gone", code: "not_found" },
      { type: "follow_done", ...r3, why: "transcript_gone", code: "not_found" },
    ])
    expect(h.events()).toEqual([])
    expect(h.host.follows).toBe(0)
  })

  it("D53: a session in the shared repo's own worktree outside the folder is followed; one in an unrelated folder or a sibling prefix folder named as the worktree is refused", async () => {
    const fx = setup()
    const h = harness(fx)
    const git = (cwd: string, ...a: string[]) =>
      execFileSync("git", ["-C", cwd, ...a], { stdio: "ignore" })
    git(fx.shared, "init", "-q")
    git(
      fx.shared,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    )
    const worktree = path.join(fx.root, "tmp", "repo-wt")
    git(fx.shared, "worktree", "add", "-q", worktree)
    mkdirSync(path.join(worktree, "pkg"))
    const unrelated = path.join(fx.root, "tmp", "elsewhere")
    const sibling = path.join(fx.root, "tmp", "repo-wt-bar")
    for (const d of [unrelated, sibling]) mkdirSync(d, { recursive: true })
    const inWt = nextId()
    writeSession(fx, inWt, { cwd: path.join(worktree, "pkg") })
    const inUnrelated = nextId()
    writeSession(fx, inUnrelated, { cwd: unrelated })
    const inSibling = nextId()
    writeSession(fx, inSibling, { cwd: sibling })
    const ok = await h.add({ sdkSessionId: inWt, worktreePath: worktree, cwdSubdir: "pkg" })
    const r1 = await h.add({ sdkSessionId: inUnrelated, worktreePath: unrelated })
    const r2 = await h.add({ sdkSessionId: inSibling, worktreePath: sibling })
    // Without the worktree, the same subdir is read against the folder: refused.
    const r3 = await h.add({ sdkSessionId: inWt, cwdSubdir: "pkg" })
    await h.host.tick()
    expect(h.done()).toEqual([
      { type: "follow_done", ...r1, why: "transcript_gone", code: "not_found" },
      { type: "follow_done", ...r2, why: "transcript_gone", code: "not_found" },
      { type: "follow_done", ...r3, why: "transcript_gone", code: "not_found" },
    ])
    expect(h.host.follows).toBe(1)
    expect(h.events(ok.sessionId).length).toBeGreaterThan(0)
    expect(h.out.logs).toContain("follow_refused outside_shared")
  })

  it("A56: an sdk-ts session ends not_found, a liaison-node one already_liaison, except an in-place follow of it by the server that ran it", async () => {
    const fx = setup()
    const h = harness(fx)
    const sdk = nextId()
    writeSession(fx, sdk, { entrypoint: "sdk-ts" })
    const own = nextId()
    writeSession(fx, own, { entrypoint: "liaison-node" })
    const ran = nextId()
    ranHere(fx, ran, own)
    const r1 = await h.add({ sdkSessionId: sdk })
    const r2 = await h.add({ sessionId: ran, sdkSessionId: own })
    const r3 = await h.add({ sessionId: ran, sdkSessionId: own, inPlace: true, startAt: "end" })
    expect(h.done()).toEqual([
      { type: "follow_done", ...r1, why: "transcript_gone", code: "not_found" },
      { type: "follow_done", ...r2, why: "transcript_gone", code: "already_liaison" },
    ])
    expect(h.host.follows).toBe(1)
    expect(
      h.system("follow", r3.sessionId).map((e) => (e.payload as { data: unknown }).data),
    ).toEqual([{ state: "started" }])
    expect(h.system("imported", r3.sessionId)).toEqual([])
  })

  it("D49 F6: an in-place follow of a liaison-node session is refused already_liaison unless this node recorded running that sdk id for the follow's own server", async () => {
    const fx = setup()
    const h = harness(fx)
    const own = nextId()
    writeSession(fx, own, { entrypoint: "liaison-node" })
    const ranA = nextId()
    ranHere(fx, ranA, own, SERVER)
    const otherSdk = nextId()
    writeSession(fx, otherSdk, { entrypoint: "liaison-node" })
    const inPlace = { inPlace: true, startAt: "end" as const }
    // Another server naming the session that ran it, by its id.
    const r1 = await h.add({ sessionId: ranA, sdkSessionId: own, server: OTHER_SERVER, ...inPlace })
    // This server pairing its own session with an sdk id it did not run.
    const r2 = await h.add({ sessionId: ranA, sdkSessionId: otherSdk, ...inPlace })
    // A session with no record at all.
    const r3 = await h.add({ sdkSessionId: own, ...inPlace })
    // The server that ran it: followed.
    const r4 = await h.add({ sessionId: ranA, sdkSessionId: own, ...inPlace })
    const refused = { why: "transcript_gone", code: "already_liaison" }
    expect(h.done()).toEqual([
      { type: "follow_done", ...r1, ...refused },
      { type: "follow_done", ...r2, ...refused },
      { type: "follow_done", ...r3, ...refused },
    ])
    expect(h.host.follows).toBe(1)
    expect(h.system("follow", r4.sessionId).length).toBe(1)
  })

  it("m5: a transcript replaced by a symlink after follow_add is not read (O_NOFOLLOW) and ends transcript_gone", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = writeSession(fx, sdkId)
    const h = harness(fx)
    const r = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    const elsewhere = path.join(fx.root, "planted.jsonl")
    writeFileSync(
      elsewhere,
      `${Buffer.alloc(statSync(file).size, " ").toString()}\n${line(userLine(common(fx, sdkId), "planted line"))}`,
    )
    renameSync(file, `${file}.moved`)
    symlinkSync(elsewhere, file)
    for (let i = 0; i < 3; i++) {
      h.advance(5_000)
      await h.host.tick()
    }
    expect(JSON.stringify(h.events())).not.toContain("planted line")
    expect(h.done()).toEqual([{ type: "follow_done", ...r, why: "transcript_gone" }])
  })

  it("D49 F8: the main follow's open refuses a symlink on its own (O_NOFOLLOW), when the file is swapped after the lstat check", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = writeSession(fx, sdkId)
    const elsewhere = path.join(fx.root, "planted-open.jsonl")
    writeFileSync(elsewhere, line(userLine(common(fx, sdkId), "planted by the swap")))
    // The swap lands between pollFollow's lstat (regularFile) and the read's open.
    const poll = TranscriptFollow.prototype.poll
    let swapped = false
    TranscriptFollow.prototype.poll = function (this: TranscriptFollow) {
      if (!swapped) {
        swapped = true
        renameSync(file, `${file}.moved`)
        symlinkSync(elsewhere, file)
      }
      return poll.call(this)
    }
    try {
      const h = harness(fx)
      const r = await h.add({ sdkSessionId: sdkId })
      for (let i = 0; i < 3; i++) {
        await h.host.tick()
        h.advance(5_000)
      }
      expect(swapped).toBe(true)
      expect(JSON.stringify(h.out.lines)).not.toContain("planted by the swap")
      expect(h.done()).toEqual([{ type: "follow_done", ...r, why: "transcript_gone" }])
    } finally {
      TranscriptFollow.prototype.poll = poll
    }
  })

  it("m5: a transcript truncated below the offset ends transcript_gone and re-uploads nothing", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = writeSession(fx, sdkId)
    const h = harness(fx)
    const r = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    const count = h.events().length
    truncateSync(file, 0)
    appendFileSync(file, line(userLine(common(fx, sdkId), "rewritten")))
    h.advance(1_000)
    await h.host.tick()
    expect(h.events().length).toBe(count)
    expect(h.done()).toEqual([{ type: "follow_done", ...r, why: "transcript_gone" }])
  })

  it("D28b: an in-place follow emits driver {elsewhere:true} then, once the registry entry is gone and the file idle 60 s, driver {elsewhere:false} and follow_done driver_left; an import follow never ends on the driver", async () => {
    const fx = setup()
    const sdkId = nextId()
    writeSession(fx, sdkId, { entrypoint: "liaison-node" })
    const imported = nextId()
    writeSession(fx, imported)
    let held = true
    const probe: DriverProbe = {
      platform: "darwin",
      mtimeMs: () => null,
      registry: () => (held ? [{ pid: 4242, sessionId: sdkId, entrypoint: "claude-vscode" }] : []),
      processes: () => [
        { pid: 4242, ppid: 77, args: "/usr/local/bin/claude --output-format stream-json" },
      ],
    }
    const h = harness(fx, { probe })
    const ran = nextId()
    ranHere(fx, ran, sdkId)
    const r = await h.add({ sessionId: ran, sdkSessionId: sdkId, inPlace: true, startAt: "end" })
    const ri = await h.add({ sdkSessionId: imported })
    await h.host.tick()
    held = false
    for (let i = 0; i < 9; i++) {
      h.advance(10_000)
      await h.host.tick()
    }
    expect(
      h.system("driver", r.sessionId).map((e) => (e.payload as { data: unknown }).data),
    ).toEqual([
      { elsewhere: true, via: "vscode" },
      { elsewhere: false, via: null },
    ])
    expect(h.done()).toEqual([{ type: "follow_done", ...r, why: "driver_left" }])
    expect(h.system("driver", ri.sessionId)).toEqual([])
    expect(h.host.follows).toBe(1)
  })
})

describe("follow host: process, backpressure and memory (A50, A57, A60)", () => {
  it("A57: a shutdown line flushes a partial batch and exits 0", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = transcriptPath(fx, sdkId)
    generateTranscript({ file, sessionId: sdkId, cwd: fx.shared, bytes: 3 * 1024 * 1024, seed: 5 })
    const written: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    async function* input() {
      yield JSON.stringify({
        type: "follow_add",
        sessionId: nextId(),
        jobId: nextId(),
        folderPath: fx.shared,
        cwdSubdir: "",
        sdkSessionId: sdkId,
        startAt: "window",
        once: false,
        inPlace: false,
        server: SERVER,
      })
      await gate
      yield JSON.stringify({ type: "shutdown" })
      await new Promise(() => {})
    }
    const code = await followMain({
      lines: input(),
      configDir: fx.configDir,
      probe: quietProbe,
      intervalMs: 5,
      log: () => {},
      write: (text) =>
        new Promise((resolve) =>
          setTimeout(() => {
            written.push(text)
            if (written.length === 3) release()
            resolve()
          }, 20),
        ),
    })
    expect(code).toBe(0)
    expect(written.length).toBeGreaterThanOrEqual(3)
    for (const w of written) {
      expect(w.endsWith("\n")).toBe(true)
      expect((JSON.parse(w) as { type: string }).type).toBe("session_events")
    }
    // Nothing after the exit, and no follow_done: the shell reports host_exit.
    const count = written.length
    await new Promise((r) => setTimeout(r, 100))
    expect(written.length).toBe(count)
  })

  it("A57: against a stdout sink that acknowledges each write after 50 ms, 8 follows replaying 8 MiB each keep the host's rss growth under 150 MB and process.stdout.writableLength under 2 × batchBytes", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = transcriptPath(fx, sdkId)
    generateTranscript({ file, sessionId: sdkId, cwd: fx.shared, bytes: 9 * 1024 * 1024, seed: 11 })
    const before = rssMb()
    const h = harness(fx, { ackMs: 50, keep: false })
    for (let i = 0; i < 8; i++) await h.add({ sdkSessionId: sdkId, once: true })
    let peak = 0
    for (let i = 0; i < 40 && h.done().length < 8; i++) {
      await h.host.tick()
      peak = Math.max(peak, process.memoryUsage().rss / (1024 * 1024))
      h.advance(1_000)
    }
    expect(h.done().length).toBe(8)
    expect(h.out.maxPending).toBeLessThan(2 * NODE_EVENT_LIMITS.batchBytes)
    expect(peak - before).toBeLessThan(150)
  }, 120_000)

  it("A50: replaying an 8 MiB window of a generated 200 MB transcript and streaming 50 MB more keeps the host's RSS growth under 150 MB", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = transcriptPath(fx, sdkId)
    generateTranscript({
      file,
      sessionId: sdkId,
      cwd: fx.shared,
      bytes: 200 * 1024 * 1024,
      seed: 13,
    })
    const more = path.join(fx.root, "more.jsonl")
    generateTranscript({
      file: more,
      sessionId: sdkId,
      cwd: fx.shared,
      bytes: 50 * 1024 * 1024,
      seed: 17,
    })
    const before = rssMb()
    const h = harness(fx, { keep: false })
    await h.add({ sdkSessionId: sdkId })
    let peak = 0
    await h.host.tick()
    // Append the 50 MB in 1 MiB slices, polling between.
    const fd = openSync(more, "r")
    const slice = Buffer.alloc(1024 * 1024)
    try {
      for (;;) {
        const got = readSync(fd, slice, 0, slice.length, null)
        if (got <= 0) break
        appendFileSync(file, slice.subarray(0, got))
        h.advance(1_000)
        await h.host.tick()
        peak = Math.max(peak, process.memoryUsage().rss / (1024 * 1024))
      }
    } finally {
      closeSync(fd)
    }
    h.advance(1_000)
    await h.host.tick()
    const events = h.out.lines.reduce((a, l) => a + ((l.count as number) ?? 0), 0)
    expect(events).toBeGreaterThan(10_000)
    expect(peak - before).toBeLessThan(150)
    rmSync(file)
    rmSync(more)
  }, 180_000)

  it("A45: every follow_done the host writes carries a why the job result schema accepts", async () => {
    const fx = setup()
    const h = harness(fx)
    const own = nextId()
    writeSession(fx, own, { entrypoint: "liaison-node" })
    await h.add({ sdkSessionId: own })
    await h.add({ sdkSessionId: nextId() })
    const kept = nextId()
    writeSession(fx, kept)
    const r = await h.add({ sdkSessionId: kept, once: true })
    await h.host.tick()
    const r2 = await h.add({ sdkSessionId: kept })
    await h.host.control(JSON.stringify({ type: "follow_remove", ...r2 }))
    const dones = h.done()
    expect(dones.length).toBe(4)
    expect(dones.some((d) => d.jobId === r.jobId && d.why === "replayed")).toBe(true)
    for (const d of dones) {
      const body = nodeFollowResultSchema.safeParse({
        why: d.why,
        ...(d.endOffset !== undefined ? { endOffset: d.endOffset } : {}),
      })
      expect(body.success).toBe(true)
    }
  })

  it("A50: a 20 MiB single line is skipped with one note and the follow continues", async () => {
    const fx = setup()
    const sdkId = nextId()
    const file = writeSession(fx, sdkId)
    const h = harness(fx)
    const { sessionId } = await h.add({ sdkSessionId: sdkId })
    await h.host.tick()
    const c = common(fx, sdkId)
    const huge = line(userLine(c, "z".repeat(20 * 1024 * 1024)))
    appendFileSync(file, huge + line(userLine(c, "after the huge one")) + huge)
    for (let i = 0; i < 6; i++) {
      h.advance(1_000)
      await h.host.tick()
    }
    appendFileSync(file, line(userLine(c, "and later")))
    h.advance(1_000)
    await h.host.tick()
    const notes = h
      .system("follow", sessionId)
      .map((e) => (e.payload as { data: unknown }).data)
      .filter((d) => (d as { skippedLine?: boolean }).skippedLine)
    expect(notes).toEqual([{ state: "started", skippedLine: true }])
    const typed = h
      .events(sessionId)
      .filter((e) => e.type === "user_message")
      .map((e) => (e.payload as { text: string }).text)
    expect(typed).toEqual(["please fix the tests", "after the huge one", "and later"])
    expect(h.out.logs).toContain("skipped_line")
  }, 60_000)

  it("A60: 8 follows in one host, one of them with 300 subagent fixtures: rss growth under 150 MB and the bytes emitted for subagents ≤ 16 MiB", async () => {
    const fx = setup()
    const heavy = nextId()
    const heavyFile = transcriptPath(fx, heavy)
    generateTranscript({
      file: heavyFile,
      sessionId: heavy,
      cwd: fx.shared,
      bytes: 12 * 1024 * 1024,
      agentEvery: 1,
      maxSubagents: 300,
      subagentBytes: 640 * 1024,
      seed: 19,
    })
    const plain = nextId()
    generateTranscript({
      file: transcriptPath(fx, plain),
      sessionId: plain,
      cwd: fx.shared,
      bytes: 9 * 1024 * 1024,
      seed: 23,
    })
    const before = rssMb()
    const h = harness(fx, { keep: false, limits: { historyBytes: 16 * 1024 * 1024 } })
    const heavyRef = await h.add({ sdkSessionId: heavy, once: true })
    for (let i = 0; i < 7; i++) await h.add({ sdkSessionId: plain, once: true })
    let peak = 0
    for (let i = 0; i < 200 && h.done().length < 8; i++) {
      await h.host.tick()
      peak = Math.max(peak, process.memoryUsage().rss / (1024 * 1024))
      h.advance(1_000)
    }
    expect(h.done().length).toBe(8)
    const subBytes = h.out.lines
      .filter((l) => l.type === "session_events" && l.sessionId === heavyRef.sessionId)
      .reduce((a, l) => a + (l.subagentBytes as number), 0)
    expect(subBytes).toBeGreaterThan(2 * 1024 * 1024)
    expect(subBytes).toBeLessThanOrEqual(NODE_IMPORT_LIMITS.subagentReplayBytes)
    expect(peak - before).toBeLessThan(150)
  }, 300_000)
})
