// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The in-app Claude sign-in's sidecar half (claude-auth.ts), against a stand-in
// CLI: what it reads out of the CLI's output, what it writes to it, how every
// way a login can end is reported, and that no pasted code ever comes back out.

import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AuthChild,
  type AuthSpawn,
  BROWSER_SINK_ENV,
  claudeAuthMain,
  claudeAuthMode,
  extractSignInUrl,
  failureDetail,
  isBrowserSinkCall,
  isClaudeSignInUrl,
  LOGIN_TIMEOUT_MS,
  parseAuthStatus,
  REDACTED,
  readAuthStatus,
  redact,
  runBrowserSink,
  runLogin,
  runWatchdog,
  selfCommand,
  startWatchdog,
  WATCHDOG_CEILING_MS,
  WATCHDOG_FLAG,
  watchdogArgv,
  watchdogStep,
  watchdogTarget,
} from "./claude-auth"
import { AsyncQueue } from "./index"

const MANUAL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code" +
  "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&code_challenge=CHALLENGEVALUE&code_challenge_method=S256&state=STATEVALUE"
const AUTOMATIC = MANUAL.replace(
  "https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
  "http%3A%2F%2Flocalhost%3A51234%2Fcallback",
)
/** What `claude auth login --claudeai` prints with no terminal, verbatim. */
const LOGIN_BANNER =
  "Opening browser to sign in…\n" +
  `If the browser didn't open, visit: ${MANUAL}\n` +
  "Paste code here if prompted > "

/** A stand-in CLI child the test drives by hand. */
class FakeChild implements AuthChild {
  readonly pid = null
  readonly out = new AsyncQueue<string>()
  readonly err = new AsyncQueue<string>()
  readonly written: string[] = []
  killed = false
  private settle: (code: number | null) => void = () => undefined
  readonly exited = new Promise<number | null>((resolve) => {
    this.settle = resolve
  })
  get stdout() {
    return this.out
  }
  get stderr() {
    return this.err
  }
  write(text: string) {
    this.written.push(text)
  }
  kill() {
    this.killed = true
    this.exit(null)
  }
  exit(code: number | null) {
    this.out.close()
    this.err.close()
    this.settle(code)
  }
}

function spawnOf(...children: FakeChild[]): {
  spawn: AuthSpawn
  calls: Array<{ argv: string[]; env: Record<string, string | undefined> }>
} {
  const calls: Array<{ argv: string[]; env: Record<string, string | undefined> }> = []
  const queue = [...children]
  return {
    calls,
    spawn: (argv, env) => {
      calls.push({ argv, env })
      const next = queue.shift()
      if (!next) throw new Error(`unexpected spawn: ${argv.join(" ")}`)
      return next
    },
  }
}

/** Whether a pid is signalable, for the end to end tests' own waiting. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held")
    await tick()
  }
}

const SIGNED_IN = {
  loggedIn: true,
  email: "someone@example.com",
  authMethod: "claude.ai",
  orgName: "Example",
}

describe("claude auth status", () => {
  it("reads the four fields out of the CLI's pretty printed JSON and drops the rest", () => {
    const printed = `{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "apiProvider": "firstParty",\n  "email": "someone@example.com",\n  "orgName": "Example",\n  "configDirectory": "/Users/someone/.claude"\n}\n`
    expect(parseAuthStatus(printed)).toEqual(SIGNED_IN)
  })

  it("reads a signed out answer, which the CLI prints with exit code 1", async () => {
    const child = new FakeChild()
    const { spawn, calls } = spawnOf(child)
    const answer = readAuthStatus({ cli: "/cli", spawn })
    child.out.push('{\n  "loggedIn": false,\n  "authMethod": "none"\n}\n')
    child.exit(1)
    expect(await answer).toEqual({
      loggedIn: false,
      email: null,
      authMethod: "none",
      orgName: null,
    })
    expect(calls[0]?.argv).toEqual(["/cli", "auth", "status", "--json"])
  })

  it("answers null for anything that is not the status JSON", () => {
    expect(parseAuthStatus("")).toBeNull()
    expect(parseAuthStatus("Not logged in. Run claude auth login to authenticate.")).toBeNull()
    expect(parseAuthStatus('{"authMethod":"none"}')).toBeNull()
  })

  it("gives up on a CLI that never answers, and kills it", async () => {
    const child = new FakeChild()
    const { spawn } = spawnOf(child)
    expect(await readAuthStatus({ cli: "/cli", spawn, timeoutMs: 20 })).toBeNull()
    expect(child.killed).toBe(true)
  })
})

describe("the sign-in URL", () => {
  it("is taken out of the login banner once it is whole", () => {
    expect(extractSignInUrl(LOGIN_BANNER)).toBe(MANUAL)
    // A chunk that ends inside the URL is not a URL yet.
    expect(extractSignInUrl(LOGIN_BANNER.slice(0, LOGIN_BANNER.indexOf("state=") + 8))).toBeNull()
  })

  it("survives a terminal hyperlink wrapped around it", () => {
    const wrapped = `visit: \u001b]8;;${MANUAL}\u0007${MANUAL}\u001b]8;;\u0007\n`
    expect(extractSignInUrl(wrapped)).toBe(MANUAL)
  })

  it("is only ever one of Claude's own https pages", () => {
    expect(isClaudeSignInUrl(MANUAL)).toBe(true)
    expect(isClaudeSignInUrl("https://platform.claude.com/oauth/code/callback")).toBe(true)
    expect(isClaudeSignInUrl("http://claude.com/cai/oauth/authorize")).toBe(false)
    expect(isClaudeSignInUrl("https://claude.com.evil.example/authorize")).toBe(false)
    expect(isClaudeSignInUrl("https://evilclaude.com/authorize")).toBe(false)
    expect(isClaudeSignInUrl("https://user:pw@claude.com/")).toBe(false)
    expect(extractSignInUrl("visit: https://evil.example/login\n")).toBeNull()
  })
})

describe("redaction", () => {
  it("strikes the pasted code, both of its halves, a URL's state and anything token shaped", () => {
    const line = redact(
      "Login failed: code abcd1234#efgh5678 rejected for ?state=STATEVALUE with sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ["abcd1234#efgh5678"],
    )
    expect(line).not.toContain("abcd1234")
    expect(line).not.toContain("efgh5678")
    expect(line).not.toContain("STATEVALUE")
    expect(line).not.toContain("AAAAAAAAAAAAAAAA")
    expect(line).toContain(REDACTED)
  })

  it("a failure says the CLI's own Login failed line, redacted", () => {
    const stderr =
      "Invalid code. Please make sure the full code was copied.\nLogin failed: Request failed with status code 400\n"
    expect(failureDetail(stderr)).toBe("Login failed: Request failed with status code 400")
    expect(failureDetail("Login failed: bad secret-code#xyz9\n", ["secret-code#xyz9"])).toBe(
      `Login failed: bad ${REDACTED}`,
    )
    expect(failureDetail("")).toBeNull()
  })
})

describe("claude auth login", () => {
  let sink: string | null = null
  afterEach(() => {
    if (sink) rmSync(sink, { recursive: true, force: true })
    sink = null
  })

  function login(child: FakeChild, extra: Partial<Parameters<typeof runLogin>[0]> = {}) {
    const events: Array<Record<string, unknown>> = []
    const control = new AsyncQueue<string>()
    const { spawn, calls } = spawnOf(child)
    const done = runLogin({
      cli: "/cli",
      spawn,
      env: { HOME: "/home/someone" },
      emit: (event) => events.push(event),
      control,
      sinkWaitMs: 30,
      status: async () => SIGNED_IN,
      ...extra,
    })
    return { events, control, calls, done }
  }

  it("runs the CLI's own login and sends the printed URL on as soon as it is printed", async () => {
    const child = new FakeChild()
    const { events, calls, done } = login(child)
    child.out.push(LOGIN_BANNER.slice(0, 40))
    await tick()
    expect(events).toEqual([])
    child.out.push(LOGIN_BANNER.slice(40))
    await until(() => events.length > 0)
    expect(calls[0]?.argv).toEqual(["/cli", "auth", "login", "--claudeai"])
    expect(events[0]).toEqual({ type: "claude_auth_url", url: MANUAL, manualUrl: MANUAL })
    child.exit(0)
    expect(await done).toBe(0)
    expect(events.at(-1)).toEqual({ type: "claude_auth_done", ok: true, account: SIGNED_IN })
  })

  it("hands the CLI this binary as its browser and sends the page it would have opened", async () => {
    const child = new FakeChild()
    const { events, calls, done } = login(child, {
      browserCommand: "/Applications/Liaison.app/Contents/MacOS/liaison-sidecar",
    })
    await until(() => calls.length === 1)
    const env = calls[0]?.env ?? {}
    expect(env.BROWSER).toBe("/Applications/Liaison.app/Contents/MacOS/liaison-sidecar")
    const sinkPath = env[BROWSER_SINK_ENV] as string
    sink = join(sinkPath, "..")
    // The CLI runs its "browser": this binary, in sink mode.
    expect(isBrowserSinkCall([AUTOMATIC], env)).toBe(true)
    expect(runBrowserSink([AUTOMATIC], env)).toBe(0)
    child.out.push(LOGIN_BANNER)
    child.out.push("\n")
    await until(() => events.length > 0)
    expect(events[0]).toEqual({ type: "claude_auth_url", url: AUTOMATIC, manualUrl: MANUAL })
    child.exit(0)
    await done
    // The private file is gone with the login.
    expect(existsSync(sinkPath)).toBe(false)
    sink = null
  })

  it("the sink writes nothing that is not a Claude page", () => {
    sink = mkdtempSync(join(tmpdir(), "claude-auth-test-"))
    const env = { [BROWSER_SINK_ENV]: join(sink, "url") }
    expect(runBrowserSink(["https://evil.example/steal"], env)).toBe(1)
    expect(existsSync(join(sink, "url"))).toBe(false)
    expect(runBrowserSink([AUTOMATIC], env)).toBe(0)
    expect(readFileSync(join(sink, "url"), "utf8")).toBe(`${AUTOMATIC}\n`)
    // A session's arguments are never taken for a browser call.
    expect(isBrowserSinkCall(["--mcp-config", "x"], env)).toBe(false)
    expect(isBrowserSinkCall([AUTOMATIC], {})).toBe(false)
  })

  it("writes a pasted code to the CLI's stdin, one line, and never sends it back out", async () => {
    const child = new FakeChild()
    const { events, control, done } = login(child)
    child.out.push(LOGIN_BANNER)
    child.out.push("\n")
    await until(() => events.length > 0)
    control.push(JSON.stringify({ type: "code", code: "  abcd1234#efgh5678\n" }))
    await until(() => child.written.length > 0)
    expect(child.written).toEqual(["abcd1234#efgh5678\n"])
    // The CLI refuses half a code and keeps waiting: the window is told.
    child.err.push("Invalid code. Please make sure the full code was copied.\n")
    await until(() => events.some((event) => event.type === "claude_auth_code_rejected"))
    child.err.push("Login failed: code abcd1234#efgh5678 was refused\n")
    child.exit(1)
    expect(await done).toBe(1)
    const last = events.at(-1) as Record<string, unknown>
    expect(last.type).toBe("claude_auth_done")
    expect(last.ok).toBe(false)
    expect(last.reason).toBe("failed")
    expect(JSON.stringify(events)).not.toContain("abcd1234")
    expect(JSON.stringify(events)).not.toContain("efgh5678")
  })

  it("a cancel kills the CLI and says cancelled", async () => {
    const child = new FakeChild()
    const { events, control, done } = login(child)
    child.out.push(LOGIN_BANNER)
    child.out.push("\n")
    await until(() => events.length > 0)
    control.push(JSON.stringify({ type: "cancel" }))
    expect(await done).toBe(1)
    expect(child.killed).toBe(true)
    expect(events.at(-1)).toEqual({ type: "claude_auth_done", ok: false, reason: "cancelled" })
  })

  it("the shell going away is a cancel too", async () => {
    const child = new FakeChild()
    const { events, control, done } = login(child)
    control.close()
    expect(await done).toBe(1)
    expect(child.killed).toBe(true)
    expect(events.at(-1)).toEqual({ type: "claude_auth_done", ok: false, reason: "cancelled" })
  })

  it("a sign-in nobody finishes times out, and the CLI is killed", async () => {
    const child = new FakeChild()
    const { events, done } = login(child, { timeoutMs: 30 })
    expect(await done).toBe(1)
    expect(child.killed).toBe(true)
    expect(events.at(-1)).toEqual({ type: "claude_auth_done", ok: false, reason: "timeout" })
  })
})

describe("the --claude-auth entry", () => {
  it("is recognised only with a known mode", () => {
    expect(claudeAuthMode(["--claude-auth", "login"])).toBe("login")
    expect(claudeAuthMode(["--claude-auth", "format-disk"])).toBeNull()
    expect(claudeAuthMode(["--mcp-config", "x"])).toBeNull()
  })

  it("status prints one line with the account", async () => {
    const child = new FakeChild()
    const { spawn } = spawnOf(child)
    const lines: string[] = []
    const done = claudeAuthMain(["--claude-auth", "status"], "/cli", {
      write: (line) => lines.push(line),
      spawn,
    })
    child.out.push(JSON.stringify(SIGNED_IN))
    child.exit(0)
    expect(await done).toBe(0)
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { type: "claude_auth_status", account: SIGNED_IN },
    ])
  })

  it("logout runs the CLI's logout and answers with the account after it", async () => {
    const logout = new FakeChild()
    const status = new FakeChild()
    const { spawn, calls } = spawnOf(logout, status)
    const lines: string[] = []
    const done = claudeAuthMain(["--claude-auth", "logout"], "/cli", {
      write: (line) => lines.push(line),
      spawn,
    })
    logout.exit(0)
    await until(() => calls.length === 2)
    status.out.push('{"loggedIn":false,"authMethod":"none"}')
    status.exit(1)
    expect(await done).toBe(0)
    expect(calls.map((call) => call.argv.slice(1).join(" "))).toEqual([
      "auth logout",
      "auth status --json",
    ])
    expect(JSON.parse(lines[0] as string)).toEqual({
      type: "claude_auth_logout",
      ok: true,
      account: { loggedIn: false, email: null, authMethod: "none", orgName: null },
    })
  })
})

// THE CLI NEVER OUTLIVES ITS SIGN-IN (review of 74b97cd63). `claude auth login`
// ignores its stdin closing, so a sidecar killed outright left it running,
// reparented to init, for as long as anyone cared to look. These run the real
// entry (`main`, through claude-auth.fixture.ts) over a stand-in CLI that, like
// the real one, sleeps through a closed stdin.
describe.skipIf(process.platform === "win32")("a sign-in whose sidecar goes away", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function signInRunning(): Promise<{
    sidecar: ReturnType<typeof Bun.spawn>
    cliPid: number
  }> {
    const dir = mkdtempSync(join(tmpdir(), "claude-auth-orphan-"))
    dirs.push(dir)
    const cli = join(dir, "claude")
    const pidFile = join(dir, "pid")
    writeFileSync(
      cli,
      `#!/bin/sh\necho $$ > "${pidFile}"\nprintf '%s\\n' "Opening browser to sign in" "If the browser didn't open, visit: ${MANUAL}"\nprintf 'Paste code here if prompted > '\nexec sleep 300\n`,
    )
    chmodSync(cli, 0o755)
    const sidecar = Bun.spawn(
      ["bun", join(import.meta.dir, "claude-auth.fixture.ts"), "--claude-auth", "login"],
      {
        env: { ...process.env, LIAISON_TEST_FAKE_CLI: cli },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    )
    const reader = (sidecar.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let printed = ""
    while (!printed.includes("claude_auth_url")) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`the sidecar ended first: ${printed}`)
      printed += decoder.decode(value)
    }
    reader.releaseLock()
    return { sidecar, cliPid: Number(readFileSync(pidFile, "utf8").trim()) }
  }

  async function goneWithin(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (processAlive(pid) && Date.now() < deadline) await tick(50)
    const gone = !processAlive(pid)
    if (!gone) process.kill(pid, "SIGKILL")
    return gone
  }

  it("a sidecar killed outright takes the CLI with it", async () => {
    const { sidecar, cliPid } = await signInRunning()
    expect(processAlive(cliPid)).toBe(true)
    sidecar.kill("SIGKILL")
    expect(await goneWithin(cliPid, 5_000)).toBe(true)
  }, 30_000)

  it("a shell that closes the sidecar's stdin ends the CLI too", async () => {
    const { sidecar, cliPid } = await signInRunning()
    ;(sidecar.stdin as { end(): void }).end()
    expect(await goneWithin(cliPid, 5_000)).toBe(true)
    expect(await sidecar.exited).toBe(1)
  }, 30_000)
})

describe("the watchdog", () => {
  /** A fake OS: pid to the identity of the process holding it, if any. */
  function world(initial: Record<number, string>) {
    const table = new Map(Object.entries(initial).map(([pid, id]) => [Number(pid), id]))
    const signals: string[] = []
    let clock = 0
    return {
      table,
      signals,
      advance: (ms: number) => {
        clock += ms
      },
      options: {
        intervalMs: 1,
        graceMs: 20,
        identity: (pid: number) => table.get(pid) ?? null,
        kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
          signals.push(`${pid}:${signal}:${table.get(pid) ?? "nobody"}`)
          if (table.get(pid) === "cli") table.delete(pid)
        },
        now: () => clock,
      },
    }
  }
  const TARGET = {
    parent: { pid: 1, identity: "sidecar" },
    child: { pid: 2, identity: "cli" },
    ceilingMs: 10_000,
  }

  // REVIEW OF 52fecfa8d: a bare pid was trusted.
  it("never signals a pid that now belongs to another process", async () => {
    const os = world({ 1: "sidecar", 2: "cli" })
    const done = runWatchdog(TARGET, os.options)
    await tick(5)
    // The CLI exits and Windows hands its pid to something else at once; then
    // the sidecar goes too. The stranger on pid 2 must not be touched.
    os.table.set(2, "unrelated")
    os.table.delete(1)
    expect(await done).toBe(0)
    expect(os.signals).toEqual([])
  })

  it("reads a sidecar whose pid was taken over as gone, and ends the CLI", async () => {
    const os = world({ 1: "sidecar", 2: "cli" })
    const done = runWatchdog(TARGET, os.options)
    await tick(5)
    expect(os.signals).toEqual([])
    os.table.set(1, "long-lived stranger")
    await done
    expect(os.signals).toEqual(["2:SIGTERM:cli"])
  })

  it("does not escalate to SIGKILL once the pid is no longer the CLI's", async () => {
    const os = world({ 2: "cli" })
    os.options.kill = (pid, signal) => {
      os.signals.push(`${pid}:${signal}`)
      // The CLI exits on SIGTERM and its pid is reused within the grace.
      os.table.set(2, "unrelated")
    }
    await runWatchdog(TARGET, os.options)
    expect(os.signals).toEqual(["2:SIGTERM"])
  })

  it("kills a CLI that ignores SIGTERM", async () => {
    const os = world({ 2: "cli" })
    os.options.kill = (pid, signal) => {
      os.signals.push(`${pid}:${signal}`)
      if (signal === "SIGKILL") os.table.delete(pid)
    }
    const done = runWatchdog(TARGET, { ...os.options, graceMs: 20, now: Date.now })
    await done
    expect(os.signals).toEqual(["2:SIGTERM", "2:SIGKILL"])
  })

  it("has a ceiling: past it the CLI is ended even with the sidecar alive", async () => {
    const os = world({ 1: "sidecar", 2: "cli" })
    const done = runWatchdog(TARGET, os.options)
    await tick(5)
    expect(os.signals).toEqual([])
    os.advance(TARGET.ceilingMs)
    await done
    expect(os.signals).toEqual(["2:SIGTERM:cli"])
    expect(WATCHDOG_CEILING_MS).toBeGreaterThan(LOGIN_TIMEOUT_MS)
  })

  it("decides each look from identities alone", () => {
    const look = (cliMatches: boolean, parentMatches: boolean, pastCeiling: boolean) =>
      watchdogStep({ cliMatches, parentMatches, pastCeiling })
    expect(look(true, true, false)).toBe("wait")
    expect(look(true, false, false)).toBe("end-cli")
    expect(look(true, true, true)).toBe("end-cli")
    expect(look(false, false, false)).toBe("exit")
    expect(look(false, true, true)).toBe("exit")
  })

  it("starts nothing when it cannot tell processes apart", async () => {
    expect(await runWatchdog(TARGET, { ...world({}).options, identity: undefined })).toBe(0)
    expect(startWatchdog(["/nonexistent"], 1, 2, () => null)).toBe(false)
    expect(startWatchdog(["/nonexistent"], 1, 2, null)).toBe(false)
  })

  it("is started with both identities and the ceiling, and only a well formed call is one", () => {
    const argv = watchdogArgv(TARGET)
    expect(argv[0]).toBe(WATCHDOG_FLAG)
    expect(watchdogTarget(argv)).toEqual(TARGET)
    expect(watchdogTarget([WATCHDOG_FLAG, "1", "sidecar", "2"])).toBeNull()
    expect(watchdogTarget([WATCHDOG_FLAG, "1", "sidecar", "x", "cli", "5"])).toBeNull()
    expect(watchdogTarget([WATCHDOG_FLAG, "1", "", "2", "cli", "5"])).toBeNull()
    expect(watchdogTarget(["--mcp-config", "1", "a", "2", "b", "5"])).toBeNull()
    expect(selfCommand("/$bunfs/root/liaison-sidecar", "/Applications/L.app/sidecar")).toEqual([
      "/Applications/L.app/sidecar",
    ])
    expect(selfCommand("/repo/sidecar/index.ts", "/usr/local/bin/bun")).toEqual([
      "/usr/local/bin/bun",
      "/repo/sidecar/index.ts",
    ])
  })

  it("a login starts one for the CLI it spawned", async () => {
    const child = Object.assign(new FakeChild(), { pid: 4242 }) as unknown as FakeChild
    const started: Array<[number, number]> = []
    const events: Array<Record<string, unknown>> = []
    const done = runLogin({
      cli: "/cli",
      spawn: () => child,
      emit: (event) => events.push(event),
      control: new AsyncQueue<string>(),
      watchdog: (parent, pid) => started.push([parent, pid]),
    })
    expect(started).toEqual([[process.pid, 4242]])
    child.exit(1)
    await done
  })
})
