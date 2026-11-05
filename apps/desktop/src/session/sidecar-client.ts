// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The overlay's whole view of the shell. Every name in here is cited from
// `sidecar-ipc-contract.md`, and no component below this module may import
// `@tauri-apps/api` (only `src/tauri.ts` does, and only this module imports
// that): a component that reaches for the shell directly cannot be rendered
// under jsdom, and there is no second seam to stub.
//
// Session state lives at module scope because there is exactly one sidecar per
// window (`sidecar.rs:383-384` stops the previous child on a second start), so
// a per-caller client object would be a lie about how many sessions exist.

import type {
  DesktopUpdateProgress,
  VerifiedFirstPartyApp,
} from "@liaison/web/lib/desktop-shell-contract"
import { createSignal } from "solid-js"
import { invoke, listen } from "../tauri"
import type { AgentKind } from "./agent-definition-client"
import {
  BANNER_RECONNECT_REQUIRED,
  FILE_ERROR_NO_SESSION,
  FILE_ERROR_OUTSIDE_SESSION_FOLDER,
  FILE_ERROR_TOO_LARGE,
  START_ERROR_BYPASS_DECLINED,
  START_ERROR_CWD_NOT_A_DIRECTORY,
  START_ERROR_DEVICE_CLIENT_NOT_ALLOWED,
  START_ERROR_MODE_DECLINED,
  START_ERROR_SIDECAR_EXITED,
  START_ERROR_UNKNOWN,
  START_ERROR_UNKNOWN_PERMISSION_MODE,
} from "./desktop-copy"
import { SIDECAR_EXITED_TYPE } from "./sidecar-exit"

/** The Tauri event carrying one protocol 2 JSON line (`sidecar.rs:25-26`). */
export const SIDECAR_LINE_EVENT = "sidecar-line"
/** The Tauri event the UI renders as a visible reconnect state (`sidecar.rs:29-30`). */
export const RECONNECT_EVENT = "liaison-reconnect-required"

/**
 * THE RUNNING SESSION'S SIDECAR EXITED ON ITS OWN (`sidecar_watch.rs`).
 *
 * The shell emits it for a child that was still the running session when it
 * died, with what it last wrote to stderr; a child the shell stopped itself is
 * never reported, and one that dies before its `boot` line refuses the start
 * instead (`SidecarExited: <reason>`). This module hands it to every turn
 * listener as a `sidecar_exited` event, because every one of them has
 * something to settle: the turn waiting for its end, the claim, the state.
 */
export const SIDECAR_EXITED_EVENT = "sidecar-exited"
/** The `type` the exit is dispatched with to `onTurnEvent` listeners. */
export { SIDECAR_EXITED_TYPE }

/** One exit, as the shell reports it. */
export interface SidecarExitReport extends SidecarEvent {
  type: typeof SIDECAR_EXITED_TYPE
  code: number | null
  signal: number | null
  /** Whether the child had written its `boot` line. */
  booted: boolean
  /** One line: what it last said, or how it ended. */
  reason: string
  stderrTail: string[]
}

/**
 * The shell's own device grant, which runs when a LOCAL SESSION starts: the
 * sidecar needs an agent-scoped token and `ensure_fresh_token` mints one
 * through the device flow, emitting the verification URI it wants approved
 * (`src-tauri/src/sidecar.rs`). It is never the user's login.
 */
export const DEVICE_APPROVAL_EVENT = "liaison-device-approval"
/**
 * An in-app update being downloaded or installed (`src-tauri/src/updater.rs`,
 * `show_progress`): `{ version, phase, percent }`, or null when it stopped.
 */
export const UPDATE_PROGRESS_EVENT = "liaison-update-progress"
/** How long an `mcp_call` may go unanswered before the caller is told. */
export const MCP_CALL_TIMEOUT_MS = 30_000

/** The permission modes a session may run in (`sidecar/index.ts:20`). */
export type PermissionMode = "auto" | "manual" | "edit" | "plan" | "bypass"

/** The mode a session starts in when nobody chose one (sidecar/auto-policy.ts). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto"

export interface StartSessionOptions {
  agentId: string
  cwd: string
  permissionMode: PermissionMode
  model: string
  /** A previous session's id, to resume it rather than start a new one. */
  resumeSessionId?: string | null
  /**
   * The composed definition the WINDOW fetched from the definition route. The
   * shell writes it into the session's MCP config and the sidecar appends it
   * to Claude Code's own system prompt, so the checksum reported on `ready` is
   * the checksum of this exact text.
   */
  agentDefinition: string
  /**
   * `personal` | `role` | `system`. It decides one thing: a personal agent
   * keeps the operator's own Claude Code connectors, every other kind runs on
   * an isolated config.
   */
  agentKind: AgentKind
  /**
   * The window's signed in access token. The shell uses it to create the
   * agent's MCP connection when it has none stored, so a signed in user is
   * never asked to approve a device code in a browser.
   */
  accessToken: string
}

/** One parsed protocol 2 line. The `type` field is what everything dispatches on. */
export interface SidecarEvent {
  type: string
  [key: string]: unknown
}

export interface PermissionPrompt extends SidecarEvent {
  type: "permission_request"
  requestId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
}

export interface SidecarReadiness {
  sidecarReadyMs: number
  systemPromptChecksum: string | null
}

/** Whether the window still believes it is talking to a live sidecar. */
export type SidecarHealth = "unknown" | "ready" | "disconnected"

/** Why the shell gave up on the session (`sidecar.rs:408-409`). */
export type ReconnectReason =
  | "TokenRefreshFailed"
  | "ConfigUnwritable"
  | "SidecarSpawnFailed"
  | "NotApproved"
  | "GrantFailed"
  | "Unreachable"
  | "DeviceClientNotAllowed"

/**
 * The shell's refusals, in words. Both commands answer with a VARIANT and the
 * window renders the copy (`sidecar-ipc-contract.md`), so this is the one
 * place a variant becomes a sentence. A variant with no entry here still
 * reaches the window as a typed error, carrying the fallback copy and the raw
 * variant: a banner that says nothing is worse than one that says "try again".
 */
const SHELL_ERROR_COPY: Record<string, string> = {
  UnknownPermissionMode: START_ERROR_UNKNOWN_PERMISSION_MODE,
  CwdNotADirectory: START_ERROR_CWD_NOT_A_DIRECTORY,
  BypassDeclined: START_ERROR_BYPASS_DECLINED,
  ModeDeclined: START_ERROR_MODE_DECLINED,
  // The three reconnect reasons and the unapproved grant are one sentence on
  // purpose: all four are fixed by reconnecting, and naming which internal
  // step failed helps nobody.
  TokenRefreshFailed: BANNER_RECONNECT_REQUIRED,
  ConfigUnwritable: BANNER_RECONNECT_REQUIRED,
  SidecarSpawnFailed: BANNER_RECONNECT_REQUIRED,
  NotApproved: BANNER_RECONNECT_REQUIRED,
  GrantFailed: BANNER_RECONNECT_REQUIRED,
  Unreachable: BANNER_RECONNECT_REQUIRED,
  DeviceClientNotAllowed: START_ERROR_DEVICE_CLIENT_NOT_ALLOWED,
  SidecarExited: START_ERROR_SIDECAR_EXITED,
  NoSession: FILE_ERROR_NO_SESSION,
  OutsideSessionFolder: FILE_ERROR_OUTSIDE_SESSION_FOLDER,
  TooLarge: FILE_ERROR_TOO_LARGE,
}

/**
 * A refusal that carries words of its own after its variant:
 * `SidecarExited: unknown permission mode: auto`. The variant is a bare
 * identifier, so a sentence with a colon in it is never mistaken for one.
 */
export function splitRefusal(raw: string): { variant: string; detail: string | null } {
  const match = /^([A-Z][A-Za-z]+): ([\s\S]+)$/.exec(raw)
  if (!match) return { variant: raw, detail: null }
  return { variant: match[1] as string, detail: (match[2] as string).trim() || null }
}

/** One refusal from the shell, as the window says it. */
export class ShellRefusalError extends Error {
  /** The shell's own variant, for a caller that has to branch on it. */
  readonly variant: string
  /** What the shell said beyond the variant (a dead sidecar's stderr), or null. */
  readonly detail: string | null
  constructor(raw: string, fallback: string) {
    const { variant, detail } = splitRefusal(raw)
    super(SHELL_ERROR_COPY[variant] ?? fallback)
    this.name = "ShellRefusalError"
    this.variant = variant
    this.detail = detail
  }
}

/** `start_session` refused, or died before the child existed. */
export class StartSessionError extends ShellRefusalError {
  constructor(variant: string) {
    super(variant, START_ERROR_UNKNOWN)
    this.name = "StartSessionError"
  }
}

/** `set_permission_mode` refused: an unknown mode, or a declined bypass. */
export class PermissionModeError extends ShellRefusalError {
  constructor(variant: string) {
    super(variant, START_ERROR_UNKNOWN)
    this.name = "PermissionModeError"
  }
}

/** `read_local_file` refused. */
export class LocalFileError extends ShellRefusalError {
  constructor(variant: string) {
    super(variant, FILE_ERROR_NO_SESSION)
    this.name = "LocalFileError"
  }
}

/**
 * What the shell actually rejected with. A Tauri command returning
 * `Err(String)` rejects with the STRING itself, not with an Error, and a
 * failure inside the bridge rejects with an Error: both have to read as the
 * same variant.
 */
function variantOf(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return String(error)
}

const [healthSignal, setHealth] = createSignal<SidecarHealth>("unknown")
export const health = healthSignal

// Kept apart from `health`, because a session the shell ASKED us to reconnect
// is a different thing to say than a session that simply stopped answering:
// one names a credential or a config to fix, the other does not.
const [reconnectReasonSignal, setReconnectReason] = createSignal<string | null>(null)
export const reconnectReason = reconnectReasonSignal

const [deviceApprovalSignal, setDeviceApproval] = createSignal<string | null>(null)
/** The verification URI the shell is waiting to have approved, or null. */
export const deviceApproval = deviceApprovalSignal

const [updateProgressSignal, setUpdateProgress] = createSignal<DesktopUpdateProgress | null>(null)
/** The update the shell is downloading or installing, or null. */
export const updateProgress = updateProgressSignal

/**
 * The shell's update event, read strictly: anything that is not the shape
 * `updater.rs` sends is null, so a malformed payload takes the card down
 * rather than drawing one with no version on it.
 */
export function updateProgressFrom(payload: unknown): DesktopUpdateProgress | null {
  if (payload === null || typeof payload !== "object") return null
  const { version, phase, percent } = payload as Record<string, unknown>
  if (typeof version !== "string" || version.length === 0) return null
  if (phase !== "downloading" && phase !== "installing") return null
  if (percent === null || percent === undefined) return { version, phase, percent: null }
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null
  return { version, phase, percent: Math.min(100, Math.max(0, Math.round(percent))) }
}

/**
 * THE CONVERSATION IS NO LONGER OURS (A32).
 *
 * The claim's heartbeat stopped getting through, so the lease is lapsing or has
 * lapsed and the server is answering that conversation again. It reads as a
 * disconnected session on purpose: from where the user sits, this window has
 * stopped being the thing that answers, which is exactly what the reconnect
 * banner is for.
 */
export const CONVERSATION_LOST_REASON = "ConversationLost"

export function reportConversationLost(): void {
  setHealth("disconnected")
  setReconnectReason(CONVERSATION_LOST_REASON)
}

/**
 * Taken down once the grant is answered, or when the user gives up on it.
 *
 * GIVING UP RELEASES THE GRANT (P6d-FX7, SK-7). This used to set the signal to
 * null and nothing else: the shell kept polling and, worse, the pending device
 * code stayed approvable for its whole fifteen minutes, so a user who cancelled
 * and then followed the link they had already copied completed a flow this
 * window had forgotten it started. The dialog's own header ("cancel releases
 * nothing, because nothing has been taken") was true about the CLAIM and never
 * about the grant.
 *
 * The withdrawal is fire and forget on purpose: the code is already gone from
 * this window, and a server that cannot be reached must not keep a dialog the
 * user has closed on screen. The grant expires on its own.
 */
export function clearDeviceApproval(): void {
  setDeviceApproval(null)
  void withdrawDeviceApproval()
}

/** `cancel_device_approval` (`sidecar.rs`): the grant this window was waiting
 *  on is taken off its slot and the server is told the code is dead. */
export async function withdrawDeviceApproval(): Promise<boolean> {
  try {
    return (await invoke("cancel_device_approval")) === true
  } catch {
    // A shell of another build has no such command, and a browser has no shell
    // at all. Neither is a reason to leave the dialog up.
    return false
  }
}

type Listener = (event: SidecarEvent) => void
const listeners = new Set<Listener>()

let resolveReadiness: ((value: SidecarReadiness) => void) | null = null
let readiness = pendingReadiness()

/**
 * A fresh readiness promise, one per SESSION. `ready` is emitted once per
 * sidecar process (`sidecar/index.ts`), so a second session that kept the
 * first promise would answer with a cold start measurement and a checksum
 * belonging to a process that is gone, and would answer instantly for a
 * session that has not started yet.
 */
function pendingReadiness(): Promise<SidecarReadiness> {
  return new Promise<SidecarReadiness>((resolve) => {
    resolveReadiness = resolve
  })
}

interface PendingMcpCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingMcpCalls = new Map<string, PendingMcpCall>()
let mcpCounter = 0

function dispatch(raw: unknown): void {
  if (typeof raw !== "string") return
  let event: SidecarEvent
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return
    event = parsed as SidecarEvent
  } catch {
    // A line that is not a protocol object belongs to nobody: the stderr
    // stream is a separate event, so this is noise and never a crash.
    return
  }
  if (event.type === "ready") {
    setHealth("ready")
    // The session the grant was for is running, so nobody is waiting on a code.
    setDeviceApproval(null)
    resolveReadiness?.({
      sidecarReadyMs: Number(event.sidecarReadyMs ?? 0),
      systemPromptChecksum: (event.systemPromptChecksum as string | null) ?? null,
    })
  }
  if (event.type === "error" || event.type === "done") setHealth("disconnected")
  if (event.type === "mcp_result") settleMcpCall(event)
  for (const listener of listeners) listener(event)
}

function settleMcpCall(event: SidecarEvent): void {
  const requestId = event.requestId
  if (typeof requestId !== "string") return
  const pending = pendingMcpCalls.get(requestId)
  // The sidecar does not serialize relays (`sidecar/index.ts:425-434`), so the
  // correlation is ours: a result for a call we already timed out is dropped.
  if (!pending) return
  pendingMcpCalls.delete(requestId)
  clearTimeout(pending.timer)
  const failure = event.error as { message?: string } | undefined
  if (failure) pending.reject(new Error(failure.message ?? "the MCP relay failed"))
  else pending.resolve(event.result)
}

/** The shell's exit payload, or null for anything that is not one. */
export function exitReportFrom(payload: unknown): SidecarExitReport | null {
  if (!payload || typeof payload !== "object") return null
  const raw = payload as Record<string, unknown>
  const number = (value: unknown) => (typeof value === "number" ? value : null)
  const reason =
    typeof raw.reason === "string" && raw.reason.trim().length > 0 ? raw.reason.trim() : "it exited"
  return {
    type: SIDECAR_EXITED_TYPE,
    code: number(raw.code),
    signal: number(raw.signal),
    booted: raw.booted === true,
    reason,
    stderrTail: Array.isArray(raw.stderrTail)
      ? raw.stderrTail.filter((line): line is string => typeof line === "string")
      : [],
  }
}

/**
 * The session is gone: no `done` line is coming, so the health says so and
 * every turn listener hears it as one more event. Exported for the harness
 * that stands in for the shell.
 */
export function dispatchExit(exit: SidecarExitReport): void {
  setHealth("disconnected")
  for (const listener of listeners) listener(exit)
}

let stream: Promise<void> | null = null

/**
 * Subscribes to the shell's two event streams, once. Every entry point awaits
 * this before it can be answered, so a caller never races the subscription.
 */
function ensureStream(): Promise<void> {
  if (stream) return stream
  stream = Promise.all([
    listen(SIDECAR_LINE_EVENT, (event: { payload: unknown }) => dispatch(event.payload)),
    listen(RECONNECT_EVENT, (event: { payload: unknown }) => {
      setHealth("disconnected")
      setReconnectReason(typeof event.payload === "string" ? event.payload : "")
      // Whatever the shell gave up on, it is no longer waiting on THIS code:
      // the grant expired, was denied, or the spawn failed after it. Leaving
      // the panel up covers the whole window with a code that can no longer be
      // approved, and the banner underneath is the thing that can be acted on.
      setDeviceApproval(null)
    }),
    listen(DEVICE_APPROVAL_EVENT, (event: { payload: unknown }) => {
      if (typeof event.payload === "string" && event.payload.length > 0) {
        setDeviceApproval(event.payload)
      }
    }),
    listen(SIDECAR_EXITED_EVENT, (event: { payload: unknown }) => {
      const exit = exitReportFrom(event.payload)
      if (exit) dispatchExit(exit)
    }),
    listen(UPDATE_PROGRESS_EVENT, (event: { payload: unknown }) => {
      setUpdateProgress(updateProgressFrom(event.payload))
    }),
  ]).then(() => undefined)
  return stream
}

/**
 * Subscribes to the shell's events without starting anything. The device
 * approval arrives on the shell's own schedule, so the window has to be
 * listening before it asks for one.
 */
export function armShellEvents(): Promise<void> {
  return ensureStream()
}

/** `start_session` (`sidecar.rs:383-384`). A second start stops the first. */
export async function startSession(options: StartSessionOptions): Promise<void> {
  await ensureStream()
  try {
    await invoke("start_session", {
      agentId: options.agentId,
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      model: options.model,
      resumeSessionId: options.resumeSessionId ?? null,
      agentDefinition: options.agentDefinition,
      agentKind: options.agentKind,
      accessToken: options.accessToken,
    })
  } catch (error) {
    throw new StartSessionError(variantOf(error))
  }
  // Cleared only once the start SUCCEEDED: a start that was refused leaves the
  // banner saying exactly what it said before, which is still true.
  setReconnectReason(null)
  setHealth("unknown")
  // The new session has not reported anything yet, and the previous one's
  // readiness is not this one's.
  readiness = pendingReadiness()
}

/** `stop_session` (`sidecar.rs:92-93`): the shutdown line, then the kill. */
export async function stopSession(): Promise<void> {
  await invoke("stop_session")
}

/**
 * `pick_folder`: the OS folder dialog, answering with the chosen path or null
 * when the user cancelled.
 *
 * It is also where a folder becomes STARTABLE (P6d-FX2, SK-1). The shell keeps
 * the set of folders it chose itself and refuses to start a session anywhere
 * else, so this call is the only way into that set, and the agent id is what
 * the shell files the folder under in its own recent list.
 */
export async function pickFolder(agentId: string | null): Promise<string | null> {
  return ((await invoke("pick_folder", { agentId: agentId ?? null })) as string | null) ?? null
}

/**
 * `recent_folders`: the folders this agent has run in, newest first, as the
 * SHELL remembers them.
 *
 * The list used to live in the webview's `localStorage`, which every script in
 * apps/web can write, and it is the set a session may be rooted in: a list the
 * page could edit would be no check at all (P6d-FX2, SK-1).
 */
export async function recentFolders(agentId: string): Promise<string[]> {
  try {
    const answer = (await invoke("recent_folders", { agentId })) as unknown
    return Array.isArray(answer)
      ? answer.filter((entry): entry is string => typeof entry === "string")
      : []
  } catch {
    // A page with no shell under it has run in no folders.
    return []
  }
}

/**
 * `get_server_address` (`sidecar.rs:325-326`): the address the install is
 * bound to, or null on a first launch. A page with no shell answers null,
 * which is the same thing a first launch is.
 */
export async function getServerAddress(): Promise<string | null> {
  try {
    return ((await invoke("get_server_address")) as string | null) ?? null
  } catch {
    return null
  }
}

/**
 * What the shell hands back when the window moves to another server: the
 * server it now talks to (null when none is left) and the page storage that
 * was parked for that server (`src-tauri/src/account.rs`).
 */
export interface SwitchedServer {
  address: string | null
  storage: Record<string, string>
}

/** What the window hands over when it leaves a server. */
export interface OutgoingPageStorage {
  /** The server the page's storage belongs to, as the page recorded it. */
  owner: string | null
  storage: Record<string, string>
}

function switchedFrom(answer: unknown): SwitchedServer {
  const raw = (answer ?? {}) as { address?: unknown; storage?: unknown }
  const storage: Record<string, string> = {}
  if (raw.storage && typeof raw.storage === "object") {
    for (const [key, value] of Object.entries(raw.storage as Record<string, unknown>)) {
      if (typeof value === "string") storage[key] = value
    }
  }
  return { address: typeof raw.address === "string" ? raw.address : null, storage }
}

/**
 * `set_server_address` (`account.rs`): a NEW address. The shell checks the
 * scheme, asks the address whether it is a Liaison (refusing with
 * `NotALiaisonServer` or `ServerUnreachable` when it is not), files it in the
 * saved list and makes it current. A refusal is a real refusal and is thrown
 * as the variant the shell named, which the connect card turns into words.
 */
export async function setServerAddress(
  url: string,
  outgoing: OutgoingPageStorage | null = null,
): Promise<SwitchedServer> {
  try {
    return switchedFrom(await invoke("set_server_address", { url, outgoing }))
  } catch (error) {
    throw new Error(variantOf(error))
  }
}

/** `switch_server`: moves the window to a server already in the saved list. */
export async function switchServer(
  address: string,
  outgoing: OutgoingPageStorage | null = null,
): Promise<SwitchedServer> {
  try {
    return switchedFrom(await invoke("switch_server", { address, outgoing }))
  } catch (error) {
    throw new Error(variantOf(error))
  }
}

/**
 * `remove_server`: forgets a server the user confirmed removing in the SHELL's
 * own dialog (the shell refuses one nobody confirmed), and answers with the
 * server that is current now, if any.
 */
export async function removeServer(address: string): Promise<SwitchedServer> {
  try {
    return switchedFrom(await invoke("remove_server", { address }))
  } catch (error) {
    throw new Error(variantOf(error))
  }
}

/** One saved server, as `list_servers` answers it. */
export interface SavedServer {
  address: string
  /** The organisation's own name, or null until the server has said it. */
  label: string | null
}

/**
 * `list_servers` (`account.rs`): the saved list and the current entry, for
 * the page's own servers UI. An older shell (or none) answers an empty list.
 */
export async function listServers(): Promise<{ current: string | null; servers: SavedServer[] }> {
  try {
    const raw = ((await invoke("list_servers")) ?? {}) as { current?: unknown; servers?: unknown }
    const servers: SavedServer[] = []
    if (Array.isArray(raw.servers)) {
      for (const entry of raw.servers as Array<{ address?: unknown; label?: unknown }>) {
        if (!entry || typeof entry.address !== "string") continue
        servers.push({
          address: entry.address,
          label: typeof entry.label === "string" ? entry.label : null,
        })
      }
    }
    return { current: typeof raw.current === "string" ? raw.current : null, servers }
  } catch {
    return { current: null, servers: [] }
  }
}

/**
 * `ask_remove_server`: the shell asks its own native removal question; on a
 * yes it emits the `remove` action (`account-menu.ts`).
 */
export async function askRemoveServer(address: string): Promise<void> {
  try {
    await invoke("ask_remove_server", { address })
  } catch (error) {
    throw new Error(variantOf(error))
  }
}

/**
 * `confirm_claude_sign_out`: the shell asks its own native "Sign out of
 * Claude" question, and signs the computer out only on a yes. The window hears
 * `signedOut` on `liaison-claude-auth`.
 */
export async function confirmClaudeSignOut(): Promise<void> {
  try {
    await invoke("confirm_claude_sign_out")
  } catch {
    // An older shell has no such command.
  }
}

/** `sign_out`: ends the current server's session, and only that one. */
export async function signOutOfServer(): Promise<void> {
  await invoke("sign_out")
}

/** The words of the shell's removal question, in the user's language (`account.rs` `DialogCopy`). */
export interface AccountDialogCopy {
  removeTitle: string
  /** `{server}` is replaced with the server's name by the shell. */
  removeMessage: string
  removeConfirm: string
  cancel: string
  /** The tray's items in the page's language (tray.rs). */
  trayOpen?: string
  trayQuit?: string
}

/** The words of the shell's "Sign out of Claude" question (`account.rs` `ClaudeDialogCopy`). */
export interface ClaudeDialogCopy {
  signedIn: string
  signOutTitle: string
  /** `{email}` is replaced with the account's email by the shell. */
  signOutMessage: string
  signOutConfirm: string
}

/** `set_account_dialog_copy`: hands the shell its two questions' words. */
export async function setAccountDialogCopy(
  copy: AccountDialogCopy,
  claude?: ClaudeDialogCopy,
): Promise<void> {
  try {
    await invoke("set_account_dialog_copy", claude ? { copy, claude } : { copy })
  } catch {
    // A refused copy keeps the words the shell already had.
  }
}

/** The Tauri event a confirmed removal reaches the window on (the wire name predates the in-app UI). */
export const ACCOUNT_MENU_EVENT = "liaison-account-menu"

/** A removal the user confirmed in the shell's own dialog. */
export interface AccountMenuAction {
  action: "remove"
  address: string
}

function accountActionFrom(payload: unknown): AccountMenuAction | null {
  if (!payload || typeof payload !== "object") return null
  const raw = payload as { action?: unknown; address?: unknown }
  if (raw.action !== "remove" || typeof raw.address !== "string" || !raw.address) return null
  return { action: "remove", address: raw.address }
}

/** Follows the shell's confirmed removals. Resolves to the unsubscribe. */
export async function onAccountMenu(
  listener: (action: AccountMenuAction) => void,
): Promise<() => void> {
  return listen(ACCOUNT_MENU_EVENT, (event: { payload: unknown }) => {
    const action = accountActionFrom(event.payload)
    if (action) listener(action)
  })
}

/**
 * `set_permission_mode` (`sidecar.rs`): the mode the RUNNING session asks in,
 * and the one the next session starts in.
 *
 * It is a shell command rather than a window-side preference for two reasons.
 * The mode has to reach the live SDK query, which only the shell can write a
 * control line to; and Bypass removes every permission prompt the user is
 * relying on, so the question has to be asked by something a page script
 * cannot skip. A refusal (`UnknownPermissionMode`, `BypassDeclined`) is a real
 * refusal and is not swallowed.
 */
export async function setPermissionMode(mode: PermissionMode): Promise<void> {
  try {
    await invoke("set_permission_mode", { mode })
  } catch (error) {
    throw new PermissionModeError(variantOf(error))
  }
}

/**
 * `open_oauth_url`: opens a sign-in URL in the user's SYSTEM browser (RFC
 * 8252). The shell opens only this install's own server's authorize route
 * asking for the desktop flow, and refuses anything else; false is a refusal
 * or a machine with no browser to open.
 */
export async function openOAuthUrl(url: string): Promise<boolean> {
  try {
    await invoke("open_oauth_url", { url })
    return true
  } catch {
    return false
  }
}

/**
 * `open_device_approval_url`: opens the device grant's approval page in the
 * user's SYSTEM browser. The shell opens only its bound server's
 * `/auth/device?code=` page; false is a refusal or no browser to open.
 */
export async function openDeviceApprovalUrl(url: string): Promise<boolean> {
  try {
    await invoke("open_device_approval_url", { url })
    return true
  } catch {
    return false
  }
}

/**
 * `open_external_url`: opens a link the user clicked in the SYSTEM browser
 * (or mail client). The shell opens only `http`, `https` and `mailto` URLs
 * without credentials; false is a refusal or nothing to open it with.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  try {
    await invoke("open_external_url", { url })
    return true
  } catch {
    return false
  }
}

/**
 * `open_local_path`: opens a file or folder an agent's message named, the way
 * double clicking it would. The SHELL decides what a click may do: a folder
 * opens in the file manager, a document in its default application, and
 * anything executable or script like is only revealed in its folder, never run
 * (`local_path.rs`). `not_found` is a path that is not on this computer;
 * `network` a network path the shell refuses without touching it; `failed`
 * any other refusal or a platform that could not show it.
 */
export async function openLocalPath(
  path: string,
): Promise<"opened" | "revealed" | "not_found" | "network" | "failed"> {
  try {
    const answer = await invoke("open_local_path", { path })
    return answer === "revealed" ? "revealed" : "opened"
  } catch (error) {
    const variant = variantOf(error)
    if (variant === "NotFound") return "not_found"
    // A network path is refused before the shell touches it (no SMB or
    // WebDAV connection to a host a message chose).
    if (variant === "NetworkPath") return "network"
    return "failed"
  }
}

/**
 * `open_downloaded_file`: saves bytes the window fetched (a label, an invoice
 * PDF) to a new temporary folder and opens the file in its default
 * application. The webview cannot open a `blob:` tab, so this is how a fetched
 * document reaches the user. The bytes travel as the raw request body and the
 * name, percent encoded, in a header; the SHELL sanitizes the name and opens
 * only document types (`downloaded_file.rs`). False is a refusal or a platform
 * that could not open it.
 */
export async function openDownloadedFile(bytes: Uint8Array, name: string): Promise<boolean> {
  try {
    await invoke("open_downloaded_file", bytes, {
      headers: { "x-liaison-file-name": encodeURIComponent(name) },
    })
    return true
  } catch {
    return false
  }
}

/**
 * `verify_first_party_app`: the SHELL fetches a first-party app's UI and its
 * signed statement from the bound server, verifies them against the keys
 * compiled into it and keeps the verified bytes (`verified_apps.rs`). Answers
 * where it serves them and the verified manifest, or null on any refusal (the
 * page then frames the app).
 */
export async function verifyFirstPartyApp(
  name: string,
  version: string,
): Promise<VerifiedFirstPartyApp | null> {
  try {
    const answer = await invoke<VerifiedFirstPartyApp>("verify_first_party_app", { name, version })
    const ok =
      answer !== null &&
      typeof answer === "object" &&
      typeof answer.url === "string" &&
      typeof answer.sha256 === "string" &&
      answer.manifest !== null &&
      typeof answer.manifest === "object"
    return ok ? answer : null
  } catch {
    return null
  }
}

/**
 * `store_refresh_token` / `load_refresh_token`: the wrapped session's refresh
 * token, kept by the SHELL in a 0600 file, ONE PER SAVED SERVER.
 *
 * The page is served from `tauri://localhost`, so the API's SameSite=Strict
 * refresh cookie is attached to none of its calls; the API answers this origin
 * with the token in the body instead and takes it back in a header
 * (apps/api/src/lib/response.ts). Storing it through the shell rather than in
 * the webview's own storage is the same choice the server address made: an
 * update that moves the webview data directory would otherwise sign every user
 * out. An empty string CLEARS it, which is what a sign-out sends.
 *
 * BOTH NAME THE SERVER. The token is released only for the server the page is
 * about to present it to, and only when that is the shell's CURRENT server
 * (`servers.rs`): a page still pointed at the server it is leaving can neither
 * read the next server's token nor file its own under it.
 */
export async function storeRefreshToken(token: string, server: string): Promise<void> {
  try {
    await invoke("store_refresh_token", { token, server })
  } catch {
    // A page with no shell under it keeps no token, and a session that cannot
    // be persisted is still a session for as long as the window is open. A
    // token from a server that is no longer current is refused on purpose.
  }
}

/**
 * `store_refresh_token`, reporting whether the shell kept it. A rotation is
 * only handed to the page once its successor is saved, so the refresh bridge
 * needs to know (overlay.tsx).
 */
export async function saveRefreshToken(token: string, server: string): Promise<boolean> {
  try {
    await invoke("store_refresh_token", { token, server })
    return true
  } catch {
    return false
  }
}

export async function loadRefreshToken(server: string): Promise<string | null> {
  try {
    return ((await invoke("load_refresh_token", { server })) as string | null) ?? null
  } catch {
    return null
  }
}

/**
 * `get_install_salt`: this install's own folder hashing salt, 32 random bytes
 * as hex, created once by the shell and kept 0600 beside the token.
 *
 * Cached for the life of the window because it never changes and because every
 * folder digest in the session goes through it. A page with no shell under it
 * answers the empty string, which hashes consistently but salts nothing: the
 * overlay only runs inside the shell, and an unsalted digest is better than a
 * digest that disagrees with the one the resume store was keyed by.
 */
let installSalt: Promise<string> | null = null

export function getInstallSalt(): Promise<string> {
  if (!installSalt) {
    installSalt = invoke("get_install_salt")
      .then((salt) => (typeof salt === "string" ? salt : ""))
      .catch(() => "")
  }
  return installSalt
}

/** What the shell says this machine is (`sidecar.rs` `platform_info`). */
export interface PlatformInfo {
  os: "macos" | "windows" | "linux"
  arch: string
}

/**
 * `platform_info` (`sidecar.rs:134-135`). It is asked of the SHELL rather than
 * read off `navigator.userAgent`, because the webview's user agent describes
 * the browser engine and a packaged Windows build can be served a string that
 * says nothing about the host. A page with no shell underneath it (apps/web in
 * a plain browser) answers null rather than guessing.
 */
export async function platformInfo(): Promise<PlatformInfo | null> {
  try {
    const answer = (await invoke("platform_info")) as PlatformInfo | undefined
    return answer?.os ? answer : null
  } catch {
    return null
  }
}

/**
 * `read_local_file`: one file out of the RUNNING session's own folder, as a
 * Blob ready to post. The shell canonicalizes the path and refuses anything
 * outside that folder (`OutsideSessionFolder`), anything over 50 MB
 * (`TooLarge`) and every read with no session running (`NoSession`), so the
 * scoping is the shell's and this function only carries the bytes.
 */
export async function readLocalFile(path: string): Promise<Blob> {
  let answer: { base64: string; mime: string }
  try {
    answer = (await invoke("read_local_file", { path })) as { base64: string; mime: string }
  } catch (error) {
    throw new LocalFileError(variantOf(error))
  }
  const binary = atob(answer.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: answer.mime })
}

/**
 * `send_turn` (`sidecar.rs`), which composes the `turn` control line. The
 * shell checks the credential's shape and drops a malformed one (S59).
 */
export async function startTurn(prompt: string, turnCredential?: string): Promise<void> {
  await ensureStream()
  await invoke("send_turn", turnCredential ? { prompt, turnCredential } : { prompt })
}

/**
 * `interrupt_turn`: the shell composes the `interrupt` control line
 * (`sidecar/index.ts:415-417`). There is no command that writes a line this
 * module composed: see the threat model in `sidecar-ipc-contract.md`.
 */
export async function interrupt(): Promise<void> {
  await invoke("interrupt_turn")
}

/**
 * Every protocol 2 line, parsed. Returns its own unsubscribe rather than a
 * promise of one: a component unmounting must not have to await anything.
 */
export function onTurnEvent(callback: Listener): () => void {
  void ensureStream()
  listeners.add(callback)
  return () => listeners.delete(callback)
}

/** Only the `permission_request` lines (`sidecar/index.ts:250-256`). */
export function onPermissionPrompt(callback: (prompt: PermissionPrompt) => void): () => void {
  return onTurnEvent((event) => {
    if (event.type === "permission_request") callback(event as PermissionPrompt)
  })
}

/**
 * `respond_permission`: one answer to one OUTSTANDING prompt. The shell
 * records the request ids the sidecar asked about and refuses an id that is
 * unknown or already answered (`UnknownPermissionRequest`), because the id
 * itself rides a broadcast event and is therefore known to every script in
 * the page. The sidecar's broker fails closed, so NOT answering is a denial
 * rather than a hang.
 *
 * There is no `updatedInput`: the sheet has no editor for a tool's arbitrary
 * input shape, and a shell that forwarded one unread would be forwarding an
 * arbitrary tool call.
 */
export async function respondToPermissionPrompt(
  requestId: string,
  behavior: "allow" | "deny",
  message?: string,
): Promise<"allow" | "deny"> {
  // D11: for a shell command or a write outside the folder, an allow is only
  // written once the shell's own dialog says yes; a no there is written as a
  // deny, and the shell answers which one it wrote.
  const written = await invoke<string>("respond_permission", {
    requestId,
    behavior,
    message: message ?? null,
  })
  return written === "allow" ? "allow" : "deny"
}

/** Resolves on the `ready` line (`sidecar/index.ts:457-461`), emitted once. */
export function getSidecarReadiness(): Promise<SidecarReadiness> {
  void ensureStream()
  return readiness
}

/**
 * One Liaison MCP tool call, relayed through the sidecar's own client so the
 * session token never reaches the webview (`sidecar/mcp-relay.ts:1-19`).
 * Correlated by `requestId` here, and given a deadline here, because the
 * sidecar fires relays without awaiting them and would never report a hang.
 *
 * `call_mcp_tool` refuses any tool outside the shell's own allowlist
 * (`McpToolNotAllowed`): the relay spends the session's agent scoped bearer,
 * and the window may only spend it on a status read.
 */
export async function callMcpTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  await ensureStream()
  mcpCounter += 1
  const requestId = `mcp-${mcpCounter}`
  const answered = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMcpCalls.delete(requestId)
      reject(new Error(`the MCP call ${tool} was not answered in time`))
    }, MCP_CALL_TIMEOUT_MS)
    pendingMcpCalls.set(requestId, { resolve, reject, timer })
  })
  try {
    await invoke("call_mcp_tool", { requestId, tool, args })
  } catch (error) {
    const pending = pendingMcpCalls.get(requestId)
    if (pending) {
      pendingMcpCalls.delete(requestId)
      clearTimeout(pending.timer)
    }
    throw error
  }
  return answered
}

// ---------------------------------------------------------------------------
// THE CLAUDE ACCOUNT LOCAL TURNS RUN ON (`src-tauri/src/claude_auth.rs`).
//
// The sign-in URL and the pasted code never come back through here: the shell
// opens the page itself and says only which phase the sign-in is in.

/** The Tauri event a Claude sign-in is followed on. */
export const CLAUDE_AUTH_EVENT = "liaison-claude-auth"

/** The account, as the shell reads it off the CLI. */
export interface ClaudeAccountAnswer {
  loggedIn: boolean
  email: string | null
}

/** One `liaison-claude-auth` event. */
export interface ClaudeAuthUpdate {
  phase: "starting" | "waiting" | "checking" | "codeRejected" | "signedIn" | "failed" | "signedOut"
  account?: ClaudeAccountAnswer
  reason?: string
  detail?: string
}

const CLAUDE_AUTH_PHASES = new Set([
  "starting",
  "waiting",
  "checking",
  "codeRejected",
  "signedIn",
  "failed",
  "signedOut",
])

export function claudeAccountFrom(payload: unknown): ClaudeAccountAnswer | null {
  if (!payload || typeof payload !== "object") return null
  const raw = payload as { loggedIn?: unknown; email?: unknown }
  if (typeof raw.loggedIn !== "boolean") return null
  return {
    loggedIn: raw.loggedIn,
    email: typeof raw.email === "string" && raw.email.length > 0 ? raw.email : null,
  }
}

/** The event's payload, or null for anything that is not one. */
export function claudeAuthUpdateFrom(payload: unknown): ClaudeAuthUpdate | null {
  if (!payload || typeof payload !== "object") return null
  const raw = payload as Record<string, unknown>
  if (typeof raw.phase !== "string" || !CLAUDE_AUTH_PHASES.has(raw.phase)) return null
  const account = claudeAccountFrom(raw.account)
  return {
    phase: raw.phase as ClaudeAuthUpdate["phase"],
    ...(account ? { account } : {}),
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
  }
}

/** Follows the Claude sign-in's events. Resolves to the unsubscribe. */
export async function onClaudeAuth(
  listener: (update: ClaudeAuthUpdate) => void,
): Promise<() => void> {
  return listen(CLAUDE_AUTH_EVENT, (event: { payload: unknown }) => {
    const update = claudeAuthUpdateFrom(event.payload)
    if (update) listener(update)
  })
}

/**
 * `claude_auth_status`: the account, or null when the shell could not tell.
 * Without `fresh` the shell may answer a sign-in it already read (at launch).
 */
export async function claudeAuthStatus(
  options: { fresh?: boolean } = {},
): Promise<ClaudeAccountAnswer | null> {
  try {
    return claudeAccountFrom(await invoke("claude_auth_status", { fresh: options.fresh === true }))
  } catch {
    return null
  }
}

/**
 * `claude_local_models`: the models the bundled Agent SDK offers, asked of it
 * with no session (`liaison-sidecar --local-models`), raw: the caller parses
 * the rows (`parseLocalModels`). Null when the SDK did not say.
 */
export async function claudeLocalModels(): Promise<unknown> {
  try {
    return await invoke("claude_local_models")
  } catch {
    return null
  }
}

/**
 * `claude_auth_note_failure`: a local turn failed to authenticate, so the
 * shell drops its cached sign-in and Settings offers Sign in again.
 */
export async function claudeAuthNoteFailure(): Promise<void> {
  try {
    await invoke("claude_auth_note_failure")
  } catch {
    // An older shell has no cache to drop; the window's own check still refuses.
  }
}

/** `claude_auth_login`: starts a sign-in. Throws the shell's refusal. */
export async function claudeAuthLogin(): Promise<void> {
  await invoke("claude_auth_login")
}

/** `claude_auth_submit_code`. Throws the shell's refusal (`ClaudeCodeRefused`). */
export async function claudeAuthSubmitCode(code: string): Promise<void> {
  await invoke("claude_auth_submit_code", { code })
}

/** `claude_auth_cancel`. */
export async function claudeAuthCancel(): Promise<void> {
  await invoke("claude_auth_cancel")
}

/** `claude_auth_reopen`: the sign-in page again. False when it did not open. */
export async function claudeAuthReopen(): Promise<boolean> {
  try {
    await invoke("claude_auth_reopen")
    return true
  } catch {
    return false
  }
}
