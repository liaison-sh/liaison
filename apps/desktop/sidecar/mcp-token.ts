// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION'S LIAISON MCP TOKEN, KEPT VALID FOR AS LONG AS THE SESSION RUNS.
//
// The shell mints an agent scoped token (it lives 15 minutes) and used to hand
// it to the Claude CLI as a static `Authorization` header. It was checked when
// the session was SPAWNED and never again, so any turn that ran past its
// fifteen minutes (a monthly report is 10 to 20 of them, and a session parked
// behind macOS privacy prompts starts late) met a 401 on every Liaison call and
// the model told the user "Serveur Liaison indisponible (erreur 401)".
//
// Now the CLI is given a `headersHelper` instead of a header: a command whose
// stdout is the headers JSON. The CLI bundled with this SDK (2.1.270) runs it
// when it connects the server AND again when a tool call comes back 401 ("Tool
// '<name>' returned 401; re-running headersHelper and retrying once"). The
// command is this very binary in `--print-mcp-headers` mode (`index.ts`), which
// answers from the per session MCP config file the shell wrote, renewing the
// token first through `/mcp/oauth/token` with the refresh token the shell
// stored for this server and agent.
//
// The long lived sidecar runs the same renewal on a timer (`startTokenKeeper`)
// so the file is usually fresh before anyone asks, and it is the one that tells
// the shell when the server REFUSED a renewal: the connection was revoked, and
// only a new approval in the browser brings it back.
//
// No token is ever written to stdout except the helper's one headers line the
// CLI asked for, and none ever reaches stderr, an error message or a log.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { NODE_TURN_CREDENTIAL_HEADER } from "../../../packages/shared/src/node-session-protocol"
import { readRegularFileNoFollow } from "./safe-read"

/** The helper mode's flag: `liaison-sidecar --print-mcp-headers --mcp-config <path>`. */
export const HEADERS_HELPER_FLAG = "--print-mcp-headers"

/**
 * How close to its expiry a token the helper is asked for gets renewed. The
 * helper is asked at connect and after a 401, so it renews unconditionally
 * whenever it can (`force`); this margin is what the relay and the keeper use.
 */
export const REFRESH_MARGIN_MS = 60_000

/** The keeper renews this long before expiry, so a helper call rarely has to. */
export const KEEPER_REFRESH_MARGIN_MS = 5 * 60_000

/** How often the keeper looks at the token. A clock compare and a small file read. */
export const KEEPER_INTERVAL_MS = 30_000

/** One renewal may take this long before it is given up on. */
export const REFRESH_TIMEOUT_MS = 15_000

/** The config file's token fields, as the shell writes them (`sidecar.rs` `write_mcp_config_at`). */
export interface TokenState {
  token: string
  /** Epoch millis, or null when neither the file nor the token says. */
  expiresAtMs: number | null
  refreshToken: string | null
  /** `<server>/mcp/oauth/token`, composed by the shell from the server it minted on. */
  tokenUrl: string | null
  /** Set when the server refused a renewal: the connection is gone. */
  refusedAtMs: number | null
}

/** The server said no to the refresh token itself. Only a new approval helps. */
export class RefreshRefused extends Error {
  constructor(status: number) {
    super(`the Liaison MCP token renewal was refused (HTTP ${status})`)
    this.name = "RefreshRefused"
  }
}

/** The `exp` claim of a JWT, in epoch millis, or null. */
export function jwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown
    }
    return typeof claims.exp === "number" ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

function readRaw(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null
const millis = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

export function readTokenState(configPath: string): TokenState {
  const raw = readRaw(configPath)
  const token = text(raw.agentScopedToken)
  if (!token) throw new Error(`${configPath}: missing agentScopedToken`)
  return {
    token,
    expiresAtMs: millis(raw.tokenExpiresAtMs) ?? jwtExpiryMs(token),
    refreshToken: text(raw.refreshToken),
    tokenUrl: text(raw.tokenUrl),
    refusedAtMs: millis(raw.tokenRefusedAtMs),
  }
}

/**
 * Rewrites the token fields and nothing else, atomically: a sibling file only
 * its owner can read, renamed over the original, so a reader (the helper, the
 * CLI, the relay) never sees half a file.
 */
export function writeTokenFields(configPath: string, fields: Record<string, unknown>): void {
  const raw = { ...readRaw(configPath), ...fields }
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(raw), { mode: 0o600 })
    renameSync(temporary, configPath)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Nothing was left behind.
    }
    throw error
  }
}

/**
 * THE TURN'S CREDENTIAL (S59, D36). The server mints one when the shell
 * re-reads the person's message a local turn answers; the shell hands it over
 * on the turn line, and the sidecar keeps it beside the token file, owner
 * only, for the helper to present as `x-liaison-turn` on that turn's calls.
 * It is meaningful only on this desktop's own agent connection (the server
 * binds it there), it lives 30 minutes on the server, and it is replaced or
 * deleted by the next turn line and deleted when the sidecar exits.
 */
export const TURN_CREDENTIAL_MAX_AGE_MS = 30 * 60_000

/** The server's shape: 32 random bytes, base64url, no padding. */
export const TURN_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function turnCredentialPath(configPath: string): string {
  return `${configPath}.turn`
}

/**
 * Writes the turn's credential atomically (0600), or deletes the file when
 * there is none. Returns whether a file was there before, so the caller knows
 * a credential has to be dropped from the live connection.
 */
export function writeTurnCredential(configPath: string, credential: string | null): boolean {
  const file = turnCredentialPath(configPath)
  let existed = false
  try {
    unlinkSync(file)
    existed = true
  } catch {
    // There was none.
  }
  if (credential === null) return existed
  if (!TURN_CREDENTIAL_PATTERN.test(credential)) return existed
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, credential, { mode: 0o600, flag: "wx" })
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Nothing was left behind.
    }
    throw error
  }
  return existed
}

/** The credential the helper presents now: a well formed one younger than 30 minutes. */
export function readTurnCredential(configPath: string, nowMs: number): string | null {
  const file = turnCredentialPath(configPath)
  // Its age and its text come from the one open file, never a symlink.
  const credential = readRegularFileNoFollow(file, 64, {
    accept: (st) => nowMs - st.mtimeMs <= TURN_CREDENTIAL_MAX_AGE_MS,
  })
  return credential !== null && TURN_CREDENTIAL_PATTERN.test(credential) ? credential : null
}

/** Still worth presenting, `marginMs` from now. An unknown expiry is trusted. */
export function usable(state: TokenState, nowMs: number, marginMs: number): boolean {
  return state.expiresAtMs === null || state.expiresAtMs > nowMs + marginMs
}

export interface Renewed {
  token: string
  expiresAtMs: number | null
  refreshToken: string
}

/**
 * One `refresh_token` grant against the server's MCP OAuth route. A 4xx is the
 * server refusing the refresh token (`invalid_grant`: revoked or unknown); any
 * other failure is the network or the server being down, which a later try may
 * get past. Neither message carries a token.
 */
export async function requestRefresh(
  tokenUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REFRESH_TIMEOUT_MS,
): Promise<Renewed> {
  let response: Response
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const name = (error as Error).name
    throw new Error(
      name === "TimeoutError" || name === "AbortError"
        ? `the Liaison MCP token renewal timed out after ${timeoutMs} ms`
        : "the Liaison server could not be reached to renew the MCP token",
    )
  }
  if (response.status >= 400 && response.status < 500) throw new RefreshRefused(response.status)
  if (!response.ok) {
    throw new Error(`the Liaison MCP token renewal failed (HTTP ${response.status})`)
  }
  let body: { access_token?: unknown; refresh_token?: unknown }
  try {
    body = (await response.json()) as typeof body
  } catch {
    throw new Error("the Liaison MCP token renewal answered something unreadable")
  }
  const token = text(body.access_token)
  if (!token) throw new Error("the Liaison MCP token renewal answered no access token")
  return {
    token,
    expiresAtMs: jwtExpiryMs(token),
    refreshToken: text(body.refresh_token) ?? refreshToken,
  }
}

export interface FreshTokenOptions {
  now?: () => number
  fetchImpl?: typeof fetch
  /** Renew when the token dies within this long. */
  marginMs?: number
  /** Renew whatever the clock says (the CLI asks after a 401, and the clock can be wrong). */
  force?: boolean
}

/** One renewal per file at a time in this process: the keeper and the relay can ask together. */
const inFlight = new Map<string, Promise<string>>()

/**
 * A token worth presenting now: the stored one while it has `marginMs` left,
 * else a renewed one, written back for the next reader.
 *
 * A REFUSED renewal is recorded in the file (`tokenRefusedAtMs`) and thrown:
 * the keeper reads the mark and has the shell ask for a new approval. A renewal
 * that merely could not happen (network, a 5xx) falls back to the stored token
 * while it has not expired, so a blip does not cost a working session its tools.
 */
export async function freshToken(
  configPath: string,
  options: FreshTokenOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now
  const state = readTokenState(configPath)
  const marginMs = options.marginMs ?? REFRESH_MARGIN_MS
  if (!options.force && usable(state, now(), marginMs)) return state.token
  if (!state.refreshToken || !state.tokenUrl) {
    // A config from a shell that stored no refresh token: the token is all
    // there is, for as long as it lasts.
    if (usable(state, now(), 0)) return state.token
    throw new Error("the Liaison MCP token expired and this session holds no way to renew it")
  }
  const running = inFlight.get(configPath)
  if (running) return running
  const { refreshToken, tokenUrl } = state
  const renewal = (async () => {
    try {
      const renewed = await requestRefresh(tokenUrl, refreshToken, options.fetchImpl)
      writeTokenFields(configPath, {
        agentScopedToken: renewed.token,
        tokenExpiresAtMs: renewed.expiresAtMs,
        refreshToken: renewed.refreshToken,
        tokenRefusedAtMs: null,
      })
      return renewed.token
    } catch (error) {
      if (error instanceof RefreshRefused) {
        writeTokenFields(configPath, { tokenRefusedAtMs: now() })
        throw error
      }
      if (usable(state, now(), 0)) return state.token
      throw error
    }
  })()
  inFlight.set(configPath, renewal)
  try {
    return await renewal
  } finally {
    inFlight.delete(configPath)
  }
}

/** The helper's argv: `--print-mcp-headers --mcp-config <path>`, or null when it is not one. */
export function headersHelperConfigPath(argv: string[]): string | null {
  if (argv[0] !== HEADERS_HELPER_FLAG) return null
  const at = argv.indexOf("--mcp-config")
  const value = at >= 0 ? argv[at + 1] : undefined
  return value && value.length > 0 ? value : null
}

/**
 * THE HELPER MODE. Prints `{"Authorization":"Bearer …"}` (plus `x-liaison-turn`
 * while the running turn has a fresh credential, S59) and exits 0, or says
 * on stderr (without the token) why it could not and exits 1. The CLI reads
 * stdout, and a non zero exit is its "helper failed", which fails the
 * connection rather than presenting a dead token.
 */
export async function printMcpHeaders(
  argv: string[],
  io: {
    out: (line: string) => void
    err: (line: string) => void
    fetchImpl?: typeof fetch
    now?: () => number
  } = {
    out: (line) => process.stdout.write(line),
    err: (line) => process.stderr.write(line),
  },
): Promise<number> {
  const configPath = headersHelperConfigPath(argv)
  if (!configPath) {
    io.err(`usage: liaison-sidecar ${HEADERS_HELPER_FLAG} --mcp-config <path>\n`)
    return 2
  }
  try {
    // FORCED: the CLI asks when it connects and when the server has just
    // answered 401, and in the second case the clock is exactly what cannot be
    // trusted. One renewal per connect is cheap.
    const token = await freshToken(configPath, {
      force: true,
      ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
      ...(io.now ? { now: io.now } : {}),
    })
    // S59: the turn's credential, when this turn has one, beside the agent's
    // own header. Never written anywhere else.
    const turn = readTurnCredential(configPath, (io.now ?? Date.now)())
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (turn) headers[NODE_TURN_CREDENTIAL_HEADER] = turn
    io.out(`${JSON.stringify(headers)}\n`)
    return 0
  } catch (error) {
    io.err(`liaison-sidecar: ${(error as Error).message}\n`)
    return 1
  }
}

/**
 * Quotes one argument for the shell the CLI runs a helper in (`/bin/sh` on
 * macOS and Linux, `cmd.exe` on Windows). The app lives under
 * `Application Support`, so an unquoted path is two words.
 */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The command the CLI runs for the headers. `entry` is the script when this is
 * a plain `bun index.ts` run (the runtime needs to be told what to run), and
 * null inside the compiled binary, which is its own entry.
 */
export function headersHelperCommand(
  configPath: string,
  executable: string = process.execPath,
  entry: string | null = compiledEntry() ? null : (process.argv[1] ?? null),
  platform: NodeJS.Platform = process.platform,
): string {
  const quote = (value: string) => shellQuote(value, platform)
  return [
    quote(executable),
    ...(entry ? [quote(entry)] : []),
    HEADERS_HELPER_FLAG,
    "--mcp-config",
    quote(configPath),
  ].join(" ")
}

/** Whether this process is the compiled binary rather than `bun <script>`. */
export function compiledEntry(): boolean {
  const main = Bun.main ?? ""
  return main.includes("$bunfs") || main.includes("~BUN")
}

export interface TokenKeeper {
  /** One look at the token: renew it when it is close to expiry, report a refusal. */
  tick(): Promise<void>
  stop(): void
}

/**
 * The long lived half. It renews the token ahead of time, so the helper's
 * forced renewal is a formality, and it is the ONE place that reports a refusal
 * to the shell, whoever met it (itself, the relay or a helper run by the CLI,
 * all of which mark the file). Reported once: a revoked connection stays
 * revoked, and the shell has already asked for the approval.
 */
export function startTokenKeeper(options: {
  configPath: string
  onRefused: () => void
  intervalMs?: number
  marginMs?: number
  now?: () => number
  fetchImpl?: typeof fetch
}): TokenKeeper {
  let reported = false
  const now = options.now ?? Date.now
  const report = () => {
    if (reported) return
    reported = true
    options.onRefused()
  }
  const tick = async () => {
    if (reported) return
    let state: TokenState
    try {
      state = readTokenState(options.configPath)
    } catch {
      // The shell deletes the file when it switches servers; the session is
      // being stopped, and there is nothing to keep.
      return
    }
    if (state.refusedAtMs !== null) return report()
    const marginMs = options.marginMs ?? KEEPER_REFRESH_MARGIN_MS
    if (usable(state, now(), marginMs)) return
    try {
      await freshToken(options.configPath, {
        marginMs,
        now,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })
    } catch (error) {
      if (error instanceof RefreshRefused) report()
      // Anything else is retried on the next tick.
    }
  }
  const timer = setInterval(() => void tick(), options.intervalMs ?? KEEPER_INTERVAL_MS)
  // The session's life is its stdin and its SDK query, never this timer.
  ;(timer as { unref?: () => void }).unref?.()
  return { tick, stop: () => clearInterval(timer) }
}
