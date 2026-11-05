// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Spawning the compiled sidecar and reading its JSON lines back is the same
// job in every integration test here, and it is the shape the Rust host
// implements too: argv passthrough, piped stdio, no shell, control lines in,
// newline delimited events out.

import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export interface LiveEnvironment {
  mcpUrl: string
  mcpToken: string
  definitionFile: string
  definitionToolCount: number
  model: string
  workDir: string
}

/** The live box's coordinates, or null when no box is configured. */
export function sidecarEnvironment(): LiveEnvironment | null {
  const env = process.env as Record<string, string | undefined>
  const mcpUrl = env.LIAISON_MCP_URL
  const mcpToken = env.LIAISON_MCP_TOKEN
  const definitionFile = env.LIAISON_AGENT_DEFINITION_FILE
  const definitionToolCount = Number(env.LIAISON_DEFINITION_TOOL_COUNT)
  if (!mcpUrl || !mcpToken || !definitionFile || !existsSync(definitionFile)) return null
  if (!Number.isFinite(definitionToolCount) || definitionToolCount <= 0) return null
  return {
    mcpUrl,
    mcpToken,
    definitionFile,
    definitionToolCount,
    model: env.LIAISON_SIDECAR_MODEL ?? "claude-haiku-4-5",
    workDir: mkdtempSync(path.join(tmpdir(), "sidecar-live-")),
  }
}

export interface SidecarEvent {
  type: string
  event?: string
  payload?: unknown
  [key: string]: unknown
}

export interface SidecarRun {
  exitCode: number
  events: SidecarEvent[]
  boot?: SidecarEvent
  ready?: { sidecarReadyMs: number; systemPromptChecksum: string | null }
  stderr: string
}

export async function runSidecar(options: {
  binary: string
  args: string[]
  prompt: string
  timeoutMs: number
  env?: Record<string, string | undefined>
}): Promise<SidecarRun> {
  const child = Bun.spawn([options.binary, ...options.args], {
    cwd: "/",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env ? (options.env as Record<string, string>) : undefined,
  })
  // Protocol 2: every line is a control line. One turn, then shutdown, so the
  // session ends on its own rather than on the timeout kill.
  child.stdin.write(`${JSON.stringify({ type: "turn", prompt: options.prompt })}\n`)
  child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`)
  child.stdin.flush()

  const timer = setTimeout(() => child.kill(), options.timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)

  const events: SidecarEvent[] = []
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as SidecarEvent)
    } catch {
      // A non-JSON line is the SDK writing to stdout directly; keep reading.
    }
  }
  const ready = events.find((event) => event.type === "ready") as SidecarRun["ready"] | undefined
  return {
    exitCode,
    events,
    boot: events.find((event) => event.type === "boot"),
    ready,
    stderr,
  }
}
