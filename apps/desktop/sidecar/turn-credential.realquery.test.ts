// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REAL QUERIES: the desktop's local turn presents ITS OWN credential (P2-T11;
// S59, D36, OPEN-4). A local session keeps one SDK query for many turns, and
// the CLI runs the Liaison server's `headersHelper` only when it connects (and
// after a 401), so a header that has to change per turn needs the connection
// made again between turns. Measured on both CLIs (the SDK's bundled binary
// and this computer's installed one), claude-haiku-5-5: the sidecar's own
// `runMain` reads two turn lines, each with its credential, writes the turn
// file, reconnects the `liaison` server and only then hands the prompt over;
// the CLI runs the real helper (`--print-mcp-headers`), and a fake Liaison
// gateway records the `x-liaison-turn` header of every tool call. Each turn's
// calls must carry that turn's credential, never the previous one's.
//
// Skipped unless macOS with the CLI signed in. Evidence goes to stderr.
import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import { startFakeLiaison } from "./fake-liaison-mcp"
import { runMain, type SessionRunner, type SidecarConfig } from "./index"
import { headersHelperCommand, jwtExpiryMs } from "./mcp-token"

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
/** This computer's installed Claude Code: the `claude` on PATH, followed to its real file. */
function installedClaude(): string | null {
  const onPath = process.env.LIAISON_RQ_INSTALLED_CLAUDE ?? Bun.which("claude")
  return onPath && existsSync(onPath) ? realpathSync(onPath) : null
}
const INSTALLED = installedClaude()

const READY = signedIn() && INSTALLED !== null
if (!READY) {
  process.stderr.write(
    "turn-credential.realquery: SKIPPED - not macOS, no installed Claude CLI, or it is not signed in\n",
  )
}
const MODEL = "claude-haiku-5-5"
const RUN_MS = 240_000
const tmpBase = READY ? realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-turncred-rq-"))) : ""
afterAll(() => {
  if (READY) rmSync(tmpBase, { recursive: true, force: true })
})

function versionOf(binary: string): string | null {
  const r = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
  return /(\d+\.\d+\.\d+)/.exec(r.stdout.toString())?.[1] ?? null
}

function cliEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE") env[k] = v
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }
}

const credential = (fill: string) => `${fill.repeat(40)}_-9`
const PROMPT =
  "Call the liaison_ping tool of the liaison MCP server (mcp__liaison__liaison_ping) " +
  "exactly once (load it with ToolSearch if you need to), then reply with the single word it returned."

describe.if(READY)("the local turn's credential reaches the gateway (S59, OPEN-4)", () => {
  for (const [label, binary] of [
    ["bundled", BUNDLED],
    ["installed", INSTALLED ?? ""],
  ] as const) {
    it(
      `S59: a reconnect between two turns makes the helper's new header reach the gateway (${label} CLI)`,
      async () => {
        const fake = startFakeLiaison({ ttlMs: 15 * 60_000 })
        const dir = mkdtempSync(path.join(tmpBase, `${label}-`))
        const configDir = mkdtempSync(path.join(tmpBase, `${label}-config-`))
        const mcpConfigPath = path.join(dir, "liaison-mcp-config.json")
        const spawnToken = fake.mint()
        writeFileSync(
          mcpConfigPath,
          JSON.stringify({
            liaisonMcpUrl: fake.mcpUrl,
            agentScopedToken: spawnToken,
            tokenExpiresAtMs: jwtExpiryMs(spawnToken),
            refreshToken: fake.refreshToken,
            tokenUrl: fake.tokenUrl,
            agentDefinition: "",
          }),
          { mode: 0o600 },
        )
        const config: SidecarConfig = {
          mcpConfigPath,
          cwd: dir,
          permissionMode: "bypass",
          model: MODEL,
          isolateConfig: false,
        }
        // The real helper, run from source exactly as the CLI runs it.
        const helper = headersHelperCommand(
          mcpConfigPath,
          process.execPath,
          path.join(import.meta.dir, "index.ts"),
        )
        const runner: SessionRunner = ({ prompts }) =>
          sdkQuery({
            prompt: prompts as AsyncIterable<SDKUserMessage>,
            options: {
              cwd: dir,
              model: MODEL,
              pathToClaudeCodeExecutable: binary,
              env: cliEnv(configDir),
              settingSources: [],
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              mcpServers: {
                liaison: { type: "http", url: fake.mcpUrl, headersHelper: helper } as never,
              },
            },
          })

        const turnDone: Array<() => void> = []
        const write = (line: string) => {
          for (const one of line.split("\n")) {
            if (!one.trim()) continue
            try {
              if ((JSON.parse(one) as { type?: string }).type === "turn_done") turnDone.shift()?.()
            } catch {
              // Not a protocol line.
            }
          }
        }
        const callsPerTurn: number[] = []
        async function* control() {
          for (const fill of ["A", "B"]) {
            const done = new Promise<void>((resolve) => turnDone.push(resolve))
            yield JSON.stringify({ type: "turn", prompt: PROMPT, turnCredential: credential(fill) })
            await done
            callsPerTurn.push(fake.calls.length)
          }
          yield JSON.stringify({ type: "shutdown" })
        }
        try {
          const exit = await runMain({ config, runner, write, control: control() })
          const first = fake.calls.slice(0, callsPerTurn[0])
          const second = fake.calls.slice(callsPerTurn[0], callsPerTurn[1])
          process.stderr.write(
            `[turn-credential.realquery] ${label} ${versionOf(binary)} exit=${exit} ` +
              `turn1=${JSON.stringify(first.map((c) => [c.tool, c.turn?.slice(0, 2) ?? null]))} ` +
              `turn2=${JSON.stringify(second.map((c) => [c.tool, c.turn?.slice(0, 2) ?? null]))}\n`,
          )
          expect(first.length).toBeGreaterThan(0)
          expect(second.length).toBeGreaterThan(0)
          expect(first.map((c) => c.turn)).toEqual(first.map(() => credential("A")))
          expect(second.map((c) => c.turn)).toEqual(second.map(() => credential("B")))
          expect(fake.calls.every((c) => c.accepted)).toBe(true)
          // The turn file does not outlive the session.
          expect(existsSync(`${mcpConfigPath}.turn`)).toBe(false)
        } finally {
          fake.stop()
        }
      },
      RUN_MS,
    )
  }
})
