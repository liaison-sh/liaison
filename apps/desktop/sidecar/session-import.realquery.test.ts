// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REAL QUERIES: the facts the session import builds on (W3 T04; S40, S41,
// OPEN-10, OPEN-11). Both CLIs (the SDK's bundled binary and this Mac's
// installed one), claude-haiku-5-5, scratch folders and a scratch "owner
// config", never the real ~/.claude:
//
// - S41 probe (GF-67): a VS Code-like session (stream-json input, entrypoint
//   claude-vscode) run in `<shared>/sub` is NOT returned by
//   `listSessions({dir: <shared>})` and IS returned by
//   `listSessions({dir: <shared>/sub, includeProgrammatic: false})`.
// - S41 probe (GF-76): a Liaison owner run (the real prepareSessionConfig with
//   its `projects` link, entrypoint liaison-node) resuming that id in
//   `<shared>/sub` appends to the SAME `<projects>/<slug>/<id>.jsonl`.
// - OPEN-11: after Liaison wrote, the VS Code-like CLI resumes the id with
//   Liaison's turn in its history, the IDE picker listing still lists it, and
//   the CLI's own "most recent session of this folder" (`--continue`) is it.
// - OPEN-10 (GF-68): a cwd whose slug passes 200 characters is stored under a
//   prefix dir `slug.slice(0,200)-<hash>` that holds `<id>.jsonl`.
//
// The login is the keychain item, kept with CLAUDE_SECURESTORAGE_CONFIG_DIR=""
// (config-isolation.ts). Skipped unless macOS with the CLI signed in.
import { afterAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { listSessions, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import { generateTranscript } from "./__fixtures__/transcript-gen"
import { AsyncQueue } from "./index"
import { OWNER_SESSION_ENTRYPOINT, prepareSessionConfig } from "./session-config"
import { TranscriptFollow } from "./transcript-follow"
import { runUnattended, type UnattendedJob } from "./unattended"

function signedIn(): boolean {
  if (process.platform !== "darwin") return false
  try {
    const status = Bun.spawnSync(["claude", "auth", "status"], { stdout: "pipe", stderr: "pipe" })
    return (JSON.parse(status.stdout.toString()) as { loggedIn?: boolean }).loggedIn === true
  } catch {
    return false
  }
}

const BUNDLED = path.join(
  import.meta.dir,
  "node_modules",
  "@anthropic-ai",
  `claude-agent-sdk-darwin-${process.arch}`,
  "claude",
)
/** This Mac's installed Claude Code: the `claude` on PATH, its link resolved. */
const onPath = Bun.which("claude")
const INSTALLED = process.env.LIAISON_RQ_INSTALLED_CLAUDE ?? (onPath ? realpathSync(onPath) : "")

const READY = signedIn()
if (!READY) {
  process.stderr.write(
    "session-import.realquery: SKIPPED - not macOS, or the CLI is not signed in\n",
  )
}
const MODEL = "claude-haiku-5-5"
const RUN_MS = 180_000
const tmpBase = realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-import-rq-")))
afterAll(() => rmSync(tmpBase, { recursive: true, force: true }))

function versionOf(binary: string): string | null {
  const r = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
  return /(\d+\.\d+\.\d+)/.exec(r.stdout.toString())?.[1] ?? null
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
}

/** The CLI's project folder name for a cwd: every non-alphanumeric becomes `-`. */
function slug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-")
}

function cliEnv(configDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE") env[k] = v
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ...extra }
}

/** `listSessions` read the way a tool on the owner's config reads it (set and restore). */
async function listAsOwner(
  ownerConfig: string,
  opts: { dir: string; includeProgrammatic?: boolean; includeWorktrees?: boolean },
) {
  const before = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = ownerConfig
  try {
    return await listSessions(opts)
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before
  }
}

interface VscodeTurn {
  exitCode: number | null
  sessionId: string | null
  result: string
  stderr: string
}

/**
 * One turn the way the VS Code extension drives the CLI: stream-json in and
 * out, entrypoint claude-vscode, on the owner's own config dir.
 */
function vscodeTurn(args: {
  binary: string
  cwd: string
  ownerConfig: string
  prompt: string
  sessionId?: string
  resume?: string
  continueLast?: boolean
}): VscodeTurn {
  const input = `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: args.prompt }] },
    parent_tool_use_id: null,
    session_id: "",
  })}\n`
  const r = Bun.spawnSync(
    [
      args.binary,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      MODEL,
      "--max-turns",
      "1",
      ...(args.sessionId ? ["--session-id", args.sessionId] : []),
      ...(args.resume ? ["--resume", args.resume] : []),
      ...(args.continueLast ? ["--continue"] : []),
    ],
    {
      cwd: args.cwd,
      env: cliEnv(args.ownerConfig, { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }),
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      timeout: RUN_MS,
    },
  )
  let sessionId: string | null = null
  let result = ""
  for (const line of r.stdout.toString().split("\n")) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line) as { type?: string; session_id?: string; result?: string }
      if (typeof m.session_id === "string") sessionId = m.session_id
      if (m.type === "result" && typeof m.result === "string") result = m.result
    } catch {}
  }
  return { exitCode: r.exitCode, sessionId, result, stderr: r.stderr.toString().slice(0, 400) }
}

/** One turn of a Liaison owner run: the node's mirror config, entrypoint liaison-node. */
async function liaisonTurn(args: {
  binary: string
  cwd: string
  configDir: string
  prompt: string
  resume: string
}): Promise<{ sessionId: string; text: string }> {
  const q = sdkQuery({
    prompt: args.prompt,
    options: {
      cwd: args.cwd,
      model: MODEL,
      pathToClaudeCodeExecutable: args.binary,
      env: cliEnv(args.configDir, { CLAUDE_CODE_ENTRYPOINT: OWNER_SESSION_ENTRYPOINT }),
      settingSources: [],
      allowedTools: [],
      tools: [],
      maxTurns: 1,
      resume: args.resume,
    },
  })
  let sessionId = ""
  let text = ""
  for await (const m of q) {
    const msg = m as Record<string, unknown>
    if (typeof msg.session_id === "string") sessionId = msg.session_id
    if (msg.type === "result" && typeof msg.result === "string") text = msg.result
  }
  return { sessionId, text }
}

/** The `entrypoint` of every conversation line of a transcript, in order. */
function entrypoints(file: string): string[] {
  const out: string[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"entrypoint"')) continue
    try {
      const e = (JSON.parse(line) as { entrypoint?: string }).entrypoint
      if (e && out[out.length - 1] !== e) out.push(e)
    } catch {}
  }
  return out
}

function jsonlIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : []
}

for (const [label, binary, idBase] of [
  ["bundled", BUNDLED, "9a9a9a9a"],
  ["installed", INSTALLED, "9b9b9b9b"],
] as const) {
  describe.if(READY)(`a VS Code session imported into Liaison, ${label} CLI (S41, OPEN-11)`, () => {
    const root = path.join(tmpBase, label)
    const ownerConfig = path.join(root, "owner-claude")
    const shared = path.join(root, "shared folder")
    const sub = path.join(shared, "sub")
    const id = `${idBase}-1111-4222-8333-444444444444`
    const projectDir = path.join(ownerConfig, "projects", slug(sub))
    const file = path.join(projectDir, `${id}.jsonl`)
    let sizeAfterVscode = 0

    it(
      "S41 probe: a subfolder session is not under listSessions of the folder",
      async () => {
        expect(existsSync(binary)).toBe(true)
        mkdirSync(ownerConfig, { recursive: true })
        mkdirSync(sub, { recursive: true })
        git(shared, "init", "-q", "-b", "main")
        git(
          shared,
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init",
        )

        const first = vscodeTurn({
          binary,
          cwd: sub,
          ownerConfig,
          sessionId: id,
          prompt: "Remember the word PERIWINKLE. Reply with just OK.",
        })
        process.stderr.write(
          `session-import.realquery: ${label} ${versionOf(binary)} vscode exit=${first.exitCode} id=${first.sessionId} result=${JSON.stringify(first.result.slice(0, 80))} err=${first.stderr}\n`,
        )
        expect(first.exitCode).toBe(0)
        expect(first.sessionId).toBe(id)
        expect(existsSync(file)).toBe(true)
        expect(entrypoints(file)).toEqual(["claude-vscode"])
        sizeAfterVscode = statSync(file).size

        const ofFolder = await listAsOwner(ownerConfig, { dir: shared })
        const ofSub = await listAsOwner(ownerConfig, { dir: sub, includeProgrammatic: false })
        process.stderr.write(
          `session-import.realquery: ${label} listSessions(folder)=${JSON.stringify(ofFolder.map((s) => s.sessionId))} listSessions(sub,ide)=${JSON.stringify(ofSub.map((s) => [s.sessionId, s.cwd]))}\n`,
        )
        expect(ofFolder.map((s) => s.sessionId)).not.toContain(id)
        expect(ofSub.map((s) => s.sessionId)).toContain(id)
      },
      RUN_MS,
    )

    it(
      "S41 probe: a Liaison resume through the projects link appends to the VS Code transcript",
      async () => {
        expect(sizeAfterVscode).toBeGreaterThan(0)
        const config = prepareSessionConfig({
          sessionId: `${idBase}-2222-4333-8444-555555555555`,
          configKind: "owner",
          level: "standard",
          realConfigDir: ownerConfig,
          dataDir: path.join(root, "data"),
        })
        expect(lstatSync(path.join(config.dir, "projects")).isSymbolicLink()).toBe(true)
        const resumed = await liaisonTurn({
          binary,
          cwd: sub,
          configDir: config.dir,
          resume: id,
          prompt: "Also remember the word TANGERINE. Reply with just OK.",
        })
        const after = entrypoints(file)
        process.stderr.write(
          `session-import.realquery: ${label} liaison resume id=${resumed.sessionId} text=${JSON.stringify(resumed.text.slice(0, 80))} entrypoints=${JSON.stringify(after)} files=${JSON.stringify(jsonlIn(projectDir))} size=${sizeAfterVscode}->${statSync(file).size}\n`,
        )
        // Resumed in place: same id, same file, no second transcript.
        expect(resumed.sessionId).toBe(id)
        expect(jsonlIn(projectDir)).toEqual([`${id}.jsonl`])
        expect(statSync(file).size).toBeGreaterThan(sizeAfterVscode)
        expect(after).toEqual(["claude-vscode", OWNER_SESSION_ENTRYPOINT])
        // The mirror's projects link survived the run.
        expect(lstatSync(path.join(config.dir, "projects")).isSymbolicLink()).toBe(true)
      },
      RUN_MS,
    )

    it(
      "OPEN-11: VS Code resumes after Liaison wrote",
      async () => {
        // The IDE and terminal pickers' listing still lists it, with the
        // folder's cwd, after Liaison's lines (entrypoint liaison-node) are last.
        const before = await listAsOwner(ownerConfig, { dir: sub, includeProgrammatic: false })
        const back = vscodeTurn({
          binary,
          cwd: sub,
          ownerConfig,
          resume: id,
          prompt: "Which two words did I ask you to remember? Reply with just the two words.",
        })
        // The CLI's own choice of this folder's most recent session.
        const last = vscodeTurn({
          binary,
          cwd: sub,
          ownerConfig,
          continueLast: true,
          prompt: "Reply with just OK.",
        })
        const afterList = await listAsOwner(ownerConfig, { dir: sub, includeProgrammatic: false })
        process.stderr.write(
          `session-import.realquery: ${label} OPEN-11 listedBefore=${JSON.stringify(before.map((s) => s.sessionId))} resume exit=${back.exitCode} id=${back.sessionId} result=${JSON.stringify(back.result.slice(0, 120))} err=${back.stderr} continue exit=${last.exitCode} id=${last.sessionId} listedAfter=${JSON.stringify(afterList.map((s) => s.sessionId))} entrypoints=${JSON.stringify(entrypoints(file))} files=${JSON.stringify(jsonlIn(projectDir))}\n`,
        )
        expect(before.map((s) => s.sessionId)).toContain(id)
        expect(back.exitCode).toBe(0)
        expect(back.sessionId).toBe(id)
        // Liaison's turn is in the history VS Code resumed.
        expect(back.result.toUpperCase()).toContain("PERIWINKLE")
        expect(back.result.toUpperCase()).toContain("TANGERINE")
        expect(last.exitCode).toBe(0)
        expect(last.sessionId).toBe(id)
        expect(afterList.map((s) => s.sessionId)).toContain(id)
        expect(jsonlIn(projectDir)).toEqual([`${id}.jsonl`])
        expect(entrypoints(file)).toEqual([
          "claude-vscode",
          OWNER_SESSION_ENTRYPOINT,
          "claude-vscode",
        ])
      },
      RUN_MS * 3,
    )
  })

  describe.if(READY)(`a long cwd's transcript, ${label} CLI (OPEN-10)`, () => {
    it(
      "OPEN-10: a long cwd's transcript is under a prefix dir",
      async () => {
        const ownerConfig = path.join(tmpBase, `long-${label}`, "owner-claude")
        // Four 60-char segments: the slug passes 200 characters.
        const cwd = path.join(
          tmpBase,
          `long-${label}`,
          ...Array.from({ length: 4 }, (_, i) => `segment-${i}-`.padEnd(60, "x")),
        )
        mkdirSync(ownerConfig, { recursive: true })
        mkdirSync(cwd, { recursive: true })
        const full = slug(cwd)
        expect(full.length).toBeGreaterThan(200)
        const id = `${idBase}-3333-4444-8555-666666666666`
        const t = vscodeTurn({
          binary,
          cwd,
          ownerConfig,
          sessionId: id,
          prompt: "Reply with just OK.",
        })
        expect(t.exitCode).toBe(0)
        const projects = path.join(ownerConfig, "projects")
        const dirs = readdirSync(projects)
        const holding = dirs.filter((d) => existsSync(path.join(projects, d, `${id}.jsonl`)))
        const listed = await listAsOwner(ownerConfig, { dir: cwd, includeProgrammatic: false })
        process.stderr.write(
          `session-import.realquery: ${label} OPEN-10 slugLen=${full.length} dirs=${JSON.stringify(dirs)} holding=${JSON.stringify(holding)} listed=${JSON.stringify(listed.map((s) => s.sessionId))}\n`,
        )
        // Not under the full slug; under exactly one `slice(0,200)-<hash>` dir.
        expect(existsSync(path.join(projects, full))).toBe(false)
        expect(holding).toHaveLength(1)
        const dir = holding[0] as string
        expect(dir.startsWith(`${full.slice(0, 200)}-`)).toBe(true)
        expect(dir.length).toBeGreaterThan(201)
        // The SDK's listing of that cwd finds it (it knows the hash).
        expect(listed.map((s) => s.sessionId)).toContain(id)
      },
      RUN_MS,
    )
  })
}

// W3 T12 (S41, S51, A44, A62): Take over of a VS Code-like session in
// `<shared>/sub` through the node's own run (runUnattended): refused while
// VS Code is still writing it; then resumed by id in the subfolder, appending
// to the same JSONL, after replaying what VS Code added since the import.
for (const [label, binary, idBase] of [
  ["bundled", BUNDLED, "8a8a8a8a"],
  ["installed", INSTALLED, "8b8b8b8b"],
] as const) {
  describe.if(READY)(
    `Take over of a VS Code session through the node, ${label} CLI (S41, A44)`,
    () => {
      const root = path.join(tmpBase, `takeover-${label}`)
      const ownerConfig = path.join(root, "owner-claude")
      const shared = path.join(root, "shared")
      const sub = path.join(shared, "sub")
      const id = `${idBase}-1111-4222-8333-444444444444`
      const projectDir = path.join(ownerConfig, "projects", slug(sub))
      const file = path.join(projectDir, `${id}.jsonl`)
      let importedAt = 0

      /** The owner's first message to the taken-over import, as the claim hands it to the node. */
      async function takeOver(prompt: string, catchUpFrom: number) {
        const job: UnattendedJob = {
          jobId: `${idBase}-2222-4333-8444-555555555555`,
          server: "https://liaison.example",
          agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          agentName: "Personal",
          model: MODEL,
          profile: { level: "standard", liaisonTools: false },
          session: {
            id: `${idBase}-3333-4444-8555-666666666666`,
            source: "import",
            model: MODEL,
            level: "standard",
            profileLevel: "standard",
            configKind: "owner",
            liaisonTools: false,
            folderPath: shared,
            folderName: "shared",
            cwdSubdir: "sub",
            finishWith: "none",
            resume: {
              sdkSessionId: id,
              after: "message",
              commandId: `${idBase}-4444-4555-8666-777777777777`,
              catchUpFrom,
            },
          },
          sharedFolders: [{ name: "shared", path: shared, kind: "repo" }],
          prompt,
          hardTokenLimit: null,
          nodeRoot: path.join(root, "Liaison Node"),
        }
        const lines: Array<Record<string, unknown>> = []
        const outcome = await runUnattended({
          job,
          emit: (l) => lines.push(l),
          control: new AsyncQueue<string>(),
          cliPath: binary,
          npmPrefix: null,
          claudeBinary: { bundledVersion: versionOf(binary) as string, run: async () => null },
          dataDir: path.join(root, "data"),
          realConfigDir: ownerConfig,
          stopGraceMs: 10_000,
        })
        const events = lines
          .filter((l) => l.type === "session_events")
          .flatMap((l) => l.events as Array<{ type: string; payload: Record<string, unknown> }>)
        return { outcome, events }
      }

      it(
        "S51: Take over while the VS Code-like session still writes its transcript → driver event, no SDK start",
        async () => {
          expect(existsSync(binary)).toBe(true)
          mkdirSync(ownerConfig, { recursive: true })
          mkdirSync(sub, { recursive: true })
          git(shared, "init", "-q", "-b", "main")
          git(
            shared,
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
          )
          const first = vscodeTurn({
            binary,
            cwd: sub,
            ownerConfig,
            sessionId: id,
            prompt: "Remember the word PERIWINKLE. Reply with just OK.",
          })
          expect(first.exitCode).toBe(0)
          importedAt = statSync(file).size
          const { outcome, events } = await takeOver("Reply with just OK.", importedAt)
          process.stderr.write(
            `session-import.realquery: ${label} takeover-driven status=${outcome.status} text=${JSON.stringify(outcome.text)} system=${JSON.stringify(events.filter((e) => e.type === "system").map((e) => e.payload.subtype))}\n`,
          )
          expect(outcome.status).toBe("done")
          expect(outcome.completion).toBeUndefined()
          expect(events.filter((e) => e.type === "system").map((e) => e.payload.subtype)).toEqual([
            "driver",
          ])
          expect(entrypoints(file)).toEqual(["claude-vscode"])
        },
        RUN_MS,
      )

      it(
        "S41: Take over of a VS Code-like session resumes by id in <shared>/sub, appends to the same JSONL, and the start event's sdkSessionId equals the imported id",
        async () => {
          expect(importedAt).toBeGreaterThan(0)
          // VS Code goes on after the import's replay stopped, then closes.
          const more = vscodeTurn({
            binary,
            cwd: sub,
            ownerConfig,
            resume: id,
            prompt: "Also remember the word TANGERINE. Reply with just OK.",
          })
          expect(more.exitCode).toBe(0)
          const old = (Date.now() - 120_000) / 1000
          utimesSync(file, old, old)
          const { outcome, events } = await takeOver(
            "Which two words did I ask you to remember? Reply with just the two words.",
            importedAt,
          )
          const start = events.findIndex(
            (e) => e.type === "system" && e.payload.subtype === "start",
          )
          const data = (events[start]?.payload.data ?? {}) as Record<string, unknown>
          const caught = events.findIndex(
            (e) => e.type === "user_message" && String(e.payload.text).includes("TANGERINE"),
          )
          process.stderr.write(
            `session-import.realquery: ${label} takeover status=${outcome.status} text=${JSON.stringify(outcome.text.slice(0, 120))} start=${start} caught=${caught} sdk=${String(data.sessionId)} cwd=${String(data.cwd)} entrypoints=${JSON.stringify(entrypoints(file))} files=${JSON.stringify(jsonlIn(projectDir))}\n`,
          )
          expect(outcome.status).toBe("done")
          expect(data.sessionId).toBe(id)
          expect(data.cwd).toBe(realpathSync(sub))
          // A62: what VS Code added after the import came first, from the transcript.
          expect(caught).toBeGreaterThanOrEqual(0)
          expect(caught).toBeLessThan(start)
          expect(outcome.text.toUpperCase()).toContain("PERIWINKLE")
          expect(outcome.text.toUpperCase()).toContain("TANGERINE")
          expect(jsonlIn(projectDir)).toEqual([`${id}.jsonl`])
          expect(entrypoints(file)).toEqual(["claude-vscode", OWNER_SESSION_ENTRYPOINT])
          // In place: no node worktree, the folder's own branch.
          expect(existsSync(path.join(root, "Liaison Node", "worktrees"))).toBe(false)
        },
        RUN_MS * 2,
      )
    },
  )
}

// The fixture generator T05 and T06 build their transcripts with: same
// options, same bytes; whole lines; the follow turns them into events.
describe("T04 fixture: the transcript generator", () => {
  it("S41: is deterministic, writes whole lines, and its lines become events", () => {
    const dir = path.join(tmpBase, "gen")
    const id = "0f0f0f0f-1111-4222-8333-444444444444"
    const a = generateTranscript({
      file: path.join(dir, "a", `${id}.jsonl`),
      sessionId: id,
      cwd: "/x/y",
      bytes: 512 * 1024,
      seed: 7,
      agentEvery: 3,
      subagentBytes: 8 * 1024,
    })
    const b = generateTranscript({
      file: path.join(dir, "b", `${id}.jsonl`),
      sessionId: id,
      cwd: "/x/y",
      bytes: 512 * 1024,
      seed: 7,
      agentEvery: 3,
      subagentBytes: 8 * 1024,
    })
    const textA = readFileSync(path.join(dir, "a", `${id}.jsonl`))
    expect(textA.equals(readFileSync(path.join(dir, "b", `${id}.jsonl`)))).toBe(true)
    expect(a.bytes).toBe(textA.length)
    expect(a.bytes).toBeGreaterThanOrEqual(512 * 1024)
    expect(textA[textA.length - 1]).toBe(0x0a)
    expect(a.agents.length).toBeGreaterThan(0)
    expect(b.agents.map((x) => x.agentId)).toEqual(a.agents.map((x) => x.agentId))
    const agent = a.agents[0] as (typeof a.agents)[number]
    const meta = JSON.parse(readFileSync(agent.metaFile, "utf8")) as { toolUseId: string }
    expect(meta.toolUseId).toBe(agent.toolUseId)
    const subLine = JSON.parse(readFileSync(agent.file, "utf8").split("\n")[0] as string) as {
      isSidechain: boolean
      agentId: string
    }
    expect(subLine).toMatchObject({ isSidechain: true, agentId: agent.agentId })
    let events = 0
    const follow = new TranscriptFollow({
      file: path.join(dir, "a", `${id}.jsonl`),
      emit: (e) => {
        events += e.length
      },
    })
    let at = -1
    while (follow.offset !== at) {
      at = follow.offset
      follow.poll()
    }
    expect(follow.offset).toBe(a.bytes)
    expect(events).toBeGreaterThan(a.turns * 3)
  })
})
