// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REAL QUERIES: the bundled Atelier (P2-T12; S38, A32, OPEN-7, D4).
// Claude Code on this Mac (signed in), claude-haiku-5-5, Standard, owner
// sessions through runUnattended, once per CLI binary (the one the SDK
// bundles and the one installed on this Mac, each forced as the session's
// binary):
//
// - OPEN-7: with no Atelier of the owner's, the bundled plugin reaches the CLI
//   through `Options.plugins`: the init message lists the plugin at the
//   bundled path and `atelier:atelier` among its slash commands, and the
//   prompt `/atelier:atelier ...` is expanded into the command (the CLI
//   replays the expanded command as a user message naming it).
// - D4: with the owner's own Atelier enabled (this Mac's real config, which
//   enables atelier@atelier), nothing is added, and the plugin the CLI loads
//   is the owner's installed copy, not the bundled one.
//
// Skipped unless macOS with the CLI signed in. Evidence goes to stderr.
import { afterAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import type { NodeLevel } from "../../../packages/shared/src/node-levels"
import {
  commandLine,
  type NodeSessionCommand,
} from "../../../packages/shared/src/node-session-protocol"
import { appDataDir, realClaudeConfigDir } from "./config-isolation"
import { AsyncQueue } from "./index"
import { sessionConfigDir } from "./session-config"
import { type QueryFn, runUnattended, type UnattendedJob } from "./unattended"

function signedIn(): boolean {
  if (process.platform !== "darwin") return false
  const status = Bun.spawnSync(["claude", "auth", "status"], { stdout: "pipe", stderr: "pipe" })
  try {
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
    "atelier-bundle.realquery: SKIPPED - not macOS, or the CLI is not signed in\n",
  )
}
const MODEL = "claude-haiku-5-5"
const RUN_MS = 180_000
const PROMPT = "/atelier:atelier say hello and stop"
/** A heading of commands/atelier.md at v0.4.0 (the host-mode section). */
const ATELIER_COMMAND_LINE = readFileSync(
  path.join(import.meta.dir, "vendor", "atelier", "commands", "atelier.md"),
  "utf8",
)
  .split("\n")
  .find((l) => l.startsWith("## ") && l.includes("Host mode")) as string
const base = READY ? realpathSync(mkdtempSync(path.join(homedir(), ".liaison-atelier-rq-"))) : ""
const tmpBase = READY ? realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-atelier-rq-"))) : ""
afterAll(() => {
  if (!READY) return
  rmSync(base, { recursive: true, force: true })
  rmSync(tmpBase, { recursive: true, force: true })
  // The D4 run is an owner session on this Mac's real config: its transcript
  // went to the owner's projects folder, under this test's temp cwd's name.
  const projects = path.join(realClaudeConfigDir(), "projects")
  const tag = path.basename(base).replace(/[^A-Za-z0-9]/g, "-")
  for (const name of existsSync(projects) ? readdirSync(projects) : []) {
    if (name.includes(tag)) rmSync(path.join(projects, name), { recursive: true, force: true })
  }
})

const CMD = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const line = (n: number, command: NodeSessionCommand) =>
  commandLine({ type: "command", commandId: CMD(n), seq: n, command })

type Ev = { type: string; payload: Record<string, unknown> }
type Msg = Record<string, unknown> & { type: string; subtype?: string }

function versionOf(binary: string): string | null {
  const r = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
  return /(\d+\.\d+\.\d+)/.exec(r.stdout.toString())?.[1] ?? null
}

function job(id: string, level: NodeLevel = "standard", prompt = PROMPT): UnattendedJob {
  const nodeRoot = path.join(base, "Liaison Node")
  mkdirSync(nodeRoot, { recursive: true })
  return {
    jobId: `${id.slice(0, 8)}-2222-4333-8444-${id.slice(-12)}`,
    server: "https://liaison.example",
    agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    agentName: "Personal",
    model: MODEL,
    profile: { level, liaisonTools: false },
    session: {
      id,
      source: "app",
      model: MODEL,
      level,
      profileLevel: level,
      configKind: "owner",
      liaisonTools: false,
    },
    prompt,
    hardTokenLimit: null,
    nodeRoot,
  }
}

/** The real query, every SDK message it yields recorded. */
function tapped(seen: Msg[]): QueryFn {
  return (a) => {
    const q = sdkQuery(a)
    const gen = (async function* () {
      for await (const m of q) {
        seen.push(m as unknown as Msg)
        yield m
      }
    })()
    return new Proxy(q, {
      get(target, prop) {
        if (prop === Symbol.asyncIterator) return () => gen
        if (prop === "next") return gen.next.bind(gen)
        const v = Reflect.get(target, prop, target)
        return typeof v === "function" ? v.bind(target) : v
      },
    })
  }
}

/**
 * Whether the CLI expanded the slash command: the session's transcript (under
 * the session config's `projects`) records the prompt as that command, and
 * the command file's own text sent to the model with it.
 */
function expanded(projects: string, sdkSessionId: string, name: string, marker: string): boolean {
  if (!existsSync(projects)) return false
  for (const dir of readdirSync(projects)) {
    const file = path.join(projects, dir, `${sdkSessionId}.jsonl`)
    if (!existsSync(file)) continue
    const text = readFileSync(file, "utf8")
    return text.includes(`<command-name>/${name}</command-name>`) && text.includes(marker)
  }
  return false
}

/** The first tool the model called, or its first words: what it did with the command. */
function firstAct(seen: Msg[]): string | null {
  for (const m of seen) {
    if (m.type !== "assistant") continue
    const content = (m.message as { content?: Array<Record<string, unknown>> }).content ?? []
    for (const c of content) {
      if (c.type === "tool_use") return `${c.name} ${JSON.stringify(c.input).slice(0, 200)}`
      if (c.type === "text" && typeof c.text === "string" && c.text) return c.text.slice(0, 200)
    }
  }
  return null
}

async function runOn(binary: string, version: string, id: string, realConfigDir: string) {
  const lines: Array<Record<string, unknown>> = []
  const seen: Msg[] = []
  const control = new AsyncQueue<string>()
  const running = runUnattended({
    job: job(id),
    emit: (l) => lines.push(l),
    control,
    cliPath: binary,
    npmPrefix: null,
    claudeBinary: { bundledVersion: version, run: async () => null },
    dataDir: path.join(tmpBase, "data"),
    realConfigDir,
    queryFn: tapped(seen),
    stopGraceMs: 10_000,
  })
  let ended = false
  void running.then(() => {
    ended = true
  })
  // Enough to see the command expanded and the model start on it, not a run.
  const end = Date.now() + RUN_MS
  while (!ended && Date.now() < end && firstAct(seen) === null) {
    await Bun.sleep(200)
  }
  if (!ended) control.push(line(1, { type: "stop", payload: {} }))
  await running
  const events = lines.filter((l) => l.type === "session_events").flatMap((l) => l.events as Ev[])
  const init = seen.find((m) => m.type === "system" && m.subtype === "init") as
    | (Msg & { slash_commands?: string[]; plugins?: Array<{ name: string; path: string }> })
    | undefined
  const start = events.find((e) => e.type === "system" && e.payload.subtype === "start")?.payload
    .data as Record<string, unknown> | undefined
  return { events, seen, init, start }
}

for (const [label, binary, idBase] of [
  ["bundled", BUNDLED, "7a7a7a1"],
  ["installed", INSTALLED, "7b7b7b1"],
] as const) {
  describe.if(READY)(`the bundled Atelier, real query, ${label} CLI (S38, OPEN-7, D4)`, () => {
    it(
      "S38: the bundled /atelier:atelier command is loaded and expands from a prompt (OPEN-7)",
      async () => {
        expect(existsSync(binary)).toBe(true)
        const version = versionOf(binary)
        expect(version).not.toBeNull()
        // An owner config of nobody's: no Atelier of the owner's, so the bundled one.
        const ownerConfig = path.join(tmpBase, `owner-config-${label}`)
        mkdirSync(ownerConfig, { recursive: true })
        const r = await runOn(
          binary,
          version as string,
          `${idBase}1-1111-4222-8333-444444444444`,
          ownerConfig,
        )
        const bundled = path.join(tmpBase, "data", "atelier", "v0.4.0")
        const atelier = r.init?.plugins?.find((p) => p.name === "atelier")
        const evidence = {
          label,
          version,
          atelierSource: r.start?.atelierSource,
          plugin: atelier ?? null,
          slashCommand: r.init?.slash_commands?.includes("atelier:atelier") ?? false,
          expanded: expanded(
            path.join(ownerConfig, "projects"),
            String(r.init?.session_id),
            "atelier:atelier",
            // A line of the vendored command file, sent to the model only when expanded.
            ATELIER_COMMAND_LINE,
          ),
          firstAct: firstAct(r.seen),
          messages: r.seen.map((m) => (m.subtype ? `${m.type}/${m.subtype}` : m.type)).join(","),
        }
        process.stderr.write(`atelier-bundle.realquery OPEN-7 ${JSON.stringify(evidence)}\n`)
        expect(r.start?.atelierSource).toBe("bundled")
        expect(atelier ? realpathSync(atelier.path) : null).toBe(realpathSync(bundled))
        expect(evidence.slashCommand).toBe(true)
        expect(evidence.expanded).toBe(true)
      },
      RUN_MS + 60_000,
    )

    it(
      "D4: with the owner's own Atelier enabled, nothing is added and the owner's copy loads",
      async () => {
        const version = versionOf(binary)
        const r = await runOn(
          binary,
          version as string,
          `${idBase}2-1111-4222-8333-444444444444`,
          realClaudeConfigDir(),
        )
        const atelier = r.init?.plugins?.find((p) => p.name === "atelier")
        const evidence = {
          label,
          atelierSource: r.start?.atelierSource,
          plugin: atelier ?? null,
          slashCommand: r.init?.slash_commands?.includes("atelier:atelier") ?? false,
        }
        process.stderr.write(`atelier-bundle.realquery D4 ${JSON.stringify(evidence)}\n`)
        expect(r.start?.atelierSource).toBe("user")
        expect(atelier?.path.startsWith(path.join(tmpBase, "data"))).toBe(false)
        expect(atelier?.path).toContain(`${path.sep}plugins${path.sep}`)
        expect(evidence.slashCommand).toBe(true)
      },
      RUN_MS + 60_000,
    )
  })
}

// ── D44: the session reads the bundle where production extracts it ──

describe.if(READY)("the bundled Atelier on the production path, real query (D44)", () => {
  for (const [level, idBase] of [
    ["strict", "7c7c7c1"],
    ["standard", "7d7d7d1"],
  ] as const) {
    it(
      `D44: at ${level}, a Read of <app data dir>/atelier/<tag>/docs/precepts.md is allowed`,
      async () => {
        const version = versionOf(BUNDLED) as string
        const ownerConfig = path.join(tmpBase, `owner-config-prod-${level}`)
        mkdirSync(ownerConfig, { recursive: true })
        // Production: no dataDir, so the app's own data dir.
        const bundle = path.join(appDataDir(), "atelier", "v0.4.0")
        const precepts = path.join(bundle, "docs", "precepts.md")
        const id = `${idBase}3-1111-4222-8333-444444444444`
        const lines: Array<Record<string, unknown>> = []
        const outcome = await runUnattended({
          job: job(
            id,
            level,
            `Use the Read tool on the file ${precepts} and reply with its first line only.`,
          ),
          emit: (l) => lines.push(l),
          cliPath: BUNDLED,
          npmPrefix: null,
          claudeBinary: { bundledVersion: version, run: async () => null },
          realConfigDir: ownerConfig,
          stopGraceMs: 10_000,
        })
        rmSync(sessionConfigDir(id), { recursive: true, force: true })
        const events = lines
          .filter((l) => l.type === "session_events")
          .flatMap((l) => l.events as Ev[])
        const start = events.find((e) => e.type === "system" && e.payload.subtype === "start")
          ?.payload.data as Record<string, unknown> | undefined
        const reads = events.filter(
          (e) =>
            e.type === "tool_call" &&
            e.payload.name === "Read" &&
            realpathSync(String((e.payload.input as { file_path?: unknown }).file_path)) ===
              realpathSync(precepts),
        )
        const results = events.filter(
          (e) => e.type === "tool_result" && reads.some((r) => r.payload.id === e.payload.id),
        )
        const firstLine = readFileSync(precepts, "utf8").split("\n")[0] ?? ""
        process.stderr.write(
          `atelier-bundle.realquery D44 ${JSON.stringify({
            level,
            status: outcome.status,
            atelierSource: start?.atelierSource,
            bundle: bundle.replace(homedir(), "~"),
            reads: reads.length,
            results: results.map((r) => ({ isError: r.payload.isError })),
            refusals: outcome.refusals ?? [],
            answer: String(outcome.text ?? "").slice(0, 160),
          })}\n`,
        )
        expect(start?.atelierSource).toBe("bundled")
        expect(reads.length).toBeGreaterThan(0)
        expect(results.length).toBeGreaterThan(0)
        expect(results.every((r) => r.payload.isError !== true)).toBe(true)
        expect(outcome.text ?? "").toContain(firstLine.replace(/^#+\s*/, "").trim())
      },
      RUN_MS + 60_000,
    )
  }
})
