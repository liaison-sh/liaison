// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Liaison desktop sidecar entry point.
//
// The shell (Tauri) spawns this binary as an `externalBin` child process with
// piped stdio and no shell. Everything the sidecar needs arrives on argv or in
// the file named by `--mcp-config`; nothing is read from a shared config on
// disk, so the same binary serves a packaged app and a development run.
//
// The day one spike recorded GO, so the turn is hosted by the Agent SDK in
// this process (sdk-runner.ts). The argument surface and the stdio protocol
// below are independent of that choice, which is why the CLI stream fallback
// would have needed no change here.

import { tmpdir } from "node:os"
import { type AskContext, autoAllows, editRunsLater, liaisonOrigin } from "./auto-policy"
import {
  claudeAuthMain,
  claudeAuthMode,
  isBrowserSinkCall,
  isWatchdogCall,
  runBrowserSink,
  runWatchdog,
  watchdogTarget,
} from "./claude-auth"
import { isolatedConfigDir, realClaudeConfigDir } from "./config-isolation"
import { followMain } from "./follow-host"
import type { McpRelay } from "./mcp-relay"
import { relayFor } from "./mcp-relay"
import type { TokenKeeper } from "./mcp-token"
import {
  freshToken,
  headersHelperConfigPath,
  printMcpHeaders,
  startTokenKeeper,
  TURN_CREDENTIAL_PATTERN,
  writeTurnCredential,
} from "./mcp-token"
import { OutsideTextTracker } from "./outside-text"
import type { SdkModelInfo, SdkPermissionMode } from "./sdk-runner"
import {
  localModelsFrom,
  mapPermissionMode,
  modelDiscoveryQuery,
  readMcpConfig,
  runSession,
  systemPromptChecksum,
} from "./sdk-runner"
import { importMain } from "./session-import"
import { unattendedJobPath, unattendedMain } from "./unattended"

/**
 * How the session treats tool calls the model wants to make. Auto is the
 * default: Liaison tools and non-destructive commands run without asking
 * (auto-policy.ts); the others stay selectable.
 */
export const PERMISSION_MODES = ["auto", "manual", "edit", "plan", "bypass"] as const
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto"
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export interface SidecarConfig {
  /** Path to the JSON file naming the Liaison MCP endpoint and its token. */
  mcpConfigPath: string
  /** Working directory the session operates in. Defaults to the process cwd. */
  cwd: string
  permissionMode: PermissionMode
  /**
   * The model the turn runs on. Required and never defaulted: an end to end
   * run that is supposed to be on the cheap model must not be able to fall
   * through to whatever the SDK or the CLI would otherwise pick.
   */
  model: string
  /**
   * A session id the SDK resumes instead of starting fresh. The session id,
   * the context and the resume semantics are all the SDK's own: the sidecar
   * only carries the id back and forth.
   */
  resumeSessionId?: string
  /**
   * Run this session on a PRIVATE Claude Code config directory, carrying the
   * operator's login across but none of their own connectors (A29,
   * config-isolation.ts). The shell sets it for a role or system agent and
   * never for a personal one: a personal agent is meant to reach what its
   * owner reaches.
   */
  isolateConfig: boolean
}

/** The `--mcp-config` file's shape. Never committed, written per session. */
export interface McpConfigFile {
  liaisonMcpUrl: string
  agentScopedToken: string
  /**
   * The composed agent definition, appended after Claude Code's own system
   * prompt. Written by the shell from the Liaison definition route, so the
   * local session carries the same charter, skills and memory the server side
   * would carry.
   */
  agentDefinition: string
}

export const USAGE =
  "usage: liaison-sidecar --mcp-config <path> --model <model> [--cwd <path>] " +
  "[--permission-mode auto|manual|edit|plan|bypass] [--resume <sessionId>] [--isolate-config]"

export function parseArgs(argv: string[]): SidecarConfig {
  let mcpConfigPath: string | undefined
  let cwd: string | undefined
  let permissionMode: string | undefined
  let model: string | undefined
  let resumeSessionId: string | undefined
  let isolateConfig = false

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === "--mcp-config") {
      mcpConfigPath = value
      i++
    } else if (flag === "--cwd") {
      cwd = value
      i++
    } else if (flag === "--permission-mode") {
      permissionMode = value
      i++
    } else if (flag === "--model") {
      model = value
      i++
    } else if (flag === "--resume") {
      resumeSessionId = value
      i++
    } else if (flag === "--isolate-config") {
      // A switch, not a pair: it consumes no value, so the flag after it is
      // still read as a flag.
      isolateConfig = true
    } else {
      throw new Error(`unknown argument: ${flag}\n${USAGE}`)
    }
  }

  if (!mcpConfigPath) throw new Error(`missing --mcp-config\n${USAGE}`)
  if (!model) throw new Error(`missing --model\n${USAGE}`)
  if (permissionMode !== undefined && !isPermissionMode(permissionMode)) {
    throw new Error(`unknown permission mode: ${permissionMode}\n${USAGE}`)
  }

  return {
    mcpConfigPath,
    cwd: cwd ?? process.cwd(),
    permissionMode: permissionMode ?? DEFAULT_PERMISSION_MODE,
    model,
    resumeSessionId,
    isolateConfig,
  }
}

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * The protocol version the shell negotiates against.
 *
 * 2: the process is a SESSION rather than one turn. After boot it reads
 * control lines from stdin for its whole lifetime, and every turn runs inside
 * ONE SDK query fed by a streaming prompt, so the session id, the context and
 * the resume semantics are the SDK's own rather than something reinvented
 * here. `turn_done` closes each turn; `done` closes the process.
 */
export const PROTOCOL_VERSION = 2

/**
 * One event on stdout is one line of JSON. Line framing (not a length prefix)
 * keeps the stream readable when a human runs the binary by hand, and keeps
 * the shell's reader a plain line splitter.
 */
export function serializeEvent(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * The kinds of SDK event the shell renders differently. Every streamed SDK
 * message carries one, so the webview never has to know the SDK's own message
 * shapes to decide what to draw.
 */
export const EVENT_KINDS = [
  "init",
  "text",
  "text_delta",
  "thinking",
  "tool_use",
  "tool_result",
  "result",
  "other",
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export function classifyMessage(message: unknown): EventKind {
  const m = message as Record<string, any>
  if (!m || typeof m !== "object") return "other"
  if (m.type === "system" && m.subtype === "init") return "init"
  if (m.type === "stream_event") return "text_delta"
  if (m.type === "result") return "result"
  if (m.type === "assistant" || m.type === "user") {
    const blocks: Array<Record<string, any>> = m.message?.content ?? []
    for (const block of blocks) {
      if (block.type === "tool_use") return "tool_use"
      if (block.type === "tool_result") return "tool_result"
      if (block.type === "thinking") return "thinking"
      if (block.type === "text") return "text"
    }
  }
  return "other"
}

/** One streamed prompt, in the SDK's own `SDKUserMessage` shape. */
export interface SidecarUserMessage {
  type: "user"
  message: { role: "user"; content: string }
  parent_tool_use_id: null
}

export function userMessage(prompt: string): SidecarUserMessage {
  return { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null }
}

/**
 * The live session: the SDK's own `Query`, which is already an async iterable
 * of streamed messages AND carries `interrupt()` and `close()`.
 */
export type SessionHandle = AsyncIterable<unknown> & {
  interrupt?: () => Promise<unknown>
  close?: () => void
  /**
   * The SDK's own mid session mode change (`Query.setPermissionMode`). Optional
   * because a test runner stands in for the query, and because a session that
   * cannot change mode must degrade to "the next session gets it" rather than
   * crash the sidecar.
   */
  setPermissionMode?: (mode: SdkPermissionMode) => Promise<unknown>
  /**
   * The SDK's own model list (`Query.supportedModels`). Optional for the same
   * reasons: a test runner stands in for the query, and a session that cannot
   * say simply leaves the shell offering what it already offers.
   */
  supportedModels?: () => Promise<SdkModelInfo[]>
  /**
   * The SDK's own `Query.reconnectMcpServer`: the CLI connects the server
   * again, which re-runs its `headersHelper` (measured on CLI 2.1.296 and
   * 2.1.286, OPEN-4). It is how a turn's credential reaches the gateway (S59).
   */
  reconnectMcpServer?: (serverName: string) => Promise<void>
}

/**
 * The SDK's own `PermissionResult`, narrowed to the two shapes the host can
 * ask for. The names are the SDK's, not Liaison's: this value is returned
 * straight out of `Options.canUseTool`.
 */
export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }

/** The SDK's `canUseTool` signature, as far as the sidecar uses it. */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { suggestions?: unknown[] } & AskContext,
) => Promise<PermissionResult>

/** What a host that never answers a permission request is told to have said. */
export const HOST_DISCONNECTED = "host disconnected"

/** What a parked permission request is answered with when the user stops the turn. */
export const INTERRUPTED_BY_USER = "the user stopped this turn"

/**
 * A MODE CHANGE THAT DID NOT HAPPEN, as its own line (P6d-FX2, SK-3, SK-4).
 *
 * It is not an `error`: the shell and the turn loop both read `error` as "the
 * turn is over", and this says nothing about the turn. It is not silence
 * either, which is what an optional-chained call plus an unconditional success
 * line amounted to: the window has to hear that the mode it asked for is not
 * the mode the session is running in.
 */
export const PERMISSION_MODE_REFUSED = "permission_mode_refused"

/** The reason a session whose query cannot change mode at all is refused with. */
export const SESSION_CANNOT_CHANGE_MODE = "SessionCannotChangeMode"

/**
 * THE SERVER REFUSED TO RENEW THE SESSION'S LIAISON MCP TOKEN: the connection
 * was revoked, so no renewal will ever work again and only a new approval in
 * the browser brings the tools back. The shell answers it with its reconnect
 * event (`TokenRefreshFailed`), which is the "your connection needs to be
 * renewed" flow, instead of the session carrying on into a wall of 401s. It
 * carries no token and no server detail.
 */
export const MCP_TOKEN_REFUSED = "mcp_token_refused"

/**
 * THE MODELS THIS SDK CAN RUN, said once per session (`{"type":"local_models",
 * "models":[{id,label}]}`), so the shell offers what the installed Agent SDK
 * advertises instead of a list written into the app. Nothing is said when the
 * SDK cannot answer in time: the shell keeps what it offered.
 */
export const LOCAL_MODELS = "local_models"

/**
 * How long the session waits for the model list. It is a control request to
 * a CLI that is already starting for the session, answered with its
 * initialization, so a few seconds is normal and anything past this is a CLI
 * that will not say.
 */
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000

/**
 * Asks the running session which models it offers and says them on stdout.
 *
 * COSTS NO TURN AND NO PROCESS. The list is part of the CLI's initialization
 * answer, which the session's own query receives whether or not anybody asks,
 * so asking starts nothing: no model call, no second CLI. Never throws and
 * never blocks a turn: a failure is one stderr line, and the shell keeps its
 * fallback.
 */
export async function announceLocalModels(
  session: SessionHandle,
  emit: (event: Record<string, unknown>) => void,
  timeoutMs: number = MODEL_DISCOVERY_TIMEOUT_MS,
): Promise<void> {
  const list = session.supportedModels
  if (!list) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    const infos = await Promise.race([list.call(session), timedOut])
    if (!infos) {
      process.stderr.write(`model discovery: no answer within ${timeoutMs} ms\n`)
      return
    }
    const models = localModelsFrom(infos)
    if (models.length > 0) emit({ type: LOCAL_MODELS, models })
  } catch (error) {
    process.stderr.write(`model discovery failed: ${(error as Error).message || String(error)}\n`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** `liaison-sidecar --import <request file>`: the session import's listing or check (S40, A42). */
export const IMPORT_FLAG = "--import"

/** The request file of an import call, or null when this run is not one. */
export function importRequestPath(argv: readonly string[]): string | null {
  return argv.length === 2 && argv[0] === IMPORT_FLAG && argv[1] ? argv[1] : null
}

/** `liaison-sidecar --follow`: the node's one follow host (follow-host.ts, W3 T06; D28 b, A45). */
export const FOLLOW_FLAG = "--follow"

/** Whether this run is the follow host, and nothing else. */
export function isFollowHostCall(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === FOLLOW_FLAG
}

/** `liaison-sidecar --local-models`: the bundled SDK's model list, then out. */
export const LOCAL_MODELS_FLAG = "--local-models"

/** Whether this run is a model discovery and nothing else. */
export function isLocalModelsCall(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === LOCAL_MODELS_FLAG
}

/**
 * THE NODE'S MODELS WITHOUT A SESSION (`--local-models`). A node that never
 * ran a local chat heard no `local_models` line, so it published the
 * fallback written into the app instead of what its SDK offers. The shell
 * runs this once per launch, which is also once per app (and so SDK) update.
 *
 * Exactly one line, always: the list, or `{"type":"local_models","error":…}`
 * when the SDK did not say, so the shell never waits out its own timeout on a
 * discovery that already failed.
 */
export async function localModelsMain(
  cliPath: string | null,
  io: {
    write?: (line: string) => void
    query?: (cliPath: string | null) => SessionHandle
    timeoutMs?: number
  } = {},
): Promise<number> {
  const write = io.write ?? ((line: string) => process.stdout.write(line))
  let said = false
  let run: SessionHandle | null = null
  try {
    run = (io.query ?? ((cli) => modelDiscoveryQuery(cli, tmpdir())))(cliPath)
    await announceLocalModels(
      run,
      (event) => {
        said = true
        write(serializeEvent(event))
      },
      io.timeoutMs,
    )
  } catch (error) {
    process.stderr.write(`model discovery failed: ${(error as Error).message || String(error)}\n`)
  } finally {
    run?.close?.()
  }
  if (!said) write(serializeEvent({ type: LOCAL_MODELS, error: "unavailable" }))
  return said ? 0 : 1
}

export interface PermissionBroker {
  canUseTool: CanUseTool
  /** Asks the host, whatever the mode would allow on its own. */
  ask(toolName: string, input: Record<string, unknown>): Promise<PermissionResult>
  /** True when the id named a request that was still waiting. */
  resolve(
    requestId: string,
    behavior: "allow" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): boolean
  /** Deny everything still waiting, and keep asking from here on (an interrupt). */
  denyPending(message: string): void
  /** Deny everything still waiting, and everything asked from here on. */
  failClosed(): void
}

/**
 * Turns the SDK's `canUseTool` callback into a `permission_request` the host
 * answers on stdin.
 *
 * FAIL CLOSED is the whole point. The SDK parks a tool call until the callback
 * settles and there is no deadline on it, so a host that dies mid prompt would
 * otherwise leave the tool blocked forever with nobody told. Every pending
 * request is denied the moment the host's stdin closes or the session shuts
 * down, and nothing is ever auto-answered for any other reason.
 */
export function createPermissionBroker(
  emit: (event: Record<string, unknown>) => void,
  /**
   * Answers yes without asking the host, for the calls the current mode runs
   * on its own (Auto, auto-policy.ts). Anything it does not allow is asked
   * exactly as before; it never denies.
   */
  allowsWithoutAsking: (
    toolName: string,
    input: Record<string, unknown>,
    options: AskContext,
  ) => boolean = () => false,
): PermissionBroker {
  // The tool's own input is kept beside the waiter: an allow with no edit has
  // to hand that input back, and the host is not asked to echo it.
  const pending = new Map<
    string,
    { settle: (result: PermissionResult) => void; input: Record<string, unknown> }
  >()
  let disconnected = false
  let counter = 0
  const askHost = (
    toolName: string,
    input: Record<string, unknown>,
    options?: { suggestions?: unknown[] },
  ): Promise<PermissionResult> => {
    if (disconnected) {
      return Promise.resolve({ behavior: "deny", message: HOST_DISCONNECTED })
    }
    counter += 1
    const requestId = `perm-${counter}`
    return new Promise<PermissionResult>((settle) => {
      pending.set(requestId, { settle, input })
      emit({
        type: "permission_request",
        requestId,
        toolName,
        input,
        ...(options?.suggestions ? { suggestions: options.suggestions } : {}),
      })
    })
  }
  return {
    canUseTool: (toolName, input, options) => {
      if (disconnected) {
        return Promise.resolve({ behavior: "deny", message: HOST_DISCONNECTED })
      }
      if (allowsWithoutAsking(toolName, input, options ?? {})) {
        return Promise.resolve({ behavior: "allow", updatedInput: input })
      }
      return askHost(toolName, input, options)
    },
    ask: (toolName, input) => askHost(toolName, input),
    resolve: (requestId, behavior, message, updatedInput) => {
      const waiter = pending.get(requestId)
      if (!waiter) return false
      pending.delete(requestId)
      if (behavior === "allow") {
        // The SDK re-reads the input from the result, so an unedited allow has
        // to hand the tool's own input back rather than an empty object.
        waiter.settle({ behavior: "allow", updatedInput: updatedInput ?? waiter.input })
      } else {
        waiter.settle({ behavior: "deny", message: message ?? "denied by the host" })
      }
      return true
    },
    denyPending: (message) => {
      for (const [requestId, waiter] of pending) {
        pending.delete(requestId)
        waiter.settle({ behavior: "deny", message })
      }
    },
    failClosed: () => {
      disconnected = true
      for (const [requestId, waiter] of pending) {
        pending.delete(requestId)
        waiter.settle({ behavior: "deny", message: HOST_DISCONNECTED })
      }
    },
  }
}

export interface SessionRunnerArgs {
  config: SidecarConfig
  /** Every turn's prompt, streamed for the life of the session. */
  prompts: AsyncIterable<SidecarUserMessage>
  /** Installed as the SDK's `Options.canUseTool` for the whole session. */
  canUseTool: CanUseTool
  /**
   * Installed as a PreToolUse hook: runs before EVERY tool call, including the
   * file edits acceptEdits runs without asking. Resolves to a reason to refuse
   * the call, or null to let the call go on as it would have.
   */
  guardTool?: ToolGuard
}

/** A PreToolUse guard (see `SessionRunnerArgs.guardTool`). */
export type ToolGuard = (toolName: string, input: Record<string, unknown>) => Promise<string | null>

export type SessionRunner = (args: SessionRunnerArgs) => SessionHandle

/**
 * A one-writer, one-reader queue with no back pressure. It is what turns the
 * host's control lines into the SDK's streaming prompt input: the host may
 * send a turn while the previous one is still streaming, and the SDK reads the
 * next prompt when it is ready for it.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      },
    }
  }
}

/** The control lines the host may send, one JSON object per line. */
export type ControlLine =
  /**
   * `turnCredential` (S59, D36): the server-minted credential of the person's
   * message this turn answers, composed by the shell (`sidecar.rs`
   * `turn_line_with_credential`). Absent on a turn that has none.
   */
  | { type: "turn"; prompt: string; turnCredential?: string }
  | { type: "interrupt" }
  | {
      type: "permission_response"
      requestId: string
      behavior: "allow" | "deny"
      message?: string
      updatedInput?: Record<string, unknown>
    }
  | { type: "mcp_call"; requestId: string; tool: string; args: Record<string, unknown> }
  /**
   * The mode this session asks in, CHANGED while it runs. Without it the mode
   * was consumed once, at start, so the composer's menu changed a pill and a
   * stored preference while the live session kept running under the old rules.
   */
  | { type: "set_permission_mode"; mode: PermissionMode }
  | { type: "shutdown" }

export interface RunMainOptions {
  config: SidecarConfig
  runner: SessionRunner
  write?: (line: string) => void
  /** Control lines from the host, one JSON object per line, for the lifetime. */
  control?: AsyncIterable<string>
  /** The Claude Code executable this session runs, once it is on a real path. */
  cliPath?: string | null
  /** When the process started, for the cold start measurement. */
  startedAtMs?: number
  /** sha256 of the agent definition this session appended to the system prompt. */
  systemPromptChecksum?: string
  /** How an `mcp_call` control line reaches the Liaison gateway. */
  relay?: McpRelay
  /**
   * Keeps the session's MCP token renewed for the session's life, calling
   * `onRefused` once if the server refuses a renewal (`mcp-token.ts`).
   */
  tokenKeeper?: (onRefused: () => void) => TokenKeeper
  /** How long a turn waits for the `liaison` reconnect before it runs anyway. */
  turnReconnectTimeoutMs?: number
}

/** The Liaison server's name in the session's `mcpServers` (`sdk-runner.ts`). */
export const LIAISON_MCP_SERVER = "liaison"
export const TURN_RECONNECT_TIMEOUT_MS = 3_000

/**
 * PUTS THIS TURN'S CREDENTIAL ON THE CONNECTION (S59, D36, OPEN-4). The CLI
 * runs the headers helper only when it connects, and one query serves every
 * turn of the session, so the credential is written where the helper reads it
 * and the `liaison` server is connected again before the prompt goes in. A
 * turn without one deletes the previous turn's and reconnects only when there
 * was one to drop. The reconnect is bounded and never fatal: a turn whose
 * connection could not be made again still runs, its calls simply lack the
 * credential, and the gateway refuses them as it does without one.
 */
async function applyTurnCredential(
  configPath: string,
  credential: unknown,
  session: SessionHandle,
  timeoutMs: number,
): Promise<void> {
  const valid =
    typeof credential === "string" && TURN_CREDENTIAL_PATTERN.test(credential) ? credential : null
  let hadOne = false
  try {
    hadOne = writeTurnCredential(configPath, valid)
  } catch (error) {
    process.stderr.write(`liaison-sidecar: turn credential not written: ${(error as Error).name}\n`)
    return
  }
  if (!valid && !hadOne) return
  const reconnect = session.reconnectMcpServer
  if (!reconnect) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      reconnect.call(session, LIAISON_MCP_SERVER),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs)
      }),
    ])
  } catch (error) {
    process.stderr.write(
      `liaison-sidecar: reconnecting ${LIAISON_MCP_SERVER} before the turn failed: ${(error as Error).message}\n`,
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * AFTER OUTSIDE TEXT, AN EDIT THAT RUNS LATER ASKS. acceptEdits runs a file
 * edit inside the folder without ever calling `canUseTool`, so a model could
 * plant a git hook, a package script or an `.envrc` for an innocent-looking
 * later command. Once `active()` says the session is in Auto and read outside
 * text, such an edit (auto-policy.ts `editRunsLater`) waits for the person;
 * every other edit goes on as before.
 */
export function guardRunnableEdits(
  active: () => boolean,
  cwd: string,
  permissions: Pick<PermissionBroker, "ask">,
): ToolGuard {
  return async (toolName, input) => {
    if (!active() || !editRunsLater(toolName, input, cwd)) return null
    const decision = await permissions.ask(toolName, input)
    return decision.behavior === "allow" ? null : (decision.message ?? "denied by the person")
  }
}

/** The session id an SDK message carries, when it carries one. */
export function sessionIdOf(message: unknown): string | null {
  const id = (message as { session_id?: unknown })?.session_id
  return typeof id === "string" && id.length > 0 ? id : null
}

/** The https origin of the Liaison server the MCP config names, or null. */
function boundOrigin(mcpConfigPath: string): string | null {
  try {
    return liaisonOrigin(readMcpConfig(mcpConfigPath).liaisonMcpUrl)
  } catch {
    return null
  }
}

/**
 * Drives the whole session and frames it onto stdout. Returns the process exit
 * code, so the caller decides whether to exit rather than this function ending
 * the process out from under a test.
 */
export async function runMain(options: RunMainOptions): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(line))
  const emit = (event: Record<string, unknown>) => write(serializeEvent(event))
  // The handshake. It goes out before anything can fail, so a sidecar that
  // dies on its first turn still told the host what it is and which Claude
  // Code executable it resolved.
  emit({
    type: "boot",
    protocolVersion: PROTOCOL_VERSION,
    cwd: options.config.cwd,
    cliPath: options.cliPath ?? null,
  })

  const prompts = new AsyncQueue<SidecarUserMessage>()
  const keeper = options.tokenKeeper?.(() => emit({ type: MCP_TOKEN_REFUSED }))
  // The mode the session runs in NOW: it starts as configured and follows
  // every mode change the SDK acknowledged.
  let currentMode: PermissionMode = options.config.permissionMode
  // Every message of the session passes through it below, so once a tool
  // result carried outside text Auto asks before any shell command for the rest
  // of the session (outside-text.ts).
  // A resumed session carries earlier results this process never saw. A
  // result the CLI saved to a file is read from its store in the config dir
  // the session runs on (sdk-runner.ts `claudeConfigEnv`). A fetch from the
  // Liaison server the session is bound to reads the organisation's own data.
  const ownOrigin = boundOrigin(options.config.mcpConfigPath)
  const outsideText = new OutsideTextTracker(options.config.cwd, {
    resumed: Boolean(options.config.resumeSessionId),
    configDir: options.config.isolateConfig ? isolatedConfigDir() : realClaudeConfigDir(),
    ownOrigin,
  })
  const permissions = createPermissionBroker(
    emit,
    (toolName, input, context) =>
      currentMode === "auto" &&
      autoAllows(toolName, input, options.config.cwd, context, {
        readOutsideText: outsideText.readOutsideText,
        ownOrigin,
      }),
  )
  const session = options.runner({
    config: options.config,
    prompts,
    canUseTool: permissions.canUseTool,
    guardTool: guardRunnableEdits(
      () => currentMode === "auto" && outsideText.readOutsideText,
      options.config.cwd,
      permissions,
    ),
  })
  // Not awaited: the list rides the session's own start and must never hold
  // up its first turn.
  void announceLocalModels(session, emit)

  const shutdown = () => {
    // Closing the prompt stream is what ends the SDK's own iteration, and with
    // it the loop below. Every parked permission request is denied first: a
    // tool call the host can no longer answer must not stay parked forever.
    permissions.failClosed()
    prompts.close()
    keeper?.stop()
    // The turn's credential never outlives the session (S59).
    try {
      writeTurnCredential(options.config.mcpConfigPath, null)
    } catch {
      // Nothing to delete.
    }
  }

  const control = options.control
  const controlDone = control
    ? (async () => {
        for await (const line of control) {
          if (!line.trim()) continue
          let parsed: ControlLine
          try {
            parsed = JSON.parse(line) as ControlLine
          } catch {
            emit({ type: "error", message: `unreadable control line: ${line.slice(0, 200)}` })
            continue
          }
          if (parsed.type === "turn") {
            // A turn is the moment a token is about to be needed: one look
            // now, rather than up to a keeper interval later. Not awaited, so a
            // slow server never holds the prompt back (the headers helper
            // renews on its own when the CLI connects or meets a 401).
            if (keeper) void keeper.tick()
            await applyTurnCredential(
              options.config.mcpConfigPath,
              parsed.turnCredential,
              session,
              options.turnReconnectTimeoutMs ?? TURN_RECONNECT_TIMEOUT_MS,
            )
            prompts.push(userMessage(parsed.prompt))
          } else if (parsed.type === "interrupt") {
            // A turn parked on a permission question is stopped too: the
            // question is answered no, so the SDK is not left waiting on a
            // callback nobody will settle.
            permissions.denyPending(INTERRUPTED_BY_USER)
            await session.interrupt?.()
            emit({ type: "interrupted" })
          } else if (parsed.type === "permission_response") {
            permissions.resolve(
              parsed.requestId,
              parsed.behavior,
              parsed.message,
              parsed.updatedInput,
            )
          } else if (parsed.type === "mcp_call") {
            // Not awaited: a slow tool must not stall the next turn line.
            const call = parsed
            void (async () => {
              // Nothing awaits this, so a throw here would be an unhandled
              // rejection and a host waiting forever for its mcp_result. Every
              // path out of it emits one.
              try {
                const relay = options.relay
                const outcome = relay
                  ? await relay(call.tool, call.args)
                  : { error: { message: "no MCP relay configured" } }
                emit({ type: "mcp_result", requestId: call.requestId, ...outcome })
              } catch (error) {
                emit({
                  type: "mcp_result",
                  requestId: call.requestId,
                  error: { message: (error as Error).message || String(error) },
                })
              }
            })()
          } else if (parsed.type === "set_permission_mode") {
            // The shell validated the mode and asked the bypass question
            // before composing this line; an unmapped one still never reaches
            // the SDK, because the whole session would die with it.
            //
            // THE SDK HAS TO HAVE SAID YES (P6d-FX2, SK-4). The call used to be
            // optional-chained and the success line emitted unconditionally, so
            // a session whose query cannot change mode reported that it had:
            // the window wrote the preference, the pill read the new mode, and
            // the running session kept its old rules.
            const apply = session.setPermissionMode
            if (!apply) {
              emit({
                type: PERMISSION_MODE_REFUSED,
                mode: parsed.mode,
                reason: SESSION_CANNOT_CHANGE_MODE,
              })
            } else {
              try {
                await apply.call(session, mapPermissionMode(parsed.mode))
                currentMode = parsed.mode
                emit({ type: "permission_mode", mode: parsed.mode })
              } catch (error) {
                // NOT an `error` line (P6d-FX2, SK-3). Every reader of this
                // stream takes `error` for the end of the turn, and a refused
                // mode change is the end of nothing: it cleared the permission
                // card the SDK was still parked on and posted whatever text had
                // arrived as the agent's finished reply, while the real turn
                // kept running.
                emit({
                  type: PERMISSION_MODE_REFUSED,
                  mode: parsed.mode,
                  reason: (error as Error).message || String(error),
                })
              }
            }
          } else if (parsed.type === "shutdown") {
            shutdown()
            return
          }
        }
        // Stdin closed without a shutdown line: the host is gone.
        shutdown()
      })()
    : Promise.resolve()

  const startedAtMs = options.startedAtMs ?? Date.now()
  let ready = false
  let sessionAnnounced = false
  let exitCode = 0
  try {
    for await (const message of session) {
      if (!ready) {
        ready = true
        // The first message the runner produces is the SDK's init, which it
        // sends once the tool catalog is connected. That instant is the cold
        // start budget's endpoint, so it is reported before the message that
        // marks it.
        emit({
          type: "ready",
          sidecarReadyMs: Date.now() - startedAtMs,
          systemPromptChecksum: options.systemPromptChecksum ?? null,
        })
      }
      if (!sessionAnnounced) {
        const sessionId = sessionIdOf(message)
        if (sessionId) {
          sessionAnnounced = true
          emit({ type: "session", sessionId })
        }
      }
      outsideText.observe(message)
      emit({ type: "message", event: classifyMessage(message), payload: message })
      // One result message ends one turn. The session stays up for the next.
      if ((message as { type?: string })?.type === "result") emit({ type: "turn_done" })
    }
  } catch (error) {
    emit({ type: "error", message: (error as Error).message })
    exitCode = 1
  }
  shutdown()
  // The control reader is NOT awaited here: it may be parked on a stdin read
  // that will never return, and a session whose SDK query has ended must not
  // hold the process open waiting for a host that has nothing left to say.
  // It is referenced so the promise is not treated as dropped work.
  void controlDone
  emit({ type: "done" })
  return exitCode
}

/** Splits a byte stream into newline terminated lines, one at a time. */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffered = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
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
 * The process entry. `cliPath` is the Claude Code executable extracted from
 * the compiled binary's own virtual filesystem; a plain `bun index.ts` run
 * passes null and lets the SDK resolve its own.
 */
export async function main(cliPath: string | null = null): Promise<number> {
  const startedAtMs = Date.now()
  const argv = process.argv.slice(2)
  // THE CLI'S BROWSER, during an in-app Claude sign-in (claude-auth.ts): one
  // URL to write down for the shell to open, then out.
  if (isBrowserSinkCall(argv)) return runBrowserSink(argv)
  // THE SIGN-IN'S WATCHDOG (claude-auth.ts): ends the CLI if the sidecar that
  // started it is killed outright.
  if (isWatchdogCall(argv)) {
    const target = watchdogTarget(argv)
    return target ? runWatchdog(target) : 2
  }
  // AN UNATTENDED NODE JOB (unattended.ts, P4 N-D T5): one job file, no
  // session flags, no permission prompts. Checked before the session parse so
  // a job can never fall through into an interactive session.
  if (unattendedJobPath(argv) !== null) return unattendedMain(argv, cliPath)
  // THE BUNDLED SDK'S MODELS (P1 node models): one line, no session.
  if (isLocalModelsCall(argv)) return localModelsMain(cliPath)
  // THE SESSION IMPORT (session-import.ts, W3 T05): one listing or check of
  // the owner's sessions in shared folders, one line, no session.
  const importRequest = importRequestPath(argv)
  if (importRequest !== null) return importMain(importRequest)
  // THE FOLLOW HOST (follow-host.ts, W3 T06): every follow of the node, fed
  // control lines on stdin until `shutdown` or EOF. No session flags.
  if (isFollowHostCall(argv)) return followMain({ lines: readLines(Bun.stdin.stream()) })
  // THE CLAUDE SIGN-IN ITSELF (claude-auth.ts): status, login or logout of the
  // CLI's own account. Not a session, and none of a session's flags.
  if (claudeAuthMode(argv) !== null) return claudeAuthMain(argv, cliPath)
  // THE HEADERS HELPER (mcp-token.ts): the CLI runs this binary for the Liaison
  // server's headers. It is not a session and needs none of a session's flags.
  if (headersHelperConfigPath(process.argv.slice(2)) !== null) {
    return printMcpHeaders(process.argv.slice(2))
  }
  let config: SidecarConfig
  try {
    config = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }
  let mcp: McpConfigFile
  try {
    mcp = readMcpConfig(config.mcpConfigPath)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }
  // Every line is a control line now: the session reads them for its whole
  // lifetime, and a turn is one of them rather than the first one.
  return runMain({
    config,
    cliPath,
    startedAtMs,
    systemPromptChecksum: systemPromptChecksum(mcp),
    relay: relayFor(mcp, (force) => freshToken(config.mcpConfigPath, { force })),
    tokenKeeper: (onRefused) => startTokenKeeper({ configPath: config.mcpConfigPath, onRefused }),
    runner: ({ config: sessionConfig, prompts, canUseTool, guardTool }) =>
      runSession(sessionConfig, prompts, cliPath, mcp, canUseTool, guardTool),
    control: readLines(Bun.stdin.stream()),
  })
}

if (import.meta.main) {
  process.exit(await main())
}
