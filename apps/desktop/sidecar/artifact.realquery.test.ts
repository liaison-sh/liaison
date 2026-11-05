// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REAL QUERIES: Artifact in a node session (P1-T10; S27, spec §6).
// Claude Code on this Mac (signed in), claude-haiku-5-5, Strict, through
// runUnattended, once per CLI binary (the one the SDK bundles and the one
// installed on this Mac, each forced as the session's binary):
//
// - bundled: the CLI's init lists the Artifact tool (the session sets
//   CLAUDE_CODE_ARTIFACT), so the start event records it available;
// - installed: either the same, or the run says "Artifact unavailable on
//   CLI <v>" on its own line (the degradation is visible, never silent).
//
// Each binary's Claude Code version goes to stderr with the result.
// Skipped unless macOS with the CLI signed in. Evidence goes to stderr.
import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
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
  process.stderr.write("artifact.realquery: SKIPPED - not macOS, or the CLI is not signed in\n")
}
const MODEL = "claude-haiku-5-5"
const RUN_MS = 180_000
const base = READY ? realpathSync(mkdtempSync(path.join(homedir(), ".liaison-artifact-rq-"))) : ""
const tmpBase = READY ? realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-artifact-rq-"))) : ""
afterAll(() => {
  if (!READY) return
  rmSync(base, { recursive: true, force: true })
  rmSync(tmpBase, { recursive: true, force: true })
})

type Ev = { type: string; payload: Record<string, unknown> }

function versionOf(binary: string): string | null {
  const r = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
  return /(\d+\.\d+\.\d+)/.exec(r.stdout.toString())?.[1] ?? null
}

function job(id: string): UnattendedJob {
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
    prompt: "Reply with the single word ok.",
    hardTokenLimit: null,
    nodeRoot,
  }
}

/** One run on the given binary, forced: no other install is taken over it. */
async function runOn(binary: string, version: string, id: string) {
  const lines: Array<Record<string, unknown>> = []
  const outcome = await runUnattended({
    job: job(id),
    emit: (l) => lines.push(l),
    control: new AsyncQueue<string>(),
    cliPath: binary,
    npmPrefix: null,
    claudeBinary: { bundledVersion: version, run: async () => null },
    dataDir: path.join(tmpBase, "data"),
    stopGraceMs: 10_000,
  })
  const events = lines.filter((l) => l.type === "session_events").flatMap((l) => l.events as Ev[])
  const system = events.filter((e) => e.type === "system").map((e) => e.payload)
  const start = system.find((p) => p.subtype === "start")
  const data = (start?.data ?? {}) as Record<string, unknown>
  const unavailable = system.find((p) => p.subtype === "artifact_unavailable")
  process.stderr.write(
    `artifact.realquery: ${binary} claudeCode=${String(data.claudeCodeVersion)} status=${
      outcome.status
    } artifact=${String(data.artifact)} line=${JSON.stringify(unavailable?.text ?? null)}\n`,
  )
  return { outcome, data, unavailable }
}

describe.if(READY)("Artifact in a node session, real query (S27, spec §6)", () => {
  it(
    "S27: the bundled CLI lists Artifact for the session",
    async () => {
      expect(existsSync(BUNDLED)).toBe(true)
      const version = versionOf(BUNDLED)
      expect(version).not.toBeNull()
      const r = await runOn(BUNDLED, version as string, "5a5a5a11-1111-4222-8333-444444444444")
      expect(r.data.claudeCodeVersion).toBe(version)
      expect(r.data.artifact).toBe("available")
      expect(r.unavailable).toBeUndefined()
    },
    RUN_MS,
  )

  it.if(existsSync(INSTALLED))(
    "S27: the installed CLI lists Artifact or says it is unavailable",
    async () => {
      const version = versionOf(INSTALLED)
      expect(version).not.toBeNull()
      const r = await runOn(INSTALLED, version as string, "5b5b5b11-1111-4222-8333-444444444444")
      expect(r.data.claudeCodeVersion).toBe(version)
      if (r.data.artifact === "available") expect(r.unavailable).toBeUndefined()
      else {
        expect(r.data.artifact).toBe("unavailable")
        expect(r.unavailable?.text).toBe(`Artifact unavailable on CLI ${version}`)
      }
    },
    RUN_MS,
  )
})
