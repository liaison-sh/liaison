// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A LOCAL SESSION OUTLIVES ITS 15 MINUTE MCP TOKEN (2026-09-23). A session
// spawned at 19:13 ran its first turn at 19:45 and every Liaison call was a
// 401, because the token was a static header checked only at spawn. These
// tests move a fake server's clock past the token's life and prove the next
// call still authenticates, through each path a call takes: the CLI's headers
// helper (this binary in `--print-mcp-headers` mode), the host's relay, and
// the keeper that tells the shell when a renewal is refused.
import { afterEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NODE_TURN_CREDENTIAL_HEADER } from "../../../packages/shared/src/node-session-protocol"
import { type FakeLiaison, fakeJwt, startFakeLiaison } from "./fake-liaison-mcp"
import { MCP_TOKEN_REFUSED, runMain } from "./index"
import { relayFor } from "./mcp-relay"
import {
  freshToken,
  HEADERS_HELPER_FLAG,
  headersHelperCommand,
  jwtExpiryMs,
  printMcpHeaders,
  RefreshRefused,
  readTokenState,
  readTurnCredential,
  shellQuote,
  startTokenKeeper,
  turnCredentialPath,
  writeTurnCredential,
} from "./mcp-token"
import { liaisonMcpServer, turnOptions } from "./sdk-runner"

const FIFTEEN_MINUTES = 15 * 60_000

let fake: FakeLiaison | null = null
afterEach(() => {
  fake?.stop()
  fake = null
})

/** The config file the shell writes (`sidecar.rs` `write_mcp_config_at`). */
function writeConfig(server: FakeLiaison, fields: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sidecar-mcp-token-"))
  const file = path.join(dir, "liaison-mcp-config.json")
  const token = server.mint()
  writeFileSync(
    file,
    JSON.stringify({
      liaisonMcpUrl: server.mcpUrl,
      agentScopedToken: token,
      tokenExpiresAtMs: jwtExpiryMs(token),
      refreshToken: server.refreshToken,
      tokenUrl: server.tokenUrl,
      agentDefinition: "",
      ...fields,
    }),
    { mode: 0o600 },
  )
  return file
}

/** One `tools/call` straight at the fake gateway with the headers the helper printed. */
async function callWith(server: FakeLiaison, headers: Record<string, string>): Promise<number> {
  const response = await fetch(server.mcpUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "liaison_ping", arguments: {} },
    }),
  })
  return response.status
}

describe("the CLI's headers helper", () => {
  it("hands the next call a token that authenticates after the spawn token expired", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const config = writeConfig(fake)
    const spawnToken = readTokenState(config).token
    expect(await callWith(fake, { Authorization: `Bearer ${spawnToken}` })).toBe(200)

    // Thirty-two minutes later, as on 2026-09-23.
    fake.advance(32 * 60_000)
    expect(await callWith(fake, { Authorization: `Bearer ${spawnToken}` })).toBe(401)

    // The CLI re-runs the helper after that 401; what it prints must work.
    let printed = ""
    const exit = await printMcpHeaders([HEADERS_HELPER_FLAG, "--mcp-config", config], {
      out: (line) => {
        printed += line
      },
      err: () => {},
      now: () => fake?.now() ?? 0,
    })
    expect(exit).toBe(0)
    const headers = JSON.parse(printed) as Record<string, string>
    expect(Object.keys(headers)).toEqual(["Authorization"])
    expect(headers.Authorization).not.toBe(`Bearer ${spawnToken}`)
    expect(await callWith(fake, headers)).toBe(200)
    // And the renewed token is written back, owner only, for the next reader.
    expect(readTokenState(config).token).toBe(headers.Authorization?.slice(7))
    expect(statSync(config).mode & 0o777).toBe(0o600)
  })

  it("runs as this very program, from the shell the CLI uses, with the config path quoted", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    // A folder with a space in it, like `Application Support`.
    const dir = mkdtempSync(path.join(tmpdir(), "sidecar helper "))
    const config = path.join(dir, "liaison-mcp-config.json")
    writeFileSync(config, readFileSync(writeConfig(fake)))
    const command = headersHelperCommand(
      config,
      process.execPath,
      path.join(import.meta.dir, "index.ts"),
    )
    // The CLI runs it with `shell: true`: /bin/sh -c on macOS and Linux.
    const child = Bun.spawnSync(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" })
    expect(child.stderr.toString()).toBe("")
    expect(child.exitCode).toBe(0)
    const headers = JSON.parse(child.stdout.toString()) as Record<string, string>
    expect(await callWith(fake, headers)).toBe(200)
    expect(fake.renewals).toBe(1)
  }, 30_000)

  it("fails without printing the token when the renewal is refused", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const config = writeConfig(fake)
    const token = readTokenState(config).token
    fake.revoke()
    let out = ""
    let err = ""
    const exit = await printMcpHeaders([HEADERS_HELPER_FLAG, "--mcp-config", config], {
      out: (line) => {
        out += line
      },
      err: (line) => {
        err += line
      },
    })
    expect(exit).toBe(1)
    expect(out).toBe("")
    expect(err).toContain("refused")
    expect(err).not.toContain(token)
    expect(err).not.toContain(fake.refreshToken)
    // The refusal is marked for the keeper to report.
    expect(readTokenState(config).refusedAtMs).not.toBeNull()
  })

  it("keeps the stored token through a network blip while it is still alive", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const config = writeConfig(fake, { tokenUrl: "http://127.0.0.1:9/mcp/oauth/token" })
    const token = readTokenState(config).token
    expect(await freshToken(config, { force: true, now: () => fake?.now() ?? 0 })).toBe(token)
  })
})

describe("the host's relay", () => {
  it("renews and retries once when the gateway answers 401 mid session", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const server = fake
    const config = writeConfig(server)
    const mcp = {
      liaisonMcpUrl: server.mcpUrl,
      agentScopedToken: readTokenState(config).token,
      agentDefinition: "",
    }
    const relay = relayFor(mcp, (force) => freshToken(config, { force, now: () => server.now() }))
    expect((await relay("liaison_ping", {})).error).toBeUndefined()
    server.advance(20 * 60_000)
    const outcome = await relay("liaison_ping", {})
    expect(outcome.error).toBeUndefined()
    expect(server.calls.map((call) => call.accepted)).toEqual([true, true])
  })

  it("renews after a 401 even when this machine's clock says the token is alive", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const server = fake
    const config = writeConfig(server)
    const mcp = {
      liaisonMcpUrl: server.mcpUrl,
      agentScopedToken: readTokenState(config).token,
      agentDefinition: "",
    }
    // The local clock lags the server's by twenty minutes (a laptop that slept).
    const lagging = () => server.now() - 20 * 60_000
    const relay = relayFor(mcp, (force) => freshToken(config, { force, now: lagging }))
    server.advance(20 * 60_000)
    const outcome = await relay("liaison_ping", {})
    expect(outcome.error).toBeUndefined()
    expect(server.calls.map((call) => call.accepted)).toEqual([false, true])
    expect(server.renewals).toBe(1)
  })

  it("was the spawn token for the whole session before, and died with it", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const config = writeConfig(fake)
    const relay = relayFor({
      liaisonMcpUrl: fake.mcpUrl,
      agentScopedToken: readTokenState(config).token,
      agentDefinition: "",
    })
    fake.advance(20 * 60_000)
    expect((await relay("liaison_ping", {})).error?.status).toBe(401)
  })
})

describe("the keeper", () => {
  it("renews ahead of expiry so the file is fresh before anyone asks", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const server = fake
    const config = writeConfig(server)
    const before = readTokenState(config).token
    const keeper = startTokenKeeper({
      configPath: config,
      onRefused: () => {},
      intervalMs: 60_000,
      now: () => server.now(),
    })
    await keeper.tick()
    expect(readTokenState(config).token).toBe(before)
    server.advance(11 * 60_000)
    await keeper.tick()
    keeper.stop()
    expect(readTokenState(config).token).not.toBe(before)
    expect(server.renewals).toBe(1)
  })

  it("reports a refused renewal once, whoever met it", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const server = fake
    const config = writeConfig(server)
    server.revoke()
    let reported = 0
    const keeper = startTokenKeeper({
      configPath: config,
      onRefused: () => {
        reported += 1
      },
      intervalMs: 60_000,
      now: () => server.now(),
    })
    // Met first by the helper the CLI ran, which only marks the file.
    await expect(freshToken(config, { force: true })).rejects.toBeInstanceOf(RefreshRefused)
    await keeper.tick()
    await keeper.tick()
    keeper.stop()
    expect(reported).toBe(1)
  })

  it("puts the refusal on the sidecar's stdout for the shell, with no token in it", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const server = fake
    const config = writeConfig(server)
    const token = readTokenState(config).token
    server.revoke()
    server.advance(FIFTEEN_MINUTES)
    const lines: string[] = []
    const control = (async function* () {
      yield JSON.stringify({ type: "turn", prompt: "hi" })
      // Let the keeper's look at the token finish before the session ends.
      await new Promise((resolve) => setTimeout(resolve, 200))
      yield JSON.stringify({ type: "shutdown" })
    })()
    await runMain({
      config: {
        mcpConfigPath: config,
        cwd: ".",
        permissionMode: "manual",
        model: "claude-haiku-4-5",
        isolateConfig: false,
      },
      write: (line) => {
        lines.push(line)
      },
      control,
      tokenKeeper: (onRefused) =>
        startTokenKeeper({ configPath: config, onRefused, now: () => server.now() }),
      runner: ({ prompts }) =>
        (async function* () {
          for await (const _ of prompts) yield { type: "result" }
        })(),
    })
    const refused = lines.filter((line) => JSON.parse(line).type === MCP_TOKEN_REFUSED)
    expect(refused).toHaveLength(1)
    expect(lines.join("")).not.toContain(token)
    expect(lines.join("")).not.toContain(server.refreshToken)
  })
})

describe("what the CLI is told about the Liaison server", () => {
  const config = {
    mcpConfigPath: "/tmp/liaison-mcp-config.json",
    cwd: "/tmp",
    permissionMode: "manual" as const,
    model: "claude-haiku-4-5",
    isolateConfig: false,
  }
  const mcp = {
    liaisonMcpUrl: "http://box/mcp",
    agentScopedToken: fakeJwt(1, "x"),
    agentDefinition: "",
  }

  it("carries a headers helper and no static token", () => {
    const liaison = turnOptions(config, mcp).mcpServers?.liaison as Record<string, unknown>
    expect(liaison.headers).toBeUndefined()
    expect(JSON.stringify(liaison)).not.toContain(mcp.agentScopedToken)
    expect(String(liaison.headersHelper)).toContain(HEADERS_HELPER_FLAG)
    expect(String(liaison.headersHelper)).toContain("'/tmp/liaison-mcp-config.json'")
  })

  it("names the compiled binary alone, and bun plus the script when run from source", () => {
    expect(
      headersHelperCommand("/a b/c.json", "/Apps/Liaison.app/liaison-sidecar", null, "darwin"),
    ).toBe(`'/Apps/Liaison.app/liaison-sidecar' ${HEADERS_HELPER_FLAG} --mcp-config '/a b/c.json'`)
    expect(headersHelperCommand("/c.json", "/usr/bin/bun", "/src/index.ts", "linux")).toBe(
      `'/usr/bin/bun' '/src/index.ts' ${HEADERS_HELPER_FLAG} --mcp-config '/c.json'`,
    )
    expect(liaisonMcpServer(mcp, "/c.json", "helper").headersHelper).toBe("helper")
  })

  it("quotes for the shell the CLI runs the helper in", () => {
    expect(shellQuote("it's", "darwin")).toBe(`'it'\\''s'`)
    expect(shellQuote(`C:\\Program Files\\Liaison\\a"b.exe`, "win32")).toBe(
      `"C:\\Program Files\\Liaison\\a""b.exe"`,
    )
  })
})

describe("the turn credential the helper presents (S59, D36)", () => {
  const CREDENTIAL = `${"A".repeat(21)}_-${"b".repeat(20)}`

  async function headersFor(config: string, now: () => number): Promise<Record<string, string>> {
    let printed = ""
    const exit = await printMcpHeaders([HEADERS_HELPER_FLAG, "--mcp-config", config], {
      out: (line) => {
        printed += line
      },
      err: () => {},
      now,
    })
    expect(exit).toBe(0)
    return JSON.parse(printed) as Record<string, string>
  }

  it("S59: the helper prints x-liaison-turn when the turn file is fresh, nothing when absent or stale", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const config = writeConfig(fake)
    const server = fake

    // Absent: the agent's own header only, exactly as before.
    expect(Object.keys(await headersFor(config, () => server.now()))).toEqual(["Authorization"])

    // Fresh: the turn's credential rides beside it, under the shared header name.
    writeTurnCredential(config, CREDENTIAL)
    expect(turnCredentialPath(config)).toBe(`${config}.turn`)
    expect(statSync(turnCredentialPath(config)).mode & 0o777).toBe(0o600)
    const fresh = await headersFor(config, () => Date.now())
    expect(fresh[NODE_TURN_CREDENTIAL_HEADER]).toBe(CREDENTIAL)
    expect(await callWith(server, fresh)).toBe(200)

    // Stale: older than the server's 30 minutes, it is not presented at all.
    const stale = await headersFor(config, () => Date.now() + 31 * 60_000)
    expect(Object.keys(stale)).toEqual(["Authorization"])

    // Cleared by the next turn line without one: gone from the disk and the header.
    writeTurnCredential(config, null)
    expect(existsSync(turnCredentialPath(config))).toBe(false)
    expect(Object.keys(await headersFor(config, () => Date.now()))).toEqual(["Authorization"])
  })

  it("S59: a turn file that is not a credential is never presented", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const config = writeConfig(fake)
    writeFileSync(turnCredentialPath(config), "not a credential\nx-other: 1", { mode: 0o600 })
    expect(Object.keys(await headersFor(config, () => Date.now()))).toEqual(["Authorization"])
  })

  it("S59: a turn file that is a symlink is never followed, even to a credential", async () => {
    fake = startFakeLiaison({ ttlMs: FIFTEEN_MINUTES })
    const config = writeConfig(fake)
    const elsewhere = `${config}.elsewhere`
    writeFileSync(elsewhere, CREDENTIAL, { mode: 0o600 })
    symlinkSync(elsewhere, turnCredentialPath(config))
    expect(readTurnCredential(config, Date.now())).toBeNull()
    expect(Object.keys(await headersFor(config, () => Date.now()))).toEqual(["Authorization"])
  })
})
