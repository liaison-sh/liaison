// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S20, end to end and live: a Local-model session writes a file with Bash,
// reads it back with Read, and the file is attached to a real Liaison thread,
// in one session against a real server.
//
// WHAT DRIVES IT. apps/desktop has no Playwright harness (the shell is a Tauri
// window, not a served page), so the harness here is the one the blueprint
// allows instead: the COMPILED sidecar, spoken to on its own protocol 2 stdio,
// with exactly the lines the shell would send (`turn`, `permission_response`,
// `shutdown`) and the events the overlay's own client dispatches on. Writing
// those lines to stdin is THIS HARNESS standing in for the shell, not a path
// the shipped overlay has: the window holds no command that writes a control
// line it composed, and the shell checks the two that carry authority
// (`respond_permission`, `call_mcp_tool`) before it writes them. Nothing is
// mocked: the definition is fetched from the real definition route and composed
// by `agent-definition-client.ts`, the model is a real haiku turn under this
// machine's Claude Code login, and the attachment is the real presign / PUT /
// confirm sequence `AttachToLiaisonAction.tsx` drives, against the real API.
//
// The permission mode is `manual` on purpose: Bash has to be ASKED for, so the
// run proves the `canUseTool` path end to end rather than stepping around it in
// bypass. It is not `edit`: measured on this box, acceptEdits treats a Bash
// command whose whole effect is writing a file as an edit and auto-accepts it,
// so no `permission_request` line is emitted at all and the mode that was
// supposed to force a prompt is the one that hides it. Recorded rather than
// asserted away.
//
// Env (a live QA box, all four required or the suite skips, visibly):
//   LIAISON_E2E_BASE_URL   the API origin
//   LIAISON_E2E_TOKEN      a QA admin session bearer (the definition route is
//                          admin only today, and the upload routes are the
//                          user's)
//   LIAISON_E2E_AGENT_ID   the agent to open the session as
//   LIAISON_E2E_THREAD_ID  the thread the file is attached to
// Optional: LIAISON_E2E_MCP_TOKEN (the agent-bound MCP bearer the session's
// tool catalog uses; falls back to LIAISON_E2E_TOKEN).
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildOne } from "../../../sidecar/build"
import {
  composeAgentDefinitionText,
  fetchAgentDefinition,
} from "../../session/agent-definition-client"

const BASE_URL = process.env.LIAISON_E2E_BASE_URL
const TOKEN = process.env.LIAISON_E2E_TOKEN
const AGENT_ID = process.env.LIAISON_E2E_AGENT_ID
const THREAD_ID = process.env.LIAISON_E2E_THREAD_ID
const MCP_TOKEN = process.env.LIAISON_E2E_MCP_TOKEN ?? TOKEN
/** D17: every e2e in this epic runs on haiku, no exception. */
const MODEL = "claude-haiku-4-5"
/** The mode that actually asks. See the note at the top. */
const PERMISSION_MODE = "manual"
const PRODUCED_FILE = "local-session.txt"

const live = Boolean(BASE_URL && TOKEN && AGENT_ID && THREAD_ID)

interface Line {
  type: string
  event?: string
  payload?: unknown
  [key: string]: unknown
}

/** The API's `{ data }` envelope, or a throw naming the status. */
async function api(pathname: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) throw new Error(`${pathname} answered ${response.status}`)
  return (await response.json()).data
}

/** How many files the thread carries today. */
async function attachmentCount(): Promise<number> {
  const query = new URLSearchParams({
    app: "kernel",
    entityType: "thread",
    entityId: THREAD_ID as string,
    limit: "100",
  })
  const data = await api(`/api/files?${query.toString()}`)
  const rows = Array.isArray(data) ? data : (data?.files ?? data?.items ?? [])
  return rows.length
}

/**
 * One session, driven the way the shell drives it: the turn goes in, every
 * permission request is answered, and the events come back out. The
 * permission answer is the point of the mode: a run that never saw a
 * `permission_request` proves nothing about `canUseTool`.
 */
async function runSession(options: {
  binary: string
  configPath: string
  cwd: string
  prompt: string
  timeoutMs: number
}): Promise<{ lines: Line[]; stderr: string; exitCode: number }> {
  const child = Bun.spawn(
    [
      options.binary,
      "--mcp-config",
      options.configPath,
      "--model",
      MODEL,
      "--cwd",
      options.cwd,
      "--permission-mode",
      PERMISSION_MODE,
    ],
    { cwd: "/", stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )

  const lines: Line[] = []
  const write = (line: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(line)}\n`)
    child.stdin.flush()
  }
  write({ type: "turn", prompt: options.prompt })

  const timer = setTimeout(() => child.kill(), options.timeoutMs)
  const reader = (async () => {
    let buffer = ""
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk)
      let cut = buffer.indexOf("\n")
      while (cut >= 0) {
        const raw = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 1)
        cut = buffer.indexOf("\n")
        if (!raw.trim()) continue
        let line: Line
        try {
          line = JSON.parse(raw) as Line
        } catch {
          continue
        }
        lines.push(line)
        // Every tool this turn asks for is allowed: the assertion is that it
        // had to ask, not that the answer varies.
        if (line.type === "permission_request") {
          write({ type: "permission_response", requestId: line.requestId, behavior: "allow" })
        }
        if (line.type === "turn_done") write({ type: "shutdown" })
      }
    }
  })()

  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
    reader,
  ])
  clearTimeout(timer)
  return { lines, stderr, exitCode }
}

/** The tool names the session called, in the order it called them. */
function toolSequence(lines: Line[]): string[] {
  return lines
    .filter((line) => line.type === "message" && line.event === "tool_use")
    .flatMap((line) => ((line.payload as any)?.message?.content ?? []) as any[])
    .filter((block) => block?.type === "tool_use")
    .map((block) => String(block.name))
}

// `describe.skipIf` skips SILENTLY: with no box configured the file prints
// nothing at all, and a run that proved nothing looks exactly like a run that
// proved this. One visible line, so the suite's output says which it was.
if (!live) {
  console.log("[S20] skipped: LIAISON_E2E_* not set")
}

describe.skipIf(!live)("local session full loop", () => {
  it("[S20] scripted local session writes reads and attaches a file through the Liaison MCP", async () => {
    const before = await attachmentCount()

    // The definition the window would fetch, composed the way the window
    // composes it. Not a fixture: a drifted route shows up here.
    const definition = await fetchAgentDefinition(AGENT_ID as string, {
      serverAddress: BASE_URL as string,
      accessToken: TOKEN as string,
    })
    const agentDefinition = composeAgentDefinitionText(definition)
    expect(agentDefinition.length).toBeGreaterThan(0)

    const workDir = mkdtempSync(path.join(tmpdir(), "liaison-s20-"))
    const configPath = path.join(workDir, "mcp.json")
    await Bun.write(
      configPath,
      JSON.stringify({
        liaisonMcpUrl: `${BASE_URL}/mcp`,
        agentScopedToken: MCP_TOKEN,
        agentDefinition,
      }),
    )

    const binary = buildOne("bun-darwin-arm64")
    const produced = path.join(workDir, PRODUCED_FILE)
    const run = await runSession({
      binary,
      configPath,
      cwd: workDir,
      prompt:
        `Use the Bash tool to run exactly: printf 'liaison local session ok' > ${PRODUCED_FILE}` +
        `\nThen use the Read tool to read ${PRODUCED_FILE}.` +
        "\nThen reply with the single word done. Do not use any other tool.",
      timeoutMs: 300_000,
    })

    // The model the flag asked for is the model that answered.
    const init = run.lines.find((line) => line.event === "init")?.payload as
      | { model?: string }
      | undefined
    expect(init?.model ?? "").toContain("haiku")

    // Bash had to be asked for, in manual mode, and the harness answered.
    const prompts = run.lines.filter((line) => line.type === "permission_request")
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.map((line) => String(line.toolName))).toContain("Bash")

    // The tools ran, in that order.
    const sequence = toolSequence(run.lines)
    const bashAt = sequence.indexOf("Bash")
    const readAt = sequence.indexOf("Read")
    expect(bashAt).toBeGreaterThanOrEqual(0)
    expect(readAt).toBeGreaterThan(bashAt)

    // And the bytes are really on disk.
    const size = statSync(produced).size
    expect(size).toBeGreaterThan(0)

    // The attach sequence AttachToLiaisonAction drives, against the real API.
    const bytes = readFileSync(produced)
    const presign = await api("/api/files/upload-url", {
      method: "POST",
      body: JSON.stringify({
        app: "kernel",
        entityType: "thread",
        entityId: THREAD_ID,
        filename: PRODUCED_FILE,
        mimeType: "text/plain",
        sizeBytes: size,
      }),
    })
    expect(typeof presign.uploadUrl).toBe("string")
    expect(typeof presign.fileToken).toBe("string")

    let put: Response | null = null
    try {
      put = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: bytes,
      })
    } catch {
      put = null
    }
    if (!put?.ok) {
      const relay = await fetch(
        `${BASE_URL}/api/file-relay/${encodeURIComponent(presign.fileToken)}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
          body: bytes,
        },
      )
      expect(relay.ok).toBe(true)
    }

    const confirmed = await api("/api/files/confirm", {
      method: "POST",
      body: JSON.stringify({
        fileToken: presign.fileToken,
        disposition: "attachment",
        contentId: null,
      }),
    })
    expect(typeof confirmed.id).toBe("string")

    expect(await attachmentCount()).toBe(before + 1)

    // The run's own evidence, printed so a report quotes the run rather than a
    // rerun: which model answered, which tools it called in which order, which
    // of them had to be asked for, and how long the sidecar took to be ready.
    const ready = run.lines.find((line) => line.type === "ready")
    console.log(
      `[S20] model=${init?.model} tools=${JSON.stringify(sequence)} ` +
        `prompted=${prompts.map((line) => line.toolName).join(",")} ` +
        `readyMs=${ready?.sidecarReadyMs} bytes=${size} ` +
        `attachments=${before}->${before + 1}`,
    )
  }, 420_000)
})
