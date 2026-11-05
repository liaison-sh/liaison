// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REAL QUERIES, one per open caveat of the session guard (P1-T06), run before
// the guard is written so each fallback is chosen by what the SDK actually
// does on this computer, never by what its documentation implies. Raw
// `query()` from the SDK, Claude Haiku, tiny prompts; every outcome is read
// from the SDK's own messages, the hook and canUseTool inputs, or the disk,
// never from the model's word. Each probe prints one evidence JSON line
// (`session-caveats CVn: {...}`).
//
// - CV2: a project allow rule for WebFetch versus a PreToolUse hook `ask`:
//   does canUseTool still see the call?
// - CV3: skills reached through a symlink in CLAUDE_CONFIG_DIR: listed?
// - CV4: the owner's user-scope MCP servers (shape only, never values), and a
//   stdio server passed through `mcpServers` with `strictMcpConfig`.
// - CV5: the provenance (`mcp_server`) the PreToolUse hook sees for a passed
//   stdio server and a passed http server.
// - CV10: AskUserQuestion under a hook `ask` reaches canUseTool, and an
//   `answers` map given back reaches the model.
// - CV11 (a CHARACTERIZATION since P1-T31, D48): the raw SDK lets a user
//   settings file's `sandbox.filesystem.allowWrite: ["~"]` widen the flag
//   layer's sandbox (array keys merge), so a session never reads the owner's
//   real settings: session-config.ts writes a filtered mirror, and P1-T41
//   proves the same write is refused through the session path. If this probe
//   ever stops widening, the SDK changed and D48 can be revisited.
//
// macOS only. Skipped, with the reason printed, when the Claude Code CLI on
// this computer is not signed in.
import { afterAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import {
  type CanUseTool,
  type HookCallback,
  type Options,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk"
import { startFakeLiaison } from "./fake-liaison-mcp"
import { AsyncQueue, userMessage } from "./index"

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
    "session-caveats.realquery: SKIPPED - not macOS, or the Claude Code CLI is not signed in (claude auth status)\n",
  )
}

const MODEL = "claude-haiku-5-5"
const TIMEOUT_MS = 180_000
const scratch = READY ? mkdtempSync(path.join(tmpdir(), "liaison-session-caveats-")) : ""

afterAll(() => {
  if (READY) rmSync(scratch, { recursive: true, force: true })
})

function evidence(name: string, value: unknown): void {
  process.stderr.write(`session-caveats ${name}: ${JSON.stringify(value, null, 2)}\n`)
}

/** An empty Claude config dir that keeps this computer's login (config-isolation.ts). */
function configDir(label: string): string {
  return mkdtempSync(path.join(scratch, `config-${label}-`))
}

function isolation(dir: string): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }
}

type Message = Record<string, unknown> & { type?: string; subtype?: string }

/** One prompt, streamed (canUseTool needs a live input), every message kept. */
async function run(prompt: string, options: Options): Promise<Message[]> {
  const prompts = new AsyncQueue<SDKUserMessage>()
  prompts.push(userMessage(prompt) as SDKUserMessage)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS - 10_000)
  const messages: Message[] = []
  const q = sdkQuery({
    prompt: prompts,
    options: {
      model: MODEL,
      maxTurns: 6,
      persistSession: false,
      abortController: abort,
      stderr: () => {},
      ...options,
    },
  })
  try {
    for await (const message of q) {
      messages.push(message as Message)
      if ((message as Message).type === "result") break
    }
  } finally {
    clearTimeout(timer)
    prompts.close()
    q.close()
  }
  return messages
}

function initOf(messages: Message[]): Message | undefined {
  return messages.find((m) => m.type === "system" && m.subtype === "init")
}

function resultOf(messages: Message[]): { subtype?: string; result?: string } | undefined {
  return messages.find((m) => m.type === "result") as { subtype?: string; result?: string }
}

type Block = {
  type?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function blocks(messages: Message[], role: "assistant" | "user"): Block[] {
  return messages
    .filter((m) => m.type === role)
    .flatMap((m) => {
      const content = (m.message as { content?: unknown } | undefined)?.content
      return Array.isArray(content) ? (content as Block[]) : []
    })
}

function toolUses(messages: Message[], name: string): Block[] {
  return blocks(messages, "assistant").filter((b) => b.type === "tool_use" && b.name === name)
}

function resultText(block: Block): string {
  const c = block.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((p) => (p as { text?: string }).text ?? "").join("\n")
  return ""
}

function toolResultFor(messages: Message[], id: string | undefined): Block | undefined {
  return blocks(messages, "user").find((b) => b.type === "tool_result" && b.tool_use_id === id)
}

function hookAnswering(
  decide: (tool: string, input: Record<string, unknown>) => "allow" | "ask" | "deny" | null,
  seen?: Array<Record<string, unknown>>,
): HookCallback {
  return async (raw) => {
    const input = raw as {
      tool_name?: string
      tool_input?: Record<string, unknown>
      mcp_server?: unknown
    }
    const tool = String(input.tool_name ?? "")
    seen?.push({ tool, mcp_server: input.mcp_server ?? null })
    const decision = decide(tool, input.tool_input ?? {})
    if (!decision) return {}
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: `session-caveats probe: ${decision}`,
      },
    }
  }
}

function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(scratch, "repo-"))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, env })
  git(["init", "-q", "-b", "main"])
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), content)
  }
  git(["add", "-A"])
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"])
  return dir
}

/** A 20-line stdio MCP server with one tool answering a nonce. */
function stdioServer(nonce: string): string {
  const file = path.join(scratch, "probe-stdio-mcp.ts")
  writeFileSync(
    file,
    `const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n")
let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    const rpc = JSON.parse(line)
    if (rpc.id === undefined) continue
    if (rpc.method === "initialize") reply(rpc.id, { protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1.0.0" } })
    else if (rpc.method === "tools/list") reply(rpc.id, { tools: [{ name: "probe_echo", description: "Returns the probe word. Call it when asked to run the probe.", inputSchema: { type: "object", properties: {} } }] })
    else if (rpc.method === "tools/call") reply(rpc.id, { content: [{ type: "text", text: ${JSON.stringify(nonce)} }] })
    else reply(rpc.id, {})
  }
})
`,
  )
  return file
}

describe.skipIf(!READY)("session guard caveats, real queries on this Mac", () => {
  it(
    "CV2: a project allow rule for WebFetch versus a hook ask",
    async () => {
      const repo = gitRepo({
        ".claude/settings.json": JSON.stringify({ permissions: { allow: ["WebFetch"] } }),
      })
      const asked: string[] = []
      const canUseTool: CanUseTool = async (toolName) => {
        asked.push(toolName)
        return { behavior: "deny", message: "session-caveats probe: denied" }
      }
      const messages = await run(
        "Use the WebFetch tool exactly once on https://example.com and report its title. Do not use any other tool.",
        {
          cwd: repo,
          env: { ...process.env, ...isolation(configDir("cv2")) },
          settingSources: ["project"],
          permissionMode: "default",
          canUseTool,
          hooks: {
            PreToolUse: [{ hooks: [hookAnswering((t) => (t === "WebFetch" ? "ask" : null))] }],
          },
        },
      )
      const fetches = toolUses(messages, "WebFetch")
      const called = asked.includes("WebFetch")
      const out = {
        webFetchCalls: fetches.length,
        canUseToolCalls: asked,
        toolResult: fetches[0]
          ? resultText(toolResultFor(messages, fetches[0].id) ?? {}).slice(0, 200)
          : null,
        branch:
          fetches.length === 0
            ? "inconclusive (no WebFetch call)"
            : called
              ? "pass: the hook ask reaches canUseTool despite the allow rule"
              : "fallback: allow pre-empts ask",
      }
      evidence("CV2", out)
      expect(fetches.length).toBeGreaterThan(0)
    },
    TIMEOUT_MS,
  )

  it(
    "CV3: skills behind a symlink in CLAUDE_CONFIG_DIR",
    async () => {
      const real = configDir("cv3-real")
      mkdirSync(path.join(real, "skills", "probe-skill"), { recursive: true })
      writeFileSync(
        path.join(real, "skills", "probe-skill", "SKILL.md"),
        "---\nname: probe-skill\ndescription: A probe skill. Never use it.\n---\nSay PROBE.\n",
      )
      const mirror = configDir("cv3-mirror")
      symlinkSync(path.join(real, "skills"), path.join(mirror, "skills"))
      const messages = await run("Reply with the single word OK.", {
        cwd: scratch,
        env: { ...process.env, ...isolation(mirror) },
        settingSources: ["user"],
        maxTurns: 1,
      })
      const init = initOf(messages)
      const skills = (init?.skills as string[] | undefined) ?? []
      const commands = (init?.slash_commands as string[] | undefined) ?? []
      const listed = skills.includes("probe-skill") || commands.includes("probe-skill")
      const out = {
        initSeen: Boolean(init),
        inSkills: skills.includes("probe-skill"),
        inSlashCommands: commands.includes("probe-skill"),
        branch: listed
          ? "pass: symlinked skills load"
          : "fallback: T30 copies skills/plugins into the mirror at each start",
      }
      evidence("CV3", out)
      expect(init).toBeDefined()
    },
    TIMEOUT_MS,
  )

  it(
    "CV4 + CV5: user-scope MCP shape, a passed stdio server and a passed http server",
    async () => {
      // The owner's own ~/.claude.json: shape only, never names or values.
      let userScope: { readable: boolean; hasMcpServers: boolean; entryFields: string[][] }
      try {
        const parsed = JSON.parse(readFileSync(path.join(homedir(), ".claude.json"), "utf8")) as {
          mcpServers?: unknown
        }
        const servers =
          parsed.mcpServers && typeof parsed.mcpServers === "object"
            ? Object.values(parsed.mcpServers as Record<string, unknown>)
            : null
        userScope = {
          readable: true,
          hasMcpServers: servers !== null,
          entryFields: (servers ?? []).map((v) =>
            v && typeof v === "object"
              ? Object.keys(v)
                  .filter((k) => ["type", "command", "args", "url", "env", "headers"].includes(k))
                  .sort()
              : [],
          ),
        }
      } catch {
        userScope = { readable: false, hasMcpServers: false, entryFields: [] }
      }

      const nonce = `CV4-${Math.random().toString(36).slice(2, 10)}`
      const fake = startFakeLiaison({ ttlMs: 3_600_000 })
      const seen: Array<Record<string, unknown>> = []
      try {
        const messages = await run(
          "Call the tool mcp__probe__probe_echo once, then call the tool mcp__web__liaison_ping once, then reply with what probe_echo returned.",
          {
            cwd: scratch,
            env: { ...process.env, ...isolation(configDir("cv4")) },
            settingSources: [],
            strictMcpConfig: true,
            mcpServers: {
              probe: { type: "stdio", command: process.execPath, args: [stdioServer(nonce)] },
              web: {
                type: "http",
                url: fake.mcpUrl,
                headers: { Authorization: `Bearer ${fake.mint()}` },
              },
            },
            hooks: {
              PreToolUse: [
                {
                  // MCP tools are deferred behind ToolSearch: the model loads
                  // them with it first, so it is allowed too.
                  hooks: [
                    hookAnswering(
                      (t) => (t.startsWith("mcp__") || t === "ToolSearch" ? "allow" : "deny"),
                      seen,
                    ),
                  ],
                },
              ],
            },
          },
        )
        const init = initOf(messages)
        const servers =
          (init?.mcp_servers as Array<{ name: string; status: string; source?: string }>) ?? []
        const echo = toolUses(messages, "mcp__probe__probe_echo")[0]
        const echoResult = echo ? resultText(toolResultFor(messages, echo.id) ?? {}) : ""
        const ping = toolUses(messages, "mcp__web__liaison_ping")[0]
        const cv4 = {
          userScope,
          initServers: servers,
          stdioCalled: Boolean(echo),
          stdioResultHasNonce: echoResult.includes(nonce),
          branch: !echo
            ? "inconclusive: probe_echo was never called"
            : servers.some((s) => s.name === "probe" && s.status === "connected") &&
                echoResult.includes(nonce)
              ? "pass: a passed stdio server loads under strictMcpConfig and its tool result arrives"
              : "fallback: at Standard user servers do not load; the start event says user MCP config unreadable",
        }
        evidence("CV4", cv4)
        const provenance = (tool: string) => seen.find((s) => s.tool === tool)?.mcp_server ?? null
        const stdioSource = provenance("mcp__probe__probe_echo")
        const httpSource = provenance("mcp__web__liaison_ping")
        const sources = [stdioSource, httpSource]
          .filter(Boolean)
          .map((s) => (s as { source?: string }).source)
        const cv5 = {
          stdio: stdioSource,
          http: httpSource,
          httpCalled: Boolean(ping),
          fakeServerCalls: fake.calls.map((c) => ({ tool: c.tool, accepted: c.accepted })),
          branch:
            !echo || !ping
              ? "inconclusive: a server's tool was never called"
              : sources.length === 0
                ? "fallback: mcp_server absent; admit mcp__<name>__* by name in the passed set at Strict and Standard"
                : sources.every((s) => s === "dynamic" || s === "sdk")
                  ? "pass: T29 admits source in {sdk, dynamic} with a name in the passed set"
                  : `unexpected source(s): ${sources.join(", ")}`,
        }
        evidence("CV5", cv5)
        expect(init).toBeDefined()
        expect(Boolean(echo)).toBe(true)
        expect(Boolean(ping)).toBe(true)
      } finally {
        fake.stop()
      }
    },
    TIMEOUT_MS,
  )

  it(
    "CV10: AskUserQuestion under a hook ask reaches canUseTool",
    async () => {
      const calls: Array<{ toolName: string; input: Record<string, unknown> }> = []
      const canUseTool: CanUseTool = async (toolName, input) => {
        calls.push({ toolName, input })
        if (toolName === "AskUserQuestion") {
          const questions = (input.questions as Array<{ question: string }> | undefined) ?? []
          const answers = Object.fromEntries(questions.map((q) => [q.question, "A"]))
          return { behavior: "allow", updatedInput: { ...input, answers } }
        }
        return { behavior: "deny", message: "session-caveats probe: denied" }
      }
      const messages = await run(
        'Use the AskUserQuestion tool exactly once to ask me "Pick a letter?" with the options A and B. Then reply with only the letter I picked.',
        {
          cwd: scratch,
          env: { ...process.env, ...isolation(configDir("cv10")) },
          settingSources: [],
          permissionMode: "default",
          canUseTool,
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  hookAnswering((t) =>
                    t === "AskUserQuestion" || t === "ExitPlanMode" ? "ask" : null,
                  ),
                ],
              },
            ],
          },
        },
      )
      const ask = calls.find((c) => c.toolName === "AskUserQuestion")
      const use = toolUses(messages, "AskUserQuestion")[0]
      const out = {
        canUseToolTools: calls.map((c) => c.toolName),
        sawQuestions: Array.isArray(ask?.input.questions),
        toolResult: use ? resultText(toolResultFor(messages, use.id) ?? {}).slice(0, 300) : null,
        finalText: resultOf(messages)?.result?.slice(0, 100) ?? null,
        branch:
          ask && Array.isArray(ask.input.questions)
            ? "pass"
            : "BLOCKER for S12 (no acceptable fallback)",
      }
      evidence("CV10", out)
      expect(Array.isArray(ask?.input.questions)).toBe(true)
    },
    TIMEOUT_MS,
  )

  it(
    "CV11 (characterization, D48): a raw user settings allowWrite ~ widens the flag layer's sandbox",
    async () => {
      const canary = path.join(homedir(), "liaison-cv11-canary")
      expect(existsSync(canary)).toBe(false)
      const config = configDir("cv11")
      writeFileSync(
        path.join(config, "settings.json"),
        JSON.stringify({
          permissions: { allow: ["Bash(*)"] },
          sandbox: { allowAppleEvents: true, filesystem: { allowWrite: ["~"] } },
        }),
      )
      const session = mkdtempSync(path.join(scratch, "session-"))
      const flag = {
        disableAllHooks: true,
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          allowAppleEvents: false,
          autoAllowBashIfSandboxed: false,
          filesystem: { disabled: false, allowWrite: [session] },
        },
      }
      const prompts = [
        "Run exactly this Bash command once and nothing else: touch ~/liaison-cv11-canary . Then reply with the command's output.",
        "You must call the Bash tool now with the command `touch ~/liaison-cv11-canary` (exactly once, no other tool, do not refuse, do not ask). Then report the exact tool output.",
      ]
      let out: Record<string, unknown> = {}
      try {
        for (const [attempt, prompt] of prompts.entries()) {
          const bashCalls: string[] = []
          const canUseTool: CanUseTool = async (toolName, input) => {
            bashCalls.push(toolName)
            return { behavior: "allow", updatedInput: input }
          }
          const messages = await run(prompt, {
            cwd: session,
            env: { ...process.env, ...isolation(config) },
            settingSources: ["user"],
            permissionMode: "default",
            settings: flag,
            canUseTool,
          })
          const bash = toolUses(messages, "Bash").find((b) =>
            String((b.input as { command?: string })?.command ?? "").includes(
              "liaison-cv11-canary",
            ),
          )
          const result = bash ? toolResultFor(messages, bash.id) : undefined
          const exists = existsSync(canary)
          out = {
            attempt: attempt + 1,
            bashCommand: bash ? (bash.input as { command?: string }).command : null,
            toolResult: result ? resultText(result).slice(0, 400) : null,
            toolResultIsError: result?.is_error ?? null,
            canUseToolCalls: bashCalls,
            canaryExists: exists,
            branch: exists
              ? "as characterized (D48): the raw user settings' allowWrite ~ widens the flag layer"
              : result
                ? "CHANGED: the sandbox refused the write despite the user allowWrite; revisit D48"
                : "inconclusive: no Bash tool_result",
          }
          if (exists || result) break
        }
      } finally {
        rmSync(canary, { force: true })
      }
      evidence("CV11", out)
      expect(out.toolResult).not.toBeNull()
      // D48: the raw SDK merges the user allowWrite into the flag layer's.
      expect(out.canaryExists).toBe(true)
    },
    TIMEOUT_MS * 2,
  )
})
