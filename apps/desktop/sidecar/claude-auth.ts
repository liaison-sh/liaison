// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SIGNING IN TO CLAUDE FROM INSIDE THE APP.
//
// A local turn runs on the Claude Code CLI this binary embeds, and that CLI
// authenticates with its OWN stored OAuth credentials. A person who has only
// ever used the Claude desktop app has none, and every local turn failed with
// "Failed to authenticate: OAuth session expired and could not be refreshed":
// the only way out was installing Claude Code and running its login in a
// terminal. This module drives that same login from the app instead.
//
// THREE MODES, one per CLI subcommand, each a short lived process the shell
// spawns (`liaison-sidecar --claude-auth status|login|logout`):
//
//   status   `claude auth status --json`, reduced to the four fields the app
//            shows (never the directories it also prints)
//   login    `claude auth login --claudeai`, driven: the sign-in URL is sent
//            to the shell as soon as the CLI prints it, a code the person
//            pasted is written to the CLI's stdin, and the process ends with
//            one `claude_auth_done` line (success, failure, cancel, timeout)
//   logout   `claude auth logout`, then a status
//
// THE SAME CREDENTIAL STORE THE TURNS READ. The CLI runs with this process's
// own environment, exactly as a personal agent's session does. An isolated
// session (config-isolation.ts) moves CLAUDE_CONFIG_DIR but pins the
// credential store to the default one, so both kinds of session read what this
// login writes: the macOS keychain item "Claude Code-credentials", or
// `~/.claude/.credentials.json` on Windows and Linux.
//
// THE BROWSER. The CLI opens the sign-in page itself, with whatever `BROWSER`
// names. Under a desktop app that open can fail silently, so the CLI is handed
// THIS binary as its browser (`BROWSER`, with `LIAISON_CLAUDE_AUTH_URL_SINK`
// naming a private file): the "browser" writes the URL there and exits, and
// the shell opens it with its own opener. The page it opens completes on its
// own (the CLI listens on localhost for the redirect). The URL the CLI PRINTS
// is the other flow, whose page shows a code to paste; it is the fallback the
// shell reopens, and the one sent when no browser URL arrived.
//
// THE CLI NEVER OUTLIVES ITS SIGN-IN. `claude auth login` ignores its stdin
// closing, so a sidecar that is killed outright (the shell's kill after the
// grace, a crash, a force quit) would leave it waiting for a code for ever,
// reparented to init. A login therefore starts a WATCHDOG beside it: this
// binary again (`--claude-auth-watchdog <sidecar pid> <cli pid>`), detached,
// which ends the CLI the moment the sidecar is gone and ends itself the moment
// the CLI is. A process of its own because the one thing it guards against is
// this process no longer running; polling because it works the same on macOS,
// Linux and Windows, where a process group or a job object would be three
// mechanisms. Both processes are named by pid AND start time
// (process-identity.ts): a pid reused by another program is never signalled,
// and a sidecar pid taken over after a hard kill still reads as gone. A hard
// ceiling (the login's timeout plus a margin) ends it all regardless. A shell that closes our stdin is still answered directly:
// the login is cancelled and the CLI killed without waiting for a poll.
//
// NOTHING SECRET LEAVES. The pasted code is written to the CLI's stdin and
// nowhere else; every detail line that is sent on is redacted first (the code,
// anything shaped like a token, the URL's state and challenge).

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type IdentityReader, identityReader } from "./process-identity"

/** `liaison-sidecar --claude-auth <mode>`. */
export const CLAUDE_AUTH_FLAG = "--claude-auth"
export const CLAUDE_AUTH_MODES = ["status", "login", "logout"] as const
export type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number]

/** The file the "browser" writes the sign-in URL into. Private to one login. */
export const BROWSER_SINK_ENV = "LIAISON_CLAUDE_AUTH_URL_SINK"

/** How long a sign-in may wait for the person before it is given up on. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000
/** How long after the printed URL the browser URL is waited for. */
export const SINK_WAIT_MS = 2_000
/** How long `status` and `logout` may take. They read or delete one credential. */
export const QUICK_COMMAND_TIMEOUT_MS = 20_000

/** `liaison-sidecar --claude-auth-watchdog <sidecar pid> <cli pid>`. */
export const WATCHDOG_FLAG = "--claude-auth-watchdog"
/** How often the watchdog looks. */
export const WATCHDOG_INTERVAL_MS = 250
/**
 * The watchdog's hard ceiling: past the login's own timeout, with a margin,
 * the CLI is ended and the watchdog exits, whatever it believes about the
 * sidecar. Nothing it guards can live for ever.
 */
export const WATCHDOG_CEILING_MS = LOGIN_TIMEOUT_MS + 60_000
/** How long the CLI is given to go on a SIGTERM before it is killed outright. */
export const WATCHDOG_KILL_GRACE_MS = 2_000

/** What replaces a secret in anything sent on. */
export const REDACTED = "[redacted]"

/** The longest detail a failure carries. One line, for a person to read. */
export const MAX_DETAIL_LENGTH = 300

/** The account the local sessions run on, as much of it as the app shows. */
export interface ClaudeAccountStatus {
  loggedIn: boolean
  email: string | null
  authMethod: string | null
  orgName: string | null
}

/** The mode this argv asks for, or null when it is not an auth call. */
export function claudeAuthMode(argv: readonly string[]): ClaudeAuthMode | null {
  if (argv[0] !== CLAUDE_AUTH_FLAG) return null
  const mode = argv[1]
  return (CLAUDE_AUTH_MODES as readonly string[]).includes(mode ?? "")
    ? (mode as ClaudeAuthMode)
    : null
}

/**
 * Whether a URL is one of Claude's own sign-in pages: https, on claude.com,
 * claude.ai or anthropic.com (or a subdomain). Anything else is never opened
 * and never sent on, whatever printed it.
 */
export function isClaudeSignInUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  if (url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return ["claude.com", "claude.ai", "anthropic.com"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  )
}

/**
 * The URL `claude auth login` printed ("If the browser didn't open, visit:
 * <url>"), or null until it has. Read from everything printed so far, since a
 * chunk can end in the middle of it: a URL is only taken once whitespace
 * follows it.
 */
export function extractSignInUrl(printed: string): string | null {
  const match = /visit:\s*(https:\/\/\S+?)(?=\s)/.exec(stripTerminalCodes(printed))
  if (!match) return null
  const url = match[1] as string
  return isClaudeSignInUrl(url) ? url : null
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
/** OSC 8 hyperlinks (ESC ] 8 ; ; url BEL, or ST) and CSI colour codes. */
const TERMINAL_CODES = new RegExp(
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-9;]*[A-Za-z]`,
  "g",
)

/** Terminal escapes a CLI may wrap a link in, removed. */
export function stripTerminalCodes(text: string): string {
  return text.replace(TERMINAL_CODES, "")
}

/** The four fields of `claude auth status --json`, or null when it is not that. */
export function parseAuthStatus(printed: string): ClaudeAccountStatus | null {
  const start = printed.indexOf("{")
  const end = printed.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(printed.slice(start, end + 1))
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (typeof value.loggedIn !== "boolean") return null
  const text = (field: unknown) =>
    typeof field === "string" && field.trim().length > 0 ? field.trim() : null
  return {
    loggedIn: value.loggedIn,
    email: text(value.email),
    authMethod: text(value.authMethod),
    orgName: text(value.orgName),
  }
}

/**
 * A line on its way out, with every secret struck: the pasted code (whole and
 * each half of its `code#state`), anything as long as a token, and the state
 * and challenge of a sign-in URL.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) {
    for (const part of [secret, ...secret.split("#")]) {
      const trimmed = part.trim()
      if (trimmed.length >= 4) out = out.split(trimmed).join(REDACTED)
    }
  }
  out = out.replace(/([?&](?:code|state|code_challenge|code_verifier)=)[^&\s]+/g, `$1${REDACTED}`)
  out = out.replace(/[A-Za-z0-9_\-.]{32,}/g, REDACTED)
  return out
}

/** A failure's one line: the CLI's own "Login failed: ..." when it said one. */
export function failureDetail(stderr: string, secrets: readonly string[] = []): string | null {
  const lines = stripTerminalCodes(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const chosen = [...lines].reverse().find((line) => /failed/i.test(line)) ?? lines.at(-1)
  if (!chosen) return null
  const clean = redact(chosen, secrets)
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH - 1)}…` : clean
}

/** The CLI said the pasted text is not a whole code. It keeps waiting. */
export function reportsInvalidCode(stderrLine: string): boolean {
  return /invalid code/i.test(stderrLine)
}

// ---------------------------------------------------------------------------
// The browser sink.

/**
 * Whether this process was started by the CLI AS ITS BROWSER: one argument,
 * a URL, and the sink variable set. Checked before anything else in `main`,
 * because it must not be read as a session's arguments.
 */
export function isBrowserSinkCall(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  const sink = env[BROWSER_SINK_ENV]
  return argv.length === 1 && !!sink && /^https?:\/\//i.test(argv[0] ?? "")
}

/** Writes the URL the CLI asked to open into the sink, when it is Claude's. */
export function runBrowserSink(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): number {
  const sink = env[BROWSER_SINK_ENV]
  const url = argv[0]
  if (!sink || !url || !isClaudeSignInUrl(url)) return 1
  try {
    appendFileSync(sink, `${url}\n`, { mode: 0o600 })
    return 0
  } catch {
    return 1
  }
}

/** The first Claude sign-in URL the sink holds, or null. */
export function readSink(path: string): string | null {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return null
  }
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => isClaudeSignInUrl(line)) ?? null
  )
}

// ---------------------------------------------------------------------------
// The child process, behind a seam a test can stand in for.

export interface AuthChild {
  /** The OS pid, for the watchdog. Null when unknown. */
  pid: number | null
  /** Decoded stdout, chunk by chunk. */
  stdout: AsyncIterable<string>
  stderr: AsyncIterable<string>
  write(text: string): void
  kill(): void
  /** The exit code, or null when it was killed. */
  exited: Promise<number | null>
}

export type AuthSpawn = (argv: string[], env: Record<string, string | undefined>) => AuthChild

async function* decode(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    yield decoder.decode(value, { stream: true })
  }
}

/** The real spawn: piped stdio, no shell. */
export const bunSpawn: AuthSpawn = (argv, env) => {
  const child = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  return {
    pid: child.pid,
    stdout: decode(child.stdout),
    stderr: decode(child.stderr),
    write(text) {
      child.stdin.write(text)
      void child.stdin.flush()
    },
    kill() {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    },
    exited: child.exited.then((code) => (child.signalCode ? null : code)),
  }
}

/**
 * The CLI to run: the one extracted from this binary, or, in a plain
 * `bun index.ts` run, the platform package installed beside it.
 */
export function resolveClaudeCli(cliPath: string | null): string | null {
  if (cliPath) return cliPath
  const os = process.platform === "win32" ? "win32" : process.platform
  const file = process.platform === "win32" ? "claude.exe" : "claude"
  try {
    return Bun.resolveSync(
      `@anthropic-ai/claude-agent-sdk-${os}-${process.arch}/${file}`,
      import.meta.dir,
    )
  } catch {
    return null
  }
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = ""
  for await (const chunk of stream) out += chunk
  return out
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout()
        reject(new Error("timed out"))
      }, ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export interface QuickOptions {
  cli: string
  spawn?: AuthSpawn
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

/** `claude auth status --json`, or null when the CLI said nothing readable. */
export async function readAuthStatus(options: QuickOptions): Promise<ClaudeAccountStatus | null> {
  const spawn = options.spawn ?? bunSpawn
  const child = spawn([options.cli, "auth", "status", "--json"], options.env ?? process.env)
  const errors = collect(child.stderr)
  try {
    // It exits 1 when nobody is signed in, and still prints the JSON: the
    // exit code is not the answer, the JSON is.
    const [printed] = await withTimeout(
      Promise.all([collect(child.stdout), child.exited]),
      options.timeoutMs ?? QUICK_COMMAND_TIMEOUT_MS,
      () => child.kill(),
    )
    return parseAuthStatus(printed)
  } catch {
    return null
  } finally {
    void errors.catch(() => undefined)
  }
}

/** `claude auth logout`. True when the CLI said it did. */
export async function runLogout(options: QuickOptions): Promise<boolean> {
  const spawn = options.spawn ?? bunSpawn
  const child = spawn([options.cli, "auth", "logout"], options.env ?? process.env)
  try {
    const [, , code] = await withTimeout(
      Promise.all([collect(child.stdout), collect(child.stderr), child.exited]),
      options.timeoutMs ?? QUICK_COMMAND_TIMEOUT_MS,
      () => child.kill(),
    )
    return code === 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The watchdog.

/** One process, named by its pid AND its start time (process-identity.ts). */
export interface WatchedProcess {
  pid: number
  identity: string
}

/** What a watchdog call names: the sidecar, the CLI, and the ceiling. */
export interface WatchdogTarget {
  parent: WatchedProcess
  child: WatchedProcess
  /** After this long the CLI is ended whatever else is true. */
  ceilingMs: number
}

/** The argv a watchdog is started with (`startWatchdog`). */
export function watchdogArgv(target: WatchdogTarget): string[] {
  return [
    WATCHDOG_FLAG,
    String(target.parent.pid),
    target.parent.identity,
    String(target.child.pid),
    target.child.identity,
    String(target.ceilingMs),
  ]
}

/** What a watchdog call names, or null when argv is not a well formed one. */
export function watchdogTarget(argv: readonly string[]): WatchdogTarget | null {
  if (argv[0] !== WATCHDOG_FLAG || argv.length !== 6) return null
  const [, parentPid, parentIdentity, childPid, childIdentity, ceiling] = argv
  const pid = (value: string | undefined) => {
    const number = Number(value)
    return Number.isInteger(number) && number > 0 ? number : null
  }
  const parent = pid(parentPid)
  const child = pid(childPid)
  const ceilingMs = pid(ceiling)
  if (!parent || !child || !ceilingMs || !parentIdentity || !childIdentity) return null
  return {
    parent: { pid: parent, identity: parentIdentity },
    child: { pid: child, identity: childIdentity },
    ceilingMs,
  }
}

/** Whether a watchdog call is what this argv is. */
export function isWatchdogCall(argv: readonly string[]): boolean {
  return argv[0] === WATCHDOG_FLAG
}

/**
 * ONE LOOK, AS A PURE DECISION.
 *
 * - The CLI is no longer the CLI (it exited, and its pid may already be
 *   somebody else's): nothing is killed, the watchdog is done.
 * - The sidecar is no longer the sidecar (gone, or its pid reused), or the
 *   ceiling has passed: the CLI is ended.
 * - Otherwise: wait.
 */
export type WatchdogStep = "wait" | "exit" | "end-cli"

export function watchdogStep(look: {
  cliMatches: boolean
  parentMatches: boolean
  pastCeiling: boolean
}): WatchdogStep {
  if (!look.cliMatches) return "exit"
  if (!look.parentMatches || look.pastCeiling) return "end-cli"
  return "wait"
}

export interface WatchdogOptions {
  intervalMs?: number
  graceMs?: number
  identity?: IdentityReader
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void
  now?: () => number
}

/**
 * Watches one sign-in: ends the CLI once the sidecar that started it is gone
 * or the ceiling passed, and returns once the CLI is gone either way. Every
 * signal is sent only to a pid whose identity was JUST read as the CLI's.
 */
export async function runWatchdog(
  target: WatchdogTarget,
  options: WatchdogOptions = {},
): Promise<number> {
  const identity = options.identity ?? identityReader()
  // No way to tell processes apart here: touching nothing is the safe answer.
  if (!identity) return 0
  const kill =
    options.kill ??
    ((pid: number, signal: "SIGTERM" | "SIGKILL") => {
      try {
        process.kill(pid, signal)
      } catch {
        // Already gone.
      }
    })
  const now = options.now ?? Date.now
  const interval = options.intervalMs ?? WATCHDOG_INTERVAL_MS
  const deadline = now() + target.ceilingMs
  const isCli = () => identity(target.child.pid) === target.child.identity
  while (true) {
    const step = watchdogStep({
      cliMatches: isCli(),
      parentMatches: identity(target.parent.pid) === target.parent.identity,
      pastCeiling: now() >= deadline,
    })
    if (step === "exit") return 0
    if (step === "end-cli") {
      kill(target.child.pid, "SIGTERM")
      const graceEnd = now() + (options.graceMs ?? WATCHDOG_KILL_GRACE_MS)
      while (isCli() && now() < graceEnd) await sleep(50)
      if (isCli()) kill(target.child.pid, "SIGKILL")
      return 0
    }
    await sleep(interval)
  }
}

/**
 * How this process starts itself again as a watchdog: the compiled binary is
 * its own command; a plain `bun index.ts` run is bun and the entry file.
 */
export function selfCommand(
  main: string = Bun.main,
  execPath: string = process.execPath,
): string[] {
  const compiled = main.includes("$bunfs") || main.includes("~BUN")
  return compiled ? [execPath] : [execPath, main]
}

/**
 * Starts a detached watchdog for one CLI child, naming both processes by
 * identity. Never throws, and starts nothing when either identity cannot be
 * read: a watchdog that cannot tell processes apart must not kill anything.
 * Answers whether one was started.
 */
export function startWatchdog(
  command: readonly string[],
  parent: number,
  child: number,
  identity: IdentityReader | null = identityReader(),
  ceilingMs: number = WATCHDOG_CEILING_MS,
): boolean {
  const parentIdentity = identity?.(parent) ?? null
  const childIdentity = identity?.(child) ?? null
  if (!parentIdentity || !childIdentity) return false
  const argv = watchdogArgv({
    parent: { pid: parent, identity: parentIdentity },
    child: { pid: child, identity: childIdentity },
    ceilingMs,
  })
  try {
    const watchdog = Bun.spawn([...command, ...argv], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    watchdog.unref()
    return true
  } catch {
    // The stdin path still ends the CLI when the shell goes away.
    return false
  }
}

// ---------------------------------------------------------------------------
// The login.

/** The control lines the shell writes during a login. */
export type LoginControlLine = { type: "code"; code: string } | { type: "cancel" }

/** Why a login ended without an account. */
export type LoginFailure = "cancelled" | "timeout" | "failed" | "cli_missing"

export interface LoginOptions {
  cli: string
  spawn?: AuthSpawn
  env?: Record<string, string | undefined>
  emit: (event: Record<string, unknown>) => void
  /** The shell's control lines. Its end is a cancel: nobody is left to paste a code. */
  control: AsyncIterable<string>
  timeoutMs?: number
  sinkWaitMs?: number
  /**
   * The command the CLI is given as its browser, or null to leave `BROWSER`
   * alone (a development run, where this process is `bun` and not the binary).
   */
  browserCommand?: string | null
  /** How the account is read once the CLI said it signed in. */
  status?: () => Promise<ClaudeAccountStatus | null>
  /**
   * Starts the watchdog that ends the CLI if this process is killed outright
   * (`runWatchdog`). Absent in a unit test's stand-in world.
   */
  watchdog?: (parentPid: number, childPid: number) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Drives one `claude auth login --claudeai` to its end and says how it ended,
 * on exactly one `claude_auth_done` line. Returns the exit code for the
 * process: 0 signed in, 1 anything else.
 */
export async function runLogin(options: LoginOptions): Promise<number> {
  const spawn = options.spawn ?? bunSpawn
  const emit = options.emit
  const secrets: string[] = []

  let sinkDir: string | null = null
  let sinkPath: string | null = null
  const env: Record<string, string | undefined> = { ...(options.env ?? process.env) }
  if (options.browserCommand) {
    sinkDir = mkdtempSync(join(tmpdir(), "liaison-claude-auth-"))
    sinkPath = join(sinkDir, "url")
    env.BROWSER = options.browserCommand
    env[BROWSER_SINK_ENV] = sinkPath
  }

  const child = spawn([options.cli, "auth", "login", "--claudeai"], env)
  if (child.pid !== null) options.watchdog?.(process.pid, child.pid)
  let outcome: LoginFailure | null = null
  let finished = false
  const stop = (why: LoginFailure) => {
    if (outcome || finished) return
    outcome = why
    child.kill()
  }

  const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? LOGIN_TIMEOUT_MS)

  let printed = ""
  let urlSent = false
  const stdoutDone = (async () => {
    for await (const chunk of child.stdout) {
      printed += chunk
      if (urlSent) continue
      const manual = extractSignInUrl(printed)
      if (!manual) continue
      urlSent = true
      // The page the CLI would have opened completes by itself; the printed
      // one asks for a code. The first is worth a short wait.
      let browser = sinkPath ? readSink(sinkPath) : null
      const deadline = Date.now() + (options.sinkWaitMs ?? SINK_WAIT_MS)
      while (!browser && sinkPath && Date.now() < deadline && !outcome) {
        await sleep(50)
        browser = readSink(sinkPath)
      }
      if (!outcome) emit({ type: "claude_auth_url", url: browser ?? manual, manualUrl: manual })
    }
  })()

  let stderrText = ""
  const stderrDone = (async () => {
    let pending = ""
    for await (const chunk of child.stderr) {
      stderrText += chunk
      pending += chunk
      let newline = pending.indexOf("\n")
      while (newline !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (reportsInvalidCode(line)) emit({ type: "claude_auth_code_rejected" })
        newline = pending.indexOf("\n")
      }
    }
  })()

  // Not awaited to its end: the control stream may be parked on a stdin read
  // that never returns once the login is over.
  void (async () => {
    for await (const line of options.control) {
      if (finished) return
      if (!line.trim()) continue
      let parsed: LoginControlLine
      try {
        parsed = JSON.parse(line) as LoginControlLine
      } catch {
        continue
      }
      if (parsed.type === "cancel") {
        stop("cancelled")
        return
      }
      if (parsed.type === "code" && typeof parsed.code === "string") {
        // One line: a newline inside it would be a second answer to the CLI.
        const code = parsed.code.replace(/[\r\n]+/g, "").trim()
        if (!code) continue
        secrets.push(code)
        child.write(`${code}\n`)
        emit({ type: "claude_auth_code_sent" })
      }
    }
    // The shell closed our stdin: nobody is left to finish this sign-in.
    stop("cancelled")
  })().catch(() => stop("cancelled"))

  const code = await child.exited
  await Promise.all([stdoutDone.catch(() => undefined), stderrDone.catch(() => undefined)])
  clearTimeout(timer)
  finished = true
  if (sinkDir) {
    try {
      rmSync(sinkDir, { recursive: true, force: true })
    } catch {
      // A temporary directory; the OS clears it.
    }
  }

  if (outcome) {
    emit({ type: "claude_auth_done", ok: false, reason: outcome })
    return 1
  }
  if (code === 0) {
    const account = (await options.status?.()) ?? null
    emit({ type: "claude_auth_done", ok: true, account })
    return 0
  }
  emit({
    type: "claude_auth_done",
    ok: false,
    reason: "failed" satisfies LoginFailure,
    detail: failureDetail(stderrText, secrets),
  })
  return 1
}

/** Splits a byte stream into lines. */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffered = ""
  for await (const chunk of decode(stream)) {
    buffered += chunk
    let newline = buffered.indexOf("\n")
    while (newline !== -1) {
      yield buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf("\n")
    }
  }
  if (buffered.length > 0) yield buffered
}

/**
 * The process entry for `--claude-auth <mode>`. One JSON line per event on
 * stdout, like a session. `cliPath` is the CLI extracted from this binary.
 */
export async function claudeAuthMain(
  argv: readonly string[],
  cliPath: string | null,
  io: {
    write: (line: string) => void
    control?: AsyncIterable<string>
    spawn?: AuthSpawn
    browserCommand?: string | null
    /** The command a watchdog is started with, or null for none. */
    watchdogCommand?: readonly string[] | null
  } = { write: (line) => process.stdout.write(line) },
): Promise<number> {
  const emit = (event: Record<string, unknown>) => io.write(`${JSON.stringify(event)}\n`)
  const mode = claudeAuthMode(argv)
  if (!mode) {
    process.stderr.write(`usage: liaison-sidecar ${CLAUDE_AUTH_FLAG} status|login|logout\n`)
    return 2
  }
  const cli = resolveClaudeCli(cliPath)
  if (!cli) {
    if (mode === "login") emit({ type: "claude_auth_done", ok: false, reason: "cli_missing" })
    else emit({ type: `claude_auth_${mode}`, error: "cli_missing" })
    return 1
  }
  const quick: QuickOptions = { cli, ...(io.spawn ? { spawn: io.spawn } : {}) }
  if (mode === "status") {
    const account = await readAuthStatus(quick)
    emit(
      account
        ? { type: "claude_auth_status", account }
        : { type: "claude_auth_status", error: "unreadable" },
    )
    return account ? 0 : 1
  }
  if (mode === "logout") {
    const ok = await runLogout(quick)
    emit({ type: "claude_auth_logout", ok, account: await readAuthStatus(quick) })
    return ok ? 0 : 1
  }
  return runLogin({
    ...quick,
    emit,
    control: io.control ?? lines(Bun.stdin.stream()),
    // Only the compiled binary can be the CLI's browser: `cliPath` is set
    // exactly when this process is that binary.
    browserCommand:
      io.browserCommand !== undefined ? io.browserCommand : cliPath ? process.execPath : null,
    status: () => readAuthStatus(quick),
    watchdog: (parent, child) => {
      const command = io.watchdogCommand !== undefined ? io.watchdogCommand : selfCommand()
      if (command) startWatchdog(command, parent, child)
    },
  })
}
