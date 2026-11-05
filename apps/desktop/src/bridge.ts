// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T04: THE SHELL, PUBLISHED (A33).
//
// After this slice the overlay draws nothing. apps/web renders the local
// session in its own surfaces, with its own tokens and its own primitives, and
// reaches this shell through exactly one object on the window, typed by the
// contract both halves share (`@liaison/web/lib/desktop-shell-contract`). The
// type is imported through the alias 6b landed, so a drift between the two
// halves is a typecheck failure rather than a runtime surprise.
//
// It is a FACADE and nothing more. Every method here is one of the Tauri
// commands the shell already offers, or a small composition the shell already
// performed from inside its own components: no new command, no new route, no
// decision that was not already being made. `src-tauri` stays frozen for this
// slice precisely because nothing below needs anything from it that is not
// there already.
//
// STATE IS PLAIN DATA. The page is on the other side of a boundary that Solid
// does not cross: the shell holds one store, pushes a frozen snapshot of it to
// every subscriber, and hands out a copy on demand. Nothing that crosses is a
// signal, a store, a DOM node or a class instance, so neither half owns the
// other's reactivity.

import { currentNodeModels, exactOfferedModel } from "@liaison/shared/node-models"
import { NODE_PROTOCOL_IMPORT } from "@liaison/shared/node-session-protocol"
import type {
  DesktopApprovalStatus,
  DesktopBridge,
  DesktopClaimHolder,
  DesktopClaudeAccount,
  DesktopNodeRecord,
  DesktopPermissionDecision,
  DesktopPermissionMode,
  DesktopPermissionRequest,
  DesktopRecentFolder,
  DesktopRuntimeLocation,
  DesktopSessionState,
  DesktopSharedRoots,
  DesktopStartRefusal,
  DesktopStartSessionInput,
  DesktopToolActivity,
} from "@liaison/web/lib/desktop-shell-contract"
import {
  DESKTOP_BRIDGE_EVENT,
  DESKTOP_BRIDGE_KEY,
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_FALLBACK_LOCAL_MODELS,
  type DesktopLocalModel,
  defaultLocalModel,
  emptyDesktopSessionState,
  isStartableLocalModel,
  offeredLocalModelFor,
  parseLocalModels,
} from "@liaison/web/lib/desktop-shell-contract"
import { createEffect, createRoot } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import {
  keepAwake,
  loadNodeCredential,
  nodeRoot,
  remoteAuto,
  setKeepAwake,
  setNodeRoot,
  setRemoteAuto,
  storeNodeCredential,
} from "./node"
import {
  NODE_CREDENTIAL_HEADER,
  nodeFolderHttp,
  nodeImportHttp,
  nodeJobHttp,
  nodeJobShell,
} from "./node-jobs/adapters"
import { createFolderRequests } from "./node-jobs/folder-requests"
import { createImportRequests } from "./node-jobs/import-requests"
import { createNodeJobRunner, type NodeJobRunner } from "./node-jobs/runner"
import {
  launchAtLogin,
  loadNotificationCredential,
  notificationClickSupport,
  notificationDeviceId,
  notificationPermission,
  onNotificationClick,
  onNotificationPermissionChange,
  raiseNotification,
  requestNotificationPermission,
  setLaunchAtLogin,
  setUnreadBadge,
  storeNotificationCredential,
} from "./notifications"
import {
  clearConnectProposal,
  connectDeepLinkAddress,
  onOAuthCompleteLink,
} from "./onboarding/DeepLinkHandler"
import { isClaudeAuthError } from "./session/claude-auth-failure"
import { buildDesktopServers } from "./session/desktop-servers"
import {
  accessToken,
  approvalRequestId,
  serverAddress as boundServerAddress,
  clearProducedFiles,
  clearRuntimeLocationMirror,
  noteProducedFile,
  producedFiles,
  rememberedRuntimeLocation,
  setPermissionMode as rememberMode,
  setRuntimeLocation as rememberRuntime,
} from "./session/desktop-store"
import { hashFolder } from "./session/folder-hash"
import { installClaimId, mintHolderKey } from "./session/local-claim"
import { recallPermissionMode, rememberPermissionMode } from "./session/permission-mode-memory"
import { getRecentFolders } from "./session/RecentFolders"
import { getSessionId } from "./session/SessionResumeStore"
import { switchServerWith } from "./session/server-switch"
import {
  type ClaudeAuthUpdate,
  callMcpTool,
  claudeAuthCancel,
  claudeAuthLogin,
  claudeAuthNoteFailure,
  claudeAuthReopen,
  claudeAuthStatus,
  claudeAuthSubmitCode,
  claudeLocalModels,
  clearDeviceApproval as clearDeviceApprovalCommand,
  confirmClaudeSignOut,
  deviceApproval,
  getInstallSalt,
  interrupt,
  onClaudeAuth,
  onPermissionPrompt,
  onTurnEvent,
  openDeviceApprovalUrl,
  openDownloadedFile,
  openExternalUrl,
  openLocalPath,
  openOAuthUrl,
  pickFolder as pickFolderCommand,
  readLocalFile as readLocalFileCommand,
  reconnectReason,
  respondToPermissionPrompt,
  ShellRefusalError,
  type SidecarExitReport,
  setPermissionMode as setPermissionModeCommand,
  setServerAddress as setServerAddressCommand,
  updateProgress,
  verifyFirstPartyApp,
} from "./session/sidecar-client"
import { SIDECAR_EXITED_TYPE } from "./session/sidecar-exit"
import type { LocalSessionHandle } from "./session/start-local-session"
import {
  endLocalSession,
  fetchTurnContext,
  LocalSessionStartError,
  startLocalSession,
} from "./session/start-local-session"
import { recallThreadFolder, rememberThreadFolder } from "./session/thread-folder-memory"
import {
  attachLocalTurns,
  currentLocalTurnMessageId,
  submitLocalTurn,
} from "./session/thread-turn-bridge"
import {
  applyToolEvent,
  isToolEvent,
  producedFilePathsOf,
  summarizeArguments,
} from "./session/tool-activity"
import { invoke } from "./tauri"
import { appVersion, checkForUpdates } from "./updates"

/** The one local session this window runs, or null. */
/** The session this window is running, and the pair it answers for. The pair
 *  is kept HERE rather than read back off the handle: a start that is refused
 *  has to know whether the live session is the same conversation, and that is
 *  a fact about what this window was asked for. */
interface LiveSession {
  handle: LocalSessionHandle
  detach: () => void
  threadId: string
  agentId: string
}

let live: LiveSession | null = null

/**
 * THIS WINDOW'S HOLDER KEY, minted once and kept for its whole life (P6d-FX7,
 * SK-5). `local-claim.ts` states the rule ("the holder is the user AND the
 * window") and the key was nevertheless minted per CLAIM, so a release the
 * server never applied left the next start arguing with its own lease: the
 * window's own claim answered 409 and the page said another machine was
 * running the conversation and to go and stop it there. There is no other
 * machine. One key per window makes a self-conflict a renewal instead.
 */
let holderKey: string | null = null

/**
 * AND THE KEY NAMES THIS INSTALL (2026-09-23), so the server can tell this
 * app's previous life from another computer: a quit that sent no release left
 * the relaunched window refused its own conversation (`installClaimId`).
 */
async function windowHolderKey(): Promise<string> {
  if (holderKey) return holderKey
  const install = await installClaimId(await getInstallSalt()).catch(() => null)
  holderKey ??= mintHolderKey(install)
  return holderKey
}

/** ONE START AT A TIME: a device grant is a human walking to a browser. */
let starting = false

/**
 * THE STATE A WINDOW STARTS ON, and it is not quite empty.
 *
 * Every field but one belongs to a session, and a window that has just come up
 * is running none: the empty state is right about all of them. The runtime the
 * user chose is not one of those, it is a preference, and the two things that
 * reload this page (the device grant and the connect card) were throwing it
 * away: the user said "this machine", the page came back, and the control said
 * Liaison with nothing started to explain it. The choice is mirrored by the
 * one setter every picker goes through, and read back here, synchronously,
 * before anything can subscribe.
 */
function initialSessionState(): DesktopSessionState {
  return {
    ...emptyDesktopSessionState(),
    runtimeLocation: rememberedRuntimeLocation(),
    localModels: rememberedLocalModels(),
  }
}

/**
 * WHERE THE SDK'S MODEL LIST SURVIVES A RELOAD AND A RELAUNCH. The list is
 * asked of the bundled SDK at launch (`discoverLocalModels`) and said again by
 * every running session (`local_models`, sidecar/index.ts); until the first
 * answer the last list this install heard is offered instead of the fallback.
 */
export const LOCAL_MODELS_MIRROR_KEY = "liaison-desktop:local-models"

/** The models offered before this window's first session says its own. */
function rememberedLocalModels(): DesktopLocalModel[] {
  try {
    const stored = localStorage.getItem(LOCAL_MODELS_MIRROR_KEY)
    const parsed = stored ? parseLocalModels(JSON.parse(stored)) : null
    if (parsed) return parsed
  } catch {
    // An unreadable copy is no copy: the fallback is offered.
  }
  return [...DESKTOP_FALLBACK_LOCAL_MODELS]
}

/**
 * THIS NODE'S CAPABILITIES (P1-T40; C1, L21, D42): the folders it shares
 * (with their paths, sent on this route only), the models its Claude offers
 * and its level pins, published to the server when the runner starts, when
 * the recent folders or the model list change, and after each unattended
 * start (a consumed confirmation may have moved a pin). A failure is logged
 * and retried on the next change; it never holds the runner up.
 */
export interface CapabilityPublisherDeps {
  serverAddress: () => string | null
  accessToken: () => string | null
  node: () => Promise<DesktopNodeRecord | null>
  models: () => readonly DesktopLocalModel[]
  /** The shell's `node_shared_folders` (node_folders.rs). */
  sharedFolders: () => Promise<unknown>
  /** The shell's `node_level_pins` (node_job.rs). */
  levelPins: () => Promise<unknown>
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  log?: (message: string, detail?: unknown) => void
}

export interface CapabilityPublisher {
  /** Publishes now (the runner starting, an unattended start). Never throws. */
  publishNow(): Promise<void>
  /** The inputs' key: publishes when it moved, or when the last publish failed. */
  changed(key: string): void
}

function sharedFolderBody(raw: unknown): Array<Record<string, string>> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((f) => {
    if (!f || typeof f !== "object") return []
    const { name, path, kind, gitDefaultBranch } = f as Record<string, unknown>
    if (typeof name !== "string" || typeof path !== "string") return []
    if (kind !== "root" && kind !== "repo") return []
    return [
      {
        name,
        path,
        kind,
        ...(typeof gitDefaultBranch === "string" && gitDefaultBranch ? { gitDefaultBranch } : {}),
      },
    ]
  })
}

function levelPinBody(raw: unknown): Array<{ agentId: string; level: string }> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((p) => {
    const { agentId, level } = (p ?? {}) as Record<string, unknown>
    return typeof agentId === "string" && typeof level === "string" ? [{ agentId, level }] : []
  })
}

export function createCapabilityPublisher(deps: CapabilityPublisherDeps): CapabilityPublisher {
  const send = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const log = deps.log ?? (() => {})
  /** The key of the last publish that the server took; null after a failure. */
  let published: string | null = null
  let latest: string | null = null
  let inFlight: Promise<void> | null = null
  let again = false

  async function once(): Promise<boolean> {
    const server = deps.serverAddress()?.replace(/\/+$/, "")
    const token = deps.accessToken()
    const node = await deps.node()
    if (!server || !token || !node?.enabled) return false
    const [folders, pins] = await Promise.all([deps.sharedFolders(), deps.levelPins()])
    const response = await send(
      `${server}/api/nodes/${encodeURIComponent(node.nodeId)}/capabilities`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          [NODE_CREDENTIAL_HEADER]: node.credential,
        },
        body: JSON.stringify({
          sharedFolders: sharedFolderBody(folders),
          models: publishedModels(deps.models()),
          levelPins: levelPinBody(pins),
          // S40: the session import this desktop answers (list, check, follow).
          importProtocol: NODE_PROTOCOL_IMPORT,
        }),
      },
    )
    if (!response.ok) log("node capabilities refused", response.status)
    return response.ok
  }

  function run(): Promise<void> {
    if (inFlight) {
      again = true
      return inFlight
    }
    const key = latest
    inFlight = (async () => {
      try {
        published = (await once()) ? key : null
      } catch (error) {
        published = null
        log("node capabilities not published", error)
      } finally {
        inFlight = null
        if (again) {
          again = false
          void run()
        }
      }
    })()
    return inFlight
  }

  return {
    publishNow: () => run(),
    changed(key) {
      latest = key
      if (key !== published) void run()
    },
  }
}

/** The shell's shared-roots answer (node_folders.rs), read defensively. */
export function sharedRootsOf(raw: unknown): DesktopSharedRoots {
  const r = (raw ?? {}) as { roots?: unknown; isDefault?: unknown; missing?: unknown }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  const roots = strings(r.roots)
  return {
    roots,
    isDefault: r.isDefault === true,
    // A shell before the missing flag answers none.
    missing: strings(r.missing).filter((m) => roots.includes(m)),
    refused: strings((raw as { refused?: unknown } | null)?.refused).filter((m) =>
      roots.includes(m),
    ),
    dropped: strings((raw as { dropped?: unknown } | null)?.dropped),
    repos: (Array.isArray((raw as { repos?: unknown } | null)?.repos)
      ? ((raw as { repos: unknown[] }).repos as Array<{ path?: unknown; defaultBranch?: unknown }>)
      : []
    )
      .filter((x) => typeof x?.path === "string" && roots.includes(x.path as string))
      .map((x) => ({
        path: x.path as string,
        defaultBranch: typeof x.defaultBranch === "string" ? x.defaultBranch : null,
      })),
  }
}

/**
 * The shared roots on the bridge (P2-T15, L21): read and set through the
 * shell, and a set publishes the node's capabilities again so the server's
 * folder names follow at once. A refused set publishes nothing.
 */
export function createSharedRoots(deps: {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  republish: () => Promise<void>
}): Pick<DesktopBridge, "sharedRoots" | "setSharedRoots"> {
  return {
    sharedRoots: async () => sharedRootsOf(await deps.invoke("node_shared_roots")),
    setSharedRoots: async (roots) => {
      const answer = sharedRootsOf(await deps.invoke("set_node_shared_roots", { roots }))
      void deps.republish()
      return answer
    },
  }
}

/**
 * "Open in VS Code" (S52, owner D13): the page names a session's folder and
 * the SHELL resolves it in its own shared-folder map and opens it in VS Code
 * (node_folders.rs `open_folder_in_editor`). No absolute path crosses the
 * bridge: a session in a subfolder adds its path relative to that folder,
 * which the shell confines to it. A name the node does not share (or shares
 * twice), or a relative path that leaves it, opens nothing.
 */
export function createFolderEditor(deps: {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}): Pick<DesktopBridge, "openFolderInEditor"> {
  return {
    openFolderInEditor: async (name, relativePath) => {
      if (!name) return false
      const args = relativePath ? { name, relativePath } : { name }
      const opened = await deps.invoke("open_folder_in_editor", args).catch(() => false)
      return opened === true
    },
  }
}

/**
 * "Stop it" (D33, batch-4 F3): an orphaned Claude process (parent launchd)
 * holds one of the owner's sessions; the owner's click asks the SHELL to stop
 * it (orphan_claude.rs `stop_orphan_claude`). The shell signals the pid only
 * when the CLI's registry entry and the process table both tie it to this
 * CLI session id and it is a `claude` binary; anything else stops nothing.
 */
export function createOrphanStopper(deps: {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}): Pick<DesktopBridge, "stopOrphanClaude"> {
  return {
    stopOrphanClaude: async (cliSessionId, pid) => {
      if (!cliSessionId || !Number.isInteger(pid) || pid <= 1) return false
      const stopped = await deps
        .invoke("stop_orphan_claude", { sessionId: cliSessionId, pid })
        .catch(() => false)
      return stopped === true
    },
  }
}

let capabilities: CapabilityPublisher | null = null

function capabilityPublisher(): CapabilityPublisher {
  capabilities ??= createCapabilityPublisher({
    serverAddress: () => boundServerAddress(),
    accessToken: () => accessToken(),
    node: async () => {
      const server = boundServerAddress()
      return server ? await loadNodeCredential(server) : null
    },
    models: () => offeredLocalModels(),
    sharedFolders: () => invoke<unknown>("node_shared_folders"),
    levelPins: () => invoke<unknown>("node_level_pins"),
    log: (message, detail) => console.warn(`[liaison node] ${message}`, detail ?? ""),
  })
  return capabilities
}

/** What the capabilities follow on this side: the offered models and the recent folders. */
function capabilityKey(): string {
  return capabilityKeyOf(offeredLocalModels(), state.recentFolders ?? [])
}

/**
 * The key a publish is skipped on: the window-side published content (the
 * models exactly as the body sends them, and the recent folders the shell's
 * folder list follows). W1-D6: it keyed on model ids only, so a window that
 * first published a mirror without reasoning levels never sent the same ids
 * WITH their levels once discovery found them. Shell-side changes (shared
 * roots, level pins) republish through publishNow.
 */
export function capabilityKeyOf(
  models: readonly DesktopLocalModel[],
  recentFolders: readonly { path: string }[],
): string {
  return JSON.stringify([publishedModels(models), recentFolders.map((f) => f.path)])
}

/** The models as the capabilities body carries them, and as the key compares them. */
function publishedModels(models: readonly DesktopLocalModel[]) {
  return models.map((m) => ({
    id: m.id,
    label: m.label,
    // S25: a model's reasoning levels go with it (the composer offers them).
    ...(m.efforts ? { efforts: m.efforts } : {}),
  }))
}

/**
 * THIS COMPUTER'S NODE JOBS (P4 N-D T5, node-jobs/runner.ts): one runner per
 * launch, created when the page says this computer is an enabled node. Its
 * calls carry the owner's session and the node credential the shell keeps.
 */
let nodeJobs: NodeJobRunner | null = null
let folderRequests: ((requestId: string) => Promise<void>) | null = null
let importRequests: ((requestId: string) => Promise<void>) | null = null

/** The node's answerer of folder requests, made once. */
function nodeFolderRequests(): (requestId: string) => Promise<void> {
  folderRequests ??= createFolderRequests({
    http: nodeFolderHttp({
      serverAddress: () => boundServerAddress(),
      accessToken: () => accessToken(),
      nodeCredential: async () => {
        const server = boundServerAddress()
        const node = server ? await loadNodeCredential(server) : null
        return node?.enabled ? node.credential : null
      },
      refreshAccessToken: () => refreshWindowToken(),
    }),
    invoke: (command, args) => invoke<unknown>(command, args),
    republish: () => capabilityPublisher().publishNow(),
    log: (message, error) => console.warn(`[node] ${message}`, error),
  })
  return folderRequests
}

/** S40: the node's answerer of session import requests, made once (node-jobs/import-requests.ts). */
function nodeImportRequests(): (requestId: string) => Promise<void> {
  importRequests ??= createImportRequests({
    http: nodeImportHttp({
      serverAddress: () => boundServerAddress(),
      accessToken: () => accessToken(),
      nodeCredential: async () => {
        const server = boundServerAddress()
        const node = server ? await loadNodeCredential(server) : null
        return node?.enabled ? node.credential : null
      },
      refreshAccessToken: () => refreshWindowToken(),
    }),
    invoke: (command, args) => invoke<unknown>(command, args),
    log: (message, error) => console.warn(`[node] ${message}`, error),
  })
  return importRequests
}

/**
 * P1-walk D12: the page's own token refresh (apps/web publishes it on
 * `__liaisonHost`, single flight), so a node call that met an expired token
 * goes again with the new one. The refresh bridge notes the new bearer
 * (overlay.tsx), which is what `accessToken()` reads.
 */
export async function refreshWindowToken(
  host: unknown = (globalThis as { __liaisonHost?: unknown }).__liaisonHost,
): Promise<boolean> {
  const ensure = (host as { ensureFreshToken?: (o: { force: boolean }) => Promise<void> } | null)
    ?.ensureFreshToken
  if (typeof ensure !== "function") return false
  const before = accessToken()
  try {
    await ensure({ force: true })
  } catch {
    return false
  }
  const after = accessToken()
  return after !== null && after !== before
}

function nodeJobRunner(): NodeJobRunner {
  if (nodeJobs) return nodeJobs
  nodeJobs = createNodeJobRunner({
    http: nodeJobHttp({
      serverAddress: () => boundServerAddress(),
      accessToken: () => accessToken(),
      nodeCredential: async () => {
        const server = boundServerAddress()
        const node = server ? await loadNodeCredential(server) : null
        return node?.enabled ? node.credential : null
      },
      refreshAccessToken: () => refreshWindowToken(),
    }),
    shell: nodeJobShell(() => accessToken()),
    // My node chat's model (D29, frozen); a session runs the model its claim
    // names, which must be one this computer offers (L18).
    // An agent model this computer runs runs as named, an older version
    // included; otherwise its family's current model, else the default
    // among the current models (never a pinned older version).
    model: (agentModel) => {
      const runs = offeredLocalModels()
      const current = currentNodeModels(runs)
      return (
        (agentModel &&
          (exactOfferedModel(agentModel, runs) ?? offeredLocalModelFor(agentModel, current))) ||
        defaultLocalModel(current)
      )
    },
    offeredModels: () => offeredLocalModels(),
    onUnattendedStart: () => {
      void capabilityPublisher().publishNow()
    },
    log: (message, detail) => console.warn(`[liaison node] ${message}`, detail ?? ""),
  })
  return nodeJobs
}

/**
 * Every model this computer runs right now: the SDK's own list once known,
 * else the fallback. Pinned older versions included, because this is what a
 * session may START on and what the server resolves a session against; what
 * is OFFERED (pickers, the agent's choices) is its `currentNodeModels`,
 * narrowed by whoever shows it.
 */
function offeredLocalModels(): readonly DesktopLocalModel[] {
  return state.localModels && state.localModels.length > 0
    ? state.localModels
    : DESKTOP_FALLBACK_LOCAL_MODELS
}

/**
 * THE BUNDLED SDK'S OWN LIST, ASKED WITHOUT A SESSION (`claude_local_models`).
 * The list used to come only from a local chat session's `local_models`
 * line, so a computer that only ever ran node jobs published the fallback
 * written into the app, and every client's Sessions picker offered that.
 * Asked once per launch (an app update, which is the only way the bundled SDK
 * changes, relaunches) and again when the node starts after a failure.
 * Single flight; a failure is forgotten so the next caller asks again.
 */
let discovery: Promise<void> | null = null

export function discoverLocalModels(): Promise<void> {
  discovery ??= (async () => {
    const models = parseLocalModels(await claudeLocalModels())
    if (!models) {
      discovery = null
      return
    }
    adoptLocalModels(models)
  })()
  return discovery
}

/**
 * A SESSION SAID WHICH MODELS ITS SDK OFFERS. A line that is not a usable list
 * changes nothing: the window keeps offering what it offered.
 */
function adoptLocalModels(value: unknown): void {
  const models = parseLocalModels(value)
  if (!models) return
  setDesktopSessionState({ localModels: models })
  try {
    localStorage.setItem(LOCAL_MODELS_MIRROR_KEY, JSON.stringify(models))
  } catch {
    // A refused store costs the next window's copy, never this one's list.
  }
}

const [state, setState] = createStore<DesktopSessionState>(initialSessionState())

type Listener = (snapshot: DesktopSessionState) => void
const listeners = new Set<Listener>()

/** A frozen copy, so a subscriber holding on to one cannot edit the shell's. */
function snapshot(): DesktopSessionState {
  return structuredClone(unwrap(state))
}

function announce(): void {
  const frozen = snapshot()
  for (const listener of listeners) listener(frozen)
}

/**
 * Writes part of the session state and tells every subscriber. Exported
 * because the pieces that learn about a change (the sidecar stream, a start, a
 * stop) are spread across this module and its tests drive it directly.
 */
export function setDesktopSessionState(patch: Partial<DesktopSessionState>): void {
  setState(patch)
  announce()
  // The node's folders and models follow the recent folders and the model list.
  if (nodeJobs) capabilityPublisher().changed(capabilityKey())
}

/** Test and sign-out seam: forgets the session and everything about it. */
export function resetDesktopBridge(): void {
  live?.detach()
  live = null
  starting = false
  // A window that forgot its session is a new window as far as the server is
  // concerned, and a new window holds a new key.
  holderKey = null
  listeners.clear()
  turnSettled = true
  folderHandles.clear()
  stopApprovalPoll()
  disposeShellState?.()
  disposeShellState = null
  detachSidecar?.()
  detachSidecar = null
  detachClaudeAuth?.()
  detachClaudeAuth = null
  claudeAuthFailed = false
  discovery = null
  setState(initialSessionState())
}

/**
 * SIGNING OUT HANDS THE RUNTIME BACK TO LIAISON (overlay.tsx, the logout call).
 *
 * Clearing the mirror alone was half a sign out: the window the next person
 * signs in to is THIS window, with this store and this signal still saying
 * "local", so the control offered them a machine that was not theirs while
 * every turn ran on Liaison. It goes through the same setter a pick goes
 * through, so the signal, the store and every subscriber move together.
 *
 * Guarded on a live session, which a sign out cannot have: a session that was
 * somehow still running would keep the runtime that describes it.
 */
export function releaseRuntimeLocation(): void {
  if (state.sessionStatus === "running" || state.sessionStatus === "starting") return
  rememberRuntime("liaison")
  setDesktopSessionState({ runtimeLocation: "liaison" })
  // Remembering "liaison" and remembering nothing are the same window; the
  // absent key is the one a machine that never chose anything has.
  clearRuntimeLocationMirror()
}

function platform(): DesktopBridge["platform"] {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent
  if (/Windows/i.test(agent)) return "windows"
  if (/Linux|X11/i.test(agent) && !/Android/i.test(agent)) return "linux"
  return "macos"
}

/** The last segment of a path, whichever separator the platform uses. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/**
 * THE HANDLES THE SHELL HAS ISSUED, id to path (P6d-FX2, SK-1).
 *
 * The page never names a folder with a path. A folder the SHELL chose (the
 * native picker, or a row of the recent list the shell persists) gets a handle
 * here, the page hands one back to start a session, and a handle that is not
 * in this map starts nothing. Together with the Rust side's own check (a `cwd`
 * that is in neither the window's picks nor the persisted list is refused)
 * that is two independent answers to "who chose this folder", which is the
 * question `readLocalFile`'s whole bound rests on.
 */
const folderHandles = new Map<string, string>()
let issuedHandles = 0

/** The handle for a folder, issued once and then reused. */
function handleFor(path: string): string {
  for (const [id, known] of folderHandles) if (known === path) return id
  issuedHandles += 1
  const id = `folder-${issuedHandles}`
  folderHandles.set(id, path)
  return id
}

/** The folder a handle names, or null for one the shell never issued. */
function folderForHandle(id: unknown): string | null {
  if (typeof id !== "string") return null
  return folderHandles.get(id) ?? null
}

async function recentFoldersFor(agentId: string | null): Promise<DesktopRecentFolder[]> {
  if (!agentId) return []
  const paths = await getRecentFolders(agentId)
  return paths.map((path) => ({ id: handleFor(path), path, name: basename(path) }))
}

/** Drops both stream subscriptions, so a second publish is not a second copy. */
let detachSidecar: (() => void) | null = null

/**
 * THE ROW A PROMPT STANDS IN when the tool has not announced itself yet.
 *
 * The sidecar's `permission_request` carries the tool's name and its input but
 * no tool use id, and it can arrive before the `tool_use` block that would
 * have made a row. A card with nowhere to live renders nothing and the turn
 * stalls on a question nobody can answer, so the shell makes the row itself
 * and hands it back once the real one arrives.
 */
const PROMPT_ROW_PREFIX = "prompt:"

/**
 * The row a prompt belongs in: the last RUNNING row for that tool with those
 * arguments. By arguments and not by name alone, which is what put both
 * prompts of a tool called twice in one turn on the second row.
 */
function rowForPrompt(
  rows: DesktopToolActivity[],
  toolName: string,
  summary: string,
): string | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row.status === "running" && row.toolName === toolName && row.summary === summary) {
      return row.id
    }
  }
  return null
}

/**
 * Hands a stand-in row back to the real `tool_use` that turned up after it, so
 * one call is one row and the card does not move.
 */
function adoptPromptRows(
  rows: DesktopToolActivity[],
  prompts: DesktopPermissionRequest[],
): { rows: DesktopToolActivity[]; prompts: DesktopPermissionRequest[] } {
  let nextRows = rows
  let nextPrompts = prompts
  for (const ghost of rows.filter((row) => row.id.startsWith(PROMPT_ROW_PREFIX))) {
    const real = nextRows.find(
      (row) =>
        !row.id.startsWith(PROMPT_ROW_PREFIX) &&
        row.toolName === ghost.toolName &&
        row.summary === ghost.summary,
    )
    if (!real) continue
    nextRows = nextRows.filter((row) => row.id !== ghost.id)
    nextPrompts = nextPrompts.map((prompt) =>
      prompt.toolUseId === ghost.id ? { ...prompt, toolUseId: real.id } : prompt,
    )
  }
  return { rows: nextRows, prompts: nextPrompts }
}

/**
 * Whether the last turn has ENDED. The sidecar announces the end of a turn and
 * not its start, so the first tool activity after an ended turn is the start
 * of the next one, and that is where the rows are cleared.
 */
let turnSettled = true

/**
 * A LOCAL TURN THAT CANNOT FINISH, SAID ON THE CONVERSATION (2026-09-23).
 *
 * The turn is over, the rows stay (they are what the turn did), and the page
 * draws the failure with a Retry. Keyed by the conversation, so it is drawn
 * where the message is and nowhere else.
 */
function failTurn(
  threadId: string,
  agentId: string,
  messageId: string | null,
  reason: string,
  kind: "stopped" | "undelivered" = "stopped",
) {
  turnSettled = true
  stopApprovalPoll()
  setDesktopSessionState({
    turnActive: false,
    pendingPermissions: [],
    toolActivity: state.toolActivity.filter((row) => !row.id.startsWith(PROMPT_ROW_PREFIX)),
    turnFailure: { threadId, agentId, messageId, reason, kind },
  })
  if (kind === "stopped" && isClaudeAuthError(reason))
    claudeSignInNeeded(threadId, agentId, messageId)
}

/**
 * CLAUDE ON THIS COMPUTER IS NOT SIGNED IN (2026-09-24), for this turn or this
 * start. The window draws a notice with "Sign in to Claude" over the composer,
 * and the failed turn keeps its Retry.
 *
 * After a failed TURN the session is ENDED, when it is this conversation's:
 * its CLI read the credentials when it started, and a session started after
 * the sign-in reads the new ones. The Retry starts that session (and resumes
 * the SDK's own transcript), exactly as it does after a sidecar that died.
 */
function claudeSignInNeeded(threadId: string, agentId: string, messageId: string | null): void {
  if (messageId !== null) {
    // A TURN proved the stored sign-in dead. Until a sign-in succeeds, every
    // start is refused up front: the CLI's own status still reads a stored
    // but dead token as signed in, and the shell's cached one goes too.
    claudeAuthFailed = true
    void claudeAuthNoteFailure()
  }
  setDesktopSessionState({
    claudeSignInNeeded: { threadId, agentId, messageId },
    claudeAccount: { loggedIn: false, email: state.claudeAccount?.email ?? null },
  })
  // A refused START stops nothing: whatever runs was not what was asked for.
  if (messageId !== null && live && live.threadId === threadId && live.agentId === agentId) {
    void stop()
  }
}

/**
 * A LOCAL TURN'S ANSWER REACHED THE CONVERSATION. The message now carries the
 * turn's activity (the server stores it the way it stores a cloud turn's), so
 * the window's own copy of the rows goes: drawn twice, one turn reads as two.
 * A failure line about that same message retires with it.
 */
function turnDelivered(messageId: string) {
  const failure = state.turnFailure
  setDesktopSessionState({
    ...(turnSettled
      ? { toolActivity: state.toolActivity.filter((row) => row.status === "running") }
      : {}),
    ...(failure && failure.messageId === messageId ? { turnFailure: null } : {}),
  })
}

/**
 * THE SIDECAR DIED UNDER A RUNNING SESSION (2026-09-23).
 *
 * It sends no `turn_done` and no `done`, so nothing else would ever end the
 * turn, and the claim heartbeat would go on keeping the server away from a
 * conversation nobody on this machine can answer. So the session ends here:
 * the turn loop is detached, the handle finishes (which releases the claim and
 * closes the audit trail, `start-local-session.ts`), and the state says the
 * session stopped and which turn went with it. The next send, or the Retry,
 * starts a new session the ordinary way.
 */
function sidecarExited(exit: SidecarExitReport): void {
  const running = live
  if (!running) return
  const messageId = currentLocalTurnMessageId()
  live = null
  running.detach()
  void running.handle.finish().catch(() => undefined)
  failTurn(running.threadId, running.agentId, messageId, exit.reason)
  setDesktopSessionState({
    sessionStatus: "stopped",
    threadId: null,
    agentId: null,
    model: null,
  })
}

/**
 * Follows the sidecar's stream for as long as this window lives, so the page
 * can render a local turn as the agent's own activity rows and its permission
 * prompt as a card in the conversation (P6d-T11, P6d-T12).
 *
 * What crosses is a one line SUMMARY of a call's arguments, never the raw
 * input blob: a tool's input shape is per tool and the page has no business
 * parsing one (session/tool-activity.ts).
 */
function followSidecar(): void {
  detachSidecar?.()
  const stopTurns = onTurnEvent((event) => {
    if (isToolEvent(event)) {
      // ONE TURN'S WORTH OF ROWS (P6d-FX1, SK-4). The array used to be cleared
      // only when a session started or stopped, so the second turn of a
      // session repeated the first turn's rows and the tenth repeated all
      // nine. A turn's activity belongs to that turn.
      const before = turnSettled ? [] : state.toolActivity
      // A PARKED PROMPT IS NEVER DROPPED BY A TOOL EVENT. It used to be cleared
      // with the rows when this event looked like the start of a new turn, but
      // a prompt that arrived while the shell still read the turn as settled
      // (its tool already had a running row) is still parked in the SDK, and
      // clearing it left the turn blocked on a question nobody could see. Only
      // an answer or a turn boundary (below) retires one.
      const waiting = state.pendingPermissions
      turnSettled = false
      const merged = adoptPromptRows(applyToolEvent(before, event), waiting)
      setDesktopSessionState({
        toolActivity: merged.rows,
        pendingPermissions: merged.prompts,
        turnActive: true,
      })
      // A FILE THE TURN WROTE IS A FILE THE COMPOSER CAN ATTACH (P6d-FX8).
      // `noteProducedFile` was called from nothing but a test, so the list the
      // attach control renders was empty in every shipped session and the
      // control never mounted. The stream is where a running session says it
      // wrote something.
      for (const path of producedFilePathsOf(event, state.folderPath)) noteProducedFile(path)
      return
    }
    if (event.type === SIDECAR_EXITED_TYPE) {
      sidecarExited(event as SidecarExitReport)
      return
    }
    if (event.type === "local_models") {
      adoptLocalModels((event as { models?: unknown }).models)
      return
    }
    // A TURN ENDS ON A TURN BOUNDARY (P6d-FX2, SK-3). `error` used to be one of
    // them, and the sidecar emits `error` lines that say nothing about the turn:
    // one of them retired every permission card while the SDK was still parked
    // on the question. A fatal session error is always followed by `done`, so
    // nothing is lost by reading only the two lines that mean it.
    if (event.type === "turn_done" || event.type === "done") {
      turnSettled = true
      // A turn that ended cannot gain a new approval, so the poll ends with it
      // rather than running for the life of the window.
      stopApprovalPoll()
      setDesktopSessionState({
        pendingPermissions: [],
        // A stand-in row nothing ever claimed is a row about a tool call that
        // never happened, and the turn is over: nothing more will be learned.
        toolActivity: state.toolActivity.filter((row) => !row.id.startsWith(PROMPT_ROW_PREFIX)),
        // The ROWS stay (they are the only record of what the turn did) and
        // the turn does not: a block still drawn as streaming after the reply
        // is a turn that never ends on screen.
        turnActive: false,
        // The "agent was updated" line belongs to the new session's FIRST
        // turn: past it, it would read as news about every later one.
        freshSession: null,
      })
    }
  })

  const stopPrompts = onPermissionPrompt((prompt) => {
    const summary = summarizeArguments(prompt.input) || prompt.toolName
    let rows = state.toolActivity
    let toolUseId = rowForPrompt(rows, prompt.toolName, summary)
    if (!toolUseId) {
      toolUseId = `${PROMPT_ROW_PREFIX}${prompt.requestId}`
      rows = [
        ...rows,
        {
          id: toolUseId,
          toolName: prompt.toolName,
          summary,
          status: "running" as const,
          startedAt: Date.now(),
        },
      ]
      turnSettled = false
    }
    // APPENDED, never overwritten: a second prompt arriving before the first
    // is answered used to take its slot, and the first was then waiting on an
    // answer no surface could give it.
    setDesktopSessionState({
      toolActivity: rows,
      pendingPermissions: [
        ...state.pendingPermissions,
        { requestId: prompt.requestId, toolName: prompt.toolName, summary, toolUseId },
      ],
    })
  })

  detachSidecar = () => {
    stopTurns()
    stopPrompts()
  }
}

/**
 * THE GATED CALL THE SESSION IS WAITING ON (P6d-FX1, SK-1).
 *
 * The overlay polled this for a banner of its own; the banner is gone and the
 * page raises a toast instead, so the poll lives here, beside the state it
 * writes. The status comes from the `liaison_approval_status` meta tool,
 * relayed through the sidecar so the session token never reaches the webview.
 */
export const APPROVAL_STATUS_TOOL = "liaison_approval_status"
export const APPROVAL_POLL_INTERVAL_MS = 2_000

/**
 * The tool's `state` field, onto what the window can SAY about it. `null` is
 * decided: nobody has to wait, so there is nothing to show. An answer this
 * build has never heard of is `unknown` and never `pending`: telling a user
 * their request is queued when it may have been lost is the failure the status
 * path exists to prevent.
 */
export function approvalStatusFor(state: unknown): DesktopApprovalStatus | null {
  switch (state) {
    case "pending":
      return "pending"
    case "approved":
    case "denied":
    case "withdrawn":
    case "cancelled":
      return null
    default:
      return "unknown"
  }
}

let approvalTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The request the poll is about, as a PLAIN variable rather than a store read.
 * The poll is started from inside an effect, and an effect that reads the same
 * store field it writes re-runs itself forever.
 */
let pollingApprovalId: string | null = null

function stopApprovalPoll(): void {
  if (approvalTimer) clearTimeout(approvalTimer)
  approvalTimer = null
  pollingApprovalId = null
}

async function pollApproval(requestId: string): Promise<void> {
  // The id moved on (decided, cleared, or replaced) while the call was in
  // flight: this answer is about a request nothing is waiting for.
  if (pollingApprovalId !== requestId) return
  let status: DesktopApprovalStatus | null
  try {
    const result = (await callMcpTool(APPROVAL_STATUS_TOOL, { approvalRequestId: requestId })) as
      | { structuredContent?: { state?: unknown } }
      | undefined
    status = approvalStatusFor(result?.structuredContent?.state)
  } catch {
    // A status we could not read is a status we do not know.
    status = "unknown"
  }
  if (pollingApprovalId !== requestId) return
  if (status === null) {
    pollingApprovalId = null
    setDesktopSessionState({ pendingApprovalRequestId: null, approvalStatus: null })
    return
  }
  setDesktopSessionState({ approvalStatus: status })
  approvalTimer = setTimeout(() => void pollApproval(requestId), APPROVAL_POLL_INTERVAL_MS)
}

/** Disposes the effects below, so a reset does not leave two of each. */
let disposeShellState: (() => void) | null = null

/**
 * EVERY FIELD THE PAGE READS IS WRITTEN HERE (P6d-FX1, SK-1).
 *
 * apps/web renders the device grant, the reconnect toast, the approval toast
 * and the produced-file attach entirely from this state. Before this the shell
 * wrote six fields and the other five were declared and never filled, so those
 * four surfaces were green against a fake bridge and dead in the product. Each
 * one is now followed from the half of the shell that actually learns it:
 *
 *   deviceApproval / reconnectReason /
 *   updateProgress                    the sidecar client's own signals
 *   producedFiles                     the desktop store's produced files
 *   deepLinkAddress                   the deep link handler's parsed proposal
 *   pendingApprovalRequestId /
 *   approvalStatus                    the `liaison_approval_status` poll
 */
function followShellState(): void {
  disposeShellState?.()
  disposeShellState = createRoot((dispose) => {
    createEffect(() => {
      setDesktopSessionState({ deviceApproval: deviceApproval() })
    })
    createEffect(() => {
      setDesktopSessionState({ reconnectReason: reconnectReason() })
    })
    createEffect(() => {
      setDesktopSessionState({ updateProgress: updateProgress() })
    })
    createEffect(() => {
      // EVERY file, not the last one (P6d-FX2, SK-8). The contract's field is a
      // list because the runtime pill's menu renders a list; mapping one slot into it
      // made that list structurally one row long.
      setDesktopSessionState({
        producedFiles: producedFiles().map((path) => ({ path, name: basename(path) })),
      })
    })
    createEffect(() => {
      setDesktopSessionState({ deepLinkAddress: connectDeepLinkAddress() })
    })
    createEffect(() => {
      const id = approvalRequestId()
      stopApprovalPoll()
      // `approvalStatus` stays null until the poll answers: the page reads a
      // null status as "waiting", which is the safe half of the pair.
      setDesktopSessionState({ pendingApprovalRequestId: id, approvalStatus: null })
      if (id) {
        pollingApprovalId = id
        void pollApproval(id)
      }
    })
    return dispose
  })
}

/**
 * Starts one local session for one conversation.
 *
 * The composition is the one `OpenFolderWithAgent` performed: hash the folder,
 * recall the mode that (agent, folder) pair last ran in, resume the session id
 * the pair left behind, start, then attach the turn loop for the conversation
 * that was claimed. It is here now because the folder and the conversation
 * come from the page's own control rather than from a floating panel.
 */
/**
 * The refusal a thrown start carries, as one of the shared vocabulary.
 *
 * `LocalSessionStartError` names which of the three server steps refused and
 * `ShellRefusalError` carries the shell's own `start_session` variant; nothing
 * else that reaches here knows anything a user can act on, so it is the
 * fallback rather than a string scraped out of a message.
 */
export function startRefusalFor(error: unknown): DesktopStartRefusal {
  if (error instanceof LocalSessionStartError) return error.reason
  if (error instanceof ShellRefusalError) return error.variant as DesktopStartRefusal
  return "StartFailed"
}

function refuseStart(
  reason: DesktopStartRefusal,
  detail: string | null = null,
  holder: DesktopClaimHolder | null = null,
): false {
  setDesktopSessionState({
    sessionStatus: "idle",
    startError: reason,
    startErrorDetail: detail,
    startClaimHolder: holder,
  })
  return false
}

/** Who holds the conversation, when the refusal is a claim the server named. */
function claimHolderOf(error: unknown): DesktopClaimHolder | null {
  return error instanceof LocalSessionStartError ? error.holder : null
}

/** What the shell said beyond the refusal's code: a dead sidecar's stderr. */
function refusalDetailOf(error: unknown): string | null {
  return error instanceof ShellRefusalError ? error.detail : null
}

async function start(input: DesktopStartSessionInput): Promise<boolean> {
  if (starting) return refuseStart("AlreadyStarting")
  // A PATH IS NOT AN ARGUMENT (P6d-FX2, SK-1). A caller that sends one is a
  // caller working from the shape this method used to have, and that shape let
  // a page script root the session, and therefore `readLocalFile`, anywhere on
  // the machine. Refused rather than ignored, so the mistake is loud.
  if (Object.hasOwn(input as object, "folderPath")) return refuseStart("PathNotAllowed")
  let folder: string | null
  if (input.folderId !== undefined) {
    folder = folderForHandle(input.folderId)
    // A handle this shell never issued names no folder at all.
    if (!folder) return refuseStart("UnknownFolder")
  } else {
    folder = state.folderPath
  }
  if (!folder) return refuseStart("NoFolderChosen")
  if (!input.threadId || !input.agentId) return refuseStart("NoConversation")
  // ONLY A LOCAL MODEL REACHES THE SIDECAR. The page names the model the user
  // picked for this conversation; anything that is not one of the Claude
  // models this shell offers (a Liaison model id, a typo, a page script's
  // invention) is refused rather than handed to the user's own Claude login.
  // Omitted is the default, which is what a page older than the choice sends.
  // A fallback id is accepted too: a page older than discovery names them
  // (`isStartableLocalModel`).
  const offered = offeredLocalModels()
  const model =
    input.model === undefined ? defaultLocalModel(currentNodeModels(offered)) : input.model
  if (!isStartableLocalModel(model, offered)) return refuseStart("UnknownModel")
  const server = boundServerAddress()
  const token = accessToken()
  if (!server || !token) return refuseStart("NotSignedIn")
  // INSIDE THE TRY, WITH THE FINALLY (P6d-FX7, SK-4). `starting` used to be
  // raised before an unguarded `await stop()`: a stop that rejected, or one
  // that never settled on a release the server accepted and never answered,
  // left this flag true for the life of the window and every later press
  // answered AlreadyStarting about a start that was never going to finish.
  starting = true
  // NO CLAUDE SIGN-IN, NO START (2026-09-24). Asked before anything running is
  // stopped or handed over: a start that cannot run a turn must not cost the
  // session that is running. Refused with its own reason, and the page offers
  // the sign-in over the composer.
  try {
    if (await claudeSignInMissing()) {
      starting = false
      claudeSignInNeeded(input.threadId, input.agentId, null)
      return refuseStart("ClaudeSignInRequired")
    }
  } catch {
    // Not being able to ask is not an answer: the start goes ahead, and a
    // turn that cannot authenticate says so on its own.
  }
  const previous = live
  // THE SAME CONVERSATION IS A RESTART, ANOTHER ONE IS A HANDOVER (P6d-FX7,
  // SK-2). Stopping unconditionally before anything had been validated meant a
  // start that the server then REFUSED had already destroyed the session that
  // was working, for a conversation the user never asked to leave. So:
  //   - same (thread, agent): stop first, exactly as P6d-FX5 made it. The old
  //     claim is released before the new one is registered, so the 409 cannot
  //     come from this window's own lease;
  //   - a different conversation: only the CLAIM is released up front (the
  //     server must stop answering there), the sidecar keeps running, and it
  //     is retired only once the new session is up. A refusal puts the claim
  //     back and leaves the session that was running exactly where it was.
  const sameConversation =
    previous !== null && previous.threadId === input.threadId && previous.agentId === input.agentId
  let handedOver = false
  try {
    if (sameConversation) {
      await stop()
    } else if (previous) {
      await previous.handle.releaseClaim()
      handedOver = true
    }
    setDesktopSessionState({
      sessionStatus: "starting",
      startError: null,
      startErrorDetail: null,
      startClaimHolder: null,
    })
    const digest = await hashFolder(folder)
    const mode = recallPermissionMode(input.agentId, digest)
    // THE COLD DECISION IS THE SERVER'S, AND SO IS THE CONTEXT (P4c-E1,
    // P4c-T26b). Asked ONCE, BEFORE the session is started, because it decides
    // whether there is an SDK conversation to resume at all: a turn more than
    // the warm window after this agent's last one runs against the context the
    // server reassembled, not the raw transcript the old session is still
    // holding. Never throws: an unreachable or older server answers null and
    // the session resumes as before, because a stale context beats none.
    // And, on a warm turn, who wrote the conversation's last agent turn: the
    // stored SDK session is resumed only if it was this one (2026-09-23).
    const { context: coldContext, lastAgentTurn } = await fetchTurnContext({
      serverAddress: server,
      accessToken: token,
      agentId: input.agentId,
      threadId: input.threadId,
      continuity: true,
    })
    const coldResume = coldContext !== null
    const handle = await startLocalSession({
      agentId: input.agentId,
      threadId: input.threadId,
      folder,
      mode,
      model,
      serverAddress: server,
      // THE SIGNAL, NOT ITS VALUE. The session heartbeats, re-reads messages
      // and posts replies for as long as it lives, and the value here dies
      // fifteen minutes after it was minted.
      accessToken,
      resumeSessionId: getSessionId(input.agentId, digest),
      coldResume,
      coldContext,
      ...(lastAgentTurn !== undefined ? { lastAgentTurn } : {}),
      // ONE HOLDER KEY PER WINDOW (P6d-FX7, SK-5). `local-claim.ts` says the
      // holder is the user AND the window; minting a fresh key per claim made
      // it the user and the CLAIM, so a release the server never applied left
      // this window arguing with its own lease and being told to go and stop
      // the session on another machine.
      holderKey: await windowHolderKey(),
      // Only when the person pressed Take over on a refusal that said who
      // holds the conversation. Never implicit (the server audits it).
      ...(input.takeOver === true ? { takeOver: true } : {}),
    })
    // Only now is the previous session retired, and WITHOUT asking the shell to
    // stop a sidecar: the shell has one child slot and the start above already
    // replaced it, so `stopSession` here would stop the session that just
    // started. Detaching and closing its trail is what is left to do.
    if (handedOver && previous) {
      previous.detach()
      await previous.handle.finish().catch(() => undefined)
    }
    const agentId = input.agentId
    const threadId = input.threadId
    live = {
      handle,
      // A prompt that could not be handed to the sidecar is a failed turn on
      // this conversation, said where the message is.
      detach: attachLocalTurns(
        handle,
        threadId,
        (messageId, reason, kind) => failTurn(threadId, agentId, messageId, reason, kind),
        turnDelivered,
      ),
      threadId,
      agentId,
    }
    // THE GRANT IS ANSWERED THE MOMENT THE SESSION RUNS (P6d-FX5, W5). It used
    // to be dropped only on the sidecar's `ready` line, which is emitted on the
    // first SDK message and therefore arrives AFTER the first turn was sent:
    // the code sat on screen over a running session, and with the step drawn in
    // a dialog it covered the very composer the turn has to be typed into.
    clearDeviceApprovalCommand()
    rememberRuntime("local")
    rememberThreadFolder(input.threadId, folder)
    // The files the LAST session made are in the last session's folder, and
    // the shell reads a file back only from the folder the session runs in.
    clearProducedFiles()
    setDesktopSessionState({
      sessionStatus: "running",
      runtimeLocation: "local",
      permissionMode: mode,
      folderPath: folder,
      threadId: input.threadId,
      agentId: input.agentId,
      model,
      recentFolders: await recentFoldersFor(input.agentId),
      toolActivity: [],
      pendingPermissions: [],
      startError: null,
      startErrorDetail: null,
      startClaimHolder: null,
      // A session running again is the answer to whatever failure was drawn.
      turnFailure: null,
      // A NEW SESSION BECAUSE THE AGENT CHANGED says so in the conversation
      // (2026-09-23). A legacy entry started fresh too, but nothing the person
      // could see changed, so that one is only in the audit row.
      freshSession:
        handle.freshReason === "definition_changed"
          ? { threadId: input.threadId, agentId: input.agentId, reason: "definition_changed" }
          : null,
    })
    turnSettled = true
    return true
  } catch (error) {
    // EVERY REFUSAL SAYS WHICH ONE IT WAS. The reason travels as a code and
    // the page owns the sentence, exactly as the reconnect reasons do.
    const reason = startRefusalFor(error)
    const detail = refusalDetailOf(error)
    if (handedOver && previous && live === previous) {
      // The session that was running is still running: its claim goes back
      // (best effort, the heartbeat and the TTL are the backstop), and the
      // state says which conversation this window is answering again. The
      // refusal still travels, so the toast names what failed.
      await previous.handle.reclaim().catch(() => undefined)
      setDesktopSessionState({
        sessionStatus: "running",
        threadId: previous.threadId,
        agentId: previous.agentId,
        startError: reason,
        startErrorDetail: detail,
        startClaimHolder: claimHolderOf(error),
      })
      return false
    }
    return refuseStart(reason, detail, claimHolderOf(error))
  } finally {
    starting = false
  }
}

/**
 * Whether Claude on this computer is known NOT to be signed in. A sign-in the
 * window already saw is trusted (a turn that finds it dead says so); anything
 * else is asked of the shell. A shell that cannot say is not a "no".
 */
async function claudeSignInMissing(): Promise<boolean> {
  if (claudeAuthFailed) return true
  if (state.claudeAccount?.loggedIn === true) return false
  // The shell answers a sign-in it read at launch without running the CLI.
  const account = await claudeAuthStatus({ fresh: false })
  if (!account) return false
  setDesktopSessionState({ claudeAccount: account })
  return !account.loggedIn
}

/**
 * A local turn failed to authenticate since the last successful sign-in in this
 * window. Cleared by a sign-in (`signedIn`), and by a new window.
 */
let claudeAuthFailed = false

/** Drops the Claude sign-in subscription, so a second publish is not a second copy. */
let detachClaudeAuth: (() => void) | null = null

/**
 * FOLLOWS A CLAUDE SIGN-IN (`src-tauri/src/claude_auth.rs`). The shell says
 * the phase and never the URL or the code; the page draws its dialog from
 * `claudeSignIn`, which is cleared on success and on a cancel.
 */
export function applyClaudeAuthUpdate(update: ClaudeAuthUpdate): void {
  switch (update.phase) {
    case "starting":
    case "waiting":
    case "checking":
    case "codeRejected":
      setDesktopSessionState({ claudeSignIn: { phase: update.phase } })
      return
    case "signedIn":
      claudeAuthFailed = false
      setDesktopSessionState({
        claudeSignIn: null,
        claudeSignInNeeded: null,
        claudeAccount: update.account ?? { loggedIn: true, email: null },
      })
      return
    case "signedOut":
      setDesktopSessionState({
        claudeAccount: update.account ?? { loggedIn: false, email: null },
      })
      return
    case "failed":
      // A cancel is the person closing the dialog: nothing to say.
      setDesktopSessionState({
        claudeSignIn:
          update.reason === "cancelled"
            ? null
            : { phase: "failed", reason: update.reason ?? "failed", detail: update.detail ?? null },
      })
      return
  }
}

function followClaudeAuth(): void {
  detachClaudeAuth?.()
  let stopped = false
  let unlisten: (() => void) | null = null
  detachClaudeAuth = () => {
    stopped = true
    unlisten?.()
  }
  void onClaudeAuth(applyClaudeAuthUpdate)
    .then((stop) => {
      if (stopped) stop()
      else unlisten = stop
    })
    .catch(() => undefined)
}

/**
 * STARTS A CLAUDE SIGN-IN, from the composer's notice or Settings > Profile.
 * The dialog opens on `starting` at once, before the shell has answered.
 */
export async function beginClaudeSignIn(): Promise<boolean> {
  setDesktopSessionState({ claudeSignIn: { phase: "starting" } })
  try {
    await claudeAuthLogin()
    return true
  } catch (error) {
    setDesktopSessionState({
      claudeSignIn: { phase: "failed", reason: variantOfRefusal(error), detail: null },
    })
    return false
  }
}

function variantOfRefusal(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return /^[A-Z][A-Za-z]+$/.test(raw) ? raw : "failed"
}

async function stop(): Promise<void> {
  const running = live
  if (!running) return
  live = null
  running.detach()
  await endLocalSession(running.handle).catch(() => undefined)
  setDesktopSessionState({
    sessionStatus: "stopped",
    threadId: null,
    agentId: null,
    model: null,
    toolActivity: [],
    pendingPermissions: [],
    freshSession: null,
  })
}

/**
 * Ends whatever this window is running, for a window that is going away
 * (`overlay.tsx` arms `pagehide` and `beforeunload`). Ending it releases the
 * thread claim, and a claim nobody releases leaves the conversation with no
 * answerer at all until its TTL runs out.
 */
export function endBridgeSession(): Promise<void> {
  return stop()
}

/**
 * D49 F9, D50: on a server switch, waits (at most `timeoutMs`) for the
 * node's follows and runs, which the shell ended, to post their end to the
 * server being left. Nothing to wait for when this computer runs no node jobs.
 */
export function settleNodeJobs(timeoutMs: number): Promise<void> {
  return nodeJobs ? nodeJobs.settleNodeJobs(timeoutMs) : Promise.resolve()
}

/**
 * B2-1 (D52): before the shell switches servers, the node claims and starts
 * nothing more (queued offers dropped, new offers ignored); a refused switch
 * thaws it again.
 */
export function freezeNodeJobs(): void {
  nodeJobs?.freezeNodeJobs()
}

export function thawNodeJobs(): void {
  nodeJobs?.thawNodeJobs()
}

/**
 * How long the shell waits for the sidecar to say what it did with a mode
 * change. A mode change is a line written to a child on this machine, so this
 * is generous; what it is NOT is optional, because no answer means the window
 * does not know, and the window must not report a mode it does not know took.
 */
export const PERMISSION_MODE_ACK_TIMEOUT_MS = 10_000

/**
 * The sidecar's own answer to one mode change: `permission_mode` for a change
 * the SDK took, `permission_mode_refused` for one it did not, nothing at all
 * for a sidecar that went away (which the timeout reads as a refusal, because
 * an unanswered change is one the window cannot claim happened).
 */
function awaitModeAck(mode: DesktopPermissionMode): {
  answer: Promise<boolean>
  cancel: () => void
} {
  let detach: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let finish: (answer: boolean) => void = () => undefined
  const answer = new Promise<boolean>((resolve) => {
    finish = (value: boolean) => {
      detach?.()
      detach = null
      if (timer) clearTimeout(timer)
      timer = null
      resolve(value)
    }
  })
  detach = onTurnEvent((event) => {
    const line = event as { type?: string; mode?: unknown }
    if (line.mode !== mode) return
    if (line.type === "permission_mode") finish(true)
    if (line.type === "permission_mode_refused") finish(false)
  })
  timer = setTimeout(() => finish(false), PERMISSION_MODE_ACK_TIMEOUT_MS)
  return { answer, cancel: () => finish(false) }
}

/** A prompt for one of the Liaison MCP server's own tools (sdk-runner.ts names it `liaison`). */
function isLiaisonToolPrompt(prompt: DesktopPermissionRequest): boolean {
  return prompt.toolName.startsWith("mcp__liaison__")
}

/**
 * Allows every prompt the session is parked on, for a switch to Bypass (or,
 * filtered, to Auto).
 *
 * The card used to be HIDDEN in Bypass and the prompt left outstanding, so the
 * user turned the questions off and the tool call blocked until the sidecar's
 * own timeout with no answerable UI anywhere. The shell answers them instead,
 * and marks the row so the activity trail says who decided.
 */
async function allowParkedPrompts(
  which: (prompt: DesktopPermissionRequest) => boolean = () => true,
): Promise<void> {
  const parked = state.pendingPermissions.filter(which)
  if (parked.length === 0) return
  for (const prompt of parked) {
    // An id the shell already retired is not an error here: it means the
    // sidecar answered it first, which is the outcome we were after.
    await respondToPermissionPrompt(prompt.requestId, "allow").catch(() => undefined)
  }
  const answered = new Set(parked.map((prompt) => prompt.toolUseId))
  const answeredIds = new Set(parked.map((prompt) => prompt.requestId))
  setDesktopSessionState({
    pendingPermissions: state.pendingPermissions.filter(
      (prompt) => !answeredIds.has(prompt.requestId),
    ),
    toolActivity: state.toolActivity.map((row) =>
      answered.has(row.id) ? { ...row, allowedByBypass: true } : row,
    ),
  })
}

function buildBridge(): DesktopBridge {
  return {
    version: DESKTOP_BRIDGE_VERSION,
    platform: platform(),
    /**
     * Every model `startSession` accepts, as bare ids for a page older than
     * the labelled list on the state. A getter, because the list changes when
     * a session says what its SDK offers.
     */
    get localModels(): readonly string[] {
      return offeredLocalModels().map((model) => model.id)
    },

    /**
     * The native picker, answering with the HANDLE for what the user chose
     * (P6d-FX2, SK-1). The shell records the folder on its own side as it goes,
     * which is what makes it startable; the path itself reaches the page on the
     * state, where it is drawn and nothing more.
     */
    async pickFolder(requestedAgentId?: string, threadId?: string): Promise<string | null> {
      // THE CALLER'S AGENT WINS while nothing is running (P6d-FX3, W3): the
      // state names an agent only once a session has claimed one, so an idle
      // pick used to be filed under null and joined no recent list at all.
      const agentId = state.agentId ?? requestedAgentId ?? null
      const chosen = await pickFolderCommand(agentId)
      if (!chosen) return null
      const handle = handleFor(chosen)
      // Remembered for the conversation it was picked for, so a relaunch does
      // not ask again (even when the start that followed was refused).
      rememberThreadFolder(threadId, chosen)
      setDesktopSessionState({
        folderPath: chosen,
        runtimeLocation: "local",
        recentFolders: await recentFoldersFor(agentId),
      })
      rememberRuntime("local")
      return handle
    },

    /**
     * The folder this conversation last ran in, back on the state, when it is
     * still one of this agent's own recent folders. Never while another
     * conversation's session is running: the state's folder is that
     * session's, and the header would name the wrong one.
     */
    async restoreThreadFolder(threadId: string, agentId: string): Promise<string | null> {
      if (!threadId || !agentId) return null
      const remembered = recallThreadFolder(threadId)
      if (!remembered) return null
      if (live && live.threadId !== threadId) return null
      const recent = await recentFoldersFor(agentId)
      if (!recent.some((folder) => folder.path === remembered)) return null
      setDesktopSessionState({ folderPath: remembered, recentFolders: recent })
      return handleFor(remembered)
    },

    /** The shell's own list for this agent, read back onto the state. */
    async loadRecentFolders(agentId: string): Promise<void> {
      if (!agentId) return
      setDesktopSessionState({ recentFolders: await recentFoldersFor(agentId) })
    },

    getServerAddress: () => boundServerAddress(),

    /**
     * The saved servers, for the page's servers UI (session/desktop-servers.ts).
     * On Windows and Linux it is the only switcher: the shell draws no menu
     * strip in the window there.
     */
    servers: buildDesktopServers(),

    /**
     * A NEW SERVER, through the same switch the servers UI makes
     * (session/server-switch.ts): the shell checks the address answers as a
     * Liaison, files it in the saved list and makes it current, stopping the
     * local session; then the claim is released on the server being left, the
     * page's storage is swapped for the new server's, and the mirror is
     * rewritten BEFORE the page starts again. The page comes up reading that
     * mirror synchronously, so writing only the shell's record brought it
     * straight back up on the address the user was leaving. A refusal throws
     * before any of it, with the shell's reason as the message, which is what
     * the connect card's error line is built on.
     */
    async setServerAddress(url: string): Promise<void> {
      await switchServerWith((outgoing) => setServerAddressCommand(url, outgoing))
    },

    dismissConnect(): void {
      clearConnectProposal()
      setDesktopSessionState({ addingServer: false, deepLinkAddress: null })
    },

    startSession: (input) => start(input),
    stopSession: () => stop(),

    /**
     * One turn, named by the MESSAGE the conversation holds (P6d-FX1).
     *
     * Never the text itself: this object is on the window, so a raw text path
     * would let any script in the page run a prompt on the user's own Claude
     * Code login. The shell re-reads the message by id and checks it is a
     * human's, in this session's own conversation, before anything runs
     * (session/thread-turn-bridge.ts).
     */
    async sendTurn(messageId: string): Promise<void> {
      await submitLocalTurn(messageId)
    },

    async interruptTurn(): Promise<void> {
      await interrupt()
    },

    async respondToPermission(
      requestId: string,
      decision: DesktopPermissionDecision,
    ): Promise<void> {
      // What the shell WROTE, which for a shell command is the answer given in
      // its own dialog (D11), not necessarily the one asked for here.
      const written = await respondToPermissionPrompt(requestId, decision)
      const answered = state.pendingPermissions.find((prompt) => prompt.requestId === requestId)
      if (!answered) return
      // A DENIED stand-in row is a tool that will never run, so it goes with
      // the prompt. An allowed one stays: the real `tool_use` is about to
      // arrive and will claim it.
      const drop =
        written === "deny" && answered.toolUseId.startsWith(PROMPT_ROW_PREFIX)
          ? answered.toolUseId
          : null
      setDesktopSessionState({
        pendingPermissions: state.pendingPermissions.filter(
          (prompt) => prompt.requestId !== requestId,
        ),
        ...(drop ? { toolActivity: state.toolActivity.filter((row) => row.id !== drop) } : {}),
      })
    },

    async readLocalFile(path: string): Promise<Blob | null> {
      try {
        return await readLocalFileCommand(path)
      } catch {
        return null
      }
    },

    /**
     * THE MODE GOES THROUGH THE SHELL, and nothing is remembered until it
     * agreed (P6d-FX1, SK-2 and SK-6).
     *
     * Two things were wrong with writing it here. Bypass removes every
     * permission prompt the user is relying on, and this method is on the
     * window: a page script could turn it on with no dialog of any kind, and
     * the value persisted, so the escalation survived into the next session.
     * And the mode never reached the RUNNING session at all, so the menu
     * changed a pill while the live session kept its old rules.
     *
     * The shell now validates the mode, asks its own native confirmation for
     * Bypass against the folder actually being handed over, and writes the
     * control line that changes the live SDK query. A refusal answers false
     * and leaves the remembered mode exactly as it was.
     */
    async setPermissionMode(mode: DesktopPermissionMode): Promise<boolean> {
      // ARMED BEFORE THE COMMAND (P6d-FX2, SK-4). The Tauri command resolves
      // the moment the control line is written to the child's stdin, which
      // says nothing about whether the SDK took it; the answer comes back on
      // the stream, and it can be there before the invoke resolves.
      const ack = state.sessionStatus === "running" ? awaitModeAck(mode) : null
      try {
        await setPermissionModeCommand(mode)
      } catch {
        ack?.cancel()
        return false
      }
      // NOTHING IS REMEMBERED UNTIL THE RUNNING QUERY ACKNOWLEDGED IT. With no
      // session running there is nothing to acknowledge: the mode is the
      // preference the next session starts in, which is what the shell answers
      // Ok to.
      if (ack && !(await ack.answer)) return false
      rememberMode(mode)
      setDesktopSessionState({ permissionMode: mode })
      // BYPASS ANSWERS WHAT IS ALREADY PARKED (P6d-FX2, SK-5). The user turned
      // the prompts off; the SDK is still parked on the ones it asked before
      // that, and nothing was going to answer them. Bypass means allow, so
      // they are allowed, and the row each one belongs to records that it was
      // the mode change and not the user that said yes.
      if (mode === "bypass") await allowParkedPrompts()
      // AUTO ANSWERS WHAT IT WOULD NOT HAVE ASKED: a Liaison tool call parked
      // before the switch. A shell command stays on its card, because only the
      // sidecar sees the command it would have to judge (auto-policy.ts).
      if (mode === "auto") await allowParkedPrompts(isLiaisonToolPrompt)
      const folder = state.folderPath
      const agentId = state.agentId
      // Remembered per (agent, folder) exactly as the switch remembered it,
      // keyed by the folder's digest so the path never leaves this machine.
      if (folder && agentId) {
        void hashFolder(folder).then((digest) => rememberPermissionMode(agentId, digest, mode))
      }
      return true
    },

    setRuntimeLocation(location: DesktopRuntimeLocation): void {
      rememberRuntime(location)
      setDesktopSessionState({ runtimeLocation: location })
    },

    /**
     * THE THIRD WAY A DEVICE GRANT ENDS (P6d-FX5, W5): the user closes it.
     *
     * The shell drops the code itself on `ready` and on the reconnect event,
     * which covers approval and expiry. Nothing covered the user giving up, so
     * `clearDeviceApproval` existed in the sidecar client and NOTHING called
     * it: a code that had been approved stayed on the state for the life of
     * the window and was shown again on the next sign-out, to a user who had
     * not asked for a session.
     *
     * It releases nothing, because nothing was taken: the claim is made after
     * the grant, and the grant the shell is polling is the shell's own to
     * finish or to time out.
     */
    clearDeviceApproval(): void {
      clearDeviceApprovalCommand()
      setDesktopSessionState({ deviceApproval: null, sessionStatus: "idle" })
    },

    /**
     * SIGN-IN HAPPENS IN THE USER'S OWN BROWSER (RFC 8252). The identity
     * provider's page never runs in this window: Google refuses embedded user
     * agents, and passkeys cannot reach the platform store from here. The
     * shell opens the URL, and only a URL that is this install's own server's
     * desktop authorize route.
     */
    openAuthInBrowser: (url: string) => openOAuthUrl(url),

    /** The device approval page, in the system browser (the shell validates it). */
    openDeviceApproval: (url: string) => openDeviceApprovalUrl(url),

    /** A clicked external link, in the system browser (the shell validates it). */
    openExternalUrl: (url: string) => openExternalUrl(url),

    /** The `liaison://oauth-complete` links that end such a sign-in. */
    onOAuthComplete: (listener: (link: string) => void) => onOAuthCompleteLink(listener),

    async checkClaudeAccount(): Promise<DesktopClaudeAccount | null> {
      const account = await claudeAuthStatus({ fresh: true })
      if (account) setDesktopSessionState({ claudeAccount: account })
      return account
    },

    startClaudeSignIn: () => beginClaudeSignIn(),

    async submitClaudeSignInCode(code: string): Promise<boolean> {
      if (typeof code !== "string" || !code.trim()) return false
      setDesktopSessionState({ claudeSignIn: { phase: "checking" } })
      try {
        await claudeAuthSubmitCode(code)
        return true
      } catch {
        setDesktopSessionState({ claudeSignIn: { phase: "codeRejected" } })
        return false
      }
    },

    async cancelClaudeSignIn(): Promise<void> {
      await claudeAuthCancel().catch(() => undefined)
      setDesktopSessionState({ claudeSignIn: null })
    },

    reopenClaudeSignIn: () => claudeAuthReopen(),

    /**
     * Asks the shell's own native question; the page cannot answer it.
     * Settings is the only place it is offered, on every desktop OS.
     */
    signOutOfClaude: () => confirmClaudeSignOut(),

    dismissClaudeSignInNeeded(): void {
      setDesktopSessionState({ claudeSignInNeeded: null })
    },

    /**
     * A path an agent's message named, opened by the SHELL, which reveals
     * rather than runs anything executable (`local_path.rs`).
     */
    openLocalPath: (path: string) => openLocalPath(path),

    /**
     * A file the window fetched, saved and opened in its default application
     * by the SHELL, which sanitizes the name and opens only documents
     * (`downloaded_file.rs`).
     */
    openDownloadedFile: (bytes: Uint8Array, name: string) => openDownloadedFile(bytes, name),

    /**
     * A first-party app's UI, verified by the SHELL against its compiled keys
     * and served by hash on `liaison-app:` (`verified_apps.rs`, S13).
     */
    verifyFirstPartyApp: (name: string, version: string) => verifyFirstPartyApp(name, version),

    // Native OS notifications through the shell (notifications.ts).
    raiseNotification: (notification) => raiseNotification(notification),
    setUnreadBadge: (count) => setUnreadBadge(count),
    notificationPermission: () => notificationPermission(),
    requestNotificationPermission: () => requestNotificationPermission(),
    onNotificationPermissionChange: (listener) => onNotificationPermissionChange(listener),
    // LIF-18: a click opens the item (macOS bundled; elsewhere the page offers it).
    notificationClickSupport: () => notificationClickSupport(),
    onNotificationClick: (listener) => onNotificationClick(listener),
    // P1-T6: this install as a notification device (notification_device.rs).
    notificationDeviceId: () => notificationDeviceId(),
    storeNotificationCredential: (server, credential) =>
      storeNotificationCredential(server, credential),
    loadNotificationCredential: (server) => loadNotificationCredential(server),
    launchAtLogin: () => launchAtLogin(),
    setLaunchAtLogin: (enabled) => setLaunchAtLogin(enabled),
    // The page saw a server newer than this app's web build (updates.ts).
    checkForUpdates: (options) => checkForUpdates(options),
    // Which version this app is, for the server's client policy (updates.ts).
    appVersion: () => appVersion(),
    // P4 N-D T4: this computer as the user's node (node.rs).
    storeNodeCredential: (server, node) => storeNodeCredential(server, node),
    loadNodeCredential: (server) => loadNodeCredential(server),
    keepAwake: () => keepAwake(),
    setKeepAwake: (enabled) => setKeepAwake(enabled),
    // G6: Auto for node chats started away from this computer (node_job.rs).
    remoteAuto: () => remoteAuto(),
    setRemoteAuto: (enabled) => setRemoteAuto(enabled),
    // P4 N-D T5: unattended jobs on this node (node-jobs/runner.ts).
    // L19: the backlog is offered with no dialog; the contract's onReview stays unused.
    startNodeJobs: () => {
      void nodeJobRunner().startup()
      capabilityPublisher().changed(capabilityKey())
      // A list that lands later republishes through `setDesktopSessionState`.
      void discoverLocalModels()
    },
    nodeJobOffered: (jobId, agentId) => {
      nodeJobs?.offer(jobId, agentId)
    },
    // P3 (C5, D36): a steering command waits for a session here; the socket is back.
    nodeSessionCommand: (sessionId) => {
      void nodeJobs?.wake(sessionId)
    },
    nodeReconnected: () => {
      void nodeJobs?.reconnected()
    },
    nodeFullOutputRequested: (sessionId, toolUseId) => {
      void nodeJobs?.fullOutput(sessionId, toolUseId)
    },
    // The owner asked about this node's folders from any client (folder-requests.ts).
    nodeFolderRequest: (requestId) => {
      void nodeFolderRequests()(requestId)
    },
    // S40: the owner asked this node for its importable Claude Code sessions.
    nodeImportRequest: (requestId) => {
      void nodeImportRequests()(requestId)
    },
    nodeRoot: () => nodeRoot(),
    setNodeRoot: (path) => setNodeRoot(path),
    // P2-T15 (L21): the shared roots, chosen with the native picker.
    ...createSharedRoots({
      invoke: (command, args) => invoke<unknown>(command, args),
      republish: () => capabilityPublisher().publishNow(),
    }),
    // S52: "Open in VS Code" on a session of this computer, by folder name.
    ...createFolderEditor({ invoke: (command, args) => invoke<unknown>(command, args) }),
    // D33: "Stop it" on an orphaned Claude process holding a session here.
    ...createOrphanStopper({ invoke: (command, args) => invoke<unknown>(command, args) }),
    pickDirectory: () => pickFolderCommand(null),
    openPrivacySettings: async () =>
      (await invoke<boolean>("open_privacy_settings").catch(() => false)) === true,

    getState: () => snapshot(),

    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * SAYS THE BRIDGE IS THERE, to a page that may already have looked.
 *
 * In the shell the injected script runs first and nothing is listening yet, so
 * this is a no op there and the page's own read at module load is what finds
 * the bridge. It costs one event and it removes the ordering as a thing that
 * has to hold: a page that resolved the bridge before it existed used to
 * render no desktop surface at all until a sign out and a sign in (W1).
 */
function announceBridge(target: object): void {
  const view = target as { dispatchEvent?: (event: Event) => boolean }
  if (typeof view.dispatchEvent !== "function" || typeof Event !== "function") return
  try {
    view.dispatchEvent(new Event(DESKTOP_BRIDGE_EVENT))
  } catch {
    // A target that is not a real event target is a test's plain object, and
    // the page it stands in for is not listening for anything.
  }
}

/**
 * Publishes the bridge, synchronously, as the injected bundle's first act.
 *
 * apps/web resolves it while its own modules load, for the same reason the
 * server address global is published first: anything published after the first
 * await is published too late, and a page that found no bridge renders no
 * desktop UI at all.
 */
export function publishDesktopBridge(target: object = globalThis): DesktopBridge {
  const existing = (target as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
  if (existing && typeof existing === "object") {
    announceBridge(target)
    return existing as DesktopBridge
  }
  const bridge = buildBridge()
  Object.defineProperty(target, DESKTOP_BRIDGE_KEY, {
    value: bridge,
    configurable: true,
    enumerable: true,
    writable: false,
  })
  // BEFORE the state is filled, on purpose (P6d-FX3, W1). The object is whole
  // the moment it is defined: its methods reach the shell's own commands and
  // its state starts at the empty snapshot and fills through `followShellState`
  // below. A page that hears about it now therefore renders the idle desktop
  // and follows the state in, which is what it would have done had it loaded
  // second.
  announceBridge(target)
  followSidecar()
  followClaudeAuth()
  void discoverLocalModels()
  // Every declared field, followed for the life of the window. The files the
  // store holds become the contract's array here, and it is REACTIVE: the old
  // one-shot read ran as the injected bundle's first act, before any session
  // could have produced anything.
  followShellState()
  return bridge
}
